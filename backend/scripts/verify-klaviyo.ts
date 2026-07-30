/**
 * Phase 4 FIXTURE verification (no live Klaviyo credentials required).
 *
 *  A. Transform unit checks — campaign/flow mapping, message→parent roll-up,
 *     conversion-metric discovery incl. the refuse-to-guess path.
 *  B. Client checks — links.next pagination, page budget, 429 backoff, and the
 *     guarantee that a key-shaped string never survives into an error message.
 *  C. End-to-end sync against a MOCKED Klaviyo API (real client, real transforms,
 *     real persist, real identity measurement, real DB) into throwaway accounts:
 *     row counts, aggregate values, account isolation, idempotency, sync_errors.
 *
 * No network call leaves this process — globalThis.fetch is replaced throughout.
 *
 * Run: `npx tsx scripts/verify-klaviyo.ts`
 */

// Pin every knob the fixture depends on, so the run is hermetic and an operator's
// .env cannot make an offline test pass or fail for the wrong reason.
//
// These MUST be set before config.ts is evaluated, and config.ts reads
// process.env once at module load. Static `import` statements are HOISTED above
// this code by the ES module spec, so the imports below are deliberately DYNAMIC:
// with static imports these assignments would run too late and silently do
// nothing — which is exactly how a stale `last_12_months` assertion survived here
// until an operator set KLAVIYO_REPORT_TIMEFRAME=last_365_days in .env and the
// timeframe check finally failed.
export {}; // marks this file a module: every import below is dynamic, see above

process.env.KLAVIYO_BACKOFF_MS = '0';
process.env.KLAVIYO_REPORT_MIN_INTERVAL_MS = '0';
process.env.KLAVIYO_API_REVISION = '2026-07-15';
process.env.KLAVIYO_REPORT_TIMEFRAME = 'last_365_days'; // production default
process.env.KLAVIYO_CONVERSION_METRIC_ID = '';
process.env.KLAVIYO_PROFILE_PAGE_BUDGET = '50';

const { pool, query } = await import('../src/db/pool.js');
const {
  transformCampaign, transformFlow, rollUpReport, toStatsRow, withRecipients,
  pickConversionMetric, AmbiguousConversionMetricError,
  V1_CHANNELS, REPORT_STATISTICS,
} = await import('../src/sync/klaviyo/transform.js');
const {
  fetchAllPages, fetchReport, verifyKlaviyoConnection, redactKey,
} = await import('../src/sync/klaviyo/client.js');
const { syncKlaviyo } = await import('../src/sync/klaviyo/poller.js');
const { upsertKlaviyoConnection } = await import('../src/db/connections.js');
const { config } = await import('../src/config.js');

const FAKE_KEY = 'pk_fixture0000000000000000000000000000';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// ---------------------------------------------------------------------------
// A. Transform unit checks
// ---------------------------------------------------------------------------
function transformChecks() {
  console.log('\nA. Transforms');

  check("V1 imports email only (SMS deferred, no migration needed to add)",
    V1_CHANNELS.length === 1 && V1_CHANNELS[0] === 'email', V1_CHANNELS);
  check('requests unique opens/clicks, not totals',
    REPORT_STATISTICS.includes('opens_unique') && REPORT_STATISTICS.includes('clicks_unique') &&
    !(REPORT_STATISTICS as readonly string[]).includes('opens') &&
    !(REPORT_STATISTICS as readonly string[]).includes('clicks'), REPORT_STATISTICS);

  const sent = transformCampaign(
    { id: 'camp_1', attributes: { name: 'Launch', send_time: '2026-06-01T10:00:00Z', scheduled_at: '2026-05-30T00:00:00Z' } },
    'email',
  );
  check('campaign id/name/kind/channel', sent?.id === 'camp_1' && sent?.name === 'Launch' &&
    sent?.kind === 'campaign' && sent?.channel === 'email', sent);
  check('campaign sent_at from send_time', sent?.sent_at === '2026-06-01T10:00:00Z', sent?.sent_at);
  check('campaign recipients null until report roll-up', sent?.recipients === null, sent?.recipients);

  const scheduled = transformCampaign(
    { id: 'camp_2', attributes: { name: 'Later', scheduled_at: '2026-09-01T00:00:00Z' } }, 'email');
  check('campaign sent_at falls back to scheduled_at', scheduled?.sent_at === '2026-09-01T00:00:00Z', scheduled?.sent_at);

  const draft = transformCampaign({ id: 'camp_3', attributes: { name: 'Draft' } }, 'email');
  check('campaign sent_at null when neither present', draft?.sent_at === null, draft?.sent_at);
  check('campaign missing name -> null, not invented',
    transformCampaign({ id: 'camp_4', attributes: {} }, 'email')?.name === null);
  check('campaign without id -> null row', transformCampaign({ attributes: { name: 'x' } }, 'email') === null);

  const flow = transformFlow({ id: 'flow_1', attributes: { name: 'Welcome', created: '2025-01-01T00:00:00Z' } });
  check('flow kind=flow', flow?.kind === 'flow', flow);
  check('flow sent_at is NULL (flows have no send timestamp)', flow?.sent_at === null, flow?.sent_at);
  check('flow name mapped', flow?.name === 'Welcome', flow);

  // Roll-up: campaign_message rows -> campaign_id. camp_ab is an A/B send with
  // two variation rows that must sum into one campaign_stats row.
  const campResults = [
    { groupings: { campaign_id: 'camp_1', campaign_message_id: 'm1' },
      statistics: { recipients: 1000, opens_unique: 400, clicks_unique: 90, conversions: 20, conversion_uniques: 18, conversion_value: 1234.567 } },
    { groupings: { campaign_id: 'camp_ab', campaign_message_id: 'm2' },
      statistics: { recipients: 500, opens_unique: 200, clicks_unique: 40, conversions: 10, conversion_uniques: 9, conversion_value: 100.005 } },
    { groupings: { campaign_id: 'camp_ab', campaign_message_id: 'm3' },
      statistics: { recipients: 500, opens_unique: 180, clicks_unique: 35, conversions: 8, conversion_uniques: 7, conversion_value: 99.995 } },
  ];
  const rolled = rollUpReport(campResults, 'campaign_id');
  check('roll-up keeps single-message campaign exact',
    rolled.get('camp_1')?.recipients === 1000 && rolled.get('camp_1')?.opens === 400, rolled.get('camp_1'));
  check('roll-up sums A/B variation rows by campaign_id',
    rolled.get('camp_ab')?.recipients === 1000 && rolled.get('camp_ab')?.opens === 380 &&
    rolled.get('camp_ab')?.clicks === 75 && rolled.get('camp_ab')?.messageRows === 2, rolled.get('camp_ab'));
  // 100.005 + 99.995 must be 200.00: proves the sum is rounded ONCE at the end
  // rather than per message row (which would double-round to 200.01).
  check('roll-up sums raw then rounds once (no double-rounding)',
    rolled.get('camp_ab')?.revenue === 200, rolled.get('camp_ab')?.revenue);
  check('roll-up rounds single-message revenue to 2dp for NUMERIC(12,2)',
    rolled.get('camp_1')?.revenue === 1234.57, rolled.get('camp_1')?.revenue);

  const flowRolled = rollUpReport([
    { groupings: { flow_id: 'flow_1', flow_message_id: 'fm1' }, statistics: { recipients: 300, opens_unique: 150, clicks_unique: 30, conversions: 5, conversion_uniques: 5, conversion_value: 250 } },
    { groupings: { flow_id: 'flow_1', flow_message_id: 'fm2' }, statistics: { recipients: 200, opens_unique: 100, clicks_unique: 20, conversions: 3, conversion_uniques: 3, conversion_value: 150 } },
  ], 'flow_id');
  check('roll-up sums flow_message rows by flow_id',
    flowRolled.get('flow_1')?.recipients === 500 && flowRolled.get('flow_1')?.opens === 250 &&
    flowRolled.get('flow_1')?.revenue === 400, flowRolled.get('flow_1'));

  check('roll-up ignores rows with no parent id',
    rollUpReport([{ groupings: {}, statistics: { recipients: 9 } }], 'campaign_id').size === 0);
  check('missing statistic becomes 0, never NaN', (() => {
    const r = rollUpReport([{ groupings: { campaign_id: 'c' }, statistics: {} }], 'campaign_id').get('c')!;
    return r.opens === 0 && r.revenue === 0 && !Number.isNaN(r.revenue);
  })());

  const statsRow = toStatsRow('camp_1', rolled.get('camp_1')!);
  check('stats row stores unique opens/clicks + conversions + revenue',
    statsRow.opens === 400 && statsRow.clicks === 90 && statsRow.conversions === 20 && statsRow.revenue === 1234.57, statsRow);
  // Both conversion figures survive to the row: total orders AND distinct
  // customers (the dashboard's "Placed order recipients"). Migration 003.
  check('stats row keeps total conversions separate from unique conversions',
    statsRow.conversions === 20 && statsRow.conversion_uniques === 18, statsRow);
  check('withRecipients attaches report recipients',
    withRecipients(sent!, rolled.get('camp_1')).recipients === 1000);
  check('withRecipients leaves recipients null when no report row',
    withRecipients(draft!, undefined).recipients === null);

  // Conversion metric discovery (Decision 5: refuse to guess).
  const metrics = [
    { id: 'MSHOP', attributes: { name: 'Placed Order', integration: { name: 'Shopify' } } },
    { id: 'MOTHER', attributes: { name: 'Placed Order', integration: { name: 'Custom' } } },
    { id: 'MNOISE', attributes: { name: 'Opened Email', integration: { name: 'Klaviyo' } } },
  ];
  check('picks the Shopify "Placed Order" metric', pickConversionMetric(metrics) === 'MSHOP');
  check('picks a lone non-Shopify "Placed Order"',
    pickConversionMetric([metrics[1], metrics[2]]) === 'MOTHER');
  check('throws when no Placed Order exists', (() => {
    try { pickConversionMetric([metrics[2]]); return false; }
    catch (e) { return e instanceof AmbiguousConversionMetricError; }
  })());
  check('throws (does NOT guess) when Placed Order is ambiguous', (() => {
    try {
      pickConversionMetric([
        { id: 'A', attributes: { name: 'Placed Order', integration: { name: 'Custom' } } },
        { id: 'B', attributes: { name: 'Placed Order', integration: { name: 'Other' } } },
      ]);
      return false;
    } catch (e) { return e instanceof AmbiguousConversionMetricError; }
  })());
}

// ---------------------------------------------------------------------------
// B. Client checks
// ---------------------------------------------------------------------------
function fakeResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): any {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => init.headers?.[h.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function clientChecks() {
  console.log('\nB. Client (pagination, budget, 429, secret redaction)');
  const conn = { apiKey: FAKE_KEY };

  // links.next pagination across 3 pages.
  let calls = 0;
  const seenHeaders: Record<string, string>[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls++;
    seenHeaders.push(init.headers);
    const page = Number(new URL(url).searchParams.get('page[cursor]') ?? '1');
    return fakeResponse({
      data: [{ id: `p${page}` }],
      links: page < 3 ? { next: `https://a.klaviyo.com/api/profiles?page[cursor]=${page + 1}` } : {},
    });
  };
  const all = await fetchAllPages(conn, '/api/profiles', { 'page[size]': '100' });
  check('follows links.next to the end', all.items.length === 3 && all.pagesFetched === 3, all);
  check('not truncated when the walk completes', all.truncated === false);
  check('sends Klaviyo-API-Key auth header',
    seenHeaders[0]?.Authorization === `Klaviyo-API-Key ${FAKE_KEY}`);
  check('sends the pinned stable revision header 2026-07-15',
    seenHeaders[0]?.revision === '2026-07-15', seenHeaders[0]?.revision);

  calls = 0;
  const budgeted = await fetchAllPages(conn, '/api/profiles', {}, 2);
  check('page budget stops the walk and flags truncated',
    budgeted.pagesFetched === 2 && budgeted.truncated === true, budgeted);

  // 429 → honour Retry-After, then succeed.
  let attempts = 0;
  (globalThis as any).fetch = async () => {
    attempts++;
    if (attempts === 1) return fakeResponse({ errors: [] }, { status: 429, headers: { 'retry-after': '0' } });
    return fakeResponse({ data: [{ id: 'ok' }], links: {} });
  };
  const retried = await fetchAllPages(conn, '/api/campaigns');
  check('retries after 429 and succeeds', attempts === 2 && retried.items.length === 1, { attempts });

  // 429 forever → throws, never silently drops (§8 trap 7).
  (globalThis as any).fetch = async () =>
    fakeResponse({ errors: [] }, { status: 429, headers: { 'retry-after': '0' } });
  let threw = false;
  try { await fetchAllPages(conn, '/api/campaigns'); } catch { threw = true; }
  check('exhausted 429 retries throw rather than drop data', threw);

  // Secret redaction: an error body echoing the key must not leak it.
  (globalThis as any).fetch = async () =>
    fakeResponse({ error: `bad key ${FAKE_KEY}` }, { status: 401 });
  let msg = '';
  try { await verifyKlaviyoConnection(conn); } catch (e) { msg = (e as Error).message; }
  check('HTTP error surfaces status', msg.includes('401'), msg);
  check('private key never appears in the error message', !msg.includes(FAKE_KEY), msg);
  check('redactKey scrubs pk_ tokens', !redactKey(`x ${FAKE_KEY} y`).includes(FAKE_KEY));
  check('redactKey scrubs an Authorization header value',
    !redactKey(`Klaviyo-API-Key ${FAKE_KEY}`).includes(FAKE_KEY));

  // Report pagination uses POST and accumulates data.attributes.results.
  let reportCalls = 0;
  (globalThis as any).fetch = async (url: string, init: any) => {
    reportCalls++;
    check(`report call ${reportCalls} uses POST`, init.method === 'POST');
    return fakeResponse({
      data: { attributes: { results: [{ groupings: { campaign_id: `c${reportCalls}` }, statistics: { recipients: 1 } }] } },
      links: reportCalls < 2 ? { next: 'https://a.klaviyo.com/api/campaign-values-reports?page_cursor=2' } : {},
    });
  };
  const rep = await fetchReport(conn, '/api/campaign-values-reports', { data: {} });
  check('report follows its own pagination', rep.results.length === 2 && rep.pagesFetched === 2, rep);

  const verifyBody = { data: [{ id: 'ACCT', attributes: { contact_information: { organization_name: 'Fixture Brand' } } }] };
  (globalThis as any).fetch = async () => fakeResponse(verifyBody);
  const acct = await verifyKlaviyoConnection(conn);
  check('GET /api/accounts verification reads the org name',
    acct.id === 'ACCT' && acct.name === 'Fixture Brand', acct);
}

// ---------------------------------------------------------------------------
// C. End-to-end sync against a mocked API
// ---------------------------------------------------------------------------
const FIXTURES = {
  metrics: {
    data: [
      { id: 'MPLACED', attributes: { name: 'Placed Order', integration: { name: 'Shopify' } } },
      { id: 'MOPEN', attributes: { name: 'Opened Email', integration: { name: 'Klaviyo' } } },
    ],
    links: {},
  },
  campaignsPage1: {
    data: [{ id: 'camp_1', attributes: { name: 'June Launch', status: 'Sent', send_time: '2026-06-01T10:00:00Z' } }],
    links: { next: 'https://a.klaviyo.com/api/campaigns?page[cursor]=CAMP2' },
  },
  campaignsPage2: {
    data: [
      { id: 'camp_ab', attributes: { name: 'A/B Promo', status: 'Variations Sent', send_time: '2026-06-15T09:00:00Z' } },
      { id: 'camp_old', attributes: { name: 'Ancient Send', status: 'Sent', send_time: '2024-01-01T09:00:00Z' } },
    ],
    links: {},
  },
  flows: {
    data: [{ id: 'flow_1', attributes: { name: 'Welcome Series', status: 'live', created: '2025-01-01T00:00:00Z' } }],
    links: {},
  },
  campaignReport: {
    data: { attributes: { results: [
      { groupings: { campaign_id: 'camp_1', campaign_message_id: 'm1' },
        statistics: { recipients: 12000, opens_unique: 4800, clicks_unique: 960, conversions: 240, conversion_uniques: 210, conversion_value: 18450.75 } },
      { groupings: { campaign_id: 'camp_ab', campaign_message_id: 'm2' },
        statistics: { recipients: 3000, opens_unique: 1200, clicks_unique: 250, conversions: 60, conversion_uniques: 55, conversion_value: 4200.25 } },
      { groupings: { campaign_id: 'camp_ab', campaign_message_id: 'm3' },
        statistics: { recipients: 3000, opens_unique: 1100, clicks_unique: 230, conversions: 55, conversion_uniques: 50, conversion_value: 3800.75 } },
      // camp_old deliberately absent: outside the 1-year reporting window.
    ] } },
    links: {},
  },
  flowReport: {
    data: { attributes: { results: [
      { groupings: { flow_id: 'flow_1', flow_message_id: 'fm1' },
        statistics: { recipients: 5000, opens_unique: 2500, clicks_unique: 500, conversions: 125, conversion_uniques: 120, conversion_value: 9000.50 } },
      { groupings: { flow_id: 'flow_1', flow_message_id: 'fm2' },
        statistics: { recipients: 2000, opens_unique: 900, clicks_unique: 180, conversions: 45, conversion_uniques: 42, conversion_value: 3000.50 } },
    ] } },
    links: {},
  },
  profiles: {
    // ALICE uppercase and bob with a trailing space prove the email match is
    // case-insensitive and trimmed (§8 trap 3). ghost@ matches no customer.
    data: [
      { id: 'prof_1', attributes: { email: 'ALICE@example.com' } },
      { id: 'prof_2', attributes: { email: 'bob@example.com ' } },
      { id: 'prof_3', attributes: { email: 'ghost@example.com' } },
      { id: 'prof_4', attributes: { email: null } },
    ],
    links: {},
  },
};

interface MockCounts { metrics: number; campaigns: number; flows: number; campaignReport: number; flowReport: number; profiles: number }

function installMockFetch(): MockCounts {
  const counts: MockCounts = { metrics: 0, campaigns: 0, flows: 0, campaignReport: 0, flowReport: 0, profiles: 0 };
  (globalThis as any).fetch = async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    if (path === '/api/metrics') { counts.metrics++; return fakeResponse(FIXTURES.metrics); }
    if (path === '/api/campaigns') {
      counts.campaigns++;
      return fakeResponse(u.searchParams.get('page[cursor]') === 'CAMP2'
        ? FIXTURES.campaignsPage2 : FIXTURES.campaignsPage1);
    }
    if (path === '/api/flows') { counts.flows++; return fakeResponse(FIXTURES.flows); }
    if (path === '/api/campaign-values-reports') { counts.campaignReport++; return fakeResponse(FIXTURES.campaignReport); }
    if (path === '/api/flow-values-reports') { counts.flowReport++; return fakeResponse(FIXTURES.flowReport); }
    if (path === '/api/profiles') { counts.profiles++; return fakeResponse(FIXTURES.profiles); }
    throw new Error(`unexpected fetch to ${path}`);
  };
  return counts;
}

async function makeAccount(name: string): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0].id;
}

async function cleanupAccount(accountId: number) {
  await query(`DELETE FROM campaign_stats WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM campaigns WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM connections WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM customers WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM sync_errors WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
}

async function endToEndChecks() {
  console.log('\nC. Mocked-API sync (real client + transforms + persist + identity + DB)');
  const accountId = await makeAccount('__verify_klaviyo__');
  const otherId = await makeAccount('__verify_klaviyo_other__');

  try {
    await query(
      `INSERT INTO customers (account_id, id, email) VALUES ($1,1,'alice@example.com'), ($1,2,'  Bob@Example.com  ')`,
      [accountId],
    );
    // A row on the neighbouring account that must remain untouched.
    await query(
      `INSERT INTO campaigns (account_id, id, name, channel, kind) VALUES ($1,'other_camp','Other','email','campaign')`,
      [otherId],
    );
    await upsertKlaviyoConnection(accountId, FAKE_KEY);

    const counts = installMockFetch();
    const result = await syncKlaviyo(accountId, { apiKey: FAKE_KEY }, 'klaviyo.poll', { forceIdentity: true });

    // --- request budget ---------------------------------------------------
    check('exactly ONE campaign values-report call (225/day ceiling)', counts.campaignReport === 1, counts);
    check('exactly ONE flow values-report call', counts.flowReport === 1, counts);
    check('one campaigns list walk per V1 channel (2 pages)', counts.campaigns === 2, counts);
    check('one flows list walk', counts.flows === 1, counts);
    check('conversion metric auto-discovered as Placed Order',
      result.conversionMetricId === 'MPLACED', result.conversionMetricId);
    check('env pins reached config (guards the ESM-hoisting trap documented at the top)',
      config.klaviyoReportTimeframe === 'last_365_days' && config.klaviyoApiRevision === '2026-07-15',
      { timeframe: config.klaviyoReportTimeframe, revision: config.klaviyoApiRevision });
    // Trailing window, not last_12_months: that key excludes the current calendar
    // month, which live-verification proved strips stats from this month's sends.
    check('reporting timeframe is a trailing window capped at 1 year',
      result.timeframe === 'last_365_days', result.timeframe);

    // --- campaigns table --------------------------------------------------
    const camps = await query<any>(
      `SELECT id, name, channel, kind, sent_at, recipients FROM campaigns WHERE account_id = $1 ORDER BY id`,
      [accountId]);
    check('3 campaigns + 1 flow persisted', camps.rowCount === 4, camps.rows.map((r) => r.id));
    const byId = new Map(camps.rows.map((r) => [r.id, r]));
    check('campaign channel=email, kind=campaign',
      byId.get('camp_1')?.channel === 'email' && byId.get('camp_1')?.kind === 'campaign');
    check('campaign sent_at persisted from send_time',
      byId.get('camp_1')?.sent_at?.toISOString() === '2026-06-01T10:00:00.000Z', byId.get('camp_1')?.sent_at);
    check('flow row has kind=flow and sent_at NULL',
      byId.get('flow_1')?.kind === 'flow' && byId.get('flow_1')?.sent_at === null, byId.get('flow_1'));
    check('campaign recipients from report roll-up', byId.get('camp_1')?.recipients === 12000, byId.get('camp_1')?.recipients);
    check('A/B campaign recipients summed across variations',
      byId.get('camp_ab')?.recipients === 6000, byId.get('camp_ab')?.recipients);
    check('flow recipients summed across flow messages',
      byId.get('flow_1')?.recipients === 7000, byId.get('flow_1')?.recipients);
    check('campaign outside the 1y report window has NULL recipients',
      byId.get('camp_old')?.recipients === null, byId.get('camp_old')?.recipients);
    check('campaignsWithoutStats reports the out-of-window send',
      result.campaignsWithoutStats === 1, result.campaignsWithoutStats);

    // --- campaign_stats table --------------------------------------------
    const stats = await query<any>(
      `SELECT campaign_id, opens, clicks, conversions, conversion_uniques, revenue
         FROM campaign_stats WHERE account_id = $1 ORDER BY campaign_id`,
      [accountId]);
    check('stats rows only for objects with report data', stats.rowCount === 3, stats.rows.map((r) => r.campaign_id));
    const sById = new Map(stats.rows.map((r) => [r.campaign_id, r]));
    check('unique opens stored for a single-message campaign', sById.get('camp_1')?.opens === 4800, sById.get('camp_1'));
    check('unique clicks stored', sById.get('camp_1')?.clicks === 960);
    check('conversions stored', sById.get('camp_1')?.conversions === 240);
    // The dashboard shows the UNIQUE figure, so both must persist and stay distinct.
    check('conversion_uniques persisted alongside total conversions',
      sById.get('camp_1')?.conversions === 240 && sById.get('camp_1')?.conversion_uniques === 210,
      sById.get('camp_1'));
    check('A/B conversion_uniques summed by campaign_id (55+50)',
      sById.get('camp_ab')?.conversion_uniques === 105, sById.get('camp_ab'));
    check('flow conversion_uniques summed by flow_id (120+42)',
      sById.get('flow_1')?.conversion_uniques === 162, sById.get('flow_1'));
    check('revenue stored to 2dp', Number(sById.get('camp_1')?.revenue) === 18450.75, sById.get('camp_1')?.revenue);
    check('A/B stats summed by campaign_id (opens 1200+1100)', sById.get('camp_ab')?.opens === 2300, sById.get('camp_ab'));
    check('A/B revenue summed (4200.25+3800.75)', Number(sById.get('camp_ab')?.revenue) === 8001, sById.get('camp_ab')?.revenue);
    check('flow stats summed by flow_id (opens 2500+900)', sById.get('flow_1')?.opens === 3400, sById.get('flow_1'));
    check('flow revenue summed (9000.50+3000.50)', Number(sById.get('flow_1')?.revenue) === 12001, sById.get('flow_1')?.revenue);
    check('no stats row for the out-of-window campaign', !sById.has('camp_old'));

    // --- no event-level storage ------------------------------------------
    const eventish = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('campaign_events','klaviyo_events','email_events','klaviyo_profiles')`);
    check('no event-level or profile table was created (V1 boundary)', Number(eventish.rows[0].n) === 0, eventish.rows[0]);

    // --- identity seam ----------------------------------------------------
    check('identity measurement ran when forced', result.identity !== null);
    check('3 usable profile emails scanned', result.identity?.profilesScanned === 3, result.identity);
    check('profile without an email counted separately', result.identity?.profilesWithoutEmail === 1, result.identity);
    check('email match is case-insensitive and trimmed (2 of 3 matched)',
      result.identity?.matched === 2 && result.identity?.unmatched === 1, result.identity);
    check('unmatched rate computed (~33%)',
      Math.abs((result.identity?.unmatchedRate ?? 0) - 1 / 3) < 0.001, result.identity?.unmatchedRate);
    check('>5% unmatched is flagged for UI surfacing', result.identity?.overThreshold === true);
    check('full scan is not marked partial', result.identity?.partial === false, result.identity);

    // --- account isolation ------------------------------------------------
    const otherRows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaigns WHERE account_id = $1`, [otherId]);
    check('neighbouring account untouched (isolation by account_id)',
      Number(otherRows.rows[0].n) === 1, otherRows.rows[0]);
    const otherStats = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaign_stats WHERE account_id = $1`, [otherId]);
    check('no stats leaked to the neighbouring account', Number(otherStats.rows[0].n) === 0);

    // --- once-daily identity gate ----------------------------------------
    const midday = await syncKlaviyo(accountId, { apiKey: FAKE_KEY }, 'klaviyo.poll', { hourUtc: 12 });
    check('identity scan SKIPPED on a midday tick (at most once daily)', midday.identity === null);
    const midnight = await syncKlaviyo(accountId, { apiKey: FAKE_KEY }, 'klaviyo.poll', { hourUtc: 0 });
    check('identity scan RUNS on the 00:00 UTC tick', midnight.identity !== null);

    // --- idempotency ------------------------------------------------------
    const campsAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaigns WHERE account_id = $1`, [accountId]);
    check('re-runs do not duplicate campaigns', Number(campsAfter.rows[0].n) === 4, campsAfter.rows[0]);
    const statsAfter = await query<any>(
      `SELECT opens, revenue FROM campaign_stats WHERE account_id = $1 AND campaign_id = 'camp_1'`, [accountId]);
    check('re-runs refresh stats in place, not duplicate',
      statsAfter.rowCount === 1 && statsAfter.rows[0].opens === 4800, statsAfter.rows);

    // --- partial identity scan flagging ----------------------------------
    const { measureKlaviyoIdentityMatch } = await import('../src/identity/graph.js');
    (globalThis as any).fetch = async () => fakeResponse({
      data: [{ id: 'p', attributes: { email: 'alice@example.com' } }],
      links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=MORE' },
    });
    const partial = await measureKlaviyoIdentityMatch(accountId, { apiKey: FAKE_KEY }, 1);
    check('budget-exhausted scan is flagged partial',
      partial.partial === true && partial.pagesFetched === 1, partial);

    // --- sync_errors ------------------------------------------------------
    installMockFetch();
    (globalThis as any).fetch = async () => fakeResponse({ errors: [{ detail: 'boom' }] }, { status: 500 });
    let failed = false;
    try {
      await syncKlaviyo(accountId, { apiKey: FAKE_KEY }, 'klaviyo.poll', { hourUtc: 12 });
    } catch { failed = true; }
    check('API failure rethrows', failed);
    const errs = await query<any>(
      `SELECT job_type, error FROM sync_errors WHERE account_id = $1`, [accountId]);
    check('failure recorded exactly once in sync_errors',
      errs.rowCount === 1 && errs.rows[0].job_type === 'klaviyo.poll', errs.rows);
    check('sync_errors row contains no private key',
      !String(errs.rows[0]?.error ?? '').includes(FAKE_KEY), errs.rows[0]?.error);
  } finally {
    await cleanupAccount(accountId);
    await cleanupAccount(otherId);
  }
}

async function main() {
  console.log('Phase 4 fixture verification — Klaviyo light poller (offline, no live API)');
  transformChecks();
  await clientChecks();
  await endToEndChecks();

  console.log(`\n${failures === 0 ? '✓ ALL FIXTURE CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nFATAL:', e);
  await pool.end();
  process.exit(1);
});
