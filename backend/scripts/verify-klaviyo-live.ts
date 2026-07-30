/**
 * Phase 4 LIVE verification — Klaviyo reconciliation data (§7, Phase 4 acceptance:
 * "3 campaigns within 1% of Klaviyo dashboard").
 *
 * This script does NOT decide whether the numbers reconcile. It prints the three
 * most recent sent EMAIL campaigns from a real sync so the operator can compare
 * them by hand against the Klaviyo dashboard. Flows are deliberately excluded from
 * the reconciliation set: a flow's stored uniques are a sum over its messages and
 * therefore an upper bound on flow-level uniques (see rollUpReport's caveat), so a
 * flow can never honestly satisfy a ≤1% criterion.
 *
 * What it does, in order:
 *   1. read KLAVIYO_API_KEY from the .env FILE (not the shell, not the DB)
 *   2. verify the credential with GET /api/accounts
 *   3. list email campaigns and count those SENT within the last 12 months
 *   4. fewer than 3  → report the count, mark live reconciliation DEFERRED, stop.
 *                      Nothing is fabricated and the implementation does not fail.
 *      3 or more     → run ONE real sync (the normal backfill entry point), then
 *                      print the 3 most recent RECONCILABLE campaigns
 *   5. stop. No commit, no further writes.
 *
 * RECONCILABLE means all three of: a real campaign_stats row, non-null recipients,
 * and a send inside the REPORT window — which is not the same thing as "inside the
 * last 12 months". Klaviyo's `last_12_months` timeframe key covers the 12 COMPLETE
 * calendar months ending at the close of last month; the current partial month is
 * excluded. Diagnosed against the live API on 2026-07-29, filtering the report to
 * three specific July sends: 0 rows under `last_12_months`, full non-zero rows for
 * all three under `last_365_days`, `last_30_days`, and an explicit custom window.
 * So a just-sent campaign is not missing, not delayed and not zero — it is out of
 * window, and picking "the 3 newest sends" would reconcile against nothing.
 * Campaigns newer than the window are listed separately as warnings, never as 0s.
 *
 * Request discipline (§4.2): fetch is instrumented — pathnames only, never
 * headers — so the output proves the grouped report path was used and that there
 * was NOT one reporting request per campaign.
 *
 * The private key is never printed: it travels only in a request header, log lines
 * carry pathnames, and every error message goes through redactKey first.
 *
 * Exit codes: 0 = reconciliation data printed · 3 = deferred (no key, or <3
 * campaigns) · 1 = failure (bad credential, API error, request-budget breach).
 *
 * ---------------------------------------------------------------------------
 * LIVE RECONCILIATION RESULT — 2026-07-29, account 1, timeframe last_365_days
 * PASS: all 3 campaigns within 1% of the Klaviyo dashboard (manual comparison).
 *
 *   campaign 1  opens 10730 API / 10724 dash · clicks 172/172 · uniq conv 3/3 · rev 1308.50/1308.50
 *   campaign 2  opens 13281 API / 13299 dash · clicks 214/214 · uniq conv 0/0 · rev 0.00/0.00
 *   campaign 3  opens 12349 API / 12353 dash · clicks 368/368 · uniq conv 14/14 · rev 4641.48/4641.48
 *
 * Open counts drift upward between the API read and the dashboard read because
 * engagement keeps accruing on a recent send; clicks, conversions and revenue
 * matched exactly.
 *
 * CONFIRMED, and the reason campaign_stats needs a deliberate decision: the
 * Klaviyo Overview column "Placed order recipients" is `conversion_uniques`, NOT
 * `conversions`. Campaign 3 returns conversions=15 and conversion_uniques=14, and
 * the dashboard shows 14 — total attributed orders vs distinct converting
 * customers are genuinely different numbers, and campaign_stats currently has one
 * column (`conversions`) holding the TOTAL.
 * ---------------------------------------------------------------------------
 *
 * Run: `npx tsx scripts/verify-klaviyo-live.ts [--account=<id>]`
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, query } from '../src/db/pool.js';
import { config } from '../src/config.js';
import {
  fetchAllPages, verifyKlaviyoConnection, redactKey, type KlaviyoConnection,
} from '../src/sync/klaviyo/client.js';
import { runKlaviyoBackfill } from '../src/sync/klaviyo/poller.js';
import { V1_CHANNELS } from '../src/sync/klaviyo/transform.js';
import { upsertKlaviyoConnection } from '../src/db/connections.js';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const RECONCILE_COUNT = 3;
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_DEFERRED = 3;

// ---------------------------------------------------------------------------
// .env reading — requirement: the key comes from .env and nowhere else
// ---------------------------------------------------------------------------

/**
 * Parse the .env file directly rather than trusting process.env. dotenv lets a
 * shell variable win over the file, and a stale exported KLAVIYO_API_KEY silently
 * reconciling against the wrong Klaviyo account is exactly the failure this stage
 * exists to catch.
 */
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fetch instrumentation — counts requests by pathname, passes through to the
// real network. Headers are never touched, so the key cannot reach a log line.
// ---------------------------------------------------------------------------
const requestCounts = new Map<string, number>();

function instrumentFetch() {
  const real = globalThis.fetch;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    let path = '(unparsed)';
    try { path = new URL(url).pathname; } catch { /* leave as-is */ }
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    return real(input, init);
  };
}

const countOf = (path: string) => requestCounts.get(path) ?? 0;

function printRequestCounts() {
  const total = [...requestCounts.values()].reduce((a, b) => a + b, 0);
  console.log(`\nRequests issued (${total} total):`);
  for (const [path, n] of [...requestCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Sent-campaign classification
// ---------------------------------------------------------------------------
interface ListedCampaign {
  id: string;
  name: string | null;
  status: string | null;
  sendTime: Date | null;
}

/**
 * A campaign counts as SENT for reconciliation when its status says so and its
 * send_time is in the past. Status strings have varied in case and wording across
 * revisions ('Sent', 'Variations Sent', 'sent'), so the substring test is
 * deliberate; the past-send_time requirement is what actually excludes drafts,
 * scheduled sends and cancellations, all of which are checked explicitly too.
 */
function classify(items: any[]): ListedCampaign[] {
  return items.map((c) => {
    const a = c?.attributes ?? {};
    const raw = typeof a.send_time === 'string' ? a.send_time : null;
    const t = raw ? new Date(raw) : null;
    return {
      id: String(c?.id ?? ''),
      name: typeof a.name === 'string' ? a.name : null,
      status: typeof a.status === 'string' ? a.status : null,
      sendTime: t && !Number.isNaN(t.getTime()) ? t : null,
    };
  });
}

function isSentWithin12Months(c: ListedCampaign, now: Date, cutoff: Date): boolean {
  if (!c.id || !c.sendTime) return false;
  if (c.sendTime > now) return false;            // scheduled for the future
  if (c.sendTime < cutoff) return false;         // outside the reporting window
  const s = (c.status ?? '').toLowerCase();
  if (/draft|cancel|scheduled|queued/.test(s)) return false;
  // Blank status with a past send_time is treated as sent; anything else must say so.
  return s === '' || s.includes('sent');
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------
interface TargetAccount { id: number; name: string; storeTimezone: string; hadConnection: boolean }

async function resolveAccount(explicitId: number | null): Promise<TargetAccount> {
  const load = async (id: number) => {
    const { rows } = await query<{ id: number; name: string; store_timezone: string }>(
      `SELECT id, name, store_timezone FROM accounts WHERE id = $1`, [id]);
    if (rows.length === 0) throw new Error(`account ${id} does not exist`);
    const { rows: conn } = await query(
      `SELECT 1 FROM connections WHERE account_id = $1 AND provider = 'klaviyo'`, [id]);
    return {
      id: rows[0].id, name: rows[0].name,
      storeTimezone: rows[0].store_timezone ?? 'UTC',
      hadConnection: conn.length > 0,
    };
  };

  if (explicitId !== null) return load(explicitId);

  const { rows: connected } = await query<{ account_id: number }>(
    `SELECT account_id FROM connections WHERE provider = 'klaviyo' ORDER BY account_id`);
  if (connected.length === 1) return load(connected[0].account_id);
  if (connected.length > 1) {
    throw new Error(
      `${connected.length} accounts have a Klaviyo connection ` +
      `(${connected.map((r) => r.account_id).join(', ')}). Re-run with --account=<id>.`,
    );
  }

  const { rows: accounts } = await query<{ id: number }>(
    `SELECT id FROM accounts ORDER BY id`);
  if (accounts.length === 1) return load(accounts[0].id);
  throw new Error(
    accounts.length === 0
      ? 'no accounts exist — run the seed or onboarding first'
      : `${accounts.length} accounts exist and none has a Klaviyo connection. Re-run with --account=<id>.`,
  );
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function fmtInTz(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).replace(', ', ' ');
  } catch {
    return '(unknown timezone)';
  }
}

const num = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
const money = (v: unknown) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));

// ---------------------------------------------------------------------------
// Report window
// ---------------------------------------------------------------------------
interface ReportWindow {
  /**
   * SQL expressions (timestamptz) for the window bounds, evaluated by ONE bounds
   * query. Calendar-aligned windows reference $1 = store timezone; trailing-day
   * windows need no parameter at all, which is why `usesTz` exists: binding a
   * parameter a statement never references is a hard Postgres error
   * ("bind message supplies 1 parameters, but prepared statement requires 0").
   */
  startSql: string;
  endSql: string;
  usesTz: boolean;
  label: string;
  /** True only for windows confirmed against the live API, not inferred. */
  verified: boolean;
}

/**
 * The window a timeframe key actually covers, as SQL evaluated in the STORE
 * timezone — Klaviyo aligns calendar windows to the account's timezone, so doing
 * the month math in UTC would misplace sends within a few hours of a month
 * boundary (§0: convert to store timezone at query time).
 *
 * Only `last_12_months` is marked verified: its boundary was confirmed against the
 * live API (see the header). Every other key is an honest approximation and says so
 * in the output rather than quietly pretending to precision.
 *
 * The bounds SQL is used by exactly one query, whose only possible parameter is
 * $1 = store timezone. Nothing downstream interpolates these fragments: the
 * selection and warning queries bind the resolved timestamps as ordinary
 * parameters, so their placeholder numbering cannot drift with the timeframe key.
 */
function reportWindow(key: string): ReportWindow {
  const monthStart = `date_trunc('month', now() AT TIME ZONE $1)`;
  const months = (backFromMonthStart: number, spanMonths: number, label: string, verified = false): ReportWindow => ({
    startSql: `(${monthStart} - interval '${backFromMonthStart + spanMonths} months') AT TIME ZONE $1`,
    endSql: `(${monthStart} - interval '${backFromMonthStart} months') AT TIME ZONE $1`,
    usesTz: true, label, verified,
  });
  const trailingDays = (n: number): ReportWindow => ({
    startSql: `now() - interval '${n} days'`,
    endSql: 'now()',
    usesTz: false,
    label: `trailing ${n} days (assumed — boundary not confirmed against the live API)`,
    verified: false,
  });

  switch (key) {
    case 'last_12_months':
      return months(0, 12, '12 complete calendar months, current month EXCLUDED (confirmed live)', true);
    case 'last_month':
      return months(0, 1, 'the previous complete calendar month (assumed)');
    case 'this_month':
      return {
        startSql: `${monthStart} AT TIME ZONE $1`, endSql: 'now()',
        usesTz: true, label: 'the current calendar month to date (assumed)', verified: false,
      };
    case 'last_365_days': return trailingDays(365);
    case 'last_90_days': return trailingDays(90);
    case 'last_30_days': return trailingDays(30);
    default:
      return {
        startSql: `now() - interval '365 days'`, endSql: 'now()',
        usesTz: false,
        label: `UNRECOGNISED timeframe key "${key}" — falling back to a trailing 365-day assumption`,
        verified: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
  console.log('Phase 4 LIVE verification — Klaviyo reconciliation data');
  console.log(`  .env: ${ENV_PATH}`);

  // --- 1. credential from .env only --------------------------------------
  const envFile = readEnvFile(ENV_PATH);
  const apiKey = (envFile.KLAVIYO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.log('\nKLAVIYO_API_KEY is not set in .env.');
    console.log('  (the shell environment and the stored DB credential are ignored by design)');
    console.log('\nRESULT: LIVE VERIFICATION DEFERRED — no live credential available.');
    console.log('  Fixture verification (scripts/verify-klaviyo.ts) remains the only passing');
    console.log('  evidence for Phase 4. Set KLAVIYO_API_KEY in .env with read-only scopes');
    console.log('  (accounts:read campaigns:read flows:read metrics:read profiles:read) and');
    console.log('  re-run this script to produce reconciliation data.');
    return EXIT_DEFERRED;
  }
  const keyShape = /^pk_[A-Za-z0-9_-]{10,}$/.test(apiKey);
  console.log(`  key: present, ${apiKey.length} chars, ${keyShape ? 'pk_ private-key shape' : 'UNEXPECTED shape (not pk_…)'}`);
  console.log(`  revision: ${config.klaviyoApiRevision}   timeframe: ${config.klaviyoReportTimeframe}`);

  const conn: KlaviyoConnection = { apiKey };
  instrumentFetch();

  // --- 2. verify the connection: GET /api/accounts -----------------------
  console.log('\n1. Connection check — GET /api/accounts');
  const account = await verifyKlaviyoConnection(conn);
  console.log(`  ✓ authenticated · Klaviyo account id ${account.id ?? '(none returned)'}`);
  console.log(`    organization: ${account.name ?? '(no organization_name)'}`);

  const target = await resolveAccount(
    (() => {
      const arg = process.argv.find((a) => a.startsWith('--account='));
      const fromArg = arg ? Number(arg.split('=')[1]) : NaN;
      const fromEnv = Number(envFile.KLAVIYO_ACCOUNT_ID ?? NaN);
      return Number.isInteger(fromArg) ? fromArg : Number.isInteger(fromEnv) ? fromEnv : null;
    })(),
  );
  console.log(`  platform account: ${target.id} ("${target.name}") · store timezone ${target.storeTimezone}`);
  console.log(`  klaviyo connection row: ${target.hadConnection ? 'exists' : 'absent — will be created from the .env key'}`);

  // --- 3. count sent email campaigns in the last 12 months ---------------
  console.log(`\n2. Sent email campaigns in the last 12 months (channel${V1_CHANNELS.length > 1 ? 's' : ''}: ${V1_CHANNELS.join(', ')})`);
  const now = new Date();
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(),
  ));

  const listed: ListedCampaign[] = [];
  for (const channel of V1_CHANNELS) {
    const { items, pagesFetched } = await fetchAllPages<any>(conn, '/api/campaigns', {
      filter: `equals(messages.channel,'${channel}')`,
      'fields[campaign]': 'name,status,archived,send_time,scheduled_at,created_at,updated_at',
      'page[size]': '100',
      sort: '-created_at',
    });
    console.log(`  ${channel}: ${items.length} campaign(s) across ${pagesFetched} page(s)`);
    listed.push(...classify(items));
  }

  const sent = listed
    .filter((c) => isSentWithin12Months(c, now, cutoff))
    .sort((a, b) => b.sendTime!.getTime() - a.sendTime!.getTime());

  console.log(`  window: ${cutoff.toISOString()} → ${now.toISOString()}`);
  console.log(`  sent within window: ${sent.length}`);
  if (sent.length > 0) {
    console.log(`  most recent send: ${sent[0].sendTime!.toISOString()} ("${sent[0].name ?? '(unnamed)'}")`);
  }

  // --- 4. not enough data → deferred, nothing invented -------------------
  if (sent.length < RECONCILE_COUNT) {
    printRequestCounts();
    console.log(`\nRESULT: LIVE RECONCILIATION DEFERRED — ${sent.length} sent email campaign(s) ` +
      `in the last 12 months, ${RECONCILE_COUNT} required.`);
    console.log('  No sync was run and no figures are reported: with fewer than 3 real sends');
    console.log('  there is nothing to compare against the Klaviyo dashboard, and inventing a');
    console.log('  comparison would defeat the purpose of the check.');
    console.log('  Phase 4 implementation is NOT failed by this — fixture verification stands.');
    console.log('  Re-run once the connected Klaviyo account has 3+ sent email campaigns.');
    if (listed.length > 0) {
      console.log('\n  For context, the campaigns the API did return:');
      for (const c of listed.slice(0, 10)) {
        console.log(`    ${c.id}  status=${c.status ?? 'null'}  send_time=${c.sendTime?.toISOString() ?? 'null'}  "${c.name ?? '(unnamed)'}"`);
      }
      if (listed.length > 10) console.log(`    … and ${listed.length - 10} more`);
    }
    return EXIT_DEFERRED;
  }

  // --- 5. one real sync --------------------------------------------------
  if (!target.hadConnection) {
    await upsertKlaviyoConnection(target.id, apiKey);
    console.log(`\n  created klaviyo connection for account ${target.id} (key encrypted at rest)`);
  }

  console.log('\n3. Running ONE real Klaviyo sync (the normal backfill entry point)');
  console.log('   Grouped values-reports only — one call per object type, message rows rolled up');
  console.log('   in memory. Multi-page reports are paced 30s apart to respect the 2/min steady');
  console.log('   limit, so this can take a few minutes.');
  const beforeCampaignReports = countOf('/api/campaign-values-reports');
  const t0 = process.hrtime.bigint();
  const result = await runKlaviyoBackfill(target.id, conn);
  const elapsedS = Number(process.hrtime.bigint() - t0) / 1e9;

  console.log(`  ✓ sync complete in ${elapsedS.toFixed(1)}s`);
  console.log(`    campaigns imported: ${result.campaigns} · flows: ${result.flows} · stats rows: ${result.stats}`);
  console.log(`    conversion metric: ${result.conversionMetricId} · timeframe: ${result.timeframe}`);
  console.log(`    report pages: campaign ${result.campaignReportPages}, flow ${result.flowReportPages}`);
  console.log(`    campaigns with no stats row: ${result.campaignsWithoutStats} (expected for sends older than the window)`);
  if (result.identity) {
    const i = result.identity;
    console.log(`    identity: ${i.matched}/${i.profilesScanned} profile emails matched a customer ` +
      `(unmatched ${(i.unmatchedRate * 100).toFixed(1)}%${i.overThreshold ? ' — OVER the 5% surfacing threshold' : ''}` +
      `${i.partial ? ', PARTIAL scan: page budget reached' : ''})`);
  }

  // Requirement: not one reporting request per campaign.
  const campaignReportCalls = countOf('/api/campaign-values-reports') - beforeCampaignReports;
  const grouped = campaignReportCalls === result.campaignReportPages && campaignReportCalls < sent.length;
  console.log(`\n  ${grouped ? '✓' : '✗'} grouped report: ${campaignReportCalls} campaign values-report ` +
    `request(s) for ${sent.length} sent campaigns (per-campaign reporting would be ${sent.length})`);

  // --- 6. select the reconcilable set ------------------------------------
  // Three conditions, all required: a real campaign_stats row (INNER JOIN — a
  // missing row must never surface as zeros), non-null recipients, and a send
  // inside the report window. "3 most recent sends" is deliberately NOT the rule:
  // sends newer than the window carry no stats and cannot be reconciled.
  const win = reportWindow(result.timeframe);
  const sentIds = sent.map((c) => c.id);

  console.log(`\n4. Report window for timeframe "${result.timeframe}"`);
  console.log(`   ${win.label}`);
  // Resolve the bounds ONCE. $1 is bound only when the window expression uses it.
  const bounds = await query<{ w_start: Date; w_end: Date }>(
    `SELECT ${win.startSql} AS w_start, ${win.endSql} AS w_end`,
    win.usesTz ? [target.storeTimezone] : [],
  );
  const { w_start: winStart, w_end: winEnd } = bounds.rows[0];
  console.log(`   ${winStart.toISOString()} → ${winEnd.toISOString()}` +
    `${win.verified ? '' : '   (assumed boundary — treat the edges with suspicion)'}`);

  const { rows } = await query<any>(
    `SELECT c.id, c.name, c.sent_at, c.recipients,
            s.opens, s.clicks, s.conversions, s.conversion_uniques, s.revenue
       FROM campaigns c
       JOIN campaign_stats s
              ON s.account_id = c.account_id AND s.campaign_id = c.id
      WHERE c.account_id = $1
        AND c.kind = 'campaign'            -- flows never enter the 1% test
        AND c.channel = 'email'
        AND c.recipients IS NOT NULL
        AND c.sent_at IS NOT NULL
        AND c.sent_at >= $2
        AND c.sent_at <  $3
        AND c.id = ANY($4::text[])         -- status Sent per the live list response
      ORDER BY c.sent_at DESC
      LIMIT $5`,
    [target.id, winStart, winEnd, sentIds, RECONCILE_COUNT],
  );

  // --- 7. sends newer than the window: warnings, never zeros -------------
  const { rows: newer } = await query<any>(
    `SELECT c.id, c.name, c.sent_at, c.recipients,
            (s.campaign_id IS NOT NULL) AS has_stats
       FROM campaigns c
       LEFT JOIN campaign_stats s
              ON s.account_id = c.account_id AND s.campaign_id = c.id
      WHERE c.account_id = $1
        AND c.kind = 'campaign'
        AND c.channel = 'email'
        AND c.sent_at IS NOT NULL
        AND c.sent_at <= now()
        AND c.sent_at >= $2
        AND (s.campaign_id IS NULL OR c.recipients IS NULL)
      ORDER BY c.sent_at DESC`,
    [target.id, winEnd],
  );

  if (newer.length > 0) {
    console.log(`\n⚠ WARNING — ${newer.length} sent email campaign(s) newer than the report window have`);
    console.log('  no usable stats. They are EXCLUDED from reconciliation rather than reported as 0.');
    console.log(`  Diagnosed cause: the "${result.timeframe}" window ends ${winEnd.toISOString()},`);
    console.log('  so these sends are out of window. This is NOT reporting delay — a filtered report');
    console.log('  request over a trailing window returns full non-zero statistics for them today.');
    for (const w of newer.slice(0, 10)) {
      console.log(`    ${w.sent_at.toISOString()}  ${w.id}  stats_row=${w.has_stats}  recipients=${num(w.recipients)}  "${w.name ?? '(unnamed)'}"`);
    }
    if (newer.length > 10) console.log(`    … and ${newer.length - 10} more`);
    console.log('  Remedy (operator decision, no code change): set KLAVIYO_REPORT_TIMEFRAME=last_365_days');
    console.log('  in .env and re-sync. Production sync logic is untouched by this script.');
  }

  if (rows.length < RECONCILE_COUNT) {
    printRequestCounts();
    console.log(`\nRESULT: LIVE RECONCILIATION DEFERRED — only ${rows.length} campaign(s) meet all three`);
    console.log('  conditions (real stats row + non-null recipients + inside the report window),');
    console.log(`  ${RECONCILE_COUNT} required. No partial figures are reported.`);
    return EXIT_DEFERRED;
  }

  const statusById = new Map(listed.map((c) => [c.id, c.status]));
  console.log(`\n5. LIVE RECONCILIATION DATA — ${rows.length} most recent reconcilable email campaign(s)`);
  console.log('   Read from the DB rows this sync just wrote. Compare by hand with the Klaviyo');
  console.log('   dashboard; opens/clicks are UNIQUE counts, revenue is conversion_value for the');
  console.log(`   "${result.conversionMetricId}" conversion metric over ${result.timeframe}.`);

  for (const [idx, r] of rows.entries()) {
    const rolled = result.rolledStats.get(r.id);
    const sentAt: Date | null = r.sent_at ?? null;
    console.log(`\n  [${idx + 1}] ${r.name ?? '(unnamed)'}`);
    console.log(`      campaign id      ${r.id}`);
    console.log(`      status           ${statusById.get(r.id) ?? '(not in list response)'}`);
    console.log(`      send time (UTC)  ${sentAt ? sentAt.toISOString() : '—'}`);
    console.log(`      send time (${target.storeTimezone})  ${sentAt ? fmtInTz(sentAt, target.storeTimezone) : '—'}`);
    if (r.opens === null && r.clicks === null && r.conversions === null) {
      console.log('      stats            NO stats row — the values-report returned nothing for this');
      console.log('                       campaign. Not reported as zero; investigate before comparing.');
      continue;
    }
    console.log(`      recipients       ${num(r.recipients)}`);
    console.log(`      unique opens     ${num(r.opens)}`);
    console.log(`      unique clicks    ${num(r.clicks)}`);
    // Both stored since migration 003. The Klaviyo Overview column "Placed order
    // recipients" is the UNIQUE one — that is the figure to compare.
    console.log(`      conversions      ${num(r.conversions)}   (total attributed orders)`);
    console.log(`      unique conv.     ${num(r.conversion_uniques)}   ← dashboard "Placed order recipients"`);
    console.log(`      revenue          ${money(r.revenue)}`);
    if (rolled && rolled.messageRows > 1) {
      console.log(`      note             ${rolled.messageRows} message rows rolled up (A/B variations): ` +
        'summed uniques are an upper bound on true campaign-level uniques.');
    }
  }

  if (rows.length < RECONCILE_COUNT) {
    console.log(`\n  ⚠ only ${rows.length} of ${RECONCILE_COUNT} campaigns came back from the DB. The API listed`);
    console.log('    3+ sent campaigns, so this is a persistence gap worth investigating, not a data gap.');
  }

  printRequestCounts();

  console.log('\nSTOPPING HERE for manual review, per instruction.');
  console.log('  Next step is yours: compare the figures above with the Klaviyo dashboard');
  console.log('  (Campaigns → each campaign, matching the reporting window). Phase 4 acceptance');
  console.log('  is 3 campaigns within 1%. Nothing is committed.');
  return EXIT_OK;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error('\nFAILED:', redactKey(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    console.error('\nRESULT: live verification could not complete. No figures reported.');
    await pool.end();
    process.exit(EXIT_FAIL);
  });
