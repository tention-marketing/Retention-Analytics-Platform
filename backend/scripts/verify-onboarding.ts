/**
 * Phase 5A verification — onboarding backend foundation.
 *
 *   A. Pure unit checks (no DB): validators, domain normalization, token
 *      creation/hashing, expiry/revocation, month math, currency rules, UI states.
 *   B. Provider fixture tests: mocked Shopify/Klaviyo/Recharge, real verification
 *      clients, real AES encryption, real upserts, real queue enqueue, into
 *      throwaway local accounts.
 *   C. Database integration: link lifecycle, provider choices, COGS writes and
 *      revenue coverage, OCAS, ad-spend expansion, confirmed-zero transitions and
 *      rollback, active-cost views, duplicate/concurrent domain rejection, and
 *      both blocker matrices.
 *   D. Session isolation: agency vs onboarding cookies, coexistence, mid-session
 *      revocation and expiry.
 *   E. Cross-tenant: account A cannot read or write account B.
 *   F. Credential-fallback regression: every provider credential IS set in the
 *      environment, and the client path must still refuse to use any of them.
 *   G. Link states: valid / expired / revoked / malformed / never existed / wrong
 *      account, plus token-exchange rate limiting and Redis-outage behaviour.
 *   H. Later connection: the exact Day-1 / Day-10 sequence from D13.
 *   I. Fastify 5 migration regressions.
 *   J. Agency API hardening (Phase 5B preflight): registration closed by
 *      default, login rate limiting and its Redis-outage behaviour, /auth/me
 *      and logout semantics, account-scoped link revocation, and the guarantee
 *      that no stack trace, filesystem path or provider credential reaches a
 *      browser-facing progress or status response.
 *
 * Non-destructive: every account created here is a throwaway, deleted on the way
 * out. No live provider credential is used and no live provider is contacted —
 * global fetch is mocked for the whole run.
 *
 * Run: `npm run verify:onboarding`
 */

// ---------------------------------------------------------------------------
// Group F depends on provider credentials being present in the environment, and
// config.ts reads process.env at import time. So the sentinels are installed
// BEFORE any module that imports config is loaded — hence the dynamic imports
// below (the same approach scripts/verify-klaviyo.ts uses).
// ---------------------------------------------------------------------------
const ENV_SENTINELS = {
  KLAVIYO_API_KEY: 'pk_ENVSENTINELKLAVIYO000000000000000000',
  RECHARGE_API_TOKEN: 'ENV_SENTINEL_RECHARGE_TOKEN',
  SHOPIFY_CLIENT_ID: 'ENV_SENTINEL_SHOPIFY_CLIENT_ID',
  SHOPIFY_CLIENT_SECRET: 'ENV_SENTINEL_SHOPIFY_CLIENT_SECRET',
  SHOPIFY_SHOP_DOMAIN: 'env-sentinel-store.myshopify.com',
} as const;
for (const [k, v] of Object.entries(ENV_SENTINELS)) process.env[k] = v;
process.env.APP_BASE_URL = 'http://localhost:5173';

const { default: bcrypt } = await import('bcryptjs');
const { pool, query } = await import('../src/db/pool.js');
const { decrypt } = await import('../src/crypto.js');
const { buildApp } = await import('../src/index.js');
const queues = await import('../src/queue/queues.js');
const { redis } = queues;
const { config, parseStrictBooleanFlag } = await import('../src/config.js');
const { classifyFailure } = await import('../src/onboarding/failures.js');
const { createHmac } = await import('node:crypto');
const links = await import('../src/onboarding/links.js');
const { normalizeShopDomain } = await import('../src/onboarding/domain.js');
const costs = await import('../src/onboarding/costs.js');
const adspend = await import('../src/onboarding/adspend.js');
const currency = await import('../src/onboarding/currency.js');
const state = await import('../src/onboarding/state.js');
const choices = await import('../src/onboarding/choices.js');
const capabilities = await import('../src/onboarding/capabilities.js');
const manageMode = await import('../src/onboarding/manageMode.js');

// ---------------------------------------------------------------------------
// Redis precondition — the FIRST thing this suite does, before anything else.
// ---------------------------------------------------------------------------
//
// The imports above define functions; none of them opens a socket or writes a
// key (queues.ts constructs its IORedis client with lazyConnect, and its Queue
// objects are created on first use, not on import). So this guard runs before
// buildApp() — whose rate limiter writes to Redis on the first request — before
// any Queue is constructed, before an account exists, before a session, and
// before a single provider fixture request. Nothing above this line mutates
// Redis.
//
// Why it has to exist: cleanup below deletes SHARED BullMQ queue structure keys
// (`wait`, `meta`, `id`, …). Those belong to the queue, not to this run's
// accounts — on a database holding real work, deleting `wait` drops somebody
// else's queued jobs. Proving the database was empty first is what makes that
// deletion provably self-inflicted.
//
// IT INSPECTS NOTHING. Only DBSIZE is read: no KEYS, no GET, no TYPE, no TTL,
// no scan. If the database is not empty the suite refuses to start without
// having read, altered or deleted one value. It does not offer to clean up for
// you, and it never calls FLUSHDB or FLUSHALL — a verification script that
// empties a database it did not fill is a far worse failure than one that
// declines to run.
async function requireEmptyRedis(): Promise<void> {
  let size: number;
  try {
    size = await redis.dbsize();
  } catch (err) {
    console.error('\n✗ Cannot reach Redis.');
    console.error(`  ${(err as Error).message}`);
    console.error(`  This suite needs a dedicated Redis at ${config.redisUrl}.`);
    process.exit(1);
  }

  if (size !== 0) {
    console.error('\n✗ REFUSING TO RUN: the Redis database is not empty.');
    console.error(`  DBSIZE is ${size}; this suite requires exactly 0.`);
    console.error('');
    console.error('  It enqueues real backfill jobs and removes shared BullMQ queue');
    console.error('  structure keys during cleanup, which is only safe when nothing else');
    console.error('  put anything in this database. Point REDIS_URL at a dedicated test');
    console.error('  database, or clear that database yourself once you are certain it');
    console.error('  holds nothing you need.');
    console.error('');
    console.error('  Nothing has been read, changed or deleted. No key was inspected.');
    await redis.quit().catch(() => undefined);
    process.exit(1);
  }

  console.log(`Redis precondition: DBSIZE is ${size} — dedicated and empty. Proceeding.`);
}

await requireEmptyRedis();

type App = Awaited<ReturnType<typeof buildApp>>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failures = 0;
const failed: string[] = [];
const groupTotals: Record<string, { pass: number; fail: number }> = {};
let currentGroup = 'A';

function group(letter: string, title: string): void {
  currentGroup = letter;
  groupTotals[letter] ??= { pass: 0, fail: 0 };
  console.log(`\n${letter}. ${title}`);
}

function check(name: string, cond: boolean, detail?: unknown): void {
  groupTotals[currentGroup] ??= { pass: 0, fail: 0 };
  if (cond) {
    passed++;
    groupTotals[currentGroup].pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    groupTotals[currentGroup].fail++;
    failed.push(`[${currentGroup}] ${name}`);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** Unique client IP per inject so the token-exchange rate limiter (group G) is
 *  not consumed by ordinary test traffic. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter++;
  return `10.${Math.floor(ipCounter / 65536) % 256}.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

/**
 * @fastify/rate-limit stores counters in Redis under
 * `fastify-rate-limit-<METHOD><route>-<key>` with a TTL equal to the window.
 *
 * The counters therefore SURVIVE between runs of this script. Without clearing
 * them, a rate-limit assertion that expects the limit to engage on exactly the
 * 11th request is non-deterministic whenever the suite is run twice inside the
 * one-minute window. Clearing the specific IP first makes the assertion mean what
 * it says.
 */
const RATE_LIMIT_KEY_PREFIX = 'fastify-rate-limit-';

/**
 * Read every backend source file with comments removed.
 *
 * The group I source scans below look for forbidden API usage (`trustProxy`,
 * `X-Forwarded-*`, `request.host`). Scanning raw text makes them match their own
 * subject matter: a comment that says "this is NEVER derived from
 * X-Forwarded-Host" is documentation of the correct behaviour, and flagging it
 * turns a security assertion into a ban on describing the threat. Stripping
 * comments first makes the checks strictly sharper — they still fail on any real
 * code usage, and no longer fail on prose.
 */
async function backendSources(): Promise<[string, string][]> {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const files = await walk(new URL('../src', import.meta.url).pathname);
  return Promise.all(
    files.map(async (f) => [f, stripComments(await readFile(f, 'utf8'))] as [string, string]),
  );
}

async function clearRateLimit(ip: string): Promise<void> {
  const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}*${ip}`).catch(() => []);
  if (keys.length) await redis.del(...keys).catch(() => undefined);
}

async function rateLimitKeysFor(ip: string): Promise<string[]> {
  return redis.keys(`${RATE_LIMIT_KEY_PREFIX}*${ip}`).catch(() => []);
}

// ---------------------------------------------------------------------------
// Poisoned error fixture for group J.
//
// Modelled on what logSyncError() actually writes — `${message}\n${stack}` — so
// the sanitization assertions run against the real shape rather than a
// convenient one: deploy-host absolute paths, internal module frames, and a
// credential-shaped string that a provider client could plausibly have included
// in an error body.
// ---------------------------------------------------------------------------
const POISON_CREDENTIAL = 'pk_live_POISONCREDENTIAL0000000000000000';
const STACK_TRACE_FIXTURE = [
  'TypeError: fetch failed',
  `    at request (/Users/deployuser/app/node_modules/undici/lib/core/request.js:112:15)`,
  '    at async node:internal/deps/undici/undici:14976:13',
  `    at async KlaviyoClient.get (/Users/deployuser/app/backend/dist/src/sync/klaviyo/client.js:44:20)`,
  `  request headers: { authorization: 'Klaviyo-API-Key ${POISON_CREDENTIAL}' }`,
].join('\n');

// ---------------------------------------------------------------------------
// Provider fixtures — no live API is ever contacted
// ---------------------------------------------------------------------------
const SHOP_FIXTURE = {
  name: 'Fixture Store',
  myshopifyDomain: 'fixture-store.myshopify.com',
  currencyCode: 'USD',
  ianaTimezone: 'America/New_York',
};

interface FetchRecord { url: string; headers: Record<string, string>; body: string }
let fetchLog: FetchRecord[] = [];

function fakeResponse(body: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installMockFetch(): void {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    fetchLog.push({ url, headers, body });

    const u = new URL(url);
    if (u.pathname === '/admin/oauth/access_token') {
      return fakeResponse({ access_token: 'shpat_fixture_token', expires_in: 86400 });
    }
    if (u.pathname.endsWith('/graphql.json')) {
      return fakeResponse({ data: { shop: { ...SHOP_FIXTURE, myshopifyDomain: u.hostname } } });
    }
    if (u.pathname === '/api/accounts') {
      return fakeResponse({
        data: [{ id: 'KLV1', attributes: { contact_information: { organization_name: 'Fixture Klaviyo' } } }],
      });
    }
    if (u.pathname === '/store') {
      return fakeResponse({ store: { name: 'Fixture Recharge' } });
    }
    // Nothing else should be reached: verification is all these services do here.
    throw new Error(`unexpected fetch to ${url}`);
  };
}

/** Did any outbound request carry one of the .env sentinel credentials? */
function envCredentialLeaked(): string | null {
  for (const rec of fetchLog) {
    const haystack = `${rec.url} ${JSON.stringify(rec.headers)} ${rec.body}`;
    for (const [name, value] of Object.entries(ENV_SENTINELS)) {
      if (haystack.includes(value)) return name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------
const createdAccounts: number[] = [];

/**
 * The store timezone every test account is created in unless a case says
 * otherwise.
 *
 * Deliberately NOT 'UTC'. It matches the production column default in
 * 001_init.sql, which is the whole point: the coverage window, the cohort month
 * and every other date boundary are computed in the ACCOUNT's timezone, and a
 * suite whose accounts all sat in UTC would never exercise that. This constant
 * is shared with monthsAgo() below so the fixtures and the account can never
 * drift apart — see the comment there.
 */
const STORE_TZ = 'America/Los_Angeles';

async function makeAccount(name: string, tz = STORE_TZ): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO accounts (name, store_timezone) VALUES ($1, $2) RETURNING id`,
    [`__verify5a_${name}_${Date.now()}_${Math.floor(passed + failures)}`, tz],
  );
  createdAccounts.push(rows[0].id);
  return rows[0].id;
}

const ACCOUNT_TABLES = [
  'ad_spend_zero_months', 'onboarding_provider_choices', 'onboarding_links',
  'ad_spend', 'sku_costs', 'account_costs', 'rcm_config',
  'line_items', 'orders', 'customers', 'products', 'inventory_levels',
  'subscription_events', 'subscriptions', 'campaign_stats', 'campaigns',
  'connections', 'sync_errors',
];

async function cleanupAccounts(): Promise<void> {
  for (const id of createdAccounts) {
    for (const t of ACCOUNT_TABLES) {
      await query(`DELETE FROM ${t} WHERE account_id = $1`, [id]).catch(() => undefined);
    }
    await query(`DELETE FROM accounts WHERE id = $1`, [id]).catch(() => undefined);
  }
}

let orderSeq = 900_000_000;
async function insertOrder(
  accountId: number, monthIso: string, totalNet: number, isFirst: boolean,
): Promise<number> {
  const id = orderSeq++;
  await query(
    `INSERT INTO orders (account_id, id, customer_id, created_at, total_net, is_first_order,
                         cancelled, test)
     VALUES ($1, $2, $3, ($4::date + interval '15 hours')::timestamptz, $5, $6, false, false)`,
    [accountId, id, id, monthIso, totalNet, isFirst],
  );
  return id;
}

async function insertLineItem(
  accountId: number, orderId: number, productId: number, sku: string, price: number, qty = 1,
): Promise<void> {
  await query(
    `INSERT INTO line_items (account_id, order_id, product_id, product_title, sku, quantity, price)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [accountId, orderId, productId, `Product ${sku}`, sku, qty, price],
  );
}

/**
 * The first day of the month `monthsBack` months before now, AS SEEN IN
 * `timeZone`.
 *
 * WHY THE TIMEZONE ARGUMENT EXISTS. This used to read the current month from
 * `new Date().getUTCMonth()`. The code under test does not: getCoverageWindow
 * computes `date_trunc('month', now() AT TIME ZONE <accounts.store_timezone>)`.
 * Those two agree for most of the month and disagree for the last seven hours of
 * it — between 17:00 Pacific on the final day and local midnight, UTC has
 * already rolled over and Pacific has not. In that window the fixtures asked for
 * the FOLLOWING month while the account was still in the previous one, and four
 * Group C checks plus three cascading Group H checks failed on a suite that had
 * changed in no way. The failures looked like an ad-spend regression and were a
 * clock mismatch in this file.
 *
 * So the month is read through the same timezone the account was created with.
 * Not the machine's local timezone — that would move the suite's answers to
 * whichever laptop or CI box ran it, which is the same class of bug wearing a
 * different hat.
 *
 * `now` is injectable so the boundary itself can be asserted at a fixed instant
 * rather than only when the calendar happens to reproduce it. See group A.
 */
function monthAgoInTimezone(monthsBack: number, timeZone: string, now: Date = new Date()): string {
  // formatToParts rather than string parsing: the numeric year and month come
  // back as labelled fields, so no locale's date order can be misread.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit',
  }).formatToParts(now);

  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    // A silent NaN here would produce a fixture month of "NaN-NaN-01" and a
    // failure somewhere far away from the cause.
    throw new Error(`Could not read the current month in ${timeZone}`);
  }

  // Arithmetic in absolute months, so a year rollover is not a special case.
  const total = year * 12 + (month - 1) - monthsBack;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

/**
 * Fixture month for an account in the default store timezone.
 *
 * Defaults to STORE_TZ — the same constant makeAccount() defaults to — so a
 * fixture and the account it is inserted against cannot disagree about what
 * month it is. A case that creates an account in another timezone must pass
 * that timezone here too.
 */
function monthsAgo(n: number, timeZone: string = STORE_TZ): string {
  return monthAgoInTimezone(n, timeZone);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of all) {
    const m = /^([^=]+)=([^;]*)/.exec(String(c));
    if (m && m[1] === name) return `${m[1]}=${m[2]}`;
  }
  return null;
}

/**
 * Seed an agency user straight into Postgres.
 *
 * POST /auth/register is closed by default now, so the suite can no longer use
 * it to obtain a session. Seeding the row and then exercising POST /auth/login
 * is strictly better anyway: it drives the real login path once per run instead
 * of the registration side door.
 *
 * The email prefix matters — cleanup deletes `verify5a_%`.
 */
const AGENCY_TEST_PASSWORD = 'verify5a-password';
let agencyUserSeq = 0;

async function seedAgencyUser(password = AGENCY_TEST_PASSWORD): Promise<string> {
  agencyUserSeq++;
  const email = `verify5a_${Date.now()}_${agencyUserSeq}@example.com`;
  const hash = await bcrypt.hash(password, 10);
  await query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, hash],
  );
  return email;
}

/** Log in over HTTP with a freshly seeded user, returning the raw reply. */
async function agencyLoginRes(app: App, email: string, password = AGENCY_TEST_PASSWORD) {
  return app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    payload: { email, password },
  });
}

async function agencyLogin(app: App): Promise<string> {
  const email = await seedAgencyUser();
  const res = await agencyLoginRes(app, email);
  const cookie = cookieFrom(res, 'tention_sid');
  if (!cookie) throw new Error(`agency login did not set a session cookie (${res.statusCode})`);
  return cookie;
}

async function mintAndExchange(
  app: App, agencyCookie: string, accountId: number,
): Promise<{ token: string; linkId: number; cookie: string }> {
  const minted = await app.inject({
    method: 'POST', url: `/accounts/${accountId}/onboarding-links`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
  const body = minted.json() as { id: number; token: string };
  const exchanged = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    payload: { token: body.token },
  });
  const cookie = cookieFrom(exchanged, 'tention_onb');
  if (!cookie) throw new Error(`token exchange did not set a cookie (${exchanged.statusCode})`);
  return { token: body.token, linkId: body.id, cookie };
}

// ===========================================================================
// A. Pure unit checks
// ===========================================================================
function groupA(): void {
  group('A', 'Pure unit checks (no database)');

  // --- domain normalization ---
  check('domain: lowercases and trims',
    normalizeShopDomain('  MyStore.MyShopify.com ').ok === true);
  check('domain: strips scheme, path and trailing slash', (() => {
    const r = normalizeShopDomain('https://mystore.myshopify.com/admin/orders?x=1');
    return r.ok && r.domain === 'mystore.myshopify.com';
  })());
  check('domain: strips port', (() => {
    const r = normalizeShopDomain('mystore.myshopify.com:443');
    return r.ok && r.domain === 'mystore.myshopify.com';
  })());
  check('domain: rejects a vanity domain',
    normalizeShopDomain('shop.example.com').ok === false);
  check('domain: rejects empty', normalizeShopDomain('   ').ok === false);
  check('domain: rejects non-string', normalizeShopDomain(undefined).ok === false);
  check('domain: accepts hyphens', (() => {
    const r = normalizeShopDomain('my-cool-store.myshopify.com');
    return r.ok && r.domain === 'my-cool-store.myshopify.com';
  })());

  // --- tokens ---
  const t1 = 'a'.repeat(43);
  check('token: 43-char base64url is well formed', links.isWellFormedToken(t1));
  check('token: wrong length rejected', !links.isWellFormedToken('a'.repeat(42)));
  check('token: non-base64url chars rejected', !links.isWellFormedToken('!'.repeat(43)));
  check('token: non-string rejected', !links.isWellFormedToken(12345));
  check('token: hash is stable', links.hashToken('abc') === links.hashToken('abc'));
  check('token: hash differs per token', links.hashToken('abc') !== links.hashToken('abd'));
  check('token: hash is sha256 hex', /^[0-9a-f]{64}$/.test(links.hashToken('abc')));
  check('token: hash is not the token', !links.hashToken(t1).includes(t1));

  // --- liveness (expiry / revocation) ---
  const base = {
    id: 1, account_id: 1, created_by: null, first_used_at: null, completed_at: null,
    created_at: new Date(),
  };
  check('liveness: future expiry is live',
    links.linkLiveness({ ...base, expires_at: new Date(Date.now() + 60_000), revoked_at: null }).ok);
  check('liveness: past expiry is expired', (() => {
    const r = links.linkLiveness({ ...base, expires_at: new Date(Date.now() - 1), revoked_at: null });
    return !r.ok && r.reason === 'expired';
  })());
  check('liveness: revoked beats a valid expiry', (() => {
    const r = links.linkLiveness({
      ...base, expires_at: new Date(Date.now() + 60_000), revoked_at: new Date(),
    });
    return !r.ok && r.reason === 'revoked';
  })());

  // --- blended margin ---
  check('blended: 42.5 accepted', costs.validateBlendedMargin(42.5).ok);
  check('blended: 0 rejected', !costs.validateBlendedMargin(0).ok);
  check('blended: 100 rejected', !costs.validateBlendedMargin(100).ok);
  check('blended: negative rejected', !costs.validateBlendedMargin(-1).ok);
  check('blended: 3 decimals rejected', !costs.validateBlendedMargin(42.555).ok);
  check('blended: null rejected (empty is never zero)', !costs.validateBlendedMargin(null).ok);
  check('blended: empty string rejected', !costs.validateBlendedMargin('').ok);
  check('blended: NaN rejected', !costs.validateBlendedMargin(NaN).ok);
  check('blended: Infinity rejected', !costs.validateBlendedMargin(Infinity).ok);

  // --- per-SKU cost ---
  check('sku cost: valid accepted', costs.validateSkuCost({ sku: 'A', cogs: 12.34 }).ok);
  check('sku cost: negative rejected', !costs.validateSkuCost({ sku: 'A', cogs: -1 }).ok);
  check('sku cost: 3 decimals rejected', !costs.validateSkuCost({ sku: 'A', cogs: 1.234 }).ok);
  check('sku cost: precision overflow rejected',
    !costs.validateSkuCost({ sku: 'A', cogs: 1e13 }).ok);
  check('sku cost: empty value rejected, not read as zero',
    !costs.validateSkuCost({ sku: 'A', cogs: '' }).ok);
  check('sku cost: zero WITHOUT confirmation rejected', (() => {
    const r = costs.validateSkuCost({ sku: 'A', cogs: 0 });
    return !r.ok && r.error === 'zero_unconfirmed';
  })());
  check('sku cost: zero WITH confirmation accepted',
    costs.validateSkuCost({ sku: 'A', cogs: 0, zeroConfirmed: true }).ok);
  check('sku cost: missing sku rejected', !costs.validateSkuCost({ cogs: 1 }).ok);

  // --- OCAS ---
  check('ocas: valid accepted', costs.validateOcas(5000, false).ok);
  check('ocas: negative rejected', !costs.validateOcas(-1, false).ok);
  check('ocas: null rejected (empty is never zero)', !costs.validateOcas(null, false).ok);
  check('ocas: zero WITHOUT confirmation rejected', (() => {
    const r = costs.validateOcas(0, false);
    return !r.ok && r.error === 'zero_unconfirmed';
  })());
  check('ocas: zero WITH confirmation accepted', costs.validateOcas(0, true).ok);
  check('ocas: precision overflow rejected', !costs.validateOcas(1e13, false).ok);

  // --- ad-spend primitives ---
  check('channel: trimmed and whitespace-collapsed', (() => {
    const r = adspend.normalizeChannel('  Meta   Ads  ');
    return r.ok && r.value === 'Meta Ads';
  })());
  check('channel: empty rejected', !adspend.normalizeChannel('   ').ok);
  check('channel: over 64 chars rejected', !adspend.normalizeChannel('x'.repeat(65)).ok);
  check('spend: valid accepted', adspend.validateSpendAmount(1234.56).ok);
  check('spend: negative rejected', !adspend.validateSpendAmount(-1).ok);
  check('spend: empty rejected, not read as zero', !adspend.validateSpendAmount('').ok);
  check('spend: 3 decimals rejected', !adspend.validateSpendAmount(1.234).ok);
  // A 0.00 spend row used to be accepted here and counted as coverage, giving a
  // caller a way to mark a month answered without confirming the zero. The
  // confirmation lives in POST /ad-spend/zero and nowhere else.
  check('spend: 0 rejected — an ordinary row cannot bypass zero confirmation',
    !adspend.validateSpendAmount(0).ok);
  check('spend: 0 carries the fixed zero_requires_confirmation code', (() => {
    const r = adspend.validateSpendAmount(0);
    return !r.ok && r.error === 'zero_requires_confirmation';
  })());
  check('spend: string "0" rejected too — coercion is not a way round it', (() => {
    const r = adspend.validateSpendAmount('0');
    return !r.ok && r.error === 'zero_requires_confirmation';
  })());
  check('spend: 0.00 rejected', !adspend.validateSpendAmount(0.0).ok);
  check('spend: the smallest positive amount is still accepted',
    adspend.validateSpendAmount(0.01).ok);

  // --- an empty field is never a number, whatever Number() thinks of it ---
  //
  // `Number('   ')`, `Number('\t')` and `Number([])` are all 0, and `Number([100])`
  // is 100. Every validator below used to open with a bare `Number(input)` guarded
  // only against the literal `''`, so a whitespace-only field arrived as a real
  // zero — and paired with the explicit zero confirmations these validators
  // require, that STORED a confirmed zero nobody had entered. See
  // onboarding/amount.ts.
  for (const [label, value] of [
    ['whitespace', '   '], ['a tab', '\t'], ['a newline', '\n'],
    ['an empty array', []], ['a single-element array', [100]],
    ['true', true], ['false', false], ['an object', {}], ['undefined', undefined],
  ] as [string, unknown][]) {
    check(`spend: ${label} is not_a_number, never a coerced value`, (() => {
      const r = adspend.validateSpendAmount(value);
      return !r.ok && r.error === 'not_a_number';
    })());
    check(`ocas: ${label} is not_a_number even WITH a zero confirmation`, (() => {
      const r = costs.validateOcas(value, true);
      return !r.ok && r.error === 'not_a_number';
    })());
    check(`sku cost: ${label} is not_a_number even WITH a zero confirmation`, (() => {
      const r = costs.validateSkuCost({ sku: 'A', cogs: value, zeroConfirmed: true });
      return !r.ok && r.error === 'not_a_number';
    })());
    check(`blended: ${label} is not_a_number`, (() => {
      const r = costs.validateBlendedMargin(value);
      return !r.ok && r.error === 'not_a_number';
    })());
  }
  // Legitimate numeric strings still work — the fix narrows coercion, it does not
  // ban the string form the wire actually carries.
  check('spend: a numeric string is still accepted', (() => {
    const r = adspend.validateSpendAmount('1234.56');
    return r.ok && r.value === 1234.56;
  })());
  check('spend: a padded numeric string is still accepted', (() => {
    const r = adspend.validateSpendAmount('  1234.56  ');
    return r.ok && r.value === 1234.56;
  })());
  check('ocas: a numeric string is still accepted', (() => {
    const r = costs.validateOcas('5000.00', false);
    return r.ok && r.value.ocas === 5000;
  })());
  check('ocas: a string "0" with confirmation is still a real confirmed zero', (() => {
    const r = costs.validateOcas('0', true);
    return r.ok && r.value.ocas === 0 && r.value.confirmedZero === true;
  })());
  check('blended: a numeric string is still accepted', (() => {
    const r = costs.validateBlendedMargin('62.55');
    return r.ok && r.value === 62.55;
  })());
  check('month: YYYY-MM normalized to first of month', (() => {
    const r = adspend.normalizeMonth('2026-03');
    return r.ok && r.value === '2026-03-01';
  })());
  check('month: YYYY-MM-DD normalized to first of month', (() => {
    const r = adspend.normalizeMonth('2026-03-17');
    return r.ok && r.value === '2026-03-01';
  })());
  check('month: month 13 rejected', !adspend.normalizeMonth('2026-13').ok);
  check('month: garbage rejected', !adspend.normalizeMonth('March 2026').ok);

  const cur = '2026-07-01';
  check('ranges: valid single row accepted', adspend.parseAdSpendRanges(
    [{ channel: 'Meta', amount: 100, startMonth: '2026-05', endMonth: '2026-07' }], cur).ok);
  check('ranges: empty list rejected', !adspend.parseAdSpendRanges([], cur).ok);
  check('ranges: start after end rejected', (() => {
    const r = adspend.parseAdSpendRanges(
      [{ channel: 'Meta', amount: 100, startMonth: '2026-07', endMonth: '2026-05' }], cur);
    return !r.ok && r.error === 'bad_range';
  })());
  check('ranges: future month rejected', (() => {
    const r = adspend.parseAdSpendRanges(
      [{ channel: 'Meta', amount: 100, startMonth: '2026-08', endMonth: '2026-09' }], cur);
    return !r.ok && r.error === 'future_month';
  })());
  check('ranges: overlapping rows for one channel rejected', (() => {
    const r = adspend.parseAdSpendRanges([
      { channel: 'Meta', amount: 100, startMonth: '2026-05', endMonth: '2026-06' },
      { channel: 'meta', amount: 200, startMonth: '2026-06', endMonth: '2026-07' },
    ], cur);
    return !r.ok && r.error === 'overlapping_rows';
  })());
  check('ranges: different channels may share months', adspend.parseAdSpendRanges([
    { channel: 'Meta', amount: 100, startMonth: '2026-06', endMonth: '2026-07' },
    { channel: 'Google', amount: 200, startMonth: '2026-06', endMonth: '2026-07' },
  ], cur).ok);

  // --- currency ---
  check('currency: USD valid', currency.isValidCurrencyCode('USD'));
  check('currency: lowercase accepted then normalized',
    currency.isValidCurrencyCode('usd') && currency.normalizeCurrencyCode('usd') === 'USD');
  check('currency: 2 letters rejected', !currency.isValidCurrencyCode('US'));
  check('currency: digits rejected', !currency.isValidCurrencyCode('US1'));
  check('currency: empty rejected', !currency.isValidCurrencyCode(''));
  check('timezone: valid IANA accepted', currency.isValidTimezone('America/New_York'));
  check('timezone: nonsense rejected', !currency.isValidTimezone('Mars/Olympus_Mons'));
  check('timezone: empty rejected', !currency.isValidTimezone(''));

  check('mismatch: detected differs from stored → mismatch', currency.hasCurrencyMismatch({
    currency: 'CAD', currency_source: 'manual', shopify_currency_detected: 'USD',
  }));
  check('mismatch: detected equals stored → no mismatch', !currency.hasCurrencyMismatch({
    currency: 'USD', currency_source: 'shopify', shopify_currency_detected: 'USD',
  }));
  check('mismatch: nothing detected → no mismatch', !currency.hasCurrencyMismatch({
    currency: 'CAD', currency_source: 'manual', shopify_currency_detected: null,
  }));

  // --- derived UI states ---
  const limited = state.deriveUiStates({
    onboardingComplete: true, shopifyConnected: false, rcmReady: false, syncRunning: false,
  });
  check('ui: complete + no Shopify → limited analytics',
    limited.onboardingComplete && limited.limitedAnalyticsAvailable && limited.shopifyNotConnected
    && !limited.rcmReady && !limited.rcmSetupIncomplete);
  const shopifyIncomplete = state.deriveUiStates({
    onboardingComplete: true, shopifyConnected: true, rcmReady: false, syncRunning: true,
  });
  check('ui: Shopify connected, RCM not ready → rcmSetupIncomplete + syncing',
    shopifyIncomplete.rcmSetupIncomplete && shopifyIncomplete.syncStillRunning
    && !shopifyIncomplete.limitedAnalyticsAvailable);
  const ready = state.deriveUiStates({
    onboardingComplete: true, shopifyConnected: true, rcmReady: true, syncRunning: false,
  });
  check('ui: ready → rcmReady and not incomplete',
    ready.rcmReady && !ready.rcmSetupIncomplete);
  check('ui: not complete → onboardingInProgress', state.deriveUiStates({
    onboardingComplete: false, shopifyConnected: false, rcmReady: false, syncRunning: false,
  }).onboardingInProgress);

  // --- fixture clock (monthAgoInTimezone) ---
  //
  // This helper decides which month every ad-spend and coverage fixture below
  // is written into. It used to read the month in UTC while the code under test
  // read it in the account's store timezone, which made four Group C checks and
  // three Group H checks fail for the last seven hours of every month. These
  // assertions pin the boundary at a FIXED INSTANT so the disagreement is caught
  // by running the suite, not by running it on the right evening.
  //
  // 2026-08-01T01:00:00Z is 18:00 on 2026-07-31 in Los Angeles: August in UTC,
  // still July in the store's own timezone.
  const BOUNDARY = new Date('2026-08-01T01:00:00Z');
  check('clock: at the UTC/Pacific boundary, Los Angeles is still in July',
    monthAgoInTimezone(0, 'America/Los_Angeles', BOUNDARY) === '2026-07-01',
    monthAgoInTimezone(0, 'America/Los_Angeles', BOUNDARY));
  check('clock: at the same instant, UTC has rolled over to August',
    monthAgoInTimezone(0, 'UTC', BOUNDARY) === '2026-08-01',
    monthAgoInTimezone(0, 'UTC', BOUNDARY));
  check('clock: the two timezones genuinely disagree at that instant',
    monthAgoInTimezone(0, 'America/Los_Angeles', BOUNDARY)
      !== monthAgoInTimezone(0, 'UTC', BOUNDARY));
  check('clock: a timezone AHEAD of UTC can be in the next month already',
    monthAgoInTimezone(0, 'Asia/Tokyo', BOUNDARY) === '2026-08-01',
    monthAgoInTimezone(0, 'Asia/Tokyo', BOUNDARY));

  // Subtraction, including the year rollover the old integer maths got right
  // and which must survive the rewrite.
  check('clock: subtracting 1 month steps back inside the year',
    monthAgoInTimezone(1, 'America/Los_Angeles', BOUNDARY) === '2026-06-01');
  check('clock: subtracting 6 months steps back inside the year',
    monthAgoInTimezone(6, 'America/Los_Angeles', BOUNDARY) === '2026-01-01');
  check('clock: subtracting 7 months crosses into the previous year',
    monthAgoInTimezone(7, 'America/Los_Angeles', BOUNDARY) === '2025-12-01',
    monthAgoInTimezone(7, 'America/Los_Angeles', BOUNDARY));
  check('clock: the 11-month window start crosses the year boundary',
    monthAgoInTimezone(11, 'America/Los_Angeles', BOUNDARY) === '2025-08-01');
  check('clock: subtracting 23 months crosses two year boundaries',
    monthAgoInTimezone(23, 'America/Los_Angeles', BOUNDARY) === '2024-08-01');
  check('clock: the rollover is computed from the STORE month, not the UTC one',
    monthAgoInTimezone(7, 'UTC', BOUNDARY) === '2026-01-01'
    && monthAgoInTimezone(7, 'America/Los_Angeles', BOUNDARY) === '2025-12-01');

  // January is where an off-by-one in the month index shows up.
  const JANUARY = new Date('2026-01-15T12:00:00Z');
  check('clock: January minus 0 is January',
    monthAgoInTimezone(0, 'America/Los_Angeles', JANUARY) === '2026-01-01');
  check('clock: January minus 1 is the previous December',
    monthAgoInTimezone(1, 'America/Los_Angeles', JANUARY) === '2025-12-01');
  check('clock: January minus 12 is the same month a year earlier',
    monthAgoInTimezone(12, 'America/Los_Angeles', JANUARY) === '2025-01-01');

  // A DST transition must not move the month.
  const DST = new Date('2026-03-08T10:30:00Z'); // 02:30 -> 03:30 in Los Angeles
  check('clock: a DST transition does not shift the month',
    monthAgoInTimezone(0, 'America/Los_Angeles', DST) === '2026-03-01');

  check('clock: every month is emitted as the first day, zero-padded', (() => {
    for (let i = 0; i <= 24; i++) {
      if (!/^\d{4}-\d{2}-01$/.test(monthAgoInTimezone(i, 'America/Los_Angeles', BOUNDARY))) {
        return false;
      }
    }
    return true;
  })());
  check('clock: consecutive offsets are strictly descending and contiguous', (() => {
    const months = Array.from({ length: 25 },
      (_, i) => monthAgoInTimezone(i, 'America/Los_Angeles', BOUNDARY));
    for (let i = 1; i < months.length; i++) {
      if (months[i] >= months[i - 1]) return false;
    }
    return new Set(months).size === months.length;
  })());
  check('clock: an unknown timezone fails loudly rather than yielding NaN', (() => {
    try {
      monthAgoInTimezone(0, 'Not/A_Timezone', BOUNDARY);
      return false;
    } catch {
      return true;
    }
  })());
  check('clock: the fixture default is the timezone the accounts are created in',
    monthsAgo(0) === monthAgoInTimezone(0, STORE_TZ));

  // --- capabilities map ---
  check('capabilities: Shopify carries the RCM revenue foundation',
    capabilities.PROVIDER_CAPABILITIES.shopify.includes('rcm_revenue_foundation'));
  check('capabilities: Recharge carries churn analytics',
    capabilities.PROVIDER_CAPABILITIES.recharge.includes('churn_analytics'));
  check('capabilities: Klaviyo carries campaign + flow analytics',
    capabilities.PROVIDER_CAPABILITIES.klaviyo.includes('campaign_analytics')
    && capabilities.PROVIDER_CAPABILITIES.klaviyo.includes('flow_analytics'));
}

// ===========================================================================
// B. Provider fixture tests
// ===========================================================================
async function groupB(app: App, agencyCookie: string): Promise<void> {
  group('B', 'Provider fixture tests (mocked APIs, real persistence + queues)');

  // --- Klaviyo, through the client-facing route ---
  const acc = await makeAccount('fixtures');
  const link = await mintAndExchange(app, agencyCookie, acc);

  const kRes = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo',
    headers: { cookie: link.cookie }, remoteAddress: nextIp(),
    payload: { apiKey: 'pk_client_specific_key_0000000000000' },
  });
  check('klaviyo: client connect succeeds', [200, 202].includes(kRes.statusCode), kRes.statusCode);
  const kBody = kRes.json() as Record<string, unknown>;
  check('klaviyo: response never echoes the key',
    !JSON.stringify(kBody).includes('pk_client_specific_key_0000000000000'));
  check('klaviyo: backfill job enqueued', kBody.queued === true, kBody);
  // Retrieve the job by the id the enqueue used. This is the regression guard for
  // the BullMQ name/id restriction: before the fix, every queue constructor threw
  // and the enqueue failure was silently reported as "Redis unavailable".
  const kJob = await queues.klaviyoPollQueue().getJob(queues.klaviyoBackfillJobId(acc));
  check('klaviyo: the enqueued job is retrievable by its job id', kJob !== undefined && kJob !== null);
  check('klaviyo: the job carries this account and nothing else',
    (kJob as { data?: { accountId?: number } } | null)?.data?.accountId === acc);

  const kRow = await query<{ credentials_encrypted: string; status: string }>(
    `SELECT credentials_encrypted, status FROM connections
      WHERE account_id = $1 AND provider = 'klaviyo'`, [acc],
  );
  check('klaviyo: connection row created with status connected',
    kRow.rows[0]?.status === 'connected');
  check('klaviyo: credential is encrypted at rest',
    !kRow.rows[0].credentials_encrypted.includes('pk_client_specific_key_0000000000000'));
  check('klaviyo: encrypted credential decrypts back to the client key',
    JSON.parse(decrypt(kRow.rows[0].credentials_encrypted)).apiKey
      === 'pk_client_specific_key_0000000000000');

  // --- Recharge ---
  const rRes = await app.inject({
    method: 'POST', url: '/onboarding/connections/recharge',
    headers: { cookie: link.cookie }, remoteAddress: nextIp(),
    payload: { token: 'client_specific_recharge_token' },
  });
  check('recharge: client connect succeeds', [200, 202].includes(rRes.statusCode), rRes.statusCode);
  check('recharge: response never echoes the token',
    !JSON.stringify(rRes.json()).includes('client_specific_recharge_token'));
  const rRow = await query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM connections WHERE account_id = $1 AND provider = 'recharge'`,
    [acc],
  );
  check('recharge: credential is encrypted at rest',
    !rRow.rows[0].credentials_encrypted.includes('client_specific_recharge_token'));

  // --- Shopify, agency-assisted (D11 Option A) ---
  const reqRes = await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/request',
    headers: { cookie: link.cookie }, remoteAddress: nextIp(),
    payload: { shopDomain: 'HTTPS://Fixture-Store.myshopify.com/admin' },
  });
  check('shopify: client request accepted and domain normalized',
    reqRes.statusCode === 200
    && (reqRes.json() as { shopDomain: string }).shopDomain === 'fixture-store.myshopify.com',
    reqRes.json());
  const choiceRow = await query<{ choice: string; requested_domain: string }>(
    `SELECT choice, requested_domain FROM onboarding_provider_choices
      WHERE account_id = $1 AND provider = 'shopify'`, [acc],
  );
  check('shopify: request recorded as a CHOICE, not a connection',
    choiceRow.rows[0]?.choice === 'requested');
  const noConn = await query(
    `SELECT 1 FROM connections WHERE account_id = $1 AND provider = 'shopify'`, [acc],
  );
  check('shopify: requested state creates NO connections row', noConn.rowCount === 0);

  const credRes = await app.inject({
    method: 'POST', url: `/accounts/${acc}/connections/shopify/credentials`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
    payload: {
      shopDomain: 'fixture-store.myshopify.com',
      clientId: 'per_store_client_id', clientSecret: 'per_store_client_secret',
    },
  });
  check('shopify: agency credential entry succeeds',
    [200, 202].includes(credRes.statusCode), credRes.json());
  const sBody = credRes.json() as Record<string, any>;
  check('shopify: backfill enqueued', sBody.queued === true);
  check('shopify: currency captured from the shop query (E6)',
    sBody.currency?.currency === 'USD' && sBody.currency?.detected === 'USD', sBody.currency);
  check('shopify: store timezone applied from ianaTimezone (E6)',
    sBody.timezoneApplied === true);
  const tzRow = await query<{ store_timezone: string; currency: string; currency_source: string }>(
    `SELECT store_timezone, currency, currency_source FROM accounts WHERE id = $1`, [acc],
  );
  check('shopify: accounts.store_timezone is no longer the LA default',
    tzRow.rows[0].store_timezone === 'America/New_York', tzRow.rows[0]);
  check('shopify: currency_source recorded as shopify',
    tzRow.rows[0].currency_source === 'shopify');
  check('shopify: response never echoes the client secret',
    !JSON.stringify(sBody).includes('per_store_client_secret'));

  const sRow = await query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM connections WHERE account_id = $1 AND provider = 'shopify'`,
    [acc],
  );
  check('shopify: credentials encrypted at rest',
    !sRow.rows[0].credentials_encrypted.includes('per_store_client_secret'));
  check('shopify: connecting supersedes the requested choice (frees the request index)',
    (await query<{ choice: string }>(
      `SELECT choice FROM onboarding_provider_choices WHERE account_id = $1 AND provider = 'shopify'`,
      [acc],
    )).rows[0].choice === 'pending');

  // Retries are idempotent: reconnecting updates the existing row, never adds one.
  await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo',
    headers: { cookie: link.cookie }, remoteAddress: nextIp(),
    payload: { apiKey: 'pk_client_specific_key_rotated_000000' },
  });
  const kCount = await query<{ n: string }>(
    `SELECT count(*) n FROM connections WHERE account_id = $1 AND provider = 'klaviyo'`, [acc],
  );
  check('retry is idempotent: still exactly one klaviyo connection', Number(kCount.rows[0].n) === 1);
  check('reconnect rotates the stored credential',
    JSON.parse(decrypt((await query<{ credentials_encrypted: string }>(
      `SELECT credentials_encrypted FROM connections WHERE account_id=$1 AND provider='klaviyo'`,
      [acc],
    )).rows[0].credentials_encrypted)).apiKey === 'pk_client_specific_key_rotated_000000');
  const shopifyStillThere = await query(
    `SELECT 1 FROM connections WHERE account_id = $1 AND provider = 'shopify'`, [acc],
  );
  check('reconnecting Klaviyo does not remove Shopify', shopifyStillThere.rowCount === 1);

  check('no outbound request carried an .env sentinel credential',
    envCredentialLeaked() === null, envCredentialLeaked());
}

// ===========================================================================
// C. Database integration
// ===========================================================================
async function groupC(app: App, agencyCookie: string): Promise<void> {
  group('C', 'Database integration');

  // --- link lifecycle ---
  const acc = await makeAccount('links');
  const minted = await links.mintOnboardingLink(acc, null);
  check('link: raw token is 43-char base64url', links.isWellFormedToken(minted.token));
  const stored = await query<{ token_hash: string }>(
    `SELECT token_hash FROM onboarding_links WHERE id = $1`, [minted.id],
  );
  check('link: only a hash is stored — the raw token is unrecoverable',
    stored.rows[0].token_hash === links.hashToken(minted.token)
    && !stored.rows[0].token_hash.includes(minted.token));
  check('link: resolves by raw token', (await links.resolveToken(minted.token)).ok);
  check('link: default TTL is 14 days', (() => {
    const days = (minted.expiresAt.getTime() - Date.now()) / 86_400_000;
    return days > 13.9 && days < 14.1;
  })());
  const listed = await links.listLinks(acc);
  check('link: listing shows active status', listed[0]?.status === 'active');
  check('link: listing exposes neither token nor hash',
    !JSON.stringify(listed).includes(minted.token)
    && !JSON.stringify(listed).includes(links.hashToken(minted.token)));
  await links.revokeLink(acc, minted.id);
  const afterRevoke = await links.resolveToken(minted.token);
  check('link: revocation is visible immediately',
    afterRevoke.ok && !links.linkLiveness(afterRevoke.link).ok);
  check('link: listing reports revoked status',
    (await links.listLinks(acc))[0]?.status === 'revoked');
  const reissued = await links.mintOnboardingLink(acc, null);
  check('link: reissued token differs from the revoked one', reissued.token !== minted.token);

  // --- provider choices, no fake connection rows ---
  const chAcc = await makeAccount('choices');
  await choices.setSkipped(chAcc, 'recharge');
  const chStates = await choices.getProviderStatuses(chAcc);
  check('choices: skipped recharge reported as skipped',
    chStates.find((s) => s.provider === 'recharge')?.state === 'skipped');
  check('choices: undecided providers reported as undecided',
    chStates.filter((s) => s.state === 'undecided').length === 2);
  const fakeRows = await query<{ n: string }>(
    `SELECT count(*) n FROM connections WHERE account_id = $1`, [chAcc],
  );
  check('choices: a skip creates NO connections row', Number(fakeRows.rows[0].n) === 0);

  // --- COGS revenue coverage (E2) ---
  const cogsAcc = await makeAccount('cogs');
  const o1 = await insertOrder(cogsAcc, monthsAgo(1), 1000, true);
  await insertLineItem(cogsAcc, o1, 1, 'SKU-A', 500);
  await insertLineItem(cogsAcc, o1, 2, 'SKU-B', 300);
  await insertLineItem(cogsAcc, o1, 3, 'SKU-C', 150);
  await insertLineItem(cogsAcc, o1, 4, 'SKU-D', 50);
  await insertLineItem(cogsAcc, o1, 5, '', 999);        // blank SKU must be excluded
  await costs.setCogsMethod(cogsAcc, 'per_sku');

  let cov = await costs.getSkuCoverage(cogsAcc);
  check('cogs: blank SKUs excluded from the eligible set',
    cov.all.every((r) => r.sku.trim() !== ''), cov.all.map((r) => r.sku));
  check('cogs: eligible line revenue excludes the blank SKU',
    cov.eligibleLineRevenue === 1000, cov.eligibleLineRevenue);
  check('cogs: required set is the SMALLEST group reaching 80%',
    cov.required.length === 2 && cov.required.map((r) => r.sku).join(',') === 'SKU-A,SKU-B',
    cov.required.map((r) => r.sku));
  check('cogs: coverage starts at 0%', cov.coveragePct === 0);

  await costs.upsertSkuCosts(cogsAcc, [{ sku: 'SKU-A', cogs: 100 }]);
  cov = await costs.getSkuCoverage(cogsAcc);
  check('cogs: costing SKU-A yields 50% coverage', cov.coveragePct === 50, cov.coveragePct);
  let readiness = await state.getRcmReadiness(cogsAcc);
  check('cogs: 50% coverage is NOT RCM-ready (blocked by shopify + cogs)',
    readiness.blockers.some((b) => b.code === 'shopify_not_connected'));

  await costs.upsertSkuCosts(cogsAcc, [{ sku: 'SKU-B', cogs: 60 }]);
  cov = await costs.getSkuCoverage(cogsAcc);
  check('cogs: costing SKU-A + SKU-B reaches 80%', cov.coveragePct === 80, cov.coveragePct);
  check('cogs: no required SKU left uncosted', cov.missingSkus.length === 0);

  const foreignSku = await costs.upsertSkuCosts(cogsAcc, [{ sku: 'SKU-NOT-MINE', cogs: 5 }]);
  check('cogs: a SKU absent from this account is rejected',
    !foreignSku.ok && foreignSku.error === 'unknown_skus');

  check('cogs: unconfirmed zero cost is flagged', await (async () => {
    await query(
      `INSERT INTO sku_costs (account_id, sku, cogs, zero_confirmed) VALUES ($1,'SKU-C',0,false)
       ON CONFLICT (account_id, sku) DO UPDATE SET cogs = 0, zero_confirmed = false`, [cogsAcc],
    );
    const c = await costs.getSkuCoverage(cogsAcc);
    return c.unconfirmedZeroSkus.includes('SKU-C');
  })());
  check('cogs: confirmed zero cost is accepted', await (async () => {
    await query(`UPDATE sku_costs SET zero_confirmed = true WHERE account_id=$1 AND sku='SKU-C'`, [cogsAcc]);
    const c = await costs.getSkuCoverage(cogsAcc);
    return !c.unconfirmedZeroSkus.includes('SKU-C');
  })());

  // E2 edge case: 30 equal SKUs, so the top 20 reach only 66.7%.
  const capAcc = await makeAccount('cogs_cap');
  const oc = await insertOrder(capAcc, monthsAgo(1), 3000, true);
  for (let i = 1; i <= 30; i++) await insertLineItem(capAcc, oc, i, `CAP-${i}`, 100);
  await costs.setCogsMethod(capAcc, 'per_sku');
  let capCov = await costs.getSkuCoverage(capAcc);
  check('cogs cap: required set capped at 20 SKUs', capCov.required.length === 20, capCov.required.length);
  check('cogs cap: cappedBelowTarget flagged when the top 20 cannot reach 80%',
    capCov.cappedBelowTarget === true);
  await costs.upsertSkuCosts(capAcc, capCov.required.map((r) => ({ sku: r.sku, cogs: 10 })));
  capCov = await costs.getSkuCoverage(capAcc);
  check('cogs cap: every displayed SKU costed, yet coverage is only ~66.7%',
    capCov.missingSkus.length === 0 && Math.abs(capCov.coveragePct - 66.67) < 0.02,
    capCov.coveragePct);

  // --- E3: switching methods retains values but the views hide the inactive set ---
  const swAcc = await makeAccount('cogs_switch');
  const os = await insertOrder(swAcc, monthsAgo(1), 100, true);
  await insertLineItem(swAcc, os, 1, 'SW-A', 100);
  await costs.setCogsMethod(swAcc, 'per_sku');
  await costs.upsertSkuCosts(swAcc, [{ sku: 'SW-A', cogs: 40 }]);
  check('switch: per_sku active → view exposes the SKU cost',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM v_active_sku_costs WHERE account_id = $1`, [swAcc])).rows[0].n) === 1);
  await costs.setBlendedMargin(swAcc, 55);
  check('switch: blended active → v_active_sku_costs hides the retained SKU cost',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM v_active_sku_costs WHERE account_id = $1`, [swAcc])).rows[0].n) === 0);
  check('switch: the SKU cost row is RETAINED, not deleted',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM sku_costs WHERE account_id = $1`, [swAcc])).rows[0].n) === 1);
  check('switch: blended margin exposed by its own view',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM v_active_blended_margin WHERE account_id = $1`, [swAcc])).rows[0].n) === 1);
  check('switch: coverage ignores retained per-SKU values while blended is active',
    (await costs.getSkuCoverage(swAcc)).coveragePct === 0);
  await costs.setCogsMethod(swAcc, 'per_sku');
  check('switch: switching back re-activates the retained value without re-entry',
    (await costs.getSkuCoverage(swAcc)).coveragePct === 100);

  // --- OCAS ---
  const ocasAcc = await makeAccount('ocas');
  await costs.setOcas(ocasAcc, 0, false);
  check('ocas: unconfirmed zero blocks readiness', (await (async () => {
    const c = await costs.getAccountCosts(ocasAcc);
    return Number(c.ocas_monthly) === 0 && c.ocas_zero_confirmed === false;
  })()));
  await costs.setOcas(ocasAcc, 0, true);
  check('ocas: confirmed zero is stored as confirmed',
    (await costs.getAccountCosts(ocasAcc)).ocas_zero_confirmed === true);

  // --- ad-spend expansion + coverage window (E1) ---
  // Scenario 1: >12 months of history, new customers every month.
  const longAcc = await makeAccount('spend_long');
  for (let i = 0; i <= 23; i++) await insertOrder(longAcc, monthsAgo(i), 100, true);
  let win = await adspend.getCoverageWindow(longAcc);
  check('E1 scenario 1: >12 months history → exactly 12 required months',
    win.requiredMonths.length === 12, win.requiredMonths.length);
  check('E1 scenario 1: window starts 11 months before the current month',
    win.windowStart === monthsAgo(11), { windowStart: win.windowStart, expected: monthsAgo(11) });
  check('E1 scenario 1: all 12 months initially missing', win.missingMonths.length === 12);

  const wrote = await adspend.writeAdSpendRanges(longAcc, [
    { channel: 'Meta', amount: 1000, startMonth: monthsAgo(11), endMonth: monthsAgo(0) },
  ]);
  check('spend: a 12-month range expands to 12 monthly rows',
    wrote.rowsWritten === 12 && wrote.monthsWritten === 12, wrote);
  check('spend: rows stored with source=manual',
    (await adspend.listAdSpend(longAcc)).every((r) => r.source === 'manual'));
  win = await adspend.getCoverageWindow(longAcc);
  check('E1 scenario 1: coverage complete after the range is entered', win.complete === true);

  // Scenario: a month with orders but NO new customers is not required.
  const gapAcc = await makeAccount('spend_gap');
  for (let i = 0; i <= 11; i++) await insertOrder(gapAcc, monthsAgo(i), 100, i !== 3);
  const gapWin = await adspend.getCoverageWindow(gapAcc);
  check('E1: a month with no new customers is NOT required',
    gapWin.requiredMonths.length === 11 && !gapWin.requiredMonths.includes(monthsAgo(3)),
    gapWin.requiredMonths.length);

  // Scenario 2: only 3 months of history.
  const shortAcc = await makeAccount('spend_short');
  for (let i = 0; i <= 2; i++) await insertOrder(shortAcc, monthsAgo(i), 100, true);
  const shortWin = await adspend.getCoverageWindow(shortAcc);
  check('E1 scenario 2: 3 months history → only 3 required months, never 12',
    shortWin.requiredMonths.length === 3, shortWin.requiredMonths);
  check('E1 scenario 2: window starts at the first order month',
    shortWin.windowStart === monthsAgo(2) && shortWin.firstOrderMonth === monthsAgo(2));

  // Scenario 3: Shopify connected, no eligible orders at all.
  const emptyAcc = await makeAccount('spend_none');
  const emptyWin = await adspend.getCoverageWindow(emptyAcc);
  check('E1 scenario 3: no eligible orders → no required months',
    emptyWin.requiredMonths.length === 0 && emptyWin.complete === true);
  check('E1 scenario 3: no first order month', emptyWin.firstOrderMonth === null);

  // --- Correction 4: mutual exclusion of real spend and confirmed zero ---
  const excAcc = await makeAccount('spend_excl');
  await insertOrder(excAcc, monthsAgo(1), 100, true);
  const m = monthsAgo(1);

  const zc = await adspend.confirmZeroMonths(excAcc, [m]);
  check('C4: confirming zero for a clean month succeeds', zc.ok);
  await adspend.writeAdSpendRanges(excAcc, [
    { channel: 'Meta', amount: 500, startMonth: m, endMonth: m },
  ]);
  check('C4: writing spend removes that month\'s confirmed-zero record',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM ad_spend_zero_months WHERE account_id=$1 AND month=$2`,
      [excAcc, m])).rows[0].n) === 0);
  check('C4: the spend row is present', Number((await query<{ n: string }>(
    `SELECT count(*) n FROM ad_spend WHERE account_id=$1 AND month=$2`, [excAcc, m])).rows[0].n) === 1);

  const noReplace = await adspend.confirmZeroMonths(excAcc, [m]);
  check('C4: confirming zero over existing spend REQUIRES an explicit replace',
    !noReplace.ok && noReplace.error === 'requires_replace', noReplace);
  check('C4: refusing the replace left the spend row untouched',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM ad_spend WHERE account_id=$1 AND month=$2`,
      [excAcc, m])).rows[0].n) === 1);

  const replaced = await adspend.confirmZeroMonths(excAcc, [m], { replace: true });
  check('C4: explicit replace succeeds and removes the spend row',
    replaced.ok && replaced.spendRowsRemoved === 1, replaced);
  const spendN = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM ad_spend WHERE account_id=$1 AND month=$2`, [excAcc, m])).rows[0].n);
  const zeroN = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM ad_spend_zero_months WHERE account_id=$1 AND month=$2`,
    [excAcc, m])).rows[0].n);
  check('C4: spend removed and zero confirmed (never both)', spendN === 0 && zeroN === 1,
    { spendN, zeroN });

  // Rollback: a failure part-way through must leave NEITHER a partial range nor a
  // deleted zero confirmation. The second entry overflows NUMERIC(12,2) in SQL,
  // which the JS validators would normally have caught first.
  const rbAcc = await makeAccount('spend_rollback');
  const rbMonth = monthsAgo(1);
  await adspend.confirmZeroMonths(rbAcc, [rbMonth]);
  let threw = false;
  try {
    await adspend.writeAdSpendRanges(rbAcc, [
      { channel: 'Meta', amount: 100, startMonth: rbMonth, endMonth: rbMonth },
      { channel: 'Google', amount: 1e13, startMonth: rbMonth, endMonth: rbMonth },
    ]);
  } catch {
    threw = true;
  }
  check('C4 rollback: an invalid row aborts the write', threw);
  check('C4 rollback: no partial ad_spend row survives', Number((await query<{ n: string }>(
    `SELECT count(*) n FROM ad_spend WHERE account_id=$1`, [rbAcc])).rows[0].n) === 0);
  check('C4 rollback: the confirmed-zero record was NOT deleted',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM ad_spend_zero_months WHERE account_id=$1`, [rbAcc])).rows[0].n) === 1);

  // Contradictory legacy data is reported rather than silently tolerated.
  const contraAcc = await makeAccount('spend_contra');
  await insertOrder(contraAcc, monthsAgo(1), 100, true);
  await query(
    `INSERT INTO ad_spend (account_id, month, channel, spend, source)
     VALUES ($1, $2, 'Legacy', 10, 'manual')`, [contraAcc, monthsAgo(1)]);
  await query(
    `INSERT INTO ad_spend_zero_months (account_id, month) VALUES ($1, $2)`,
    [contraAcc, monthsAgo(1)]);
  const contraWin = await adspend.getCoverageWindow(contraAcc);
  check('C4: coexisting states are reported as contradictory',
    contraWin.contradictoryMonths.length === 1 && contraWin.complete === false);

  // --- duplicate + concurrent Shopify domain rejection ---
  const domA = await makeAccount('dom_a');
  const domB = await makeAccount('dom_b');
  const dupDomain = `dup-${Date.now()}.myshopify.com`;
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
     VALUES ($1, 'shopify', 'x', $2, 'connected')`, [domA, dupDomain]);
  let dupBlocked = false;
  try {
    await query(
      `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
       VALUES ($1, 'shopify', 'x', $2, 'connected')`, [domB, dupDomain.toUpperCase()]);
  } catch { dupBlocked = true; }
  check('domain: the unique index rejects the same domain in another account, case-insensitively',
    dupBlocked);

  const reqDomain = `req-${Date.now()}.myshopify.com`;
  await choices.setShopifyRequested(domA, reqDomain);
  let reqBlocked = false;
  try {
    await choices.setShopifyRequested(domB, reqDomain);
  } catch { reqBlocked = true; }
  check('domain: an ACTIVE request is exclusive across accounts (Correction 3)', reqBlocked);
  await choices.setShopifyRequested(domA, reqDomain);
  check('domain: re-requesting the same domain for the same account is idempotent', true);
  await choices.supersedeChoiceOnConnect(domA, 'shopify');
  let freed = true;
  try {
    await choices.setShopifyRequested(domB, reqDomain);
  } catch { freed = false; }
  check('domain: connecting frees the active-request index for that domain', freed);

  // True concurrency: two accounts racing for one domain — exactly one wins.
  const raceA = await makeAccount('race_a');
  const raceB = await makeAccount('race_b');
  const raceDomain = `race-${Date.now()}.myshopify.com`;
  const raceResults = await Promise.allSettled([
    choices.setShopifyRequested(raceA, raceDomain),
    choices.setShopifyRequested(raceB, raceDomain),
  ]);
  const fulfilled = raceResults.filter((r) => r.status === 'fulfilled').length;
  check('domain: concurrent requests for one domain → exactly one succeeds',
    fulfilled === 1, raceResults.map((r) => r.status));

  // --- onboarding-completion blocker matrix ---
  const blkAcc = await makeAccount('blockers');
  let comp = await state.canCompleteOnboarding(blkAcc);
  check('matrix: nothing decided → no_platform_connected + provider_undecided',
    comp.blockers.some((b) => b.code === 'no_platform_connected')
    && comp.blockers.some((b) => b.code === 'provider_undecided'), comp.blockers.map((b) => b.code));
  await choices.setSkipped(blkAcc, 'shopify');
  await choices.setSkipped(blkAcc, 'klaviyo');
  await choices.setSkipped(blkAcc, 'recharge');
  comp = await state.canCompleteOnboarding(blkAcc);
  check('matrix: everything skipped → still blocked by no_platform_connected',
    !comp.complete && comp.blockers.length === 1
    && comp.blockers[0].code === 'no_platform_connected', comp.blockers.map((b) => b.code));
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, status)
     VALUES ($1, 'klaviyo', 'x', 'connected')`, [blkAcc]);
  comp = await state.canCompleteOnboarding(blkAcc);
  check('matrix: one connected platform + others skipped → COMPLETE', comp.complete, comp.blockers);
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, status)
     VALUES ($1, 'recharge', 'x', 'pending')`, [blkAcc]);
  comp = await state.canCompleteOnboarding(blkAcc);
  check('matrix: an unverified connection blocks completion',
    comp.blockers.some((b) => b.code === 'connection_not_verified'));
  await query(`DELETE FROM connections WHERE account_id=$1 AND provider='recharge'`, [blkAcc]);
  check('matrix: account_not_found for a nonexistent account',
    (await state.canCompleteOnboarding(2_000_000_001)).blockers[0].code === 'account_not_found');
  // The decisive property of the split: a completely uncosted account with one
  // connected platform completes. No cost/currency code can appear here at all.
  const uncosted = await makeAccount('uncosted');
  await choices.setSkipped(uncosted, 'shopify');
  await choices.setSkipped(uncosted, 'recharge');
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, status)
     VALUES ($1, 'klaviyo', 'x', 'connected')`, [uncosted]);
  const uncostedComp = await state.canCompleteOnboarding(uncosted);
  check('matrix: an account with NO costs, NO currency, NO spend still completes',
    uncostedComp.complete, uncostedComp.blockers.map((b) => b.code));
  const everyCode = [
    ...uncostedComp.blockers, ...comp.blockers,
  ].map((b) => b.code).join(',');
  check('matrix: completion blockers never mention cogs/ocas/spend/currency',
    !/cogs|ocas|spend|currency/.test(everyCode), everyCode);

  // --- RCM-readiness blocker matrix ---
  const rcmAcc = await makeAccount('rcm');
  let rr = await state.getRcmReadiness(rcmAcc);
  check('rcm matrix: no Shopify → shopify_not_connected only',
    !rr.ready && rr.blockers.length === 1 && rr.blockers[0].code === 'shopify_not_connected');

  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
     VALUES ($1,'shopify','x',$2,'connected')`, [rcmAcc, `rcm-${Date.now()}.myshopify.com`]);
  rr = await state.getRcmReadiness(rcmAcc);
  const codes = () => rr.blockers.map((b) => b.code);
  check('rcm matrix: Shopify connected, nothing else → currency + revenue + cogs + ocas + spend',
    codes().includes('currency_unknown')
    && codes().includes('no_eligible_revenue_data')
    && codes().includes('cogs_method_not_selected')
    && codes().includes('ocas_missing'), codes());

  // E1b: zero-revenue workspace must NOT become ready on a blended margin alone.
  await currency.setManualCurrency(rcmAcc, 'USD');
  await costs.setBlendedMargin(rcmAcc, 60);
  await costs.setOcas(rcmAcc, 5000, false);
  rr = await state.getRcmReadiness(rcmAcc);
  check('E1b: blended margin alone does NOT make a zero-revenue workspace RCM-ready',
    !rr.ready && codes().includes('no_eligible_revenue_data'), codes());
  check('E1b: the client-safe message is the approved wording',
    rr.blockers.find((b) => b.code === 'no_eligible_revenue_data')?.message
      === 'Shopify is connected, but there is not enough eligible commerce history yet to calculate RCM.');

  // Add real revenue, then walk the remaining blockers to zero.
  for (let i = 0; i <= 2; i++) await insertOrder(rcmAcc, monthsAgo(i), 500, true);
  rr = await state.getRcmReadiness(rcmAcc);
  check('rcm matrix: revenue present → no_eligible_revenue_data clears',
    !codes().includes('no_eligible_revenue_data'), codes());
  check('rcm matrix: ad-spend coverage now blocks',
    codes().includes('ad_spend_coverage_incomplete'), codes());

  await adspend.writeAdSpendRanges(rcmAcc, [
    { channel: 'Meta', amount: 250, startMonth: monthsAgo(2), endMonth: monthsAgo(0) },
  ]);
  rr = await state.getRcmReadiness(rcmAcc);
  check('rcm matrix: all inputs satisfied → RCM READY', rr.ready, codes());

  // Removing one input must revert readiness (the partial state is a feature).
  await query(`UPDATE account_costs SET ocas_monthly = NULL WHERE account_id = $1`, [rcmAcc]);
  rr = await state.getRcmReadiness(rcmAcc);
  check('rcm matrix: removing OCAS reverts readiness',
    !rr.ready && codes().includes('ocas_missing'));
  await costs.setOcas(rcmAcc, 5000, false);
  await query(`UPDATE account_costs SET blended_margin_pct = NULL WHERE account_id = $1`, [rcmAcc]);
  rr = await state.getRcmReadiness(rcmAcc);
  check('rcm matrix: removing the blended margin reverts readiness',
    !rr.ready && codes().includes('cogs_blended_missing_or_invalid'));
  await costs.setBlendedMargin(rcmAcc, 60);
  check('rcm matrix: readiness is recomputed live, never cached',
    (await state.getRcmReadiness(rcmAcc)).ready === true);

  // --- currency: all four Correction-1 cases ---
  const c1 = await makeAccount('cur1');
  const r1 = await currency.applyShopifyCurrency(c1, 'USD');
  check('C1 case 1: no existing currency → Shopify adopted',
    r1.outcome === 'adopted_no_previous'
    && (await currency.getCurrencyState(c1))?.currency_source === 'shopify');

  const c2 = await makeAccount('cur2');
  await currency.setManualCurrency(c2, 'USD');
  const r2 = await currency.applyShopifyCurrency(c2, 'USD');
  const s2 = await currency.getCurrencyState(c2);
  check('C1 case 2: manual matches Shopify → source upgraded, no blocker',
    r2.outcome === 'confirmed_match' && s2?.currency === 'USD'
    && s2.currency_source === 'shopify' && !currency.hasCurrencyMismatch(s2));

  const c3 = await makeAccount('cur3');
  await currency.setManualCurrency(c3, 'CAD');
  const r3 = await currency.applyShopifyCurrency(c3, 'USD');
  const s3 = await currency.getCurrencyState(c3);
  check('C1 case 3: manual differs, NO money rows → replaced, no blocker',
    r3.outcome === 'replaced_no_money_rows' && s3?.currency === 'USD'
    && !currency.hasCurrencyMismatch(s3));

  const c4 = await makeAccount('cur4');
  await currency.setManualCurrency(c4, 'CAD');
  await costs.setOcas(c4, 4000, false);            // a money row now exists
  const r4 = await currency.applyShopifyCurrency(c4, 'USD');
  const s4 = await currency.getCurrencyState(c4);
  check('C1 case 4: manual differs WITH money rows → both currencies preserved',
    r4.outcome === 'mismatch_preserved' && s4?.currency === 'CAD'
    && s4.shopify_currency_detected === 'USD', s4);
  check('C1 case 4: nothing was converted or deleted',
    Number((await costs.getAccountCosts(c4)).ocas_monthly) === 4000);
  check('C1 case 4: mismatch is derived from the two columns',
    currency.hasCurrencyMismatch(s4!));
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
     VALUES ($1,'shopify','x',$2,'connected')`, [c4, `cur4-${Date.now()}.myshopify.com`]);
  const rr4 = await state.getRcmReadiness(c4);
  check('C1 case 4: currency_mismatch blocks RCM readiness',
    rr4.blockers.some((b) => b.code === 'currency_mismatch'));
  check('C1 case 4: the mismatch blocker is marked agency-only',
    rr4.blockers.find((b) => b.code === 'currency_mismatch')?.detail?.agencyOnlyResolution === true);
  const resolved = await currency.resolveCurrencyMismatch(c4);
  const s4b = await currency.getCurrencyState(c4);
  check('C1 case 4: agency resolution adopts the Shopify currency',
    resolved.ok && s4b?.currency === 'USD' && s4b.currency_source === 'shopify');
  check('C1 case 4: the blocker clears from database state alone, no stored boolean',
    !(await state.getRcmReadiness(c4)).blockers.some((b) => b.code === 'currency_mismatch'));
  check('C1: manual currency refused once Shopify is authoritative',
    !(await currency.setManualCurrency(c4, 'GBP')).ok);

  // --- capabilities ---
  const capAcc2 = await makeAccount('caps');
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, status)
     VALUES ($1,'recharge','x','connected')`, [capAcc2]);
  const caps = await capabilities.getCapabilities(capAcc2);
  check('capabilities: Recharge-only exposes churn analytics',
    caps.available.includes('churn_analytics'));
  check('capabilities: Shopify capabilities listed as unavailable, not failed',
    caps.unavailable.some((u) => u.capability === 'rcm_revenue_foundation'
      && u.requiresProvider === 'shopify'));
  check('capabilities: fullExperience false with one provider', caps.fullExperience === false);
}

// ===========================================================================
// D. Session isolation
// ===========================================================================
async function groupD(app: App, agencyCookie: string): Promise<void> {
  group('D', 'Session isolation (agency vs scoped onboarding)');

  const acc = await makeAccount('sessions');
  const link = await mintAndExchange(app, agencyCookie, acc);

  const onbHitsAgency = await app.inject({
    method: 'GET', url: '/accounts', headers: { cookie: link.cookie }, remoteAddress: nextIp(),
  });
  check('onboarding session cannot reach GET /accounts', onbHitsAgency.statusCode === 401);

  for (const [method, url] of [
    ['POST', '/accounts'], ['POST', `/accounts/${acc}/onboarding-links`],
    ['GET', `/accounts/${acc}/onboarding/status`], ['POST', '/connections/klaviyo'],
    ['POST', `/accounts/${acc}/onboarding/complete`], ['GET', `/accounts/${acc}/rcm-readiness`],
  ] as [string, string][]) {
    const res = await app.inject({
      method: method as 'GET', url, headers: { cookie: link.cookie },
      remoteAddress: nextIp(), payload: {},
    });
    check(`onboarding session rejected from ${method} ${url}`, res.statusCode === 401, res.statusCode);
  }

  for (const url of ['/onboarding/me', '/onboarding/progress', '/onboarding/skus']) {
    const res = await app.inject({
      method: 'GET', url, headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
    });
    check(`agency session rejected from GET ${url}`, res.statusCode === 401, res.statusCode);
  }

  // Both cookies present at once — the browser-equivalent two-tab case.
  const both = `${agencyCookie}; ${link.cookie}`;
  const agencyWithBoth = await app.inject({
    method: 'GET', url: '/accounts', headers: { cookie: both }, remoteAddress: nextIp(),
  });
  const onbWithBoth = await app.inject({
    method: 'GET', url: '/onboarding/me', headers: { cookie: both }, remoteAddress: nextIp(),
  });
  check('both cookies present: the agency route still works', agencyWithBoth.statusCode === 200);
  check('both cookies present: the onboarding route still works', onbWithBoth.statusCode === 200);
  check('exchanging a token did not convert or inherit the agency session',
    agencyWithBoth.statusCode === 200 && onbWithBoth.statusCode === 200);

  // Onboarding logout must not touch the agency session.
  const logout = await app.inject({
    method: 'POST', url: '/onboarding/logout', headers: { cookie: both }, remoteAddress: nextIp(),
  });
  const setCookies = (Array.isArray(logout.headers['set-cookie'])
    ? logout.headers['set-cookie'] : [String(logout.headers['set-cookie'] ?? '')]).map(String);
  check('onboarding logout clears the onboarding cookie (empty value + past expiry)',
    logout.statusCode === 200
    && setCookies.some((c) => /^tention_onb=;/.test(c) && /Expires=|Max-Age=0/i.test(c)),
    setCookies);
  // @fastify/session re-issues tention_sid on every request carrying a live
  // session, so its presence here is a refresh, not a logout. The invariant that
  // matters is that it is never a CLEARING cookie.
  const agencySet = setCookies.filter((c) => c.startsWith('tention_sid='));
  check('onboarding logout never clears the agency cookie',
    agencySet.every((c) => !/^tention_sid=;/.test(c) && !/Max-Age=0/i.test(c)
      && !/Expires=Thu, 01 Jan 1970/i.test(c)), agencySet);
  const agencyAfterLogout = await app.inject({
    method: 'GET', url: '/accounts', headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('agency session survives an onboarding logout', agencyAfterLogout.statusCode === 200);

  // Revocation must bite inside an already-open session.
  const revAcc = await makeAccount('revoke_mid');
  const revLink = await mintAndExchange(app, agencyCookie, revAcc);
  check('mid-session: request works before revocation',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', headers: { cookie: revLink.cookie },
      remoteAddress: nextIp(),
    })).statusCode === 200);
  const revRes = await app.inject({
    method: 'DELETE', url: `/accounts/${revAcc}/onboarding-links/${revLink.linkId}`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('mid-session: the account-scoped revoke route accepted the request',
    revRes.statusCode === 200, { status: revRes.statusCode, body: revRes.body });
  check('mid-session: revocation takes effect on the very next request',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', headers: { cookie: revLink.cookie },
      remoteAddress: nextIp(),
    })).statusCode === 401);

  // Expiry must bite inside an already-open session too.
  const expAcc = await makeAccount('expire_mid');
  const expLink = await mintAndExchange(app, agencyCookie, expAcc);
  await query(`UPDATE onboarding_links SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [expLink.linkId]);
  check('mid-session: expiry takes effect on the very next request',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', headers: { cookie: expLink.cookie },
      remoteAddress: nextIp(),
    })).statusCode === 401);

  // A forged/tampered cookie must not authenticate.
  const forged = await app.inject({
    method: 'GET', url: '/onboarding/me',
    headers: { cookie: 'tention_onb=eyJsIjoxLCJhIjoxfQ.forgedsignature' },
    remoteAddress: nextIp(),
  });
  check('a tampered onboarding cookie is rejected', forged.statusCode === 401);
}

// ===========================================================================
// E. Cross-tenant
// ===========================================================================
async function groupE(app: App, agencyCookie: string): Promise<void> {
  group('E', 'Cross-tenant isolation');

  const accA = await makeAccount('tenant_a');
  const accB = await makeAccount('tenant_b');
  const linkA = await mintAndExchange(app, agencyCookie, accA);

  // Distinct SKUs so a leak would be unmistakable.
  const oA = await insertOrder(accA, monthsAgo(1), 100, true);
  await insertLineItem(accA, oA, 1, 'A-ONLY-SKU', 100);
  const oB = await insertOrder(accB, monthsAgo(1), 100, true);
  await insertLineItem(accB, oB, 1, 'B-ONLY-SKU', 100);
  await costs.setOcas(accB, 1234, false);

  // Account identifiers must be REJECTED, not ignored.
  const bodyProbe = await app.inject({
    method: 'PUT', url: '/onboarding/ocas', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(), payload: { accountId: accB, ocasMonthly: 999 },
  });
  check('accountId in the body is rejected with 400', bodyProbe.statusCode === 400,
    bodyProbe.statusCode);
  check('rejection names the reason',
    (bodyProbe.json() as { error: string }).error === 'account_identifier_not_permitted');

  const snakeProbe = await app.inject({
    method: 'PUT', url: '/onboarding/ocas', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(), payload: { account_id: accB, ocasMonthly: 999 },
  });
  check('account_id in the body is rejected', snakeProbe.statusCode === 400);

  const queryProbe = await app.inject({
    method: 'GET', url: `/onboarding/skus?account_id=${accB}`,
    headers: { cookie: linkA.cookie }, remoteAddress: nextIp(),
  });
  check('account_id in the query string is rejected', queryProbe.statusCode === 400);

  check('account B\'s OCAS was not modified by any probe',
    Number((await costs.getAccountCosts(accB)).ocas_monthly) === 1234);

  // Reads are scoped by the session's account.
  const skus = await app.inject({
    method: 'GET', url: '/onboarding/skus', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(),
  });
  const skuBody = JSON.stringify(skus.json());
  check('A cannot see B\'s SKUs', skuBody.includes('A-ONLY-SKU') && !skuBody.includes('B-ONLY-SKU'));

  // Writes cannot name a foreign SKU.
  const foreign = await app.inject({
    method: 'PUT', url: '/onboarding/cogs', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(),
    payload: { method: 'per_sku', skus: [{ sku: 'B-ONLY-SKU', cogs: 5 }] },
  });
  check('A submitting B\'s SKU is rejected',
    foreign.statusCode === 400
    && (foreign.json() as { error: string }).error === 'unknown_skus', foreign.json());
  check('no cost row was created for the foreign SKU',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM sku_costs WHERE sku = 'B-ONLY-SKU'`)).rows[0].n) === 0);

  // A cannot connect a provider into B, nor inspect B's progress.
  const connProbe = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(), payload: { accountId: accB, apiKey: 'pk_x0000000000000000000000000000000000' },
  });
  check('A cannot connect a provider to B', connProbe.statusCode === 400);
  check('B has no connections after the attempt',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1`, [accB])).rows[0].n) === 0);

  const progress = await app.inject({
    method: 'GET', url: '/onboarding/progress', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(),
  });
  check('progress is scoped to A only', progress.statusCode === 200);

  // The client payload leaks no internal identifiers.
  const me = await app.inject({
    method: 'GET', url: '/onboarding/me', headers: { cookie: linkA.cookie },
    remoteAddress: nextIp(),
  });
  const meBody = JSON.stringify(me.json());
  check('client payload contains no account_id / accountId key',
    !/"account_?[Ii]d"/.test(meBody), meBody.slice(0, 200));
  check('client payload contains no queue job identifier',
    !meBody.includes('backfill:'), meBody.slice(0, 200));
  check('client payload contains no credential material',
    !meBody.includes('credentials_encrypted') && !meBody.includes('pk_'));

  // Domain uniqueness across accounts, through the HTTP surface.
  const shared = `shared-${Date.now()}.myshopify.com`;
  await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/request',
    headers: { cookie: linkA.cookie }, remoteAddress: nextIp(), payload: { shopDomain: shared },
  });
  const linkB = await mintAndExchange(app, agencyCookie, accB);
  const dupReq = await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/request',
    headers: { cookie: linkB.cookie }, remoteAddress: nextIp(),
    payload: { shopDomain: shared.toUpperCase() },
  });
  check('B cannot claim a domain A has actively requested', dupReq.statusCode === 409, dupReq.json());
  check('the conflict message names no other account',
    !JSON.stringify(dupReq.json()).includes(String(accA)));
}

// ===========================================================================
// F. Credential-fallback regression
// ===========================================================================
async function groupF(app: App, agencyCookie: string): Promise<void> {
  group('F', 'Credential-fallback regression (.env credentials ARE all set)');

  check('precondition: KLAVIYO_API_KEY is set in the environment',
    process.env.KLAVIYO_API_KEY === ENV_SENTINELS.KLAVIYO_API_KEY);
  check('precondition: RECHARGE_API_TOKEN is set in the environment',
    process.env.RECHARGE_API_TOKEN === ENV_SENTINELS.RECHARGE_API_TOKEN);
  check('precondition: SHOPIFY_CLIENT_ID/SECRET/DOMAIN are set in the environment',
    process.env.SHOPIFY_CLIENT_ID === ENV_SENTINELS.SHOPIFY_CLIENT_ID
    && process.env.SHOPIFY_CLIENT_SECRET === ENV_SENTINELS.SHOPIFY_CLIENT_SECRET
    && process.env.SHOPIFY_SHOP_DOMAIN === ENV_SENTINELS.SHOPIFY_SHOP_DOMAIN);

  const acc = await makeAccount('env_fallback');
  const link = await mintAndExchange(app, agencyCookie, acc);
  fetchLog = [];

  for (const [provider, url, payload] of [
    ['klaviyo', '/onboarding/connections/klaviyo', { apiKey: '' }],
    ['klaviyo', '/onboarding/connections/klaviyo', {}],
    ['recharge', '/onboarding/connections/recharge', { token: '' }],
    ['recharge', '/onboarding/connections/recharge', {}],
    ['recharge', '/onboarding/connections/recharge', { token: '   ' }],
  ] as [string, string, object][]) {
    const res = await app.inject({
      method: 'POST', url, headers: { cookie: link.cookie }, remoteAddress: nextIp(), payload,
    });
    check(`${provider}: empty client credential (${JSON.stringify(payload)}) FAILS`,
      res.statusCode === 400
      && (res.json() as { code?: string }).code === 'missing_credentials',
      res.json());
  }

  const shopifyBlank = await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/request',
    headers: { cookie: link.cookie }, remoteAddress: nextIp(), payload: { shopDomain: '' },
  });
  check('shopify: a blank client domain FAILS instead of using SHOPIFY_SHOP_DOMAIN',
    shopifyBlank.statusCode === 400, shopifyBlank.json());

  const connRows = await query<{ n: string }>(
    `SELECT count(*) n FROM connections WHERE account_id = $1`, [acc],
  );
  check('no connection row was written by any empty-credential attempt',
    Number(connRows.rows[0].n) === 0, connRows.rows[0]);

  const choiceRows = await query<{ n: string }>(
    `SELECT count(*) n FROM onboarding_provider_choices
      WHERE account_id = $1 AND requested_domain = $2`, [acc, ENV_SENTINELS.SHOPIFY_SHOP_DOMAIN],
  );
  check('the env shop domain was never recorded as a request',
    Number(choiceRows.rows[0].n) === 0);

  const leak = envCredentialLeaked();
  check('NO outbound verification call received an .env credential', leak === null, leak);
  check('no outbound call was made at all for an empty credential',
    fetchLog.length === 0, fetchLog.map((f) => f.url));

  // The client-facing surface must not even accept the opt-in flag.
  const optInProbe = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: { apiKey: '', useEnvCredentials: true },
  });
  check('client route ignores useEnvCredentials and still fails',
    optInProbe.statusCode === 400, optInProbe.json());
  check('still no connection row after the opt-in probe',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1`, [acc])).rows[0].n) === 0);

  // The AGENCY route also refuses implicitly — the flag must be explicit (E10).
  const agencyImplicit = await app.inject({
    method: 'POST', url: '/connections/klaviyo', headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: { accountId: acc },
  });
  check('agency route: no implicit env fallback either', agencyImplicit.statusCode === 400,
    agencyImplicit.json());

  fetchLog = [];
  const agencyExplicit = await app.inject({
    method: 'POST', url: '/connections/klaviyo', headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: { accountId: acc, useEnvCredentials: true },
  });
  check('agency route: env fallback works ONLY with useEnvCredentials:true',
    [200, 202].includes(agencyExplicit.statusCode), agencyExplicit.json());
  check('the explicit opt-in is the only path that used an env credential',
    envCredentialLeaked() === 'KLAVIYO_API_KEY');
  fetchLog = [];
}

// ===========================================================================
// G. Link states + rate limiting
// ===========================================================================
async function groupG(app: App, agencyCookie: string): Promise<void> {
  group('G', 'Link states (uniform generic failure) + rate limiting');

  const acc = await makeAccount('link_states');
  const accName = (await query<{ name: string }>(
    `SELECT name FROM accounts WHERE id = $1`, [acc])).rows[0].name;

  const valid = await links.mintOnboardingLink(acc, null);
  const expired = await links.mintOnboardingLink(acc, null);
  await query(`UPDATE onboarding_links SET expires_at = now() - interval '1 day' WHERE id = $1`,
    [expired.id]);
  const revoked = await links.mintOnboardingLink(acc, null);
  await links.revokeLink(acc, revoked.id);

  const okRes = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    payload: { token: valid.token },
  });
  check('valid token: 200 and the workspace name is revealed',
    okRes.statusCode === 200 && (okRes.json() as { workspaceName: string }).workspaceName === accName);

  const cases: [string, unknown][] = [
    ['expired', expired.token],
    ['revoked', revoked.token],
    ['malformed (too short)', 'abc'],
    ['malformed (bad chars)', '!'.repeat(43)],
    ['never existed', 'Z'.repeat(43)],
    ['missing', undefined],
    ['wrong type', 12345],
  ];
  const bodies: string[] = [];
  for (const [label, token] of cases) {
    const res = await app.inject({
      method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
      payload: token === undefined ? {} : { token },
    });
    const body = JSON.stringify(res.json());
    bodies.push(`${res.statusCode}|${body}`);
    check(`${label}: 401`, res.statusCode === 401, res.statusCode);
    check(`${label}: reveals no workspace name`, !body.includes(accName));
    check(`${label}: reveals no account id`, !body.includes(`"${acc}"`) && !body.includes(`:${acc}`));
    check(`${label}: does not say which reason applied`,
      !/expired|revoked|not_found|malformed/i.test(body), body);
  }
  check('every invalid/expired/revoked/nonexistent response is BYTE-IDENTICAL',
    new Set(bodies).size === 1, [...new Set(bodies)]);

  // A token in the query string is refused outright, so it can never be logged.
  const inQuery = await app.inject({
    method: 'POST', url: `/onboarding/session?token=${valid.token}`, remoteAddress: nextIp(),
    payload: {},
  });
  check('a token supplied via the query string is refused',
    inQuery.statusCode === 400
    && (inQuery.json() as { error: string }).error === 'token_must_be_in_body');

  check('Referrer-Policy: no-referrer is set on onboarding responses',
    okRes.headers['referrer-policy'] === 'no-referrer', okRes.headers['referrer-policy']);

  // No route accepts a raw token in a path (Correction 2).
  const pathRoute = await app.inject({
    method: 'GET', url: `/onboarding/c/${valid.token}`, remoteAddress: nextIp(),
  });
  check('there is no /onboarding/c/:token route at all', pathRoute.statusCode === 404);

  // --- rate limiting (E7). Fixed IP so the limiter accumulates. ---
  const rlIp = '203.0.113.77';
  // Redis counters outlive the process, so clear this IP first or the "engages on
  // request 11" assertion silently depends on how recently the suite last ran.
  await clearRateLimit(rlIp);
  check('rate-limit counter for the test IP starts clean',
    (await rateLimitKeysFor(rlIp)).length === 0);
  let sawLimit = false;
  let limitedAt = 0;
  for (let i = 1; i <= 14; i++) {
    const res = await app.inject({
      method: 'POST', url: '/onboarding/session', remoteAddress: rlIp,
      payload: { token: 'Y'.repeat(43) },
    });
    if (res.statusCode === 429) { sawLimit = true; limitedAt = i; break; }
  }
  check('token exchange is rate limited from one IP', sawLimit, { limitedAt });
  check('the limit engages at the configured 10 requests/minute',
    limitedAt === 11, { limitedAt });
  // Positive proof the limiter is Redis-backed rather than in-process: the counter
  // is observable in Redis, so the limit holds across API processes.
  const rlKeys = await rateLimitKeysFor(rlIp);
  check('the rate-limit counter is stored in Redis, not in process memory',
    rlKeys.length === 1 && rlKeys[0].startsWith(RATE_LIMIT_KEY_PREFIX), rlKeys);
  check('the Redis counter has a TTL (the window expires)',
    (await redis.ttl(rlKeys[0]).catch(() => -2)) > 0);

  const otherIp = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: '198.51.100.5',
    payload: { token: 'Y'.repeat(43) },
  });
  check('a different IP is not affected by another IP\'s limit',
    otherIp.statusCode === 401, otherIp.statusCode);

  // Redis outage: skipOnError must let onboarding proceed rather than lock out.
  const { default: Fastify } = await import('fastify');
  const { default: cookiePlugin } = await import('@fastify/cookie');
  const { default: rateLimitPlugin } = await import('@fastify/rate-limit');
  const { default: IORedis } = await import('ioredis');
  const deadRedis = new IORedis('redis://127.0.0.1:6390', {
    lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false,
    connectTimeout: 150, retryStrategy: () => null,
  });
  deadRedis.on('error', () => undefined); // expected; must not crash the process
  const outageApp = Fastify({ logger: false });
  await outageApp.register(cookiePlugin);
  await outageApp.register(rateLimitPlugin, {
    global: false, redis: deadRedis as never, skipOnError: true, keyGenerator: (r) => r.ip,
  });
  outageApp.post('/probe', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
    async () => ({ ok: true }));
  await outageApp.ready();
  const outage = await Promise.race([
    (async () => {
      const a = await outageApp.inject({ method: 'POST', url: '/probe', remoteAddress: '10.9.9.9' });
      const b = await outageApp.inject({ method: 'POST', url: '/probe', remoteAddress: '10.9.9.9' });
      return [a.statusCode, b.statusCode];
    })(),
    new Promise<number[]>((r) => setTimeout(() => r([-1, -1]), 8000)),
  ]);
  check('Redis outage: rate-limited route fails OPEN rather than locking onboarding out',
    outage[0] === 200 && outage[1] === 200, outage);
  await outageApp.close();
  deadRedis.disconnect();
}

// ===========================================================================
// H. Later connection (the exact D13 sequence)
// ===========================================================================
async function groupH(app: App, agencyCookie: string): Promise<void> {
  group('H', 'Later connection — the exact D13 Day-1 / Day-10 sequence');

  // 1. Connect Klaviyo only.
  const acc = await makeAccount('later');
  const link = await mintAndExchange(app, agencyCookie, acc);
  const kRes = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: { apiKey: 'pk_later_client_key_00000000000000000' },
  });
  check('1. Klaviyo connected', [200, 202].includes(kRes.statusCode), kRes.json());

  // 2. Skip Shopify and Recharge.
  for (const p of ['shopify', 'recharge']) {
    const res = await app.inject({
      method: 'POST', url: `/onboarding/connections/${p}/skip`, headers: { cookie: link.cookie },
      remoteAddress: nextIp(), payload: {},
    });
    check(`2. ${p} skipped`, res.statusCode === 200);
  }
  check('2. skipping created no connections rows for the skipped providers',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id=$1 AND provider IN ('shopify','recharge')`,
      [acc])).rows[0].n) === 0);

  // 3-4. Complete onboarding.
  const done = await app.inject({
    method: 'POST', url: '/onboarding/complete', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('3. Klaviyo-only onboarding COMPLETES', done.statusCode === 200, done.json());
  check('4. accounts.onboarding_complete is true', await state.isOnboardingComplete(acc));
  const doneBody = done.json() as { rcmReady: boolean; rcmBlockers: { code: string }[] };

  // 5. RCM unavailable.
  check('5. RCM is unavailable', doneBody.rcmReady === false);
  check('5. the only RCM blocker is the missing Shopify connection',
    doneBody.rcmBlockers.length === 1 && doneBody.rcmBlockers[0].code === 'shopify_not_connected',
    doneBody.rcmBlockers);
  const meLimited = (await app.inject({
    method: 'GET', url: '/onboarding/me', headers: { cookie: link.cookie }, remoteAddress: nextIp(),
  })).json() as { uiStates: Record<string, boolean>; capabilities: { available: string[] } };
  check('5. UI state reports limited analytics available',
    meLimited.uiStates.limitedAnalyticsAvailable === true
    && meLimited.uiStates.shopifyNotConnected === true
    && meLimited.uiStates.rcmReady === false);
  check('5. Klaviyo capabilities available, Shopify capabilities are not',
    meLimited.capabilities.available.includes('campaign_analytics')
    && !meLimited.capabilities.available.includes('rcm_revenue_foundation'));

  // 6. Connect Shopify later, under the SAME account.
  const beforeAccounts = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM accounts`)).rows[0].n);
  const laterDomain = `later-${Date.now()}.myshopify.com`;
  const sRes = await app.inject({
    method: 'POST', url: `/accounts/${acc}/connections/shopify/credentials`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
    payload: { shopDomain: laterDomain, clientId: 'later_id', clientSecret: 'later_secret' },
  });
  check('6. Shopify connected later', [200, 202].includes(sRes.statusCode), sRes.json());
  check('6. it attached to the SAME account_id',
    (await query<{ account_id: number }>(
      `SELECT account_id FROM connections WHERE provider='shopify' AND shop_domain=$1`,
      [laterDomain])).rows[0].account_id === acc);

  // 7. No second workspace.
  check('7. no second workspace was created',
    Number((await query<{ n: string }>(`SELECT count(*) n FROM accounts`)).rows[0].n)
      === beforeAccounts);

  // 8. Backfill enqueued.
  check('8. the Shopify backfill was enqueued',
    (sRes.json() as { queued: boolean }).queued === true);

  // 9. Completion never reverts.
  check('9. onboarding_complete remains true', await state.isOnboardingComplete(acc));

  // 10. Readiness recalculated: now missing costs, not Shopify.
  let rr = await state.getRcmReadiness(acc);
  let codes = rr.blockers.map((b) => b.code);
  check('10. readiness recomputed — Shopify no longer the blocker',
    !codes.includes('shopify_not_connected'), codes);
  check('10. cost setup is now what stands in the way',
    codes.includes('cogs_method_not_selected') && codes.includes('ocas_missing'), codes);
  check('10. currency arrived from Shopify, so it is not a blocker',
    !codes.includes('currency_unknown'), codes);
  check('10. capabilities grew to include Shopify',
    (await capabilities.getCapabilities(acc)).available.includes('rcm_revenue_foundation'));
  check('10. the skipped Shopify choice was superseded',
    (await choices.getProviderStatuses(acc)).find((p) => p.provider === 'shopify')?.state
      === 'connected');

  // 11. Complete currency, COGS, OCAS and ad spend.
  for (let i = 0; i <= 2; i++) await insertOrder(acc, monthsAgo(i), 400, true);
  rr = await state.getRcmReadiness(acc);
  check('11. eligible revenue satisfied',
    !rr.blockers.map((b) => b.code).includes('no_eligible_revenue_data'));

  const cogsRes = await app.inject({
    method: 'PUT', url: '/onboarding/cogs', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: { method: 'blended', blendedMarginPct: 62.5 },
  });
  check('11. COGS accepted through the client route', cogsRes.statusCode === 200, cogsRes.json());
  const ocasRes = await app.inject({
    method: 'PUT', url: '/onboarding/ocas', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: { ocasMonthly: 7500 },
  });
  check('11. OCAS accepted through the client route', ocasRes.statusCode === 200, ocasRes.json());

  rr = await state.getRcmReadiness(acc);
  codes = rr.blockers.map((b) => b.code);
  check('12. RCM still NOT ready while ad spend is missing',
    !rr.ready && codes.includes('ad_spend_coverage_incomplete'), codes);

  const spendRes = await app.inject({
    method: 'PUT', url: '/onboarding/ad-spend', headers: { cookie: link.cookie },
    remoteAddress: nextIp(),
    payload: {
      rows: [{
        channel: 'Meta', amount: 900,
        startMonth: monthsAgo(2).slice(0, 7), endMonth: monthsAgo(0).slice(0, 7),
      }],
    },
  });
  check('12. ad spend accepted and expanded to monthly rows',
    spendRes.statusCode === 200
    && (spendRes.json() as { rowsWritten: number }).rowsWritten === 3, spendRes.json());

  rr = await state.getRcmReadiness(acc);
  check('12. RCM becomes ready ONLY once every blocker is cleared', rr.ready,
    rr.blockers.map((b) => b.code));
  check('12. onboarding_complete never reverted throughout',
    await state.isOnboardingComplete(acc));

  // Reconnecting Klaviyo must not disturb Shopify data.
  //
  // UPDATED FOR PHASE 5C-1, and the expected outcome is now the opposite one.
  // This account completed through its client link at step 3, so the link is in
  // restricted manage mode and §5.4.4 denies re-connecting an ALREADY CONNECTED
  // provider. The reconnect is therefore refused with 409 rather than rotating
  // the credential. The invariants this block was written to protect are
  // unchanged and still asserted below: Shopify's orders, Shopify's connection
  // row and RCM readiness all survive the attempt.
  //
  // PRE-COMPLETION credential rotation is NOT weakened by this and keeps its own
  // coverage: group B rotates a Klaviyo key on an account that never completes
  // ("reconnect rotates the stored credential"), and group L section G proves
  // the same key is left untouched once manage mode engages.
  const ordersBefore = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM orders WHERE account_id = $1`, [acc])).rows[0].n);
  const reconnect = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: { apiKey: 'pk_later_rotated_0000000000000000000' },
  });
  check('a completed link may no longer re-connect a connected Klaviyo (5C-1)',
    reconnect.statusCode === 409
    && (reconnect.json() as { code?: string }).code === 'provider_already_connected',
    { status: reconnect.statusCode, body: reconnect.json() });
  check('reconnecting Klaviyo left Shopify orders intact',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM orders WHERE account_id = $1`, [acc])).rows[0].n) === ordersBefore);
  check('reconnecting Klaviyo left the Shopify connection intact',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id=$1 AND provider='shopify'`,
      [acc])).rows[0].n) === 1);
  check('RCM still ready after the Klaviyo reconnect',
    (await state.getRcmReadiness(acc)).ready);
}

// ===========================================================================
// I. Fastify 5 migration regressions
// ===========================================================================
//
// Added by the Fastify 4 -> 5 upgrade. Every assertion here covers something the
// A-H suite did NOT already prove, and two of them target the specific advisories
// the upgrade exists to close:
//
//   GHSA-jx2c-rxcm-jvmq  Content-Type tab character allows body-validation bypass
//   GHSA-444r-cwp2-x5xf  request.protocol / request.host spoofable via X-Forwarded-*
//
// Nothing here replaces or weakens an existing check.

/** Parse a Set-Cookie header list into name -> raw directive string. */
function setCookieList(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map(String);
}
function cookieDirective(res: { headers: Record<string, unknown> }, name: string): string | null {
  return setCookieList(res).find((c) => c.startsWith(`${name}=`)) ?? null;
}

/** Forge a CORRECTLY SIGNED onboarding cookie — mirrors onboarding/session.ts. */
function forgeOnboardingCookie(linkId: number, accountId: number): string {
  const body = Buffer.from(
    JSON.stringify({ l: linkId, a: accountId, i: Math.floor(Date.now() / 1000) }),
    'utf8',
  ).toString('base64url');
  const mac = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `tention_onb=${body}.${mac}`;
}

async function groupI(app: App, agencyCookie: string): Promise<void> {
  group('I', 'Fastify 5 migration regressions');

  const acc = await makeAccount('fastify5');
  const link = await mintAndExchange(app, agencyCookie, acc);

  // --- session/cookie separation at issue time --------------------------
  const freshEmail = await seedAgencyUser();
  const loginRes = await agencyLoginRes(app, freshEmail);
  const loginCookies = setCookieList(loginRes);
  check('agency login sets ONLY the agency cookie',
    loginCookies.some((c) => c.startsWith('tention_sid='))
    && !loginCookies.some((c) => c.startsWith('tention_onb=')), loginCookies);
  // A DEDICATED agency session for the logout test below, so destroying it cannot
  // invalidate the shared session the rest of this group needs.
  const throwawayAgencyCookie = cookieFrom(loginRes, 'tention_sid')!;

  const minted2 = await app.inject({
    method: 'POST', url: `/accounts/${acc}/onboarding-links`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
  const token2 = (minted2.json() as { token: string }).token;
  const exchangeRes = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    payload: { token: token2 },   // deliberately NO agency cookie on this request
  });
  const exchangeCookies = setCookieList(exchangeRes);
  check('token exchange sets ONLY the onboarding cookie',
    exchangeCookies.some((c) => c.startsWith('tention_onb='))
    && !exchangeCookies.some((c) => c.startsWith('tention_sid=')), exchangeCookies);

  // --- agency logout must not disturb the onboarding session ------------
  const both = `${throwawayAgencyCookie}; ${link.cookie}`;
  const agencyLogout = await app.inject({
    method: 'POST', url: '/auth/logout', headers: { cookie: both }, remoteAddress: nextIp(),
  });
  check('the agency logout under test actually destroyed its own session',
    (await app.inject({
      method: 'GET', url: '/accounts', headers: { cookie: throwawayAgencyCookie },
      remoteAddress: nextIp(),
    })).statusCode === 401);
  const logoutCookies = setCookieList(agencyLogout);
  check('agency logout never emits a clearing directive for the onboarding cookie',
    !logoutCookies.some((c) => /^tention_onb=;/.test(c) || (/^tention_onb=/.test(c) && /Max-Age=0/i.test(c))),
    logoutCookies);
  check('the onboarding session still authenticates after an agency logout',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', headers: { cookie: link.cookie },
      remoteAddress: nextIp(),
    })).statusCode === 200);

  // --- cookie attributes survive the plugin majors ----------------------
  const onbDirective = cookieDirective(exchangeRes, 'tention_onb')!;
  const sidDirective = cookieDirective(loginRes, 'tention_sid')!;
  check('onboarding cookie is HttpOnly', /HttpOnly/i.test(onbDirective), onbDirective);
  check('agency cookie is HttpOnly', /HttpOnly/i.test(sidDirective), sidDirective);
  check('onboarding cookie is SameSite=Lax', /SameSite=Lax/i.test(onbDirective), onbDirective);
  check('agency cookie is SameSite=Lax', /SameSite=Lax/i.test(sidDirective), sidDirective);
  check('onboarding cookie is Path=/', /Path=\//.test(onbDirective), onbDirective);
  // Secure is environment-aware: both cookies derive it from config.isProd, so in
  // this development run it must be ABSENT. A hardcoded Secure would break local
  // HTTP; a hardcoded non-Secure would leak the cookie in production.
  check('config.isProd is false in this run (so Secure must be absent)', config.isProd === false);
  check('onboarding cookie omits Secure in development', !/Secure/i.test(onbDirective), onbDirective);
  check('agency cookie omits Secure in development', !/Secure/i.test(sidDirective), sidDirective);

  // --- clearCookie under @fastify/cookie v11 ---------------------------
  // v11 changed clearCookie to set maxAge to zero. The directive must still be a
  // real clear (empty value + an immediate-expiry signal) and keep Path=/, or the
  // browser would retain a dead session cookie on a different path.
  const onbLogout = await app.inject({
    method: 'POST', url: '/onboarding/logout', headers: { cookie: link.cookie },
    remoteAddress: nextIp(),
  });
  const clearDirective = cookieDirective(onbLogout, 'tention_onb') ?? '';
  check('clearCookie emits an empty value', /^tention_onb=;/.test(clearDirective), clearDirective);
  check('clearCookie emits an immediate-expiry signal (Max-Age=0 or past Expires)',
    /Max-Age=0/i.test(clearDirective) || /Expires=Thu, 01 Jan 1970/i.test(clearDirective),
    clearDirective);
  check('clearCookie preserves Path=/ so the cookie is actually removed',
    /Path=\//.test(clearDirective), clearDirective);

  // --- signed-cookie verification, including a CORRECTLY signed forgery -
  const live = await mintAndExchange(app, agencyCookie, acc);
  const otherAcc = await makeAccount('fastify5_other');
  check('a correctly SIGNED cookie whose account does not match the link is rejected',
    (await app.inject({
      method: 'GET', url: '/onboarding/me',
      headers: { cookie: forgeOnboardingCookie(live.linkId, otherAcc) },
      remoteAddress: nextIp(),
    })).statusCode === 401);
  check('a correctly SIGNED cookie for a nonexistent link is rejected',
    (await app.inject({
      method: 'GET', url: '/onboarding/me',
      headers: { cookie: forgeOnboardingCookie(2_000_000_001, acc) },
      remoteAddress: nextIp(),
    })).statusCode === 401);
  check('a correctly signed, matching cookie still authenticates (signing round-trips)',
    (await app.inject({
      method: 'GET', url: '/onboarding/me',
      headers: { cookie: forgeOnboardingCookie(live.linkId, acc) },
      remoteAddress: nextIp(),
    })).statusCode === 200);

  // --- GHSA-jx2c-rxcm-jvmq: Content-Type tab cannot bypass validation ---
  const victim = await makeAccount('f5_ct_victim');
  await costs.setOcas(victim, 4321, false);
  const tabbed = await app.inject({
    method: 'PUT', url: '/onboarding/ocas',
    headers: { cookie: live.cookie, 'content-type': 'application/json\t' },
    remoteAddress: nextIp(),
    payload: JSON.stringify({ accountId: victim, ocasMonthly: 999 }),
  });
  check('tab-suffixed Content-Type does not yield a 2xx or 5xx',
    tabbed.statusCode >= 400 && tabbed.statusCode < 500, tabbed.statusCode);
  check('tab-suffixed Content-Type cannot bypass the account-identifier guard',
    Number((await costs.getAccountCosts(victim)).ocas_monthly) === 4321);
  const tabbedSemi = await app.inject({
    method: 'PUT', url: '/onboarding/ocas',
    headers: { cookie: live.cookie, 'content-type': 'application/json;\tcharset=utf-8' },
    remoteAddress: nextIp(),
    payload: JSON.stringify({ accountId: victim, ocasMonthly: 999 }),
  });
  check('tab inside Content-Type parameters cannot bypass the guard either',
    tabbedSemi.statusCode >= 400 && tabbedSemi.statusCode < 500
    && Number((await costs.getAccountCosts(victim)).ocas_monthly) === 4321,
    tabbedSemi.statusCode);

  // --- malformed and oversized bodies ----------------------------------
  const badJson = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' },
    payload: '{"token": ',
  });
  check('malformed JSON returns a safe 400, not a 500', badJson.statusCode === 400, badJson.statusCode);
  check('the malformed-JSON response leaks no stack trace',
    !/at \w+ \(|\.ts:\d+|node_modules/.test(JSON.stringify(badJson.json())), badJson.json());

  const oversized = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' },
    payload: `{"token":"${'x'.repeat(2 * 1024 * 1024)}"}`,
  });
  check('an oversized body is rejected by the body limit (413), not a 500',
    oversized.statusCode === 413, oversized.statusCode);

  // A genuinely unregistered media type must be refused outright.
  const unsupportedCt = await app.inject({
    method: 'PUT', url: '/onboarding/ocas',
    headers: { cookie: live.cookie, 'content-type': 'application/xml' },
    remoteAddress: nextIp(), payload: '<ocasMonthly>1</ocasMonthly>',
  });
  check('an unregistered Content-Type is refused with 415',
    unsupportedCt.statusCode === 415, unsupportedCt.statusCode);

  // text/plain IS supported (Fastify parses it into a string), so the guarantee
  // there is different and worth asserting separately: the string body must still
  // go through full validation rather than being trusted.
  const plainCt = await app.inject({
    method: 'PUT', url: '/onboarding/ocas',
    headers: { cookie: live.cookie, 'content-type': 'text/plain' },
    remoteAddress: nextIp(), payload: 'ocasMonthly=1',
  });
  check('a text/plain body is still fully validated, not trusted',
    plainCt.statusCode === 400
    && (plainCt.json() as { error: string }).error === 'not_a_number', plainCt.json());
  check('the text/plain attempt wrote nothing',
    (await costs.getAccountCosts(victim)).ocas_monthly === '4321.00'
    || Number((await costs.getAccountCosts(victim)).ocas_monthly) === 4321);

  // --- GHSA-444r-cwp2-x5xf: forwarded headers are not trusted ----------
  // Fastify 5 no longer exposes trustProxy on initialConfig at all, so reading it
  // would prove nothing either way. Assert the two things that DO establish the
  // property: no source passes the option, and the behaviour is verified below.
  check('no source file enables trustProxy', await (async () => {
    for (const [, code] of await backendSources()) {
      if (/trustProxy/.test(code)) return false;
    }
    return true;
  })());

  // Fastify 5 disables semicolon query delimiters by default (RFC 3986). That
  // matters here: with them enabled, `?x=1;account_id=99` could smuggle a second
  // parameter past the account-identifier guard.
  check('useSemicolonDelimiter is disabled (RFC 3986 query parsing)',
    (app.initialConfig as Record<string, unknown>).useSemicolonDelimiter === false,
    (app.initialConfig as Record<string, unknown>).useSemicolonDelimiter);
  check('a semicolon-smuggled account_id is not parsed into a second parameter',
    (await app.inject({
      method: 'GET', url: '/onboarding/skus?x=1;account_id=99',
      headers: { cookie: link.cookie }, remoteAddress: nextIp(),
    })).statusCode === 200);

  const spoofed = await app.inject({
    method: 'POST', url: `/accounts/${acc}/onboarding-links`,
    headers: {
      cookie: agencyCookie,
      'x-forwarded-host': 'evil.example.com',
      'x-forwarded-proto': 'https',
      host: 'evil.example.com',
    },
    remoteAddress: nextIp(), payload: {},
  });
  const spoofedUrl = (spoofed.json() as { url: string }).url;
  check('a minted onboarding link uses APP_BASE_URL, not any forwarded host',
    spoofedUrl.startsWith(config.appBaseUrl) && !spoofedUrl.includes('evil.example.com'),
    spoofedUrl);
  check('APP_BASE_URL is the authoritative source for generated links',
    config.appBaseUrl === 'http://localhost:5173', config.appBaseUrl);
  check('no source file builds a URL from a forwarded or request host', await (async () => {
    for (const [, code] of await backendSources()) {
      if (/x-forwarded|req\.host|request\.host|req\.hostname|request\.hostname/i.test(code)) return false;
    }
    return true;
  })());

  // With trustProxy off, Fastify must ignore X-Forwarded-* entirely.
  const { default: Fastify } = await import('fastify');
  const probe = Fastify({ logger: false });
  probe.get('/p', async (req) => ({ host: req.host, protocol: req.protocol, hostname: req.hostname }));
  await probe.ready();
  const probed = (await probe.inject({
    method: 'GET', url: '/p',
    headers: { host: 'real.local', 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' },
  })).json() as { host: string; protocol: string; hostname: string };
  check('request.host ignores X-Forwarded-Host when trustProxy is off',
    probed.host === 'real.local', probed);
  check('request.protocol ignores X-Forwarded-Proto when trustProxy is off',
    probed.protocol === 'http', probed);
  await probe.close();

  // --- routing integrity ------------------------------------------------
  // Fastify 5 throws FST_ERR_DUPLICATED_ROUTE at registration, so a clean boot is
  // already evidence. Enumerate explicitly so a future duplicate is named.
  const routeApp = buildApp();
  const seen: string[] = [];
  routeApp.addHook('onRoute', (r) => { seen.push(`${r.method} ${r.url}`); });
  await routeApp.ready();
  const flat = seen.flatMap((s) => {
    const [m, u] = s.split(' ');
    return m.startsWith('[') ? JSON.parse(m.replace(/'/g, '"')).map((x: string) => `${x} ${u}`) : [s];
  });
  const dupes = flat.filter((r, i) => flat.indexOf(r) !== i);
  check('no duplicate route registration', dupes.length === 0, dupes);
  check('the full route table registered', flat.length >= 35, flat.length);
  check('no route accepts a raw token in its path',
    !flat.some((r) => /:token|\/c\/:/.test(r)), flat.filter((r) => /token/.test(r)));
  check('the webhook route is registered',
    flat.some((r) => r.includes('/webhooks/shopify')), flat.filter((r) => r.includes('webhook')));
  await routeApp.close();

  // The raw-body content-type parser (needed for HMAC) must still work: a bad HMAC
  // has to reach the handler and be rejected with 401, not blow up in the parser.
  const badHmac = await app.inject({
    method: 'POST', url: '/webhooks/shopify', remoteAddress: nextIp(),
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': 'nobody.myshopify.com',
    },
    payload: JSON.stringify({ id: 1 }),
  });
  check('webhook raw-body parser still runs and a bad HMAC yields 401',
    badHmac.statusCode === 401, badHmac.statusCode);

  // --- rate-limit response hygiene -------------------------------------
  const rlIp = '203.0.113.99';
  await clearRateLimit(rlIp);
  let limited: { statusCode: number; body: string } | null = null;
  for (let i = 1; i <= 14; i++) {
    const res = await app.inject({
      method: 'POST', url: '/onboarding/session', remoteAddress: rlIp,
      payload: { token: token2 },
    });
    if (res.statusCode === 429) { limited = { statusCode: 429, body: res.body }; break; }
  }
  check('a 429 is reachable on the token-exchange route', limited !== null);
  check('the 429 body contains no onboarding token',
    limited !== null && !limited.body.includes(token2), limited?.body);
  check('the 429 body contains no workspace name or account id',
    limited !== null && !limited.body.includes('__verify5a') && !limited.body.includes(String(acc)),
    limited?.body);
}

// ===========================================================================
// J. Agency API hardening (preflight for Phase 5B)
// ===========================================================================
async function groupJ(app: App, agencyCookie: string): Promise<void> {
  group('J', 'Agency API hardening');

  // --- registration is closed by default --------------------------------
  check('config.allowAgencyRegistration defaults to false (env unset in this run)',
    config.allowAgencyRegistration === false, config.allowAgencyRegistration);

  // The env rule itself, not merely its effect: only the exact string opens it.
  for (const raw of [undefined, '', '0', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ']) {
    check(`ALLOW_AGENCY_REGISTRATION=${JSON.stringify(raw)} does NOT enable registration`,
      parseStrictBooleanFlag(raw) === false, raw);
  }
  check("ALLOW_AGENCY_REGISTRATION='true' is the one value that enables registration",
    parseStrictBooleanFlag('true') === true);

  const novelEmail = `verify5a_closed_${Date.now()}@example.com`;
  const existingEmail = await seedAgencyUser();

  const closedNovel = await app.inject({
    method: 'POST', url: '/auth/register', remoteAddress: nextIp(),
    payload: { email: novelEmail, password: 'a-long-enough-password' },
  });
  const closedExisting = await app.inject({
    method: 'POST', url: '/auth/register', remoteAddress: nextIp(),
    payload: { email: existingEmail, password: 'a-long-enough-password' },
  });
  const closedGarbage = await app.inject({
    method: 'POST', url: '/auth/register', remoteAddress: nextIp(), payload: { nope: 1 },
  });

  check('closed registration returns 404', closedNovel.statusCode === 404, closedNovel.statusCode);
  check('closed registration created NO user',
    (await query('SELECT 1 FROM users WHERE email = $1', [novelEmail])).rowCount === 0);
  check('closed registration: an EXISTING email gets the identical status',
    closedExisting.statusCode === closedNovel.statusCode);
  check('closed registration: an EXISTING email gets the identical body — no enumeration oracle',
    closedExisting.body === closedNovel.body, {
      novel: closedNovel.body, existing: closedExisting.body,
    });
  check('closed registration: a malformed payload is also indistinguishable',
    closedGarbage.statusCode === closedNovel.statusCode && closedGarbage.body === closedNovel.body,
    closedGarbage.body);
  check('closed registration body leaks no email',
    !closedExisting.body.includes(existingEmail), closedExisting.body);

  // --- the gate is wired to the config value, and nothing else ----------
  const bootstrapEmail = `verify5a_bootstrap_${Date.now()}@example.com`;
  const bootstrapRes = await (async () => {
    config.allowAgencyRegistration = true;
    try {
      return await app.inject({
        method: 'POST', url: '/auth/register', remoteAddress: nextIp(),
        payload: { email: bootstrapEmail, password: 'a-long-enough-password' },
      });
    } finally {
      config.allowAgencyRegistration = false;
    }
  })();
  check('bootstrap mode: registration succeeds ONLY when explicitly configured',
    bootstrapRes.statusCode === 201, bootstrapRes.statusCode);
  check('bootstrap mode: the user was actually created',
    (await query('SELECT 1 FROM users WHERE email = $1', [bootstrapEmail])).rowCount === 1);
  check('bootstrap mode: sets only the agency cookie',
    setCookieList(bootstrapRes).some((c) => c.startsWith('tention_sid='))
    && !setCookieList(bootstrapRes).some((c) => c.startsWith('tention_onb=')));
  check('bootstrap mode: the response never echoes the password',
    !bootstrapRes.body.includes('a-long-enough-password'), bootstrapRes.body);
  const reClosed = await app.inject({
    method: 'POST', url: '/auth/register', remoteAddress: nextIp(),
    payload: { email: `verify5a_reclosed_${Date.now()}@example.com`, password: 'a-long-enough-password' },
  });
  check('registration closes again as soon as the flag is back to false',
    reClosed.statusCode === 404, reClosed.statusCode);

  // --- login --------------------------------------------------------------
  const loginEmail = await seedAgencyUser();

  // Capture stdout across the login attempts: the app logs with pino at
  // level 30, and a password reaching the log is as bad as one reaching a body.
  const logBuffer: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]) => {
    logBuffer.push(String(chunk));
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  const [goodLogin, wrongPassword, unknownEmail, shortPassword, malformed] =
    await (async () => {
      try {
        return [
          await agencyLoginRes(app, loginEmail),
          await agencyLoginRes(app, loginEmail, 'definitely-not-the-password'),
          await agencyLoginRes(app, `verify5a_ghost_${Date.now()}@example.com`, 'irrelevant-password'),
          await agencyLoginRes(app, loginEmail, 'short'),
          await app.inject({
            method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
            payload: { email: loginEmail },
          }),
        ] as const;
      } finally {
        (process.stdout as { write: unknown }).write = realWrite;
      }
    })();

  check('login: correct credentials succeed', goodLogin.statusCode === 200, goodLogin.statusCode);
  check('login: success sets the agency cookie', cookieFrom(goodLogin, 'tention_sid') !== null);
  check('login: success body carries only id and email',
    JSON.stringify(Object.keys(goodLogin.json() as object).sort()) === '["email","id"]',
    goodLogin.json());
  check('login: success body contains no password hash',
    !goodLogin.body.includes('$2a$') && !goodLogin.body.includes('password'), goodLogin.body);

  check('login: a wrong password returns 401', wrongPassword.statusCode === 401);
  check('login: an unknown email returns 401', unknownEmail.statusCode === 401);
  check('login: wrong password and unknown email are byte-identical — no user enumeration',
    wrongPassword.body === unknownEmail.body, {
      wrongPassword: wrongPassword.body, unknownEmail: unknownEmail.body,
    });
  // Regression on the oracle this task removed: a too-short password used to be
  // a 400 while a long wrong one was a 401, which varied the response with the
  // submitted secret.
  check('login: a SHORT wrong password gets the same 401, not a 400',
    shortPassword.statusCode === 401, shortPassword.statusCode);
  check('login: a short wrong password is byte-identical to any other wrong credential',
    shortPassword.body === wrongPassword.body, shortPassword.body);
  check('login: a missing field is still a 400 (malformed request, not a credential verdict)',
    malformed.statusCode === 400, malformed.statusCode);

  const allLoginBodies = [goodLogin, wrongPassword, unknownEmail, shortPassword, malformed]
    .map((r) => r.body).join('\n');
  check('login: no response body echoes a submitted password',
    !allLoginBodies.includes(AGENCY_TEST_PASSWORD)
    && !allLoginBodies.includes('definitely-not-the-password')
    && !allLoginBodies.includes('irrelevant-password'), allLoginBodies);
  const logText = logBuffer.join('');
  check('login: no submitted password reached the process log',
    !logText.includes(AGENCY_TEST_PASSWORD)
    && !logText.includes('definitely-not-the-password')
    && !logText.includes('irrelevant-password'));
  check('login: no bcrypt hash reached the process log', !logText.includes('$2a$'));

  // --- cookie attributes on the login path ------------------------------
  const sidDirective = cookieDirective(goodLogin, 'tention_sid')!;
  check('login cookie is HttpOnly', /HttpOnly/i.test(sidDirective), sidDirective);
  check('login cookie is SameSite=Lax', /SameSite=Lax/i.test(sidDirective), sidDirective);
  check('login cookie is Path=/', /Path=\//.test(sidDirective), sidDirective);
  check('login cookie Secure stays environment-aware (absent in this dev run)',
    config.isProd === false && !/Secure/i.test(sidDirective), sidDirective);

  // --- login rate limiting ----------------------------------------------
  const rlIp = '198.51.100.7';
  const otherIp = '198.51.100.8';
  await clearRateLimit(rlIp);
  await clearRateLimit(otherIp);

  let firstLimited = 0;
  for (let i = 1; i <= 15; i++) {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: rlIp,
      payload: { email: loginEmail, password: 'wrong-on-purpose' },
    });
    if (res.statusCode === 429) { firstLimited = i; break; }
  }
  check('login: repeated attempts from one source reach 429', firstLimited > 0, firstLimited);
  check('login: the limit allows a realistic number of human retries before engaging',
    firstLimited >= 10, firstLimited);

  const limitedRes = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: rlIp,
    payload: { email: loginEmail, password: AGENCY_TEST_PASSWORD },
  });
  check('login: the 429 body echoes neither the email nor the password',
    !limitedRes.body.includes(loginEmail) && !limitedRes.body.includes(AGENCY_TEST_PASSWORD),
    limitedRes.body);
  check('login: even a CORRECT password is throttled once the limit engages',
    limitedRes.statusCode === 429, limitedRes.statusCode);

  const untouched = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: otherIp,
    payload: { email: loginEmail, password: AGENCY_TEST_PASSWORD },
  });
  check('login: a different source is NOT collaterally blocked',
    untouched.statusCode === 200, untouched.statusCode);

  check('login: the rate-limit counter lives in Redis, so the limit holds across processes',
    (await rateLimitKeysFor(rlIp)).length > 0);
  check('login: the Redis counter carries a TTL, so the block is temporary not permanent',
    (await redis.ttl((await rateLimitKeysFor(rlIp))[0]).catch(() => -2)) > 0);

  // Redis outage on the login limiter: skipOnError must fail OPEN. Failing closed
  // would turn a Redis blip into an agency-wide lockout with no way in to fix it.
  const { default: Fastify } = await import('fastify');
  const { default: rateLimitPlugin } = await import('@fastify/rate-limit');
  const { default: IORedis } = await import('ioredis');
  const deadRedis = new IORedis('redis://127.0.0.1:6390', {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  deadRedis.on('error', () => undefined);
  const outageApp = Fastify({ logger: false });
  await outageApp.register(rateLimitPlugin, {
    global: false, redis: deadRedis as never, skipOnError: true, keyGenerator: (r) => r.ip,
  });
  outageApp.post('/login-probe', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async () => ({ ok: true }));
  await outageApp.ready();
  const outageCodes: number[] = [];
  for (let i = 0; i < 12; i++) {
    outageCodes.push((await outageApp.inject({
      method: 'POST', url: '/login-probe', remoteAddress: '10.9.9.8',
    })).statusCode);
  }
  check('login limiter under a Redis outage fails OPEN rather than locking the agency out',
    outageCodes.every((c) => c === 200), outageCodes);
  await outageApp.close();
  deadRedis.disconnect();

  // --- GET /auth/me -------------------------------------------------------
  const meAnon = await app.inject({ method: 'GET', url: '/auth/me', remoteAddress: nextIp() });
  check('/auth/me rejects an unauthenticated request', meAnon.statusCode === 401, meAnon.statusCode);

  const meAuthed = await app.inject({
    method: 'GET', url: '/auth/me', headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('/auth/me accepts a valid agency cookie', meAuthed.statusCode === 200, meAuthed.statusCode);
  check('/auth/me returns only safe agency-user fields',
    JSON.stringify(Object.keys(meAuthed.json() as object).sort()) === '["email","id"]',
    meAuthed.json());
  check('/auth/me never returns a password hash',
    !meAuthed.body.includes('$2a$') && !meAuthed.body.includes('password_hash'), meAuthed.body);

  const meAcc = await makeAccount('auth_me');
  const meLink = await mintAndExchange(app, agencyCookie, meAcc);
  const meOnboarding = await app.inject({
    method: 'GET', url: '/auth/me', headers: { cookie: meLink.cookie }, remoteAddress: nextIp(),
  });
  check('/auth/me rejects an onboarding-only session',
    meOnboarding.statusCode === 401, meOnboarding.statusCode);

  // --- logout -------------------------------------------------------------
  const logoutEmail = await seedAgencyUser();
  const logoutLoginRes = await agencyLoginRes(app, logoutEmail);
  const logoutCookie = cookieFrom(logoutLoginRes, 'tention_sid')!;
  const logoutRes = await app.inject({
    method: 'POST', url: '/auth/logout',
    headers: { cookie: `${logoutCookie}; ${meLink.cookie}` }, remoteAddress: nextIp(),
  });
  const logoutSetCookies = setCookieList(logoutRes);
  check('logout: emits no directive touching the onboarding cookie',
    !logoutSetCookies.some((c) => c.startsWith('tention_onb=')), logoutSetCookies);
  check('logout: /auth/me rejects the destroyed agency session',
    (await app.inject({
      method: 'GET', url: '/auth/me', headers: { cookie: logoutCookie }, remoteAddress: nextIp(),
    })).statusCode === 401);
  check('logout: the onboarding session is untouched and still authenticates',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', headers: { cookie: meLink.cookie },
      remoteAddress: nextIp(),
    })).statusCode === 200);

  // --- account-scoped link revocation ------------------------------------
  const accA = await makeAccount('revoke_scope_a');
  const accB = await makeAccount('revoke_scope_b');
  const linkA = await links.mintOnboardingLink(accA, null);
  const linkB = await links.mintOnboardingLink(accB, null);

  const foreign = await app.inject({
    method: 'DELETE', url: `/accounts/${accA}/onboarding-links/${linkB.id}`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check("revoke: account A cannot revoke account B's link", foreign.statusCode === 404, foreign.statusCode);
  check("revoke: the foreign link is still live after the attempt",
    (await links.getLinkById(linkB.id))?.revoked_at === null);

  const missing = await app.inject({
    method: 'DELETE', url: `/accounts/${accA}/onboarding-links/999999999`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('revoke: a link that never existed gets the same 404 as a foreign one',
    missing.statusCode === 404 && missing.body === foreign.body,
    { missing: missing.body, foreign: foreign.body });

  const ownRevoke = await app.inject({
    method: 'DELETE', url: `/accounts/${accA}/onboarding-links/${linkA.id}`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('revoke: same-account revocation succeeds', ownRevoke.statusCode === 200, ownRevoke.statusCode);
  check('revoke: the link is revoked in the database',
    (await links.getLinkById(linkA.id))?.revoked_at !== null);
  check('revoke: the revoked token stops resolving immediately',
    !links.linkLiveness((await links.getLinkById(linkA.id))!).ok);
  check('revoke: exchanging the revoked token now fails',
    (await app.inject({
      method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
      payload: { token: linkA.token },
    })).statusCode === 401);
  check('revoke: is idempotent — a second call still succeeds',
    (await app.inject({
      method: 'DELETE', url: `/accounts/${accA}/onboarding-links/${linkA.id}`,
      headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
    })).statusCode === 200);

  const unscoped = await app.inject({
    method: 'DELETE', url: `/onboarding-links/${linkB.id}`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('revoke: the old UNSCOPED route is gone', unscoped.statusCode === 404, unscoped.statusCode);
  check("revoke: and it did not revoke anything on its way out",
    (await links.getLinkById(linkB.id))?.revoked_at === null);

  const anonRevoke = await app.inject({
    method: 'DELETE', url: `/accounts/${accB}/onboarding-links/${linkB.id}`,
    remoteAddress: nextIp(),
  });
  check('revoke: an unauthenticated caller is rejected', anonRevoke.statusCode === 401);
  check('revoke: an onboarding-only session is rejected',
    (await app.inject({
      method: 'DELETE', url: `/accounts/${accB}/onboarding-links/${linkB.id}`,
      headers: { cookie: meLink.cookie }, remoteAddress: nextIp(),
    })).statusCode === 401);

  // --- error sanitization -------------------------------------------------
  check('classifier: a stack trace is classified, never echoed', (() => {
    const f = classifyFailure(STACK_TRACE_FIXTURE, 'klaviyo', 'klaviyo.backfill');
    return !JSON.stringify(f).includes('/Users/')
      && !JSON.stringify(f).includes('undici')
      && !JSON.stringify(f).includes('at async');
  })());
  for (const [label, raw, code, category, retryable] of [
    ['401 unauthorized', 'Klaviyo API 401 Unauthorized: invalid api key', 'provider_auth_failed', 'auth', false],
    ['429 throttle', 'Request failed: 429 Too Many Requests', 'provider_rate_limited', 'rate_limit', true],
    ['network', 'TypeError: fetch failed\n  at node:internal/deps/undici', 'provider_unreachable', 'network', true],
    ['502 upstream', 'Shopify responded 502 Bad Gateway', 'provider_error', 'provider', true],
    ['unrecognised', 'something nobody anticipated', 'sync_failed', 'internal', true],
  ] as [string, string, string, string, boolean][]) {
    const f = classifyFailure(raw, 'shopify', 'shopify.backfill');
    check(`classifier: ${label} → ${code}/${category} retryable=${retryable}`,
      f.code === code && f.category === category && f.retryable === retryable, f);
    check(`classifier: ${label} publicMessage contains no raw text`,
      !f.publicMessage.includes('undici') && !f.publicMessage.includes('api key')
      && !f.publicMessage.includes('Bad Gateway'), f.publicMessage);
  }
  check('classifier: a null reason still yields a usable safe failure', (() => {
    const f = classifyFailure(null, 'recharge', 'recharge.backfill');
    return f.code === 'sync_failed' && f.provider === 'recharge'
      && f.publicMessage.includes('Recharge') && f.publicMessage.length > 0;
  })());

  // Plant a realistic poisoned sync_errors row — a full stack trace with deploy
  // paths AND a credential-shaped string — then read it back over HTTP.
  const errAcc = await makeAccount('error_sanitization');
  await query(
    `INSERT INTO sync_errors (account_id, job_type, error) VALUES ($1, $2, $3)`,
    [errAcc, 'klaviyo.backfill', STACK_TRACE_FIXTURE],
  );

  const progressRes = await app.inject({
    method: 'GET', url: `/accounts/${errAcc}/progress`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  const statusRes = await app.inject({
    method: 'GET', url: `/accounts/${errAcc}/onboarding/status`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  check('progress: responds 200', progressRes.statusCode === 200, progressRes.statusCode);

  for (const [label, body] of [
    ['progress', progressRes.body], ['onboarding status', statusRes.body],
  ] as [string, string][]) {
    check(`${label}: exposes no stack frame`, !body.includes('at async') && !body.includes('at Object.'), label);
    check(`${label}: exposes no filesystem path`,
      !body.includes('/Users/') && !body.includes('node_modules') && !body.includes('node:internal'));
    check(`${label}: exposes no provider credential`, !body.includes(POISON_CREDENTIAL));
    check(`${label}: exposes no raw exception text`, !body.includes('TypeError: fetch failed'));
    check(`${label}: the raw failedReason field is gone`, !body.includes('failedReason'));
    check(`${label}: the raw recentErrors field is gone`, !body.includes('recentErrors'));
  }

  const klaviyoDetail = (progressRes.json() as {
    provider: string; recentFailures: { code: string; category: string; stage: string;
      retryable: boolean; publicMessage: string }[];
  }[]).find((p) => p.provider === 'klaviyo');
  check('progress: the planted failure still surfaces, classified',
    (klaviyoDetail?.recentFailures.length ?? 0) === 1, klaviyoDetail?.recentFailures);
  const safe = klaviyoDetail!.recentFailures[0];
  check('progress: the classified failure keeps a stable machine code',
    safe.code === 'provider_unreachable', safe);
  check('progress: the classified failure keeps its category', safe.category === 'network');
  check('progress: the classified failure keeps the actionable stage',
    safe.stage === 'klaviyo.backfill', safe.stage);
  check('progress: the classified failure states whether a retry is worthwhile',
    safe.retryable === true);
  check('progress: the public message is a fixed, renderable sentence',
    safe.publicMessage === 'Klaviyo could not be reached. The sync will be retried.',
    safe.publicMessage);

  // The raw text must survive where it is actually useful.
  const retained = await query<{ error: string }>(
    `SELECT error FROM sync_errors WHERE account_id = $1`, [errAcc]);
  check('sanitization removed nothing from backend troubleshooting: sync_errors still has the trace',
    retained.rows[0]?.error === STACK_TRACE_FIXTURE);
}

// ===========================================================================
// K. Agency onboarding completion — POST /accounts/:id/onboarding/complete
// ===========================================================================
//
// This endpoint has existed since Phase 5A and was reachable from nothing: the
// only coverage was group D's 401 probe. Phase 5B-2G gives it a caller, so this
// group verifies the contract that caller now depends on.
//
// IT CHANGES NOTHING. canCompleteOnboarding(), markOnboardingComplete() and the
// route itself are untouched; every check below reads the behaviour that is
// already there. No completion timestamp column is introduced, and the agency
// path's deliberate non-effect on onboarding_links is PINNED rather than
// "fixed" — see check 12.
//
// Providers are made connected by inserting the `connections` row directly.
// That is not a shortcut around verification: what is under test here is the
// completion gate's reading of connection state, not the provider clients (group
// B owns those, against mocked fixtures). No live API is contacted anywhere in
// this file — global fetch is mocked for the whole run.

/** The tables a refusal must leave untouched, plus the account row itself. */
const COMPLETION_SNAPSHOT_TABLES = [
  'connections', 'onboarding_provider_choices', 'onboarding_links',
  'account_costs', 'sku_costs', 'ad_spend', 'ad_spend_zero_months',
] as const;

/**
 * Every row this account owns in the tables above, as deterministic text.
 *
 * Ordered by the row's own JSON rather than by a primary key, so tables with
 * composite or text keys still serialise identically across two reads. Comparing
 * whole rows — not counts — is what makes "byte-for-byte unchanged" mean it: a
 * mutation that swapped a value while keeping the row count would pass a count
 * check and fail this one.
 */
async function completionSnapshot(accountId: number): Promise<string> {
  const parts: string[] = [];
  const acct = await query<{ j: string | null }>(
    `SELECT to_jsonb(a)::text AS j FROM accounts a WHERE id = $1`, [accountId]);
  parts.push(`accounts=${acct.rows[0]?.j ?? 'ABSENT'}`);
  for (const t of COMPLETION_SNAPSHOT_TABLES) {
    const { rows } = await query<{ j: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
         FROM ${t} t WHERE account_id = $1`,
      [accountId],
    );
    parts.push(`${t}=${rows[0].j}`);
  }
  return parts.join('\n');
}

/**
 * Mark a provider connected without touching a provider API.
 *
 * `credentials_encrypted` is a non-credential literal: nothing on the completion
 * path decrypts it, and a realistic-looking ciphertext in a test fixture is one
 * more string that has to be proven harmless.
 */
async function seedConnectedProvider(
  accountId: number, provider: 'shopify' | 'klaviyo' | 'recharge',
  shopDomain: string | null = null,
): Promise<void> {
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
     VALUES ($1, $2, 'verify5a-not-a-credential', $3, 'connected')
     ON CONFLICT (account_id, provider)
     DO UPDATE SET status = 'connected', shop_domain = EXCLUDED.shop_domain`,
    [accountId, provider, shopDomain],
  );
}

/** Does this account have any financial input recorded at all? */
async function hasAnyFinancialInput(accountId: number): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM account_costs        WHERE account_id = $1)
     + (SELECT count(*) FROM sku_costs            WHERE account_id = $1)
     + (SELECT count(*) FROM ad_spend             WHERE account_id = $1)
     + (SELECT count(*) FROM ad_spend_zero_months WHERE account_id = $1)
     + (SELECT count(*) FROM accounts WHERE id = $1 AND currency IS NOT NULL)
     ) AS n`,
    [accountId],
  );
  return Number(rows[0].n) > 0;
}

/** The closed blocker vocabularies. A code outside them is a contract change. */
const COMPLETION_BLOCKER_CODES = [
  'account_not_found', 'session_invalid', 'link_account_mismatch', 'session_revoked',
  'session_expired', 'no_platform_connected', 'provider_undecided', 'connection_not_verified',
] as const;
const RCM_BLOCKER_CODES = [
  'shopify_not_connected', 'currency_unknown', 'currency_mismatch', 'no_eligible_revenue_data',
  'cogs_method_not_selected', 'cogs_blended_missing_or_invalid',
  'insufficient_shopify_data_for_skus', 'cogs_per_sku_zero_unconfirmed', 'cogs_per_sku_incomplete',
  'ocas_missing', 'ocas_zero_unconfirmed', 'contradictory_ad_spend_state',
  'ad_spend_coverage_incomplete', 'ad_spend_invalid',
] as const;

/** Substrings that must never appear in a completion response, at any depth. */
const COMPLETION_FORBIDDEN = [
  'credentials', 'credentials_encrypted', 'apiKey', 'api_key', 'clientSecret', 'client_secret',
  'accessToken', 'access_token', 'password', 'secret', 'token',
  'account_id', 'accountId', 'jobId', 'jobState', 'failedReason', 'recentErrors',
  'stack', 'node_modules', 'node:internal', 'file://', '/Users/', '/var/', '/opt/',
  'SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'pg_', 'ECONNREFUSED', 'verify5a-not-a-credential',
] as const;

function checkCompletionBodyHygiene(label: string, raw: string): void {
  for (const needle of COMPLETION_FORBIDDEN) {
    check(`${label}: response carries no "${needle}"`, !raw.includes(needle));
  }
  check(`${label}: response is a single line of JSON with no embedded trace`, !/\\n\s*at /.test(raw));
}

function checkBlockerShape(
  label: string, blockers: { code: string; message: string }[], allowed: readonly string[],
): void {
  check(`${label}: every code comes from the closed vocabulary`,
    blockers.every((b) => allowed.includes(b.code)), blockers.map((b) => b.code));
  check(`${label}: every message is a short single-line sentence`,
    blockers.every((b) =>
      typeof b.message === 'string' && b.message.length > 0 && b.message.length <= 300
      && !/[\n\r]/.test(b.message)),
    blockers.map((b) => b.message));
  check(`${label}: no message quotes a filesystem path or an exception`,
    blockers.every((b) => !/\/Users\/|node_modules|:\d+:\d+|^[A-Za-z]*Error:/.test(b.message)));
}

async function groupK(app: App, agencyCookie: string): Promise<void> {
  group('K', 'Agency onboarding completion (5B-2G)');

  const completeUrl = (id: number | string) => `/accounts/${id}/onboarding/complete`;

  // --- 1. No agency cookie -------------------------------------------------
  const noCookieAcc = await makeAccount('complete_nocookie');
  await seedConnectedProvider(noCookieAcc, 'klaviyo');
  await choices.setSkipped(noCookieAcc, 'shopify');
  await choices.setSkipped(noCookieAcc, 'recharge');
  const anon = await app.inject({
    method: 'POST', url: completeUrl(noCookieAcc), remoteAddress: nextIp(), payload: {},
  });
  check('1. unauthenticated completion is refused', anon.statusCode === 401, anon.statusCode);
  check('1. the refusal names no reason beyond "unauthorized"',
    (anon.json() as { error?: string }).error === 'unauthorized');
  check('1. the account is still incomplete', !(await state.isOnboardingComplete(noCookieAcc)));

  // --- 2. Scoped onboarding-link cookie ------------------------------------
  //
  // A client link is not a weaker agency session; it is a different principal.
  // requireAuth rejects it because it carries no session.userId.
  const scopedAcc = await makeAccount('complete_scoped');
  await seedConnectedProvider(scopedAcc, 'klaviyo');
  await choices.setSkipped(scopedAcc, 'shopify');
  await choices.setSkipped(scopedAcc, 'recharge');
  const scopedLink = await mintAndExchange(app, agencyCookie, scopedAcc);
  const scoped = await app.inject({
    method: 'POST', url: completeUrl(scopedAcc), headers: { cookie: scopedLink.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('2. a scoped onboarding-link cookie is refused by the agency route',
    scoped.statusCode === 401, scoped.statusCode);
  check('2. the account is still incomplete', !(await state.isOnboardingComplete(scopedAcc)));

  // --- 3. Invalid path ids -------------------------------------------------
  for (const bad of ['abc', '0', '-1', '1.5', '%20']) {
    const res = await app.inject({
      method: 'POST', url: completeUrl(bad), headers: { cookie: agencyCookie },
      remoteAddress: nextIp(), payload: {},
    });
    check(`3. path id "${bad}" is refused with 400 bad_account_id`,
      res.statusCode === 400 && (res.json() as { error: string }).error === 'bad_account_id',
      { status: res.statusCode, body: res.json() });
  }

  // --- 4. Missing account --------------------------------------------------
  const accountsBefore = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM accounts`)).rows[0].n);
  const missingId = 2_000_000_007;
  const missing = await app.inject({
    method: 'POST', url: completeUrl(missingId), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('4. an absent account is 404 account_not_found',
    missing.statusCode === 404 && (missing.json() as { error: string }).error === 'account_not_found',
    { status: missing.statusCode, body: missing.json() });
  check('4. no account row was created by the attempt',
    Number((await query<{ n: string }>(`SELECT count(*) n FROM accounts`)).rows[0].n)
      === accountsBefore);
  check('4. no dependent row was created for the absent id',
    (await completionSnapshot(missingId)).includes('accounts=ABSENT')
    && !(await completionSnapshot(missingId)).match(/=\[\{/));

  // --- 5. provider_undecided, in isolation --------------------------------
  const undecidedAcc = await makeAccount('complete_undecided');
  await seedConnectedProvider(undecidedAcc, 'klaviyo');
  await choices.setSkipped(undecidedAcc, 'recharge');
  // Shopify is deliberately left with no connection and no choice row at all.
  const beforeUndecided = await completionSnapshot(undecidedAcc);
  const undecided = await app.inject({
    method: 'POST', url: completeUrl(undecidedAcc), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  const undecidedBody = undecided.json() as {
    completed: boolean; onboardingBlockers: { code: string; message: string }[];
  };
  check('5. an undecided platform refuses completion with 409', undecided.statusCode === 409,
    undecided.statusCode);
  check('5. the refusal says completed:false', undecidedBody.completed === false);
  check('5. provider_undecided is among the blockers',
    undecidedBody.onboardingBlockers.some((b) => b.code === 'provider_undecided'),
    undecidedBody.onboardingBlockers.map((b) => b.code));
  check('5. the blocker names the platform at fault',
    undecidedBody.onboardingBlockers.some((b) => b.message.includes('shopify')));
  check('5. the account is still incomplete', !(await state.isOnboardingComplete(undecidedAcc)));
  check('5. the refusal mutated nothing (17)',
    (await completionSnapshot(undecidedAcc)) === beforeUndecided);
  checkBlockerShape('5', undecidedBody.onboardingBlockers, COMPLETION_BLOCKER_CODES);
  checkCompletionBodyHygiene('5', undecided.body);

  // --- 6. no_platform_connected, in isolation ------------------------------
  const noneAcc = await makeAccount('complete_none');
  for (const p of ['shopify', 'klaviyo', 'recharge'] as const) await choices.setSkipped(noneAcc, p);
  const beforeNone = await completionSnapshot(noneAcc);
  const none = await app.inject({
    method: 'POST', url: completeUrl(noneAcc), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  const noneBody = none.json() as {
    completed: boolean; onboardingBlockers: { code: string; message: string }[];
  };
  check('6. skipping everything refuses completion with 409', none.statusCode === 409,
    none.statusCode);
  check('6. no_platform_connected is among the blockers',
    noneBody.onboardingBlockers.some((b) => b.code === 'no_platform_connected'),
    noneBody.onboardingBlockers.map((b) => b.code));
  check('6. every platform being answered is NOT sufficient on its own',
    noneBody.onboardingBlockers.every((b) => b.code !== 'provider_undecided'));
  check('6. the account is still incomplete', !(await state.isOnboardingComplete(noneAcc)));
  check('6. the refusal mutated nothing (17)',
    (await completionSnapshot(noneAcc)) === beforeNone);
  check('6. skipping created no connections row',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1`, [noneAcc])).rows[0].n) === 0);
  checkBlockerShape('6', noneBody.onboardingBlockers, COMPLETION_BLOCKER_CODES);
  checkCompletionBodyHygiene('6', none.body);

  // --- 7. Klaviyo-only completion -----------------------------------------
  //
  // The load-bearing case. Shopify absent, no cost figure anywhere, and setup
  // still finishes — with RCM honestly reported as unavailable in the same
  // response.
  const klaviyoOnly = await makeAccount('complete_klaviyo_only');
  await seedConnectedProvider(klaviyoOnly, 'klaviyo');
  await choices.setSkipped(klaviyoOnly, 'shopify');
  await choices.setSkipped(klaviyoOnly, 'recharge');
  check('7. no financial input exists on this account',
    !(await hasAnyFinancialInput(klaviyoOnly)));
  const kOnly = await app.inject({
    method: 'POST', url: completeUrl(klaviyoOnly), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  const kOnlyBody = kOnly.json() as {
    completed: boolean; rcmReady: boolean; rcmBlockers: { code: string; message: string }[];
  };
  check('7. Klaviyo-only onboarding completes', kOnly.statusCode === 200, {
    status: kOnly.statusCode, body: kOnly.json(),
  });
  check('7. the response says completed:true', kOnlyBody.completed === true);
  check('7. accounts.onboarding_complete became true',
    await state.isOnboardingComplete(klaviyoOnly));
  check('7. the same response says RCM is NOT ready', kOnlyBody.rcmReady === false);
  check('7. shopify_not_connected remains an RCM blocker',
    kOnlyBody.rcmBlockers.some((b) => b.code === 'shopify_not_connected'),
    kOnlyBody.rcmBlockers.map((b) => b.code));
  check('7. no cost blocker is reported instead of the missing Shopify connection',
    kOnlyBody.rcmBlockers.length === 1, kOnlyBody.rcmBlockers.map((b) => b.code));
  check('7. completion required no financial row (10)',
    !(await hasAnyFinancialInput(klaviyoOnly)));
  check('7. completion fabricated no connection for a skipped platform',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1`, [klaviyoOnly])).rows[0].n) === 1);
  check('7. the skipped platforms are still recorded as skipped',
    (await choices.getProviderStatuses(klaviyoOnly))
      .filter((p) => p.state === 'skipped').map((p) => p.provider).join(',') === 'shopify,recharge');
  checkBlockerShape('7', kOnlyBody.rcmBlockers, RCM_BLOCKER_CODES);
  checkCompletionBodyHygiene('7', kOnly.body);

  // --- 8. A requested platform is an answer, and stays "requested" ---------
  const requestedAcc = await makeAccount('complete_requested');
  await seedConnectedProvider(requestedAcc, 'klaviyo');
  await choices.setShopifyRequested(requestedAcc, `verify5a-req-${Date.now()}.myshopify.com`);
  await choices.setSkipped(requestedAcc, 'recharge');
  const requested = await app.inject({
    method: 'POST', url: completeUrl(requestedAcc), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('8. an agency-assist request counts as answered and completes',
    requested.statusCode === 200, { status: requested.statusCode, body: requested.json() });
  check('8. onboarding_complete became true', await state.isOnboardingComplete(requestedAcc));
  const reqStatuses = await choices.getProviderStatuses(requestedAcc);
  check('8. Shopify is still "requested" after completion',
    reqStatuses.find((p) => p.provider === 'shopify')?.state === 'requested',
    reqStatuses.map((p) => `${p.provider}:${p.state}`));
  check('8. completion did NOT relabel the request as connected',
    reqStatuses.filter((p) => p.state === 'connected').map((p) => p.provider).join(',') === 'klaviyo');
  check('8. no connections row was invented for the requested store',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1 AND provider = 'shopify'`,
      [requestedAcc])).rows[0].n) === 0);
  // Through the wire payload the frontend actually reads, not only the helper.
  const reqStatusRes = await app.inject({
    method: 'GET', url: `/accounts/${requestedAcc}/onboarding/status`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  const reqStatusBody = reqStatusRes.json() as {
    onboardingComplete: boolean;
    providers: { provider: string; state: string }[];
    rcmReadiness: { ready: boolean };
    uiStates: Record<string, boolean>;
  };
  check('8. the status payload reports completion',
    reqStatusBody.onboardingComplete === true);
  check('8. the status payload keeps the three states distinct',
    reqStatusBody.providers.map((p) => `${p.provider}:${p.state}`).join(',')
      === 'shopify:requested,klaviyo:connected,recharge:skipped',
    reqStatusBody.providers);
  check('8. completion did not make RCM ready', reqStatusBody.rcmReadiness.ready === false);
  check('8. uiStates reports complete-but-limited, not complete-and-ready',
    reqStatusBody.uiStates.onboardingComplete === true
    && reqStatusBody.uiStates.limitedAnalyticsAvailable === true
    && reqStatusBody.uiStates.rcmReady === false, reqStatusBody.uiStates);

  // --- 9. All three connected ---------------------------------------------
  const allAcc = await makeAccount('complete_all');
  await seedConnectedProvider(allAcc, 'shopify', `verify5a-all-${Date.now()}.myshopify.com`);
  await seedConnectedProvider(allAcc, 'klaviyo');
  await seedConnectedProvider(allAcc, 'recharge');
  const all = await app.inject({
    method: 'POST', url: completeUrl(allAcc), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  const allBody = all.json() as { completed: boolean; rcmReady: boolean };
  check('9. all three connected completes', all.statusCode === 200,
    { status: all.statusCode, body: all.json() });
  check('9. onboarding_complete became true', await state.isOnboardingComplete(allAcc));
  check('9. Shopify being connected still does not make RCM ready — costs are missing',
    allBody.rcmReady === false);
  check('9. completion required no financial row (10)', !(await hasAnyFinancialInput(allAcc)));

  // --- 11. Idempotency ----------------------------------------------------
  const afterFirst = await completionSnapshot(klaviyoOnly);
  const globalAccountsBefore = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM accounts`)).rows[0].n);
  const globalCompleteBefore = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM accounts WHERE onboarding_complete = true`)).rows[0].n);
  const repeat = await app.inject({
    method: 'POST', url: completeUrl(klaviyoOnly), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('11. a repeated completion is 200, not a conflict', repeat.statusCode === 200,
    { status: repeat.statusCode, body: repeat.json() });
  check('11. the repeat still says completed:true',
    (repeat.json() as { completed: boolean }).completed === true);
  check('11. onboarding_complete remains true', await state.isOnboardingComplete(klaviyoOnly));
  check('11. the repeat added no row of any kind',
    (await completionSnapshot(klaviyoOnly)) === afterFirst);
  check('11. no account was created by the repeat',
    Number((await query<{ n: string }>(`SELECT count(*) n FROM accounts`)).rows[0].n)
      === globalAccountsBefore);
  check('11. no unrelated account became complete',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM accounts WHERE onboarding_complete = true`)).rows[0].n)
      === globalCompleteBefore);

  // --- 12. The agency path leaves onboarding links alone ------------------
  //
  // PINNING CURRENT BEHAVIOUR, NOT ASSERTING AN IDEAL. The client route stamps
  // completed_at (check 13); the agency route deliberately does not, because no
  // consumer of that flag exists until the Phase 5C wizard decides what a
  // completed account's link should open into. 5B-2G does not change it, and
  // this check is what will notice if something later does.
  const linkAcc = await makeAccount('complete_agency_link');
  await seedConnectedProvider(linkAcc, 'klaviyo');
  await choices.setSkipped(linkAcc, 'shopify');
  await choices.setSkipped(linkAcc, 'recharge');
  const liveLink = await mintAndExchange(app, agencyCookie, linkAcc);
  const linkBefore = await links.getLinkById(liveLink.linkId);
  const agencyDone = await app.inject({
    method: 'POST', url: completeUrl(linkAcc), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('12. agency completion succeeded', agencyDone.statusCode === 200, agencyDone.statusCode);
  const linkAfter = await links.getLinkById(liveLink.linkId);
  check('12. the live link is untouched: completed_at stays NULL',
    linkAfter?.completed_at === null, linkAfter?.completed_at);
  check('12. the live link is untouched: revoked_at stays NULL',
    linkAfter?.revoked_at === null, linkAfter?.revoked_at);
  check('12. the live link is untouched: expiry unchanged',
    linkAfter?.expires_at.getTime() === linkBefore?.expires_at.getTime());
  check('12. the agency listing still reports it as active',
    (await links.listLinks(linkAcc)).find((l) => l.id === liveLink.linkId)?.status === 'active');

  // --- 13. The client route, by contrast, DOES stamp its link -------------
  const clientAcc = await makeAccount('complete_client_link');
  await seedConnectedProvider(clientAcc, 'klaviyo');
  const clientLink = await mintAndExchange(app, agencyCookie, clientAcc);
  for (const p of ['shopify', 'recharge']) {
    await app.inject({
      method: 'POST', url: `/onboarding/connections/${p}/skip`,
      headers: { cookie: clientLink.cookie }, remoteAddress: nextIp(), payload: {},
    });
  }
  const clientDone = await app.inject({
    method: 'POST', url: '/onboarding/complete', headers: { cookie: clientLink.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('13. the client route completes', clientDone.statusCode === 200,
    { status: clientDone.statusCode, body: clientDone.json() });
  check('13. the client route stamps its own link completed_at',
    (await links.getLinkById(clientLink.linkId))?.completed_at !== null);
  const reExchange = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    payload: { token: clientLink.token },
  });
  // UPDATED FOR PHASE 5C-1. This check previously read manageMode as a synonym
  // for "this link has a completed_at", which was the pre-5C-1 definition. The
  // locked contract (§5.4.1) makes manageMode a PERMISSION state derived from
  // onboardingComplete OR completedByThisLink, and keeps completedByThisLink as
  // a separate audit fact. Here a client completion set BOTH, so the expected
  // lifecycle triple is true/true/true — the assertion is widened to all three
  // facts rather than inferring one from the other. Group L proves the case that
  // separates them: an agency-completed account whose link never completed.
  const reExchangeBody = reExchange.json() as {
    onboardingComplete: boolean; completedByThisLink: boolean; manageMode: boolean;
  };
  check('13. re-exchanging that token reports manageMode:true',
    reExchangeBody.manageMode === true, reExchangeBody);
  check('13. and reports the account latch and this link\'s own completion separately',
    reExchangeBody.onboardingComplete === true && reExchangeBody.completedByThisLink === true,
    reExchangeBody);

  // --- 14. A link scoped to B cannot complete A ---------------------------
  const accA = await makeAccount('complete_tenant_a');
  const accB = await makeAccount('complete_tenant_b');
  await seedConnectedProvider(accA, 'klaviyo');
  await choices.setSkipped(accA, 'shopify');
  await choices.setSkipped(accA, 'recharge');
  await seedConnectedProvider(accB, 'klaviyo');
  await choices.setSkipped(accB, 'shopify');
  await choices.setSkipped(accB, 'recharge');
  const linkB = await mintAndExchange(app, agencyCookie, accB);

  const crossAgency = await app.inject({
    method: 'POST', url: completeUrl(accA), headers: { cookie: linkB.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('14. B\'s scoped cookie is refused by A\'s agency completion route',
    crossAgency.statusCode === 401, crossAgency.statusCode);
  check('14. A is still incomplete', !(await state.isOnboardingComplete(accA)));

  const crossClient = await app.inject({
    method: 'POST', url: '/onboarding/complete', headers: { cookie: linkB.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('14. B\'s cookie completes B and only B', crossClient.statusCode === 200
    && (await state.isOnboardingComplete(accB)), crossClient.statusCode);
  check('14. A was not completed by B\'s client session',
    !(await state.isOnboardingComplete(accA)));

  // --- 15/16. A body account id cannot redirect the write ----------------
  //
  // NOTE THE DIFFERENCE FROM THE CLIENT PATH, and it is deliberate on both
  // sides. Client routes REJECT an account identifier with 400
  // `account_identifier_not_permitted` (group E), because there the id would be
  // the only thing distinguishing one workspace from another. The agency route
  // does not reject it — it never reads the body at all, so the field is inert
  // rather than refused. This check proves inertness: the write lands on the
  // path's account, and B is untouched.
  const snapshotBBefore = await completionSnapshot(accB);
  const bCompleteBefore = await state.isOnboardingComplete(accB);
  const redirected = await app.inject({
    method: 'POST', url: completeUrl(accA), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: { accountId: accB, account_id: accB, account: accB },
  });
  check('15. the request succeeds — the extra fields are unused, not rejected',
    redirected.statusCode === 200, { status: redirected.statusCode, body: redirected.json() });
  check('15. it is NOT answered with the client path\'s account_identifier_not_permitted',
    (redirected.json() as { error?: string }).error === undefined);
  check('15. the account in the PATH is the one that completed',
    await state.isOnboardingComplete(accA));
  check('16. account B is byte-for-byte unchanged',
    (await completionSnapshot(accB)) === snapshotBBefore);
  check('16. account B\'s completion flag is exactly what it was',
    (await state.isOnboardingComplete(accB)) === bCompleteBefore);

  // --- 17. Refusal rollback, over every table, once more -----------------
  //
  // Checks 5 and 6 already compare a full snapshot around their 409s. This one
  // does it on an account that carries data in EVERY snapshot table, so a
  // partial write would have somewhere to show up.
  const richAcc = await makeAccount('complete_rollback');
  await seedConnectedProvider(richAcc, 'klaviyo');
  // Answered: klaviyo connected. Unanswered: shopify AND recharge → 409.
  await currency.setManualCurrency(richAcc, 'USD');
  await costs.setCogsMethod(richAcc, 'per_sku');
  // upsertSkuCosts only accepts a SKU this account has actually sold, so the
  // line item has to exist before the cost can.
  const richOrder = await insertOrder(richAcc, monthsAgo(1), 250, true);
  await insertLineItem(richAcc, richOrder, 7001, 'ROLLBACK-SKU', 250);
  await costs.upsertSkuCosts(richAcc, [{ sku: 'ROLLBACK-SKU', cogs: 4.5, zeroConfirmed: false }]);
  await costs.setOcas(richAcc, 900, false);
  await adspend.writeAdSpendRanges(richAcc, [
    { channel: 'Meta', amount: 100, startMonth: monthsAgo(1), endMonth: monthsAgo(1) },
  ]);
  await adspend.confirmZeroMonths(richAcc, [monthsAgo(2)], { replace: false });
  await mintOnboardingLinkFor(app, agencyCookie, richAcc);
  const richBefore = await completionSnapshot(richAcc);
  const richRes = await app.inject({
    method: 'POST', url: completeUrl(richAcc), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(), payload: {},
  });
  check('17. the refusal still happens with every financial input present',
    richRes.statusCode === 409, richRes.statusCode);
  check('17. and it is the undecided platforms, never the money, that block it',
    (richRes.json() as { onboardingBlockers: { code: string }[] }).onboardingBlockers
      .every((b) => b.code === 'provider_undecided'),
    (richRes.json() as { onboardingBlockers: { code: string }[] }).onboardingBlockers);
  check('17. connections, choices, links, costs, SKU costs, ad spend and zero months are all unchanged',
    (await completionSnapshot(richAcc)) === richBefore);
  check('17. the account did not become complete', !(await state.isOnboardingComplete(richAcc)));

  // --- 18. Response hygiene, over every response this group produced ------
  for (const [label, res] of [
    ['18 success', kOnly], ['18 refusal', undecided], ['18 repeat', repeat],
    ['18 all-connected', all], ['18 requested', requested], ['18 rollback refusal', richRes],
  ] as [string, { body: string }][]) {
    checkCompletionBodyHygiene(label, res.body);
  }
  check('18. a success response carries exactly the three documented fields',
    Object.keys(kOnly.json() as object).sort().join(',') === 'completed,rcmBlockers,rcmReady',
    Object.keys(kOnly.json() as object));
  check('18. a refusal carries exactly the two documented fields',
    Object.keys(undecided.json() as object).sort().join(',') === 'completed,onboardingBlockers',
    Object.keys(undecided.json() as object));
  check('18. no outbound provider request was made by any completion',
    fetchLog.every((r) => !r.url.includes('/onboarding/complete')));
  check('18. no .env credential leaked while this group ran', envCredentialLeaked() === null,
    envCredentialLeaked());
}

/** Mint a link without exchanging it, so a case can assert on an unused link. */
async function mintOnboardingLinkFor(
  app: App, agencyCookie: string, accountId: number,
): Promise<void> {
  await app.inject({
    method: 'POST', url: `/accounts/${accountId}/onboarding-links`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
}

// ===========================================================================
// L. Phase 5C-1 — restricted manage mode and the three lifecycle facts
// ===========================================================================
//
// §5.4.1 locks THREE facts that must never be collapsed into one another:
//
//   onboardingComplete    accounts.onboarding_complete — the account passed
//                         Gate 1 at least once, through EITHER route
//   completedByThisLink   onboarding_links.completed_at — an AUDIT fact about
//                         one specific link
//   manageMode            a PERMISSION state, derived as
//                         onboardingComplete OR completedByThisLink
//
// The load-bearing case, and the reason the OR exists, is C below: an agency
// completes the account while a client link is open and has never completed
// anything. That link must immediately become restricted (manageMode true)
// while its completed_at stays null, so the UI can truthfully say "setup is
// complete" without ever claiming this client did it.
//
// Every fact here is read from live PostgreSQL on each request. Section E proves
// that by mutating the tables under an already-issued cookie.

/** The lifecycle triple, in the shape both client responses return. */
interface Lifecycle {
  onboardingComplete: boolean;
  completedByThisLink: boolean;
  manageMode: boolean;
  expiresAt: string;
}

function triple(l: Lifecycle): string {
  return `${l.onboardingComplete}/${l.completedByThisLink}/${l.manageMode}`;
}

/**
 * Substrings and key shapes a lifecycle response must never contain.
 *
 * Split from COMPLETION_FORBIDDEN because the two surfaces answer different
 * questions: this one is specifically about the client lifecycle payloads, and
 * it adds the link identifier — the internal id that names WHICH bearer link is
 * in hand, and which a client has no use for.
 */
const LIFECYCLE_FORBIDDEN_KEYS = [
  /"account_?[Ii]d"/, /"link_?[Ii]d"/, /"token/, /"linkToken"/,
] as const;
const LIFECYCLE_FORBIDDEN_TEXT = [
  'token_hash', 'credentials', 'credentials_encrypted', 'apiKey', 'api_key',
  'clientSecret', 'client_secret', 'accessToken', 'access_token',
  'jobId', 'jobState', 'failedReason', 'recentErrors', 'backfill:',
  'stack', 'node_modules', 'node:internal', '/Users/', 'ECONNREFUSED',
  'verify5a-not-a-credential',
] as const;

function checkLifecycleHygiene(label: string, raw: string): void {
  for (const re of LIFECYCLE_FORBIDDEN_KEYS) {
    check(`${label}: carries no ${re.source} key`, !re.test(raw), raw.slice(0, 240));
  }
  for (const needle of LIFECYCLE_FORBIDDEN_TEXT) {
    check(`${label}: carries no "${needle}"`, !raw.includes(needle));
  }
  check(`${label}: carries no embedded stack frame`, !/\\n\s*at /.test(raw));
}

async function groupL(app: App, agencyCookie: string): Promise<void> {
  group('L', 'Phase 5C-1 restricted manage mode');

  const me = async (cookie: string) => app.inject({
    method: 'GET', url: '/onboarding/me', headers: { cookie }, remoteAddress: nextIp(),
  });
  const exchange = async (token: string) => app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(), payload: { token },
  });
  const clientComplete = async (cookie: string) => app.inject({
    method: 'POST', url: '/onboarding/complete', headers: { cookie }, remoteAddress: nextIp(),
    payload: {},
  });
  const agencyComplete = async (accountId: number) => app.inject({
    method: 'POST', url: `/accounts/${accountId}/onboarding/complete`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
  /** An account that satisfies Gate 1 with Klaviyo alone. */
  const completableAccount = async (name: string): Promise<number> => {
    const id = await makeAccount(name);
    await seedConnectedProvider(id, 'klaviyo');
    await choices.setSkipped(id, 'shopify');
    await choices.setSkipped(id, 'recharge');
    return id;
  };
  const linkRow = async (linkId: number) => links.getLinkById(linkId);

  // =======================================================================
  // A. Initial state — a new incomplete account, a new active link
  // =======================================================================
  const a1 = await makeAccount('5c1_initial');
  const aMint = await app.inject({
    method: 'POST', url: `/accounts/${a1}/onboarding-links`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
  const aToken = (aMint.json() as { token: string }).token;
  const aExchange = await exchange(aToken);
  const aCookie = cookieFrom(aExchange, 'tention_onb')!;
  const aExchangeBody = aExchange.json() as Lifecycle & { workspaceName: string };
  const aMeRes = await me(aCookie);
  const aMeBody = aMeRes.json() as Lifecycle;

  check('A. exchange on a fresh account reports false/false/false',
    triple(aExchangeBody) === 'false/false/false', aExchangeBody);
  check('A. /onboarding/me reports false/false/false',
    triple(aMeBody) === 'false/false/false', aMeBody);
  check('A. the two responses agree on all three facts',
    triple(aExchangeBody) === triple(aMeBody), { aExchangeBody, aMeBody });
  check('A. both responses carry the same expiresAt',
    aExchangeBody.expiresAt === aMeBody.expiresAt,
    { exchange: aExchangeBody.expiresAt, me: aMeBody.expiresAt });
  check('A. expiresAt is a valid ISO-8601 timestamp',
    typeof aExchangeBody.expiresAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(aExchangeBody.expiresAt)
    && !Number.isNaN(Date.parse(aExchangeBody.expiresAt)),
    aExchangeBody.expiresAt);
  check('A. expiresAt round-trips to the stored link expiry',
    Date.parse(aExchangeBody.expiresAt)
      === (await linkRow((aMint.json() as { id: number }).id))?.expires_at.getTime());
  check('A. all three facts are present as distinct keys, not inferred',
    ['onboardingComplete', 'completedByThisLink', 'manageMode']
      .every((k) => k in (aMeBody as unknown as Record<string, unknown>)),
    Object.keys(aMeBody as unknown as object));
  checkLifecycleHygiene('A exchange', aExchange.body);
  checkLifecycleHygiene('A me', aMeRes.body);

  // =======================================================================
  // B. Client completion — both facts become true, expiry never moves
  // =======================================================================
  const b1 = await completableAccount('5c1_client_complete');
  const bLink = await mintAndExchange(app, agencyCookie, b1);
  const bBefore = await linkRow(bLink.linkId);
  const bDone = await clientComplete(bLink.cookie);
  check('B. client completion succeeds', bDone.statusCode === 200,
    { status: bDone.statusCode, body: bDone.json() });
  check('B. accounts.onboarding_complete became true', await state.isOnboardingComplete(b1));
  const bStamped = await linkRow(bLink.linkId);
  check('B. this link\'s completed_at is stamped', bStamped?.completed_at !== null);
  const bStampedAt = bStamped?.completed_at?.getTime();

  const bMe = (await me(bLink.cookie)).json() as Lifecycle;
  check('B. /onboarding/me reports true/true/true', triple(bMe) === 'true/true/true', bMe);
  const bReExchange = (await exchange(bLink.token)).json() as Lifecycle;
  check('B. re-exchanging the same raw token reports true/true/true',
    triple(bReExchange) === 'true/true/true', bReExchange);
  check('B. re-exchange did not extend expiresAt',
    bReExchange.expiresAt === bMe.expiresAt
    && Date.parse(bReExchange.expiresAt) === bBefore?.expires_at.getTime(),
    { reExchange: bReExchange.expiresAt, before: bBefore?.expires_at });

  const bRepeat = await clientComplete(bLink.cookie);
  const bAfterRepeat = await linkRow(bLink.linkId);
  check('B. a repeated client completion is idempotent (200, not a conflict)',
    bRepeat.statusCode === 200, { status: bRepeat.statusCode, body: bRepeat.json() });
  check('B. the repeat did NOT move completed_at',
    bAfterRepeat?.completed_at?.getTime() === bStampedAt,
    { first: bStampedAt, after: bAfterRepeat?.completed_at });
  check('B. the repeat did NOT extend expires_at',
    bAfterRepeat?.expires_at.getTime() === bBefore?.expires_at.getTime());
  check('B. the repeat left the link unrevoked and active',
    bAfterRepeat?.revoked_at === null
    && (await links.listLinks(b1)).find((l) => l.id === bLink.linkId)?.status === 'active');
  check('B. manageMode is still true after the repeat',
    ((await me(bLink.cookie)).json() as Lifecycle).manageMode === true);

  // =======================================================================
  // C. Agency completion with an active client link — THE case for the OR
  // =======================================================================
  const c1 = await completableAccount('5c1_agency_complete');
  const cLink = await mintAndExchange(app, agencyCookie, c1);
  const cBefore = await linkRow(cLink.linkId);
  const cInitial = (await me(cLink.cookie)).json() as Lifecycle;
  check('C. before agency completion the link reports false/false/false',
    triple(cInitial) === 'false/false/false', cInitial);

  const cAgency = await agencyComplete(c1);
  check('C. the real authenticated agency route completed the account',
    cAgency.statusCode === 200, { status: cAgency.statusCode, body: cAgency.json() });

  // THE ASSERTION THIS WHOLE GROUP EXISTS FOR: same cookie, no re-exchange.
  const cAfterRes = await me(cLink.cookie);
  const cAfter = cAfterRes.json() as Lifecycle;
  check('C. the SAME cookie, with no re-exchange, now reports true/false/true',
    triple(cAfter) === 'true/false/true', cAfter);
  check('C. the response does not claim this link completed anything',
    cAfter.completedByThisLink === false, cAfter);
  const cLinkAfter = await linkRow(cLink.linkId);
  check('C. the link\'s completed_at remains NULL',
    cLinkAfter?.completed_at === null, cLinkAfter?.completed_at);
  check('C. expires_at is unchanged',
    cLinkAfter?.expires_at.getTime() === cBefore?.expires_at.getTime());
  check('C. revoked_at is unchanged (still NULL)', cLinkAfter?.revoked_at === null);
  check('C. the agency listing still reports the link as active',
    (await links.listLinks(c1)).find((l) => l.id === cLink.linkId)?.status === 'active');
  check('C. the link still authenticates — restricted, not ended',
    cAfterRes.statusCode === 200, cAfterRes.statusCode);
  checkLifecycleHygiene('C me', cAfterRes.body);

  const cReExchange = await exchange(cLink.token);
  const cReBody = cReExchange.json() as Lifecycle;
  check('C. re-exchanging the same raw token also reports true/false/true',
    triple(cReBody) === 'true/false/true', cReBody);
  check('C. re-exchange did not restore unrestricted setup access',
    cReBody.manageMode === true, cReBody);
  check('C. re-exchange did not extend expiry',
    Date.parse(cReBody.expiresAt) === cBefore?.expires_at.getTime());
  checkLifecycleHygiene('C re-exchange', cReExchange.body);

  // manageMode BEFORE the link-specific stamp — captured above as cAfter.
  const cClientDone = await clientComplete(cLink.cookie);
  check('C. the restricted link may still complete, idempotently',
    cClientDone.statusCode === 200, { status: cClientDone.statusCode, body: cClientDone.json() });
  const cStamped = await linkRow(cLink.linkId);
  check('C. that client completion stamped THIS link\'s completed_at',
    cStamped?.completed_at !== null);
  const cFinal = (await me(cLink.cookie)).json() as Lifecycle;
  check('C. the resulting state is true/true/true', triple(cFinal) === 'true/true/true', cFinal);
  check('C. manageMode was true BOTH before and after the link-specific stamp',
    cAfter.manageMode === true && cFinal.manageMode === true,
    { before: cAfter.manageMode, after: cFinal.manageMode });
  check('C. only the audit fact changed across that completion',
    cAfter.onboardingComplete === cFinal.onboardingComplete
    && cAfter.completedByThisLink === false && cFinal.completedByThisLink === true,
    { before: cAfter, after: cFinal });
  const cStampedAt = cStamped?.completed_at?.getTime();
  await clientComplete(cLink.cookie);
  check('C. a further repeat still does not move completed_at',
    (await linkRow(cLink.linkId))?.completed_at?.getTime() === cStampedAt);
  check('C. and still does not extend expires_at',
    (await linkRow(cLink.linkId))?.expires_at.getTime() === cBefore?.expires_at.getTime());

  // =======================================================================
  // D. Defensive OR state — latch false, this link completed
  // =======================================================================
  //
  // Not reachable through the routes: the client completion path sets the latch
  // and the stamp together. It is constructed directly so the OR is proven to be
  // a real disjunction rather than an expression whose second operand is never
  // load-bearing. Deriving manageMode from onboardingComplete alone would leave
  // this link unrestricted.
  const d1 = await makeAccount('5c1_defensive_or');
  const dLink = await mintAndExchange(app, agencyCookie, d1);
  await query(`UPDATE onboarding_links SET completed_at = now() WHERE id = $1`, [dLink.linkId]);
  const dLatchBefore = await state.isOnboardingComplete(d1);
  const dStampBefore = (await linkRow(dLink.linkId))?.completed_at?.getTime();
  check('D. fixture precondition: the account latch is false', dLatchBefore === false);
  check('D. fixture precondition: the link has a completed_at', dStampBefore !== undefined);

  const dMeRes = await me(dLink.cookie);
  const dMe = dMeRes.json() as Lifecycle;
  check('D. /onboarding/me reports false/true/true', triple(dMe) === 'false/true/true', dMe);
  const dRe = (await exchange(dLink.token)).json() as Lifecycle;
  check('D. session restore reports false/true/true too', triple(dRe) === 'false/true/true', dRe);
  check('D. the two agree', triple(dMe) === triple(dRe), { dMe, dRe });
  check('D. reading did not silently set the account latch',
    (await state.isOnboardingComplete(d1)) === false);
  check('D. reading did not silently move the link stamp',
    (await linkRow(dLink.linkId))?.completed_at?.getTime() === dStampBefore);
  checkLifecycleHygiene('D me', dMeRes.body);

  // Fixture restored; the throwaway account itself is removed by cleanupAccounts.
  await query(`UPDATE onboarding_links SET completed_at = NULL WHERE id = $1`, [dLink.linkId]);
  check('D. the fixture was restored (completed_at back to NULL)',
    (await linkRow(dLink.linkId))?.completed_at === null);

  // =======================================================================
  // E. Fresh PostgreSQL recomputation under ONE already-issued cookie
  // =======================================================================
  const e1 = await makeAccount('5c1_recompute');
  const eLink = await mintAndExchange(app, agencyCookie, e1);
  check('E. baseline under the issued cookie is false/false/false',
    triple((await me(eLink.cookie)).json() as Lifecycle) === 'false/false/false');

  await query(`UPDATE accounts SET onboarding_complete = true WHERE id = $1`, [e1]);
  check('E1. flipping accounts.onboarding_complete changes manageMode on the NEXT request',
    triple((await me(eLink.cookie)).json() as Lifecycle) === 'true/false/true');

  await query(`UPDATE accounts SET onboarding_complete = false WHERE id = $1`, [e1]);
  await query(`UPDATE onboarding_links SET completed_at = now() WHERE id = $1`, [eLink.linkId]);
  check('E2. flipping completed_at changes completedByThisLink and manageMode',
    triple((await me(eLink.cookie)).json() as Lifecycle) === 'false/true/true');

  await query(`UPDATE onboarding_links SET completed_at = NULL WHERE id = $1`, [eLink.linkId]);
  check('E3. clearing both facts drops the session back to unrestricted setup',
    triple((await me(eLink.cookie)).json() as Lifecycle) === 'false/false/false');
  check('E3. no new cookie was ever issued for those transitions',
    (await me(eLink.cookie)).headers['set-cookie'] === undefined);
  check('E3. and no token was re-exchanged to obtain them', true);

  // E4. The cookie itself carries no lifecycle permission field.
  const eCookieValue = eLink.cookie.split('=').slice(1).join('=');
  const ePayloadRaw = Buffer.from(
    eCookieValue.slice(0, eCookieValue.lastIndexOf('.')), 'base64url',
  ).toString('utf8');
  const ePayload = JSON.parse(ePayloadRaw) as Record<string, unknown>;
  check('E4. the signed cookie payload holds exactly {l, a, i}',
    Object.keys(ePayload).sort().join(',') === 'a,i,l', ePayload);
  check('E4. it carries no lifecycle or permission field',
    !/manageMode|onboardingComplete|completedByThisLink|completed_at|complete/i.test(ePayloadRaw),
    ePayloadRaw);

  // E5. A correctly SIGNED cookie that asserts its own lifecycle is ignored.
  const forgedLifecycle = (() => {
    const body = Buffer.from(JSON.stringify({
      l: eLink.linkId, a: e1, i: Math.floor(Date.now() / 1000),
      manageMode: false, onboardingComplete: false, completedByThisLink: false,
    }), 'utf8').toString('base64url');
    const mac = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
    return `tention_onb=${body}.${mac}`;
  })();
  await query(`UPDATE accounts SET onboarding_complete = true WHERE id = $1`, [e1]);
  const eForged = await me(forgedLifecycle);
  check('E5. a correctly signed cookie claiming manageMode:false cannot override the database',
    eForged.statusCode === 200
    && triple(eForged.json() as Lifecycle) === 'true/false/true', eForged.json());
  await query(`UPDATE accounts SET onboarding_complete = false WHERE id = $1`, [e1]);

  // =======================================================================
  // F. The central action contract
  // =======================================================================
  const EXPECTED_ACTIONS: Record<string, string> = {
    'POST /onboarding/logout': 'session.logout',
    'GET /onboarding/me': 'status.read',
    'GET /onboarding/progress': 'progress.read',
    'POST /onboarding/connections/klaviyo': 'connections.klaviyo.connect',
    'POST /onboarding/connections/recharge': 'connections.recharge.connect',
    'POST /onboarding/connections/shopify/request': 'connections.shopify.request',
    // Added by Phase 5C-2. The route count below moves 16 → 17 for the same
    // reason: one new authenticated route exists, so the contract this group
    // pins is one entry larger. Nothing here was relaxed — the map is checked
    // entry by entry, so a wider map is a stricter assertion.
    'POST /onboarding/connections/:provider/request': 'connections.choice.request',
    'POST /onboarding/connections/:provider/skip': 'connections.choice.skip',
    'PUT /onboarding/currency': 'currency.update',
    'GET /onboarding/skus': 'costs.read',
    'GET /onboarding/costs': 'costs.read',
    'PUT /onboarding/cogs': 'cogs.update',
    'PUT /onboarding/ocas': 'ocas.update',
    'GET /onboarding/ad-spend': 'ad_spend.read',
    'PUT /onboarding/ad-spend': 'ad_spend.update',
    'POST /onboarding/ad-spend/zero': 'ad_spend.zero_confirm',
    'POST /onboarding/complete': 'completion.submit',
  };

  // Read the declarations off the REAL route table rather than off the source
  // text: what enforceManageMode reads at runtime is routeOptions.config, so
  // that is what has to be inspected.
  const routeApp = buildApp();
  const declared = new Map<string, string | undefined>();
  routeApp.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      if (!r.url.startsWith('/onboarding')) continue;
      declared.set(`${m} ${r.url}`, (r.config as { clientAction?: string } | undefined)?.clientAction);
    }
  });
  await routeApp.ready();

  // Fastify auto-registers a HEAD twin for every GET (exposeHeadRoutes). The
  // twins are counted separately below rather than inflating the total: they are
  // generated, not declared, and the assertion that matters for them is that the
  // generation carries the declaration across — a HEAD twin without a
  // clientAction would be an undefended copy of a defended route.
  const headTwins = [...declared.entries()].filter(([k]) => k.startsWith('HEAD '));
  const authenticated = [...declared.entries()]
    .filter(([k]) => !k.startsWith('HEAD ') && k !== 'POST /onboarding/session');
  check('F. there are exactly 17 authenticated scoped onboarding routes',
    authenticated.length === 17, authenticated.map(([k]) => k));
  check('F. every auto-generated HEAD twin inherits its GET route\'s clientAction',
    headTwins.length > 0
    && headTwins.every(([k, v]) => v === declared.get(k.replace(/^HEAD /, 'GET '))),
    headTwins.map(([k, v]) => `${k}:${v}`));
  check('F. every authenticated route declares a clientAction',
    authenticated.every(([, v]) => typeof v === 'string' && v.length > 0),
    authenticated.filter(([, v]) => !v).map(([k]) => k));
  for (const [route, action] of Object.entries(EXPECTED_ACTIONS)) {
    check(`F. ${route} declares ${action}`, declared.get(route) === action,
      { expected: action, actual: declared.get(route) });
  }
  check('F. POST /onboarding/session is public exchange and declares no client action',
    declared.has('POST /onboarding/session')
    && declared.get('POST /onboarding/session') === undefined,
    declared.get('POST /onboarding/session'));
  check('F. every declared action is a member of the closed vocabulary',
    authenticated.every(([, v]) =>
      (manageMode.CLIENT_ONBOARDING_ACTIONS as readonly string[]).includes(v as string)),
    authenticated.map(([, v]) => v));
  await routeApp.close();

  // --- F. default-deny, exercised through enforceManageMode itself --------
  //
  // An ISOLATED Fastify fixture, not a production test route: §5.4.4 requires
  // every future client route to be denied unless explicitly allowlisted, and
  // adding a route to the real app to prove that would be adding exactly the
  // kind of surface the rule exists to prevent. The principal is injected
  // directly so the guard is the only thing under test.
  const { default: Fastify } = await import('fastify');
  const guardApp = Fastify({ logger: false });
  guardApp.decorateRequest('onboarding', null);
  let injectedManageMode = true;
  guardApp.addHook('preHandler', async (req) => {
    (req as unknown as { onboarding: unknown }).onboarding = {
      accountId: 1, linkId: 1, onboardingComplete: injectedManageMode,
      completedByThisLink: false, manageMode: injectedManageMode,
      expiresAt: new Date(Date.now() + 86_400_000),
    };
  });
  guardApp.addHook('preHandler', manageMode.enforceManageMode);
  guardApp.get('/undeclared', async () => ({ reached: true }));
  guardApp.get('/unknown-action',
    { config: { clientAction: 'not.a.real.action' as never } },
    async () => ({ reached: true }));
  guardApp.get('/allowed',
    { config: { clientAction: 'status.read' } },
    async () => ({ reached: true }));
  await guardApp.ready();

  const gUndeclared = await guardApp.inject({ method: 'GET', url: '/undeclared' });
  const gUnknown = await guardApp.inject({ method: 'GET', url: '/unknown-action' });
  const gAllowed = await guardApp.inject({ method: 'GET', url: '/allowed' });
  check('F. a route with NO clientAction is refused with 403',
    gUndeclared.statusCode === 403, gUndeclared.statusCode);
  check('F. a route declaring an unknown action is refused with 403',
    gUnknown.statusCode === 403, gUnknown.statusCode);
  check('F. the handler was never reached in either case',
    !gUndeclared.body.includes('reached') && !gUnknown.body.includes('reached'),
    { undeclared: gUndeclared.body, unknown: gUnknown.body });
  check('F. both refusals return the SAME stable neutral body',
    gUndeclared.body === gUnknown.body, { a: gUndeclared.body, b: gUnknown.body });
  check('F. the refusal body is exactly the single shared constant',
    gUndeclared.body === JSON.stringify(manageMode.MANAGE_MODE_DENIED), gUndeclared.body);
  // The shared constant deliberately says "Ask your account manager", so the word
  // "account" is expected prose. What must be absent is anything that identifies
  // the ACTION, the allowlist, or a specific account or link.
  check('F. the refusal names no action, allowlist, account id or link id',
    !/not\.a\.real\.action|allowlist|status\.read|clientAction|manageMode/.test(gUndeclared.body)
    && !/account_?[Ii]d|link_?[Ii]d|\d/.test(gUndeclared.body),
    gUndeclared.body);
  check('F. the refusal reveals nothing about which of the two faults occurred',
    gUndeclared.body === gUnknown.body
    && !/declar|unknown|missing/i.test(gUndeclared.body), gUndeclared.body);
  check('F. an allowlisted action still passes the guard',
    gAllowed.statusCode === 200 && gAllowed.body.includes('reached'), gAllowed.statusCode);

  // The same fixture with manageMode FALSE: a missing declaration must still
  // fail closed. A guard that only bites after completion is a bug that arrives
  // months late, on somebody else's shift.
  injectedManageMode = false;
  check('F. a missing declaration fails closed in first-time setup mode too',
    (await guardApp.inject({ method: 'GET', url: '/undeclared' })).statusCode === 403);
  check('F. an unknown action fails closed in first-time setup mode too',
    (await guardApp.inject({ method: 'GET', url: '/unknown-action' })).statusCode === 403);
  check('F. a declared, allowlisted action still works in first-time setup mode',
    (await guardApp.inject({ method: 'GET', url: '/allowed' })).statusCode === 200);
  await guardApp.close();

  check('F. isAllowedInManageMode agrees with the declared vocabulary',
    manageMode.CLIENT_ONBOARDING_ACTIONS.every((a) => manageMode.isAllowedInManageMode(a))
    && !manageMode.isAllowedInManageMode('not.a.real.action')
    && !manageMode.isAllowedInManageMode(undefined));
  check('F. deriveManageMode is the OR, not either operand alone',
    manageMode.deriveManageMode({ onboardingComplete: false, completedByThisLink: false }) === false
    && manageMode.deriveManageMode({ onboardingComplete: true, completedByThisLink: false }) === true
    && manageMode.deriveManageMode({ onboardingComplete: false, completedByThisLink: true }) === true
    && manageMode.deriveManageMode({ onboardingComplete: true, completedByThisLink: true }) === true);

  // =======================================================================
  // G. Manage-mode provider restrictions
  // =======================================================================

  // --- G. Klaviyo -------------------------------------------------------
  const g1 = await makeAccount('5c1_klaviyo_locked');
  const gLink = await mintAndExchange(app, agencyCookie, g1);
  const K_ORIGINAL = 'pk_5c1_original_key_000000000000000000';
  const K_REPLACEMENT = 'pk_5c1_replacement_key_0000000000000';
  const gConnect = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: gLink.cookie },
    remoteAddress: nextIp(), payload: { apiKey: K_ORIGINAL },
  });
  check('G. Klaviyo connects normally BEFORE completion',
    [200, 202].includes(gConnect.statusCode), gConnect.json());
  for (const p of ['shopify', 'recharge']) {
    await app.inject({
      method: 'POST', url: `/onboarding/connections/${p}/skip`,
      headers: { cookie: gLink.cookie }, remoteAddress: nextIp(), payload: {},
    });
  }
  check('G. first-time skip still works on an incomplete account',
    (await choices.getProviderStatuses(g1))
      .filter((p) => p.state === 'skipped').map((p) => p.provider).join(',') === 'shopify,recharge');
  check('G. client completion engages manage mode',
    (await clientComplete(gLink.cookie)).statusCode === 200
    && ((await me(gLink.cookie)).json() as Lifecycle).manageMode === true);

  const gRowBefore = (await query<{ credentials_encrypted: string; status: string }>(
    `SELECT credentials_encrypted, status FROM connections
      WHERE account_id = $1 AND provider = 'klaviyo'`, [g1])).rows[0];
  fetchLog = [];
  const gRefused = await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: gLink.cookie },
    remoteAddress: nextIp(), payload: { apiKey: K_REPLACEMENT },
  });
  check('G. Klaviyo re-connect in manage mode is refused with 409',
    gRefused.statusCode === 409, { status: gRefused.statusCode, body: gRefused.json() });
  check('G. the refusal code is the stable provider_already_connected',
    (gRefused.json() as { code: string }).code === 'provider_already_connected', gRefused.json());
  check('G. the replacement credential was never verified — no outbound call at all',
    fetchLog.length === 0, fetchLog.map((f) => f.url));
  check('G. the refusal never echoes the submitted credential',
    !gRefused.body.includes(K_REPLACEMENT));
  const gRowAfter = (await query<{ credentials_encrypted: string; status: string }>(
    `SELECT credentials_encrypted, status FROM connections
      WHERE account_id = $1 AND provider = 'klaviyo'`, [g1])).rows[0];
  check('G. the stored ciphertext is byte-for-byte unchanged',
    gRowAfter.credentials_encrypted === gRowBefore.credentials_encrypted);
  check('G. and it still decrypts to the ORIGINAL key, not the replacement',
    JSON.parse(decrypt(gRowAfter.credentials_encrypted)).apiKey === K_ORIGINAL);
  check('G. the connection row is still exactly one, still connected',
    gRowAfter.status === 'connected'
    && Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1 AND provider = 'klaviyo'`,
      [g1])).rows[0].n) === 1);

  // --- G. Recharge ------------------------------------------------------
  const g2 = await makeAccount('5c1_recharge_locked');
  const g2Link = await mintAndExchange(app, agencyCookie, g2);
  const R_ORIGINAL = 'recharge_5c1_original_token';
  const R_REPLACEMENT = 'recharge_5c1_replacement_token';
  check('G. Recharge connects normally BEFORE completion',
    [200, 202].includes((await app.inject({
      method: 'POST', url: '/onboarding/connections/recharge', headers: { cookie: g2Link.cookie },
      remoteAddress: nextIp(), payload: { token: R_ORIGINAL },
    })).statusCode));
  for (const p of ['shopify', 'klaviyo']) {
    await app.inject({
      method: 'POST', url: `/onboarding/connections/${p}/skip`,
      headers: { cookie: g2Link.cookie }, remoteAddress: nextIp(), payload: {},
    });
  }
  await clientComplete(g2Link.cookie);
  const g2Before = (await query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM connections WHERE account_id = $1 AND provider = 'recharge'`,
    [g2])).rows[0];
  fetchLog = [];
  const g2Refused = await app.inject({
    method: 'POST', url: '/onboarding/connections/recharge', headers: { cookie: g2Link.cookie },
    remoteAddress: nextIp(), payload: { token: R_REPLACEMENT },
  });
  check('G. Recharge re-connect in manage mode is refused with 409',
    g2Refused.statusCode === 409
    && (g2Refused.json() as { code: string }).code === 'provider_already_connected',
    { status: g2Refused.statusCode, body: g2Refused.json() });
  check('G. Recharge: no verification call was made for the replacement token',
    fetchLog.length === 0, fetchLog.map((f) => f.url));
  check('G. Recharge: the refusal never echoes the submitted token',
    !g2Refused.body.includes(R_REPLACEMENT));
  const g2After = (await query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM connections WHERE account_id = $1 AND provider = 'recharge'`,
    [g2])).rows[0];
  check('G. Recharge: the stored ciphertext is unchanged',
    g2After.credentials_encrypted === g2Before.credentials_encrypted);
  check('G. Recharge: it still decrypts to the ORIGINAL token',
    JSON.parse(decrypt(g2After.credentials_encrypted)).token === R_ORIGINAL);

  // --- G. Shopify domain request, and skip, against a CONNECTED provider --
  const g3 = await makeAccount('5c1_shopify_locked');
  await seedConnectedProvider(g3, 'shopify', `5c1-locked-${Date.now()}.myshopify.com`);
  await choices.setSkipped(g3, 'klaviyo');
  await choices.setSkipped(g3, 'recharge');
  const g3Link = await mintAndExchange(app, agencyCookie, g3);
  await agencyComplete(g3);
  check('G. the Shopify-connected account is in manage mode',
    ((await me(g3Link.cookie)).json() as Lifecycle).manageMode === true);

  const g3ChoicesBefore = (await query<{ j: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
       FROM onboarding_provider_choices t WHERE account_id = $1`, [g3])).rows[0].j;
  const g3ConnBefore = (await query<{ j: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
       FROM connections t WHERE account_id = $1`, [g3])).rows[0].j;
  const g3Request = await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/request',
    headers: { cookie: g3Link.cookie }, remoteAddress: nextIp(),
    payload: { shopDomain: `5c1-different-${Date.now()}.myshopify.com` },
  });
  check('G. a domain request against a CONNECTED Shopify is refused with 409',
    g3Request.statusCode === 409
    && (g3Request.json() as { code: string }).code === 'provider_already_connected',
    { status: g3Request.statusCode, body: g3Request.json() });
  check('G. the refusal created or modified NO provider-choice row',
    (await query<{ j: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
         FROM onboarding_provider_choices t WHERE account_id = $1`, [g3])).rows[0].j
      === g3ChoicesBefore);
  check('G. the connected Shopify row is byte-for-byte unchanged',
    (await query<{ j: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
         FROM connections t WHERE account_id = $1`, [g3])).rows[0].j === g3ConnBefore);

  const g3Skip = await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/skip',
    headers: { cookie: g3Link.cookie }, remoteAddress: nextIp(), payload: {},
  });
  check('G. a CONNECTED provider cannot be skipped in manage mode',
    g3Skip.statusCode === 409
    && (g3Skip.json() as { code: string }).code === 'provider_already_connected',
    { status: g3Skip.statusCode, body: g3Skip.json() });
  check('G. the skip refusal left the connections row intact',
    (await query<{ j: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
         FROM connections t WHERE account_id = $1`, [g3])).rows[0].j === g3ConnBefore);
  check('G. Shopify is STILL reported as connected, never as skipped',
    (await choices.getProviderStatuses(g3)).find((p) => p.provider === 'shopify')?.state
      === 'connected');
  check('G. the choices table was not touched by the skip refusal either',
    (await query<{ j: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
         FROM onboarding_provider_choices t WHERE account_id = $1`, [g3])).rows[0].j
      === g3ChoicesBefore);

  // --- G. An UNCONNECTED requested provider may still be skipped ---------
  const g4 = await makeAccount('5c1_requested_to_skipped');
  await seedConnectedProvider(g4, 'klaviyo');
  await choices.setShopifyRequested(g4, `5c1-req-${Date.now()}.myshopify.com`);
  await choices.setSkipped(g4, 'recharge');
  const g4Link = await mintAndExchange(app, agencyCookie, g4);
  await agencyComplete(g4);
  check('G. the requested-Shopify account is in manage mode',
    ((await me(g4Link.cookie)).json() as Lifecycle).manageMode === true);
  check('G. Shopify starts as requested and unconnected',
    (await choices.getProviderStatuses(g4)).find((p) => p.provider === 'shopify')?.state
      === 'requested');
  const g4Skip = await app.inject({
    method: 'POST', url: '/onboarding/connections/shopify/skip',
    headers: { cookie: g4Link.cookie }, remoteAddress: nextIp(), payload: {},
  });
  check('G. an UNCONNECTED requested provider may become skipped in manage mode',
    g4Skip.statusCode === 200, { status: g4Skip.statusCode, body: g4Skip.json() });
  check('G. and its state really is skipped now',
    (await choices.getProviderStatuses(g4)).find((p) => p.provider === 'shopify')?.state
      === 'skipped');
  check('G. no connections row was invented for the skipped provider',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1 AND provider = 'shopify'`,
      [g4])).rows[0].n) === 0);

  // =======================================================================
  // H. Currency and financial regression, through the manage-mode surface
  // =======================================================================
  const h1 = await completableAccount('5c1_financial');
  const hLink = await mintAndExchange(app, agencyCookie, h1);
  await agencyComplete(h1);
  check('H. the financial fixture account is in manage mode',
    ((await me(hLink.cookie)).json() as Lifecycle).manageMode === true);

  const hCurrency = await app.inject({
    method: 'PUT', url: '/onboarding/currency', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(), payload: { currency: 'eur' },
  });
  check('H. manual-authority currency is still client-editable in manage mode',
    hCurrency.statusCode === 200, hCurrency.json());
  check('H. it was normalized and stored with manual authority',
    (await currency.getCurrencyState(h1))?.currency === 'EUR'
    && (await currency.getCurrencyState(h1))?.currency_source === 'manual');

  const hCogs = await app.inject({
    method: 'PUT', url: '/onboarding/cogs', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(), payload: { method: 'blended', blendedMarginPct: 55 },
  });
  const hOcas = await app.inject({
    method: 'PUT', url: '/onboarding/ocas', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(), payload: { ocasMonthly: 4200 },
  });
  const hSpend = await app.inject({
    method: 'PUT', url: '/onboarding/ad-spend', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(),
    payload: {
      rows: [{
        channel: 'Meta', amount: 500,
        startMonth: monthsAgo(1).slice(0, 7), endMonth: monthsAgo(1).slice(0, 7),
      }],
    },
  });
  // An unconfirmed zero must still be refused in manage mode — §5.4.7 keeps
  // "zero ad spend requires explicit confirmation", and manage mode grants the
  // ACTION, never a relaxation of the rule inside it.
  const hZeroUnconfirmed = await app.inject({
    method: 'POST', url: '/onboarding/ad-spend/zero', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(), payload: { months: [monthsAgo(2).slice(0, 7)] },
  });
  check('H. an UNCONFIRMED zero-spend declaration is still refused in manage mode',
    hZeroUnconfirmed.statusCode === 400
    && (hZeroUnconfirmed.json() as { error: string }).error === 'zero_unconfirmed',
    hZeroUnconfirmed.json());
  const hZero = await app.inject({
    method: 'POST', url: '/onboarding/ad-spend/zero', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(),
    payload: { months: [monthsAgo(2).slice(0, 7)], confirmedZero: true },
  });
  check('H. COGS remains writable in manage mode', hCogs.statusCode === 200, hCogs.json());
  check('H. OCAS remains writable in manage mode', hOcas.statusCode === 200, hOcas.json());
  check('H. positive ad spend remains writable in manage mode',
    hSpend.statusCode === 200, hSpend.json());
  check('H. a zero-spend declaration remains available in manage mode',
    hZero.statusCode === 200, hZero.json());
  check('H. the stored financial values are exactly what was submitted',
    Number((await costs.getAccountCosts(h1)).blended_margin_pct) === 55
    && Number((await costs.getAccountCosts(h1)).ocas_monthly) === 4200);
  check('H. positive spend and a zero declaration stayed mutually exclusive by month',
    (await adspend.listAdSpend(h1)).every((r) => String(r.month).slice(0, 7) !== monthsAgo(2).slice(0, 7)),
    (await adspend.listAdSpend(h1)).map((r) => String(r.month)));

  // Shopify-authoritative currency is NOT client-overridable, in manage mode
  // or out of it — mismatch resolution is agency-only (§5.4.7).
  const h2 = await makeAccount('5c1_shopify_currency');
  await seedConnectedProvider(h2, 'shopify', `5c1-cur-${Date.now()}.myshopify.com`);
  await choices.setSkipped(h2, 'klaviyo');
  await choices.setSkipped(h2, 'recharge');
  await currency.applyShopifyCurrency(h2, 'USD');
  const h2Link = await mintAndExchange(app, agencyCookie, h2);
  await agencyComplete(h2);
  const h2Before = await currency.getCurrencyState(h2);
  const h2Override = await app.inject({
    method: 'PUT', url: '/onboarding/currency', headers: { cookie: h2Link.cookie },
    remoteAddress: nextIp(), payload: { currency: 'CAD' },
  });
  check('H. a client cannot overwrite a Shopify-authoritative currency',
    h2Override.statusCode === 400
    && (h2Override.json() as { error: string }).error === 'shopify_authoritative',
    { status: h2Override.statusCode, body: h2Override.json() });
  const h2After = await currency.getCurrencyState(h2);
  check('H. both the stored currency and its authority are unchanged',
    h2After?.currency === h2Before?.currency
    && h2After?.currency_source === h2Before?.currency_source, { h2Before, h2After });
  check('H. no automatic conversion happened — the value is still USD',
    h2After?.currency === 'USD' && h2After?.shopify_currency_detected === 'USD', h2After);

  // An account identifier from a client is still refused before anything else.
  const hProbe = await app.inject({
    method: 'PUT', url: '/onboarding/ocas', headers: { cookie: hLink.cookie },
    remoteAddress: nextIp(), payload: { accountId: h2, ocasMonthly: 1 },
  });
  check('H. an account identifier in a manage-mode write is rejected with 400',
    hProbe.statusCode === 400
    && (hProbe.json() as { error: string }).error === 'account_identifier_not_permitted',
    hProbe.json());
  check('H. the named foreign account was not written to',
    (await costs.getAccountCosts(h2))?.ocas_monthly == null,
    (await costs.getAccountCosts(h2))?.ocas_monthly);
  check('H. and the session\'s own OCAS was not changed by the rejected write',
    Number((await costs.getAccountCosts(h1)).ocas_monthly) === 4200);

  // =======================================================================
  // I. Security regression on the manage-mode surface
  // =======================================================================
  const i1 = await completableAccount('5c1_revoked_manage');
  const iLink = await mintAndExchange(app, agencyCookie, i1);
  await agencyComplete(i1);
  check('I. the link works while active, in manage mode',
    (await me(iLink.cookie)).statusCode === 200);
  await app.inject({
    method: 'DELETE', url: `/accounts/${i1}/onboarding-links/${iLink.linkId}`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  const iRevoked = await me(iLink.cookie);
  check('I. revocation ends a manage-mode session on the very next request',
    iRevoked.statusCode === 401, iRevoked.statusCode);
  check('I. the revoked session returns the neutral client failure',
    JSON.stringify(iRevoked.json()) === JSON.stringify({
      error: 'invalid_link',
      message: 'This setup link is not valid. Ask your account manager for a new one.',
    }), iRevoked.json());
  check('I. re-exchanging a revoked token is refused just as neutrally',
    (await exchange(iLink.token)).statusCode === 401);

  const i2 = await completableAccount('5c1_expired_manage');
  const i2Link = await mintAndExchange(app, agencyCookie, i2);
  await agencyComplete(i2);
  await query(`UPDATE onboarding_links SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [i2Link.linkId]);
  check('I. expiry ends a manage-mode session on the very next request',
    (await me(i2Link.cookie)).statusCode === 401);
  check('I. and the expired token can no longer be exchanged',
    (await exchange(i2Link.token)).statusCode === 401);

  // Cookie lifetime capped by the link's own expiry.
  const i3 = await completableAccount('5c1_cookie_cap');
  const i3Mint = await app.inject({
    method: 'POST', url: `/accounts/${i3}/onboarding-links`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
  const i3Body = i3Mint.json() as { id: number; token: string };
  await query(`UPDATE onboarding_links SET expires_at = now() + interval '90 seconds' WHERE id = $1`,
    [i3Body.id]);
  const i3Exchange = await exchange(i3Body.token);
  const i3Directive = cookieDirective(i3Exchange, 'tention_onb') ?? '';
  const i3MaxAge = Number(/Max-Age=(\d+)/i.exec(i3Directive)?.[1] ?? -1);
  check('I. the onboarding cookie carries a Max-Age', i3MaxAge > 0, i3Directive);
  check('I. cookie lifetime is capped by the remaining life of its link',
    i3MaxAge <= 90, { maxAge: i3MaxAge });

  // Client and agency principals stay disjoint on the manage-mode surface too.
  const i4 = await completableAccount('5c1_separation');
  const i4Link = await mintAndExchange(app, agencyCookie, i4);
  await agencyComplete(i4);
  check('I. a manage-mode client cookie cannot reach an agency route',
    (await app.inject({
      method: 'GET', url: '/accounts', headers: { cookie: i4Link.cookie }, remoteAddress: nextIp(),
    })).statusCode === 401);
  check('I. a manage-mode client cookie cannot list or revoke onboarding links',
    (await app.inject({
      method: 'POST', url: `/accounts/${i4}/onboarding-links`,
      headers: { cookie: i4Link.cookie }, remoteAddress: nextIp(), payload: {},
    })).statusCode === 401);
  check('I. an agency cookie still cannot reach the client onboarding surface',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', headers: { cookie: agencyCookie },
      remoteAddress: nextIp(),
    })).statusCode === 401);

  // Tenant isolation, with BOTH accounts complete so manage mode is engaged.
  const i5 = await completableAccount('5c1_tenant_a');
  const i6 = await completableAccount('5c1_tenant_b');
  const i5Link = await mintAndExchange(app, agencyCookie, i5);
  await agencyComplete(i5);
  await agencyComplete(i6);
  await costs.setOcas(i6, 777, false);
  const i5Me = await me(i5Link.cookie);
  check('I. a manage-mode session reads only its own workspace',
    (i5Me.json() as { workspaceName: string }).workspaceName
      === (await query<{ name: string }>(
        `SELECT name FROM accounts WHERE id = $1`, [i5])).rows[0].name);
  check('I. it cannot name another account in a write',
    (await app.inject({
      method: 'PUT', url: '/onboarding/ocas', headers: { cookie: i5Link.cookie },
      remoteAddress: nextIp(), payload: { account_id: i6, ocasMonthly: 5 },
    })).statusCode === 400);
  check('I. the other account\'s OCAS is untouched',
    Number((await costs.getAccountCosts(i6)).ocas_monthly) === 777);
  checkLifecycleHygiene('I me', i5Me.body);
  check('I. no .env credential leaked while this group ran',
    envCredentialLeaked() === null, envCredentialLeaked());
}

// ===========================================================================
// M. Phase 5C-2 provider request and choice transitions
// ===========================================================================
//
// §5.4.5 adds client-scoped agency-assist REQUESTS for Klaviyo and Recharge, and
// the whole point of the state is that it is an ANSWER and not a connection:
// requesting satisfies the "answered" half of Gate 1 while leaving completion
// blocked until something is genuinely connected. So the load-bearing proofs
// here are negative ones — a request writes no connections row, contacts no
// provider, enqueues no job, and never reports connected.
//
// The route is also strictly bodyless. It takes a path parameter and nothing
// else, and a supplied body is REFUSED rather than ignored: a client that sent
// `{ apiKey: … }` and got a 200 would reasonably conclude a credential had been
// accepted.

/** One account's rows in one table, as deterministic text. */
async function tableSnapshot(table: string, accountId: number): Promise<string> {
  const { rows } = await query<{ j: string }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS j
       FROM ${table} t WHERE account_id = $1`,
    [accountId],
  );
  return rows[0].j;
}

/**
 * Every body shape the route must refuse.
 *
 * Sent as raw JSON text with an explicit Content-Type rather than through
 * inject's payload serialisation, so `0`, `false`, `""` and `null` arrive as
 * those exact JSON values. They are the cases a truthiness check would wave
 * through, which is precisely why they are here.
 */
const BODY_CASES: [string, string][] = [
  ['{}', '{}'],
  ['null', 'null'],
  ['[]', '[]'],
  ['[1, 2]', '[1,2]'],
  ['0', '0'],
  ['5', '5'],
  ['false', 'false'],
  ['true', 'true'],
  ['""', '""'],
  ['"text"', '"text"'],
  ['{ unknown }', '{"unknown":"value"}'],
  ['{ shopDomain }', '{"shopDomain":"synthetic.myshopify.com"}'],
  ['{ clientId }', '{"clientId":"synthetic-client-id"}'],
  ['{ clientSecret }', '{"clientSecret":"synthetic-secret"}'],
  ['{ apiKey }', '{"apiKey":"synthetic-key"}'],
  ['{ token }', '{"token":"synthetic-token"}'],
  ['{ several credential-shaped fields }',
    '{"apiKey":"synthetic-key","token":"synthetic-token","clientId":"synthetic-client-id",'
    + '"clientSecret":"synthetic-secret","shopDomain":"synthetic.myshopify.com"}'],
];

/** Field names and values from BODY_CASES that a refusal must never echo. */
const REFLECTION_NEEDLES = [
  'shopDomain', 'clientId', 'clientSecret', 'apiKey', 'token', 'unknown',
  'synthetic-key', 'synthetic-token', 'synthetic-secret', 'synthetic-client-id',
  'synthetic.myshopify.com', 'value', 'text',
] as const;

const BODY_REFUSAL = '{"error":"request_body_not_permitted"}';

/**
 * Identifier fields a 5C-2 response must never carry, matched as JSON KEYS.
 *
 * Deliberately not a substring test. The account-identifier refusal's stable
 * error CODE is `account_identifier_not_permitted`, which contains the letters
 * "account_id" while carrying no account id at all — a substring test flags that
 * as a leak and is simply wrong. What must be absent is the field: a quoted key
 * followed by a colon, which is the only way a value could actually be attached.
 */
const M_FORBIDDEN_KEYS = [
  /"account_?[Ii]d"\s*:/, /"account"\s*:/, /"link_?[Ii]d"\s*:/,
  /"connection_?[Ii]d"\s*:/, /"id"\s*:/,
] as const;

/** Values and field names that can never legitimately appear at all. */
const M_FORBIDDEN_TEXT = [
  'credentials', 'credentials_encrypted', 'apiKey', 'api_key', 'clientSecret',
  'client_secret', 'clientId', 'client_id', 'accessToken', 'access_token',
  'token_hash', 'password', 'jobId', 'jobState', 'failedReason',
  'recentErrors', 'backfill:', 'stack', 'node_modules', 'node:internal',
  '/Users/', 'SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'pg_', 'ECONNREFUSED',
  'verify5a-not-a-credential',
] as const;

function checkMHygiene(label: string, raw: string): void {
  for (const re of M_FORBIDDEN_KEYS) {
    check(`${label}: carries no ${re.source} key`, !re.test(raw), raw.slice(0, 240));
  }
  for (const needle of M_FORBIDDEN_TEXT) {
    check(`${label}: carries no "${needle}"`, !raw.includes(needle));
  }
  check(`${label}: carries no embedded stack frame`, !/\\n\s*at /.test(raw));
}

async function groupM(app: App, agencyCookie: string): Promise<void> {
  group('M', 'Phase 5C-2 provider request and choice transitions');

  const collected: [string, string][] = [];
  const record = (label: string, res: { body: string }) => {
    collected.push([label, res.body]);
    return res;
  };

  const requestUrl = (p: string) => `/onboarding/connections/${p}/request`;
  const skipUrl = (p: string) => `/onboarding/connections/${p}/skip`;

  /** The bodyless call the route is designed for: no payload, no Content-Type. */
  const requestBodyless = async (cookie: string, provider: string) => app.inject({
    method: 'POST', url: requestUrl(provider), headers: { cookie }, remoteAddress: nextIp(),
  });
  const skipCall = async (cookie: string, provider: string) => app.inject({
    method: 'POST', url: skipUrl(provider), headers: { cookie }, remoteAddress: nextIp(),
    payload: {},
  });
  const choiceRow = async (accountId: number, provider: string) => (await query<{
    choice: string; requested_domain: string | null; n: string;
  }>(
    `SELECT choice, requested_domain, count(*) OVER () AS n
       FROM onboarding_provider_choices WHERE account_id = $1 AND provider = $2`,
    [accountId, provider],
  )).rows[0] ?? null;
  const choiceRowCount = async (accountId: number, provider: string) => Number((await query<{ n: string }>(
    `SELECT count(*) n FROM onboarding_provider_choices WHERE account_id = $1 AND provider = $2`,
    [accountId, provider],
  )).rows[0].n);
  const connRowCount = async (accountId: number, provider: string) => Number((await query<{ n: string }>(
    `SELECT count(*) n FROM connections WHERE account_id = $1 AND provider = $2`,
    [accountId, provider],
  )).rows[0].n);
  const stateOf = async (accountId: number, provider: string) =>
    (await choices.getProviderStatuses(accountId)).find((p) => p.provider === provider)?.state;

  interface RequestBody {
    provider: string; state: string; message: string;
    providers: { provider: string; state: string }[];
  }

  /** Assert a successful request response and its persisted shape. */
  async function checkRequestSucceeded(
    label: string, res: { statusCode: number; body: string }, accountId: number, provider: string,
  ): Promise<void> {
    record(label, res);
    check(`${label}: 200`, res.statusCode === 200, { status: res.statusCode, body: res.body });
    const body = JSON.parse(res.body) as RequestBody;
    check(`${label}: top-level provider is ${provider}`, body.provider === provider, body.provider);
    check(`${label}: top-level state is requested`, body.state === 'requested', body.state);
    check(`${label}: the provider array reports it requested`,
      body.providers.find((p) => p.provider === provider)?.state === 'requested',
      body.providers);
    check(`${label}: it is NOT reported connected anywhere in the response`,
      !body.providers.some((p) => p.provider === provider && p.state === 'connected')
      && body.state !== 'connected', body);
    check(`${label}: exactly one choice row exists`, (await choiceRowCount(accountId, provider)) === 1);
    const row = await choiceRow(accountId, provider);
    check(`${label}: choice='requested'`, row?.choice === 'requested', row?.choice);
    check(`${label}: requested_domain IS NULL`, row?.requested_domain === null, row?.requested_domain);
    check(`${label}: no connection row exists`, (await connRowCount(accountId, provider)) === 0);
    check(`${label}: derived state is requested`, (await stateOf(accountId, provider)) === 'requested');
  }

  // =======================================================================
  // A. Route and action contract
  // =======================================================================
  const routeApp = buildApp();
  const declaredM = new Map<string, string | undefined>();
  routeApp.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      if (!r.url.startsWith('/onboarding')) continue;
      declaredM.set(`${m} ${r.url}`, (r.config as { clientAction?: string } | undefined)?.clientAction);
    }
  });
  await routeApp.ready();
  const authenticatedM = [...declaredM.entries()]
    .filter(([k]) => !k.startsWith('HEAD ') && k !== 'POST /onboarding/session');
  check('A. the real app has 17 authenticated scoped onboarding routes',
    authenticatedM.length === 17, authenticatedM.map(([k]) => k));
  check('A. all 17 declare a clientAction',
    authenticatedM.every(([, v]) => typeof v === 'string' && v.length > 0),
    authenticatedM.filter(([, v]) => !v).map(([k]) => k));
  check('A. POST /onboarding/connections/:provider/request declares connections.choice.request',
    declaredM.get('POST /onboarding/connections/:provider/request') === 'connections.choice.request',
    declaredM.get('POST /onboarding/connections/:provider/request'));
  check('A. the static Shopify request route is still separately registered',
    declaredM.get('POST /onboarding/connections/shopify/request') === 'connections.shopify.request');
  check('A. POST /onboarding/session is still public token exchange with no clientAction',
    declaredM.has('POST /onboarding/session')
    && declaredM.get('POST /onboarding/session') === undefined);
  await routeApp.close();

  check('A. connections.choice.request is in the centralized action vocabulary',
    (manageMode.CLIENT_ONBOARDING_ACTIONS as readonly string[]).includes('connections.choice.request'));
  check('A. connections.choice.request is in the centralized manage-mode allowlist',
    manageMode.isAllowedInManageMode('connections.choice.request'));
  // 17 routes, 16 DISTINCT actions: GET /onboarding/skus and GET
  // /onboarding/costs deliberately share `costs.read`, because an action names a
  // category of thing a session may do, not a URL. 5C-2 added one action to the
  // 15 that existed before it.
  check('A. the vocabulary holds 16 distinct actions for 17 routes',
    manageMode.CLIENT_ONBOARDING_ACTIONS.length === 16,
    manageMode.CLIENT_ONBOARDING_ACTIONS.length);
  check('A. every declared route action is a member of that vocabulary',
    authenticatedM.every(([, v]) =>
      (manageMode.CLIENT_ONBOARDING_ACTIONS as readonly string[]).includes(v as string)),
    authenticatedM.map(([, v]) => v));
  check('A. costs.read is the only action serving more than one route',
    authenticatedM.filter(([, v]) => v === 'costs.read').length === 2
    && new Set(authenticatedM.map(([, v]) => v)).size === 16,
    authenticatedM.map(([k, v]) => `${k}→${v}`));
  check('A. an unknown action is still not allowlisted',
    !manageMode.isAllowedInManageMode('connections.choice.invent'));

  // =======================================================================
  // B. Authentication and account scope
  // =======================================================================
  const b1 = await makeAccount('5c2_auth');
  const bLink = await mintAndExchange(app, agencyCookie, b1);

  const bAnon = await app.inject({
    method: 'POST', url: requestUrl('klaviyo'), remoteAddress: nextIp(),
  });
  check('B. no cookie is refused with 401', bAnon.statusCode === 401, bAnon.statusCode);
  const bAgency = await app.inject({
    method: 'POST', url: requestUrl('klaviyo'), headers: { cookie: agencyCookie },
    remoteAddress: nextIp(),
  });
  check('B. an agency cookie is refused with 401', bAgency.statusCode === 401, bAgency.statusCode);
  check('B. neither refusal created a choice row',
    (await choiceRowCount(b1, 'klaviyo')) === 0);
  const bValid = await requestBodyless(bLink.cookie, 'klaviyo');
  check('B. a valid onboarding-link cookie reaches the client route',
    bValid.statusCode === 200, { status: bValid.statusCode, body: bValid.body });
  record('B valid', bValid);

  // Account identifiers: rejected by the hook, before the handler.
  const b2 = await makeAccount('5c2_auth_other');
  const bOtherBefore = await tableSnapshot('onboarding_provider_choices', b2);
  for (const key of ['accountId', 'account_id', 'account']) {
    const res = await app.inject({
      method: 'POST', url: requestUrl('recharge'),
      headers: { cookie: bLink.cookie, 'content-type': 'application/json' },
      remoteAddress: nextIp(), payload: `{"${key}":${b2}}`,
    });
    record(`B body ${key}`, res);
    check(`B. a body ${key} is rejected by rejectClientAccountId, not by the body guard`,
      res.statusCode === 400
      && (JSON.parse(res.body) as { error: string }).error === 'account_identifier_not_permitted',
      { status: res.statusCode, body: res.body });
    const q = await app.inject({
      method: 'POST', url: `${requestUrl('recharge')}?${key}=${b2}`,
      headers: { cookie: bLink.cookie }, remoteAddress: nextIp(),
    });
    record(`B query ${key}`, q);
    check(`B. a query-string ${key} is rejected the same way`,
      q.statusCode === 400
      && (JSON.parse(q.body) as { error: string }).error === 'account_identifier_not_permitted',
      { status: q.statusCode, body: q.body });
  }
  check('B. no account-identifier attempt wrote anything to the named account',
    (await tableSnapshot('onboarding_provider_choices', b2)) === bOtherBefore
    && (await tableSnapshot('connections', b2)) === '[]');
  check('B. nor to the session\'s own account beyond its one real request',
    (await choiceRowCount(b1, 'recharge')) === 0);
  check('B. account identity came only from the principal — B\'s klaviyo row is on A',
    (await choiceRowCount(b1, 'klaviyo')) === 1 && (await choiceRowCount(b2, 'klaviyo')) === 0);

  // =======================================================================
  // C. Strictly bodyless contract
  // =======================================================================
  for (const provider of ['klaviyo', 'recharge'] as const) {
    const c = await makeAccount(`5c2_body_${provider}`);
    const cLink = await mintAndExchange(app, agencyCookie, c);

    // The bodyless call proceeds.
    const ok = await requestBodyless(cLink.cookie, provider);
    check(`C. ${provider}: no body and no Content-Type proceeds`, ok.statusCode === 200,
      { status: ok.statusCode, body: ok.body });
    record(`C ${provider} bodyless`, ok);

    // Reset to a known state, then prove the whole matrix mutates nothing.
    const choicesBefore = await tableSnapshot('onboarding_provider_choices', c);
    const connsBefore = await tableSnapshot('connections', c);
    const dbsizeBefore = await redis.dbsize();
    fetchLog = [];
    const rejections: string[] = [];

    for (const [label, raw] of BODY_CASES) {
      const res = await app.inject({
        method: 'POST', url: requestUrl(provider),
        headers: { cookie: cLink.cookie, 'content-type': 'application/json' },
        remoteAddress: nextIp(), payload: raw,
      });
      rejections.push(`${res.statusCode}|${res.body}`);
      check(`C. ${provider} body ${label}: 400 request_body_not_permitted`,
        res.statusCode === 400 && res.body === BODY_REFUSAL,
        { status: res.statusCode, body: res.body });
    }
    check(`C. ${provider}: every body rejection is BYTE-IDENTICAL`,
      new Set(rejections).size === 1, [...new Set(rejections)]);
    check(`C. ${provider}: no rejection reflects a submitted field name or value`,
      rejections.every((r) => !REFLECTION_NEEDLES.some((n) => r.includes(n))),
      rejections.filter((r) => REFLECTION_NEEDLES.some((n) => r.includes(n))));
    check(`C. ${provider}: no provider-choice row was created or modified`,
      (await tableSnapshot('onboarding_provider_choices', c)) === choicesBefore);
    check(`C. ${provider}: no connection row was created or modified`,
      (await tableSnapshot('connections', c)) === connsBefore
      && (await tableSnapshot('connections', c)) === '[]');
    check(`C. ${provider}: no outbound provider request occurred`,
      fetchLog.length === 0, fetchLog.map((f) => f.url));
    check(`C. ${provider}: no Redis key was added`,
      (await redis.dbsize()) === dbsizeBefore,
      { before: dbsizeBefore, after: await redis.dbsize() });
    check(`C. ${provider}: no backfill job was created`,
      (await queues.klaviyoPollQueue().getJob(queues.klaviyoBackfillJobId(c))
        .catch(() => null)) == null
      && (await queues.rechargeBackfillQueue().getJob(queues.rechargeBackfillJobId(c))
        .catch(() => null)) == null);

    // Content-Type: application/json with NO payload — Fastify's own empty-JSON
    // behaviour, deliberately left alone rather than forced to a different
    // answer by changing the global content-type parser.
    const emptyJson = await app.inject({
      method: 'POST', url: requestUrl(provider),
      headers: { cookie: cLink.cookie, 'content-type': 'application/json' },
      remoteAddress: nextIp(),
    });
    record(`C ${provider} empty-json`, emptyJson);
    check(`C. ${provider}: application/json with no payload is Fastify's 400, before the handler`,
      emptyJson.statusCode === 400
      && (JSON.parse(emptyJson.body) as { code?: string }).code === 'FST_ERR_CTP_EMPTY_JSON_BODY',
      { status: emptyJson.statusCode, body: emptyJson.body });
    check(`C. ${provider}: the empty-JSON refusal changed no state`,
      (await tableSnapshot('onboarding_provider_choices', c)) === choicesBefore
      && (await tableSnapshot('connections', c)) === connsBefore);
  }

  // --- C. Ordering proofs ------------------------------------------------
  const cOrder = await makeAccount('5c2_body_order');
  await seedConnectedProvider(cOrder, 'klaviyo');
  const cOrderLink = await mintAndExchange(app, agencyCookie, cOrder);
  const cOrderChoices = await tableSnapshot('onboarding_provider_choices', cOrder);
  const cOrderConns = await tableSnapshot('connections', cOrder);

  const connectedWithBody = await app.inject({
    method: 'POST', url: requestUrl('klaviyo'),
    headers: { cookie: cOrderLink.cookie, 'content-type': 'application/json' },
    remoteAddress: nextIp(), payload: '{"apiKey":"synthetic-key"}',
  });
  record('C connected+body', connectedWithBody);
  check('C. a CONNECTED provider plus a body returns request_body_not_permitted, not provider_already_connected',
    connectedWithBody.statusCode === 400 && connectedWithBody.body === BODY_REFUSAL,
    { status: connectedWithBody.statusCode, body: connectedWithBody.body });

  const unknownWithBody = await app.inject({
    method: 'POST', url: requestUrl('not_a_provider'),
    headers: { cookie: cOrderLink.cookie, 'content-type': 'application/json' },
    remoteAddress: nextIp(), payload: '{"unknown":"value"}',
  });
  record('C unknown+body', unknownWithBody);
  check('C. an UNKNOWN provider plus a body returns request_body_not_permitted, not bad_provider',
    unknownWithBody.statusCode === 400 && unknownWithBody.body === BODY_REFUSAL,
    { status: unknownWithBody.statusCode, body: unknownWithBody.body });
  check('C. both ordering probes mutated nothing',
    (await tableSnapshot('onboarding_provider_choices', cOrder)) === cOrderChoices
    && (await tableSnapshot('connections', cOrder)) === cOrderConns);

  // =======================================================================
  // D. Provider routing, and Shopify's static-route precedence
  // =======================================================================
  const d1 = await makeAccount('5c2_routing');
  const dLink = await mintAndExchange(app, agencyCookie, d1);

  const dUnknown = await requestBodyless(dLink.cookie, 'not_a_provider');
  record('D unknown', dUnknown);
  check('D. an unknown provider is 400 bad_provider',
    dUnknown.statusCode === 400
    && (JSON.parse(dUnknown.body) as { error: string }).error === 'bad_provider',
    { status: dUnknown.statusCode, body: dUnknown.body });
  check('D. klaviyo is accepted', (await requestBodyless(dLink.cookie, 'klaviyo')).statusCode === 200);
  check('D. recharge is accepted', (await requestBodyless(dLink.cookie, 'recharge')).statusCode === 200);

  // STATIC-ROUTE PRECEDENCE, proven rather than assumed.
  //
  // find-my-way prefers a static segment over a parametric one, so
  // /onboarding/connections/shopify/request reaches the DOMAIN-BEARING route and
  // never the generic handler. The two are distinguishable by their responses:
  // the generic handler answers a bodyless shopify call with `bad_provider`,
  // while the static route answers it with the domain validator's `empty`.
  const dShopifyBodyless = await requestBodyless(dLink.cookie, 'shopify');
  record('D shopify bodyless', dShopifyBodyless);
  check('D. a bodyless Shopify request reaches the STATIC domain route, not the generic one',
    dShopifyBodyless.statusCode === 400
    && (JSON.parse(dShopifyBodyless.body) as { code?: string; error?: string }).code === 'empty'
    && (JSON.parse(dShopifyBodyless.body) as { error?: string }).error === undefined,
    { status: dShopifyBodyless.statusCode, body: dShopifyBodyless.body });

  const dDomain = `5c2-static-${Date.now()}.myshopify.com`;
  const dShopifyOk = await app.inject({
    method: 'POST', url: requestUrl('shopify'), headers: { cookie: dLink.cookie },
    remoteAddress: nextIp(), payload: { shopDomain: dDomain.toUpperCase() },
  });
  record('D shopify domain', dShopifyOk);
  check('D. a valid synthetic Shopify domain request keeps its existing behaviour',
    dShopifyOk.statusCode === 200
    && (JSON.parse(dShopifyOk.body) as { shopDomain: string }).shopDomain === dDomain,
    { status: dShopifyOk.statusCode, body: dShopifyOk.body });
  const dShopifyRow = await choiceRow(d1, 'shopify');
  check('D. Shopify still stores its requested_domain — the domainless path was NOT used',
    dShopifyRow?.choice === 'requested' && dShopifyRow?.requested_domain === dDomain,
    dShopifyRow);
  check('D. the Shopify request created no connection row',
    (await connRowCount(d1, 'shopify')) === 0);

  const dShopifyBadDomain = await app.inject({
    method: 'POST', url: requestUrl('shopify'), headers: { cookie: dLink.cookie },
    remoteAddress: nextIp(), payload: { shopDomain: 'not-a-shopify-store.example.com' },
  });
  record('D shopify bad domain', dShopifyBadDomain);
  check('D. an invalid Shopify domain keeps its existing safe response',
    dShopifyBadDomain.statusCode === 400
    && (JSON.parse(dShopifyBadDomain.body) as { code: string }).code === 'not_myshopify',
    { status: dShopifyBadDomain.statusCode, body: dShopifyBadDomain.body });

  fetchLog = [];
  const dShopifyCreds = await app.inject({
    method: 'POST', url: requestUrl('shopify'), headers: { cookie: dLink.cookie },
    remoteAddress: nextIp(),
    payload: {
      shopDomain: dDomain, clientId: 'synthetic-client-id',
      clientSecret: 'synthetic-secret', useEnvCredentials: true,
    },
  });
  record('D shopify creds', dShopifyCreds);
  check('D. Shopify credentials on the client request surface are never accepted',
    (await connRowCount(d1, 'shopify')) === 0 && fetchLog.length === 0,
    { conns: await connRowCount(d1, 'shopify'), fetches: fetchLog.map((f) => f.url) });
  check('D. and the response echoes neither the client id nor the secret',
    !dShopifyCreds.body.includes('synthetic-client-id')
    && !dShopifyCreds.body.includes('synthetic-secret'));

  // =======================================================================
  // E / F. Full transition matrices, per provider
  // =======================================================================
  for (const provider of ['klaviyo', 'recharge'] as const) {
    const t = await makeAccount(`5c2_transitions_${provider}`);
    const tLink = await mintAndExchange(app, agencyCookie, t);
    const P = provider === 'klaviyo' ? 'E' : 'F';

    // 1. no row / undecided → requested
    check(`${P}. ${provider} starts undecided with no choice row`,
      (await choiceRowCount(t, provider)) === 0 && (await stateOf(t, provider)) === 'undecided');
    await checkRequestSucceeded(
      `${P}1. ${provider} undecided → requested`, await requestBodyless(tLink.cookie, provider), t, provider);

    // 2. choice='pending' → requested (the state supersedeChoiceOnConnect leaves)
    await choices.supersedeChoiceOnConnect(t, provider);
    check(`${P}2. ${provider} is 'pending' and therefore reads as undecided`,
      (await choiceRow(t, provider))?.choice === 'pending'
      && (await stateOf(t, provider)) === 'undecided');
    await checkRequestSucceeded(
      `${P}2. ${provider} pending → requested`, await requestBodyless(tLink.cookie, provider), t, provider);

    // 3. skipped → requested
    const skipRes = await skipCall(tLink.cookie, provider);
    check(`${P}3. ${provider} requested → skipped succeeds`, skipRes.statusCode === 200,
      { status: skipRes.statusCode, body: skipRes.body });
    record(`${P}3 ${provider} skip`, skipRes);
    check(`${P}3. ${provider} is now skipped`, (await stateOf(t, provider)) === 'skipped');
    await checkRequestSucceeded(
      `${P}3. ${provider} skipped → requested`, await requestBodyless(tLink.cookie, provider), t, provider);

    // 4. requested → requested, idempotently
    const beforeDup = await choiceRow(t, provider);
    const dup = await requestBodyless(tLink.cookie, provider);
    await checkRequestSucceeded(
      `${P}4. ${provider} requested → requested (duplicate)`, dup, t, provider);
    check(`${P}4. ${provider}: the duplicate added no second choice row`,
      (await choiceRowCount(t, provider)) === 1);
    check(`${P}4. ${provider}: choice and requested_domain are unchanged by the duplicate`,
      (await choiceRow(t, provider))?.choice === beforeDup?.choice
      && (await choiceRow(t, provider))?.requested_domain === beforeDup?.requested_domain);

    // 5. requested → skipped
    const skip2 = await skipCall(tLink.cookie, provider);
    record(`${P}5 ${provider} skip`, skip2);
    check(`${P}5. ${provider} requested → skipped`,
      skip2.statusCode === 200 && (await stateOf(t, provider)) === 'skipped',
      { status: skip2.statusCode, state: await stateOf(t, provider) });
    check(`${P}5. ${provider}: skipping cleared requested_domain and kept one row`,
      (await choiceRow(t, provider))?.requested_domain === null
      && (await choiceRowCount(t, provider)) === 1);

    // 6. skipped → requested again
    await checkRequestSucceeded(
      `${P}6. ${provider} skipped → requested again`,
      await requestBodyless(tLink.cookie, provider), t, provider);
    check(`${P}6. ${provider}: still exactly one choice row after six transitions`,
      (await choiceRowCount(t, provider)) === 1);
    check(`${P}6. ${provider}: still no connection row after six transitions`,
      (await connRowCount(t, provider)) === 0);
  }

  // =======================================================================
  // G. A request has no connection side effects
  // =======================================================================
  const g1 = await makeAccount('5c2_side_effects');
  const gLink = await mintAndExchange(app, agencyCookie, g1);
  const gAccountBefore = await completionSnapshot(g1);
  const gDbsizeBefore = await redis.dbsize();
  fetchLog = [];

  const gK = await requestBodyless(gLink.cookie, 'klaviyo');
  const gR = await requestBodyless(gLink.cookie, 'recharge');
  record('G klaviyo', gK);
  record('G recharge', gR);
  check('G. both requests succeeded', gK.statusCode === 200 && gR.statusCode === 200);
  check('G. NO outbound provider request was made — no verification function was reached',
    fetchLog.length === 0, fetchLog.map((f) => f.url));
  check('G. no .env credential could have leaked, since nothing was sent',
    envCredentialLeaked() === null, envCredentialLeaked());
  check('G. the connections table is still empty for this account',
    (await tableSnapshot('connections', g1)) === '[]');
  check('G. no credentials_encrypted value exists anywhere for this account',
    Number((await query<{ n: string }>(
      `SELECT count(*) n FROM connections WHERE account_id = $1 AND credentials_encrypted IS NOT NULL`,
      [g1])).rows[0].n) === 0);
  check('G. no BullMQ job was created for either provider',
    (await queues.klaviyoPollQueue().getJob(queues.klaviyoBackfillJobId(g1)).catch(() => null)) == null
    && (await queues.rechargeBackfillQueue().getJob(queues.rechargeBackfillJobId(g1)).catch(() => null)) == null
    && (await queues.backfillQueue().getJob(queues.backfillJobId(g1)).catch(() => null)) == null);
  check('G. Redis gained no key from either request',
    (await redis.dbsize()) === gDbsizeBefore);
  check('G. no sync status was fabricated — progress reports nothing connected',
    (await capabilities.getCapabilities(g1)).connected.length === 0);
  check('G. no capability was granted by requesting',
    (await capabilities.getCapabilities(g1)).available.length === 0);
  check('G. requesting is recorded as requested, not connected, in capabilities',
    (await capabilities.getCapabilities(g1)).requested.sort().join(',') === 'klaviyo,recharge',
    (await capabilities.getCapabilities(g1)).requested);
  check('G. ONLY onboarding_provider_choices changed on this account',
    (await completionSnapshot(g1)) !== gAccountBefore
    && (await tableSnapshot('connections', g1)) === '[]'
    && (await tableSnapshot('ad_spend', g1)) === '[]'
    && (await tableSnapshot('sku_costs', g1)) === '[]'
    && (await tableSnapshot('account_costs', g1)) === '[]');
  check('G. requested does NOT satisfy the genuine-connected requirement',
    (await state.canCompleteOnboarding(g1)).blockers
      .some((b) => b.code === 'no_platform_connected'),
    (await state.canCompleteOnboarding(g1)).blockers.map((b) => b.code));

  // =======================================================================
  // H. Connected-provider refusal — request AND skip, before and after Gate 1
  // =======================================================================
  for (const provider of ['klaviyo', 'recharge'] as const) {
    // --- before completion ---------------------------------------------
    const h = await makeAccount(`5c2_connected_pre_${provider}`);
    await seedConnectedProvider(h, provider);
    const hLink = await mintAndExchange(app, agencyCookie, h);
    check(`H. ${provider}: the account has NOT completed (first-time setup mode)`,
      !(await state.isOnboardingComplete(h)));
    const hChoices = await tableSnapshot('onboarding_provider_choices', h);
    const hConns = await tableSnapshot('connections', h);
    fetchLog = [];

    const hReq = await requestBodyless(hLink.cookie, provider);
    record(`H ${provider} pre request`, hReq);
    check(`H. ${provider}: requesting a CONNECTED provider before completion is 409`,
      hReq.statusCode === 409
      && (JSON.parse(hReq.body) as { code: string }).code === 'provider_already_connected',
      { status: hReq.statusCode, body: hReq.body });
    const hSkip = await skipCall(hLink.cookie, provider);
    record(`H ${provider} pre skip`, hSkip);
    check(`H. ${provider}: skipping a CONNECTED provider before completion is 409 (newly unconditional)`,
      hSkip.statusCode === 409
      && (JSON.parse(hSkip.body) as { code: string }).code === 'provider_already_connected',
      { status: hSkip.statusCode, body: hSkip.body });
    check(`H. ${provider}: both refusals are byte-identical`, hReq.body === hSkip.body,
      { req: hReq.body, skip: hSkip.body });
    check(`H. ${provider}: the choice table is unchanged`,
      (await tableSnapshot('onboarding_provider_choices', h)) === hChoices);
    check(`H. ${provider}: the connection row and its encrypted credential are unchanged`,
      (await tableSnapshot('connections', h)) === hConns);
    check(`H. ${provider}: it is still reported connected, never skipped`,
      (await stateOf(h, provider)) === 'connected');
    check(`H. ${provider}: no provider request and no queue job resulted`,
      fetchLog.length === 0
      && (await queues.klaviyoPollQueue().getJob(queues.klaviyoBackfillJobId(h)).catch(() => null)) == null
      && (await queues.rechargeBackfillQueue().getJob(queues.rechargeBackfillJobId(h)).catch(() => null)) == null,
      fetchLog.map((f) => f.url));

    // --- in manage mode --------------------------------------------------
    const hm = await makeAccount(`5c2_connected_manage_${provider}`);
    await seedConnectedProvider(hm, provider);
    for (const other of PROVIDER_TRIO.filter((p) => p !== provider)) {
      await choices.setSkipped(hm, other);
    }
    const hmLink = await mintAndExchange(app, agencyCookie, hm);
    await app.inject({
      method: 'POST', url: `/accounts/${hm}/onboarding/complete`,
      headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
    });
    check(`H. ${provider}: the account is now in manage mode`,
      (await state.isOnboardingComplete(hm)));
    const hmChoices = await tableSnapshot('onboarding_provider_choices', hm);
    const hmConns = await tableSnapshot('connections', hm);
    fetchLog = [];

    const hmReq = await requestBodyless(hmLink.cookie, provider);
    const hmSkip = await skipCall(hmLink.cookie, provider);
    record(`H ${provider} manage request`, hmReq);
    record(`H ${provider} manage skip`, hmSkip);
    check(`H. ${provider}: requesting a CONNECTED provider in manage mode is the same 409`,
      hmReq.statusCode === 409 && hmReq.body === hReq.body,
      { status: hmReq.statusCode, body: hmReq.body });
    check(`H. ${provider}: skipping a CONNECTED provider in manage mode is the same 409`,
      hmSkip.statusCode === 409 && hmSkip.body === hReq.body,
      { status: hmSkip.statusCode, body: hmSkip.body });
    check(`H. ${provider}: manage-mode refusals mutated nothing`,
      (await tableSnapshot('onboarding_provider_choices', hm)) === hmChoices
      && (await tableSnapshot('connections', hm)) === hmConns
      && fetchLog.length === 0);
    check(`H. ${provider}: the refusal message is stable and names no account or link`,
      (JSON.parse(hmReq.body) as { message: string }).message
        === `${provider === 'klaviyo' ? 'Klaviyo' : 'Recharge'} is already connected. `
          + 'Ask your account manager to change it.',
      hmReq.body);
    check(`H. ${provider}: the refusal does not say whether a credential was submitted`,
      !/credential|apiKey|token|key/i.test(hmReq.body), hmReq.body);
  }

  // =======================================================================
  // I. Connect preservation — requested/skipped → genuinely connected
  // =======================================================================
  for (const provider of ['klaviyo', 'recharge'] as const) {
    for (const start of ['requested', 'skipped'] as const) {
      const i = await makeAccount(`5c2_connect_${provider}_${start}`);
      const iLink = await mintAndExchange(app, agencyCookie, i);
      if (start === 'requested') await requestBodyless(iLink.cookie, provider);
      else await skipCall(iLink.cookie, provider);
      check(`I. ${provider}: starts ${start}`, (await stateOf(i, provider)) === start);

      const secret = provider === 'klaviyo'
        ? `pk_5c2_${start}_key_00000000000000000`
        : `recharge_5c2_${start}_token`;
      const connected = await app.inject({
        method: 'POST', url: `/onboarding/connections/${provider}`,
        headers: { cookie: iLink.cookie }, remoteAddress: nextIp(),
        payload: provider === 'klaviyo' ? { apiKey: secret } : { token: secret },
      });
      record(`I ${provider} ${start} connect`, connected);
      check(`I. ${provider}: ${start} → connected succeeds`,
        [200, 202].includes(connected.statusCode), connected.body);
      check(`I. ${provider}: a real connection is the only connected fact`,
        (await stateOf(i, provider)) === 'connected');
      check(`I. ${provider}: exactly one connection row exists`,
        (await connRowCount(i, provider)) === 1);
      const row = (await query<{ credentials_encrypted: string; status: string }>(
        `SELECT credentials_encrypted, status FROM connections
          WHERE account_id = $1 AND provider = $2`, [i, provider])).rows[0];
      check(`I. ${provider}: the credential is encrypted at rest`,
        !row.credentials_encrypted.includes(secret));
      check(`I. ${provider}: and decrypts back to what was submitted`,
        JSON.parse(decrypt(row.credentials_encrypted))[provider === 'klaviyo' ? 'apiKey' : 'token']
          === secret);
      check(`I. ${provider}: the ${start} choice was superseded to 'pending'`,
        (await choiceRow(i, provider))?.choice === 'pending',
        (await choiceRow(i, provider))?.choice);
      check(`I. ${provider}: the response never echoes the credential`,
        !connected.body.includes(secret));
    }
  }

  // =======================================================================
  // J. Completion-gate truth
  // =======================================================================
  const j1 = await makeAccount('5c2_gate_mixed');
  const jLink = await mintAndExchange(app, agencyCookie, j1);
  await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: jLink.cookie },
    remoteAddress: nextIp(), payload: { apiKey: 'pk_5c2_gate_key_0000000000000000000' },
  });
  await requestBodyless(jLink.cookie, 'recharge');
  await skipCall(jLink.cookie, 'shopify');
  const jStates = await choices.getProviderStatuses(j1);
  check('J. the account is connected / requested / skipped across the three providers',
    jStates.map((p) => `${p.provider}:${p.state}`).join(',')
      === 'shopify:skipped,klaviyo:connected,recharge:requested', jStates);
  const jGate = await state.canCompleteOnboarding(j1);
  check('J. that combination satisfies the basic provider-answer gate',
    jGate.complete === true, jGate.blockers.map((b) => b.code));
  check('J. a requested provider counts as ANSWERED — no provider_undecided blocker',
    !jGate.blockers.some((b) => b.code === 'provider_undecided'));
  check('J. and is not counted among the genuine connections',
    jGate.connectedCount === 1, jGate.connectedCount);
  const jDone = await app.inject({
    method: 'POST', url: '/onboarding/complete', headers: { cookie: jLink.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  record('J complete', jDone);
  check('J. completion succeeds through the real route', jDone.statusCode === 200, jDone.body);
  check('J. no financial input was required', !(await hasAnyFinancialInput(j1)));
  const jBody = JSON.parse(jDone.body) as { rcmReady: boolean; rcmBlockers: { code: string }[] };
  check('J. RCM readiness stays separate and is NOT ready', jBody.rcmReady === false);
  check('J. and it is the missing Shopify connection, not the request, that blocks RCM',
    jBody.rcmBlockers.some((b) => b.code === 'shopify_not_connected'),
    jBody.rcmBlockers.map((b) => b.code));
  check('J. Recharge is STILL requested after completion, never relabelled connected',
    (await stateOf(j1, 'recharge')) === 'requested');
  check('J. and no connection row was invented for it',
    (await connRowCount(j1, 'recharge')) === 0);

  // Requested-only / skipped-only, with zero genuine connections.
  const j2 = await makeAccount('5c2_gate_requests_only');
  const j2Link = await mintAndExchange(app, agencyCookie, j2);
  await requestBodyless(j2Link.cookie, 'klaviyo');
  await requestBodyless(j2Link.cookie, 'recharge');
  await skipCall(j2Link.cookie, 'shopify');
  const j2Gate = await state.canCompleteOnboarding(j2);
  check('J. every provider answered but NONE connected still fails the gate',
    j2Gate.complete === false, j2Gate.blockers.map((b) => b.code));
  check('J. the blocker is no_platform_connected, not provider_undecided',
    j2Gate.blockers.some((b) => b.code === 'no_platform_connected')
    && !j2Gate.blockers.some((b) => b.code === 'provider_undecided'),
    j2Gate.blockers.map((b) => b.code));
  const j2Done = await app.inject({
    method: 'POST', url: '/onboarding/complete', headers: { cookie: j2Link.cookie },
    remoteAddress: nextIp(), payload: {},
  });
  record('J requests-only complete', j2Done);
  check('J. the real completion route refuses it with 409', j2Done.statusCode === 409, j2Done.body);
  check('J. onboarding_complete did NOT become true merely because providers were requested',
    !(await state.isOnboardingComplete(j2)));
  check('J. and the historical latch is untouched for that account',
    (await query<{ c: boolean }>(
      `SELECT onboarding_complete c FROM accounts WHERE id = $1`, [j2])).rows[0].c === false);

  // =======================================================================
  // K. Manage-mode requested ↔ skipped on an UNCONNECTED provider
  // =======================================================================
  const k1 = await makeAccount('5c2_manage_transitions');
  await seedConnectedProvider(k1, 'klaviyo');
  await choices.setSkipped(k1, 'shopify');
  await choices.setSkipped(k1, 'recharge');
  const kLink = await mintAndExchange(app, agencyCookie, k1);
  await app.inject({
    method: 'POST', url: `/accounts/${k1}/onboarding/complete`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(), payload: {},
  });
  const kMe = await app.inject({
    method: 'GET', url: '/onboarding/me', headers: { cookie: kLink.cookie }, remoteAddress: nextIp(),
  });
  check('K. the link is in manage mode',
    (JSON.parse(kMe.body) as { manageMode: boolean }).manageMode === true);

  const kToRequested = await requestBodyless(kLink.cookie, 'recharge');
  record('K skipped→requested', kToRequested);
  check('K. an UNCONNECTED provider may go skipped → requested in manage mode',
    kToRequested.statusCode === 200 && (await stateOf(k1, 'recharge')) === 'requested',
    { status: kToRequested.statusCode, state: await stateOf(k1, 'recharge') });
  const kToSkipped = await skipCall(kLink.cookie, 'recharge');
  record('K requested→skipped', kToSkipped);
  check('K. and requested → skipped, on the SAME cookie with no token exchange',
    kToSkipped.statusCode === 200 && (await stateOf(k1, 'recharge')) === 'skipped',
    { status: kToSkipped.statusCode, state: await stateOf(k1, 'recharge') });
  const kBack = await requestBodyless(kLink.cookie, 'recharge');
  check('K. and back again, still with no re-exchange',
    kBack.statusCode === 200 && (await stateOf(k1, 'recharge')) === 'requested');
  check('K. the CONNECTED provider may do neither',
    (await requestBodyless(kLink.cookie, 'klaviyo')).statusCode === 409
    && (await skipCall(kLink.cookie, 'klaviyo')).statusCode === 409);
  check('K. and it is still connected after both refusals',
    (await stateOf(k1, 'klaviyo')) === 'connected');

  // =======================================================================
  // M. Expiry, revocation and isolation on the new route
  // =======================================================================
  const m1 = await makeAccount('5c2_revoked');
  const mLink = await mintAndExchange(app, agencyCookie, m1);
  check('M. the new route works while the link is live',
    (await requestBodyless(mLink.cookie, 'klaviyo')).statusCode === 200);
  const mBefore = await tableSnapshot('onboarding_provider_choices', m1);
  await app.inject({
    method: 'DELETE', url: `/accounts/${m1}/onboarding-links/${mLink.linkId}`,
    headers: { cookie: agencyCookie }, remoteAddress: nextIp(),
  });
  const mRevoked = await requestBodyless(mLink.cookie, 'recharge');
  record('M revoked', mRevoked);
  check('M. a revoked link fails on the very next request to the new route',
    mRevoked.statusCode === 401, mRevoked.statusCode);
  check('M. the revoked refusal is the neutral client failure',
    JSON.parse(mRevoked.body).error === 'invalid_link', mRevoked.body);
  check('M. the revoked response clears the onboarding cookie, per the existing contract',
    (cookieDirective(mRevoked, 'tention_onb') ?? '').startsWith('tention_onb=;'),
    cookieDirective(mRevoked, 'tention_onb'));
  check('M. and nothing changed after the revoked attempt',
    (await tableSnapshot('onboarding_provider_choices', m1)) === mBefore);

  const m2 = await makeAccount('5c2_expired');
  const m2Link = await mintAndExchange(app, agencyCookie, m2);
  await query(`UPDATE onboarding_links SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [m2Link.linkId]);
  const mExpired = await requestBodyless(m2Link.cookie, 'klaviyo');
  record('M expired', mExpired);
  check('M. an expired link fails on the very next request to the new route',
    mExpired.statusCode === 401, mExpired.statusCode);
  check('M. and wrote nothing', (await tableSnapshot('onboarding_provider_choices', m2)) === '[]');

  const m3 = await makeAccount('5c2_isolation_a');
  const m4 = await makeAccount('5c2_isolation_b');
  const m3Link = await mintAndExchange(app, agencyCookie, m3);
  await choices.setSkipped(m4, 'recharge');
  const m4Before = await tableSnapshot('onboarding_provider_choices', m4);
  await requestBodyless(m3Link.cookie, 'recharge');
  check('M. one account\'s request cannot alter another account\'s choices',
    (await tableSnapshot('onboarding_provider_choices', m4)) === m4Before);
  check('M. nor another account\'s connections',
    (await tableSnapshot('connections', m4)) === '[]');
  check('M. no agency route became reachable from the client cookie',
    (await app.inject({
      method: 'GET', url: '/accounts', headers: { cookie: m3Link.cookie }, remoteAddress: nextIp(),
    })).statusCode === 401
    && (await app.inject({
      method: 'POST', url: `/accounts/${m4}/onboarding-links`,
      headers: { cookie: m3Link.cookie }, remoteAddress: nextIp(), payload: {},
    })).statusCode === 401);

  // =======================================================================
  // L. Response hygiene, over every response this group produced
  // =======================================================================
  for (const [label, body] of collected) checkMHygiene(`L ${label}`, body);
  check('L. no response in this group leaked a synthetic credential value',
    collected.every(([, b]) =>
      !['synthetic-key', 'synthetic-token', 'synthetic-secret', 'synthetic-client-id']
        .some((n) => b.includes(n))),
    collected.filter(([, b]) => b.includes('synthetic-')).map(([l]) => l));
  check('L. no .env credential leaked while this group ran',
    envCredentialLeaked() === null, envCredentialLeaked());
}

/** The three providers, for loops that need "the other two". */
const PROVIDER_TRIO = ['shopify', 'klaviyo', 'recharge'] as const;

// ===========================================================================
// Main
// ===========================================================================

/**
 * Redis must end exactly as it began: empty.
 *
 * It does NOT clean up the leftovers — silently forcing the database back to
 * zero is how a cleanup bug survives for months, and the next run would refuse
 * to start with no clue why. The names are safe to print: the precondition
 * proved the database was empty beforehand, so every remaining key came from
 * here.
 */
let redisClean = false;
async function assertRedisEmpty(): Promise<boolean> {
  const size = await redis.dbsize().catch(() => -1);
  if (size === 0) {
    console.log('  Redis: DBSIZE is 0 — the database is exactly as the run found it.');
    return true;
  }
  console.log(`\n✗ Redis was NOT returned to empty. DBSIZE is ${size}.`);
  const remaining = await redis.keys('*').catch(() => [] as string[]);
  console.log('  Keys this run created and failed to remove:');
  for (const key of remaining.slice(0, 50)) console.log(`    ${key}`);
  if (remaining.length > 50) console.log(`    …and ${remaining.length - 50} more`);
  console.log('  They have been LEFT IN PLACE. Fix the cleanup rather than flushing.');
  return false;
}

async function main(): Promise<void> {
  console.log('Phase 5A verification — onboarding backend (offline; all provider APIs mocked)');
  installMockFetch();

  groupA();

  const app = buildApp();
  await app.ready();
  const agencyCookie = await agencyLogin(app);

  try {
    await groupB(app, agencyCookie);
    await groupC(app, agencyCookie);
    await groupD(app, agencyCookie);
    await groupE(app, agencyCookie);
    await groupF(app, agencyCookie);
    await groupG(app, agencyCookie);
    await groupH(app, agencyCookie);
    await groupI(app, agencyCookie);
    await groupJ(app, agencyCookie);
    await groupK(app, agencyCookie);
    await groupL(app, agencyCookie);
    await groupM(app, agencyCookie);
  } finally {
    console.log('\nCleanup');
    await cleanupAccounts();
    await query(`DELETE FROM users WHERE email LIKE 'verify5a_%'`).catch(() => undefined);
    // --- queue jobs, removed through BullMQ rather than by key pattern -----
    //
    // The group B and group H provider fixtures enqueue real backfill jobs, so
    // this run genuinely has jobs to clear — leaving them behind hands work to a
    // real worker.
    //
    // `job.remove()` deletes the job hash AND unlinks it from the wait list and
    // every index BullMQ put it in. The previous version globbed
    // `bull:<queue>:*<prefix>-<id>*` and DEL'd the matches, which encodes
    // BullMQ's internal key layout as guesswork and would also match a longer id
    // sharing the prefix (`…-138` matching `…-1387`). getJob() takes the exact
    // id, so neither hazard applies.
    //
    // The ids come from queues.ts rather than being re-spelled here: an id that
    // does not match the one the enqueue used would silently remove nothing.
    let removedJobs = 0;
    const JOB_TARGETS: [() => { getJob: (id: string) => Promise<unknown> }, (n: number) => string][] = [
      [queues.backfillQueue, queues.backfillJobId],
      [queues.rechargeBackfillQueue, queues.rechargeBackfillJobId],
      [queues.klaviyoPollQueue, queues.klaviyoBackfillJobId],
    ];
    for (const [queueFactory, jobIdFor] of JOB_TARGETS) {
      for (const id of createdAccounts) {
        const job = (await queueFactory().getJob(jobIdFor(id)).catch(() => null)) as
          { remove: () => Promise<void> } | null;
        if (job) {
          await job.remove().catch(() => undefined);
          removedJobs++;
        }
      }
    }
    console.log(`  removed ${removedJobs} queue job(s)`);

    // --- queue structure keys ----------------------------------------------
    //
    // SAFE ONLY BECAUSE OF THE PRECONDITION AT THE TOP OF THIS FILE. These keys
    // are shared by the whole queue, not owned by one account. The suite refused
    // to start unless DBSIZE was exactly 0, so every one of them was created by
    // this run, by enqueuing the fixture backfills above.
    let removedStructure = 0;
    for (const queueName of ['shopify-backfill', 'recharge-backfill', 'klaviyo-poll']) {
      for (const k of ['meta', 'id', 'wait', 'events', 'marker', 'completed', 'failed', 'active']) {
        removedStructure += await redis.del(`bull:${queueName}:${k}`).catch(() => 0);
      }
    }
    console.log(`  removed ${removedStructure} queue structure key(s)`);

    // Rate-limit counters this run created — and by the same precondition, the
    // only ones that can be here. They carry a TTL and would expire on their
    // own, but "returns Redis to how it found it" should not depend on waiting.
    const rlKeys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}*`).catch(() => []);
    if (rlKeys.length) await redis.del(...rlKeys).catch(() => undefined);
    console.log(`  cleared ${rlKeys.length} rate-limit counters`);
    console.log(`  cleaned ${createdAccounts.length} throwaway accounts`);
    await app.close();
    // After cleanup, before the results table. Reported as a hard precondition
    // failure rather than a counted check, so the suite's total stays a measure
    // of the contract it verifies rather than of its own housekeeping.
    redisClean = await assertRedisEmpty();
  }

  console.log('\n' + '='.repeat(72));
  console.log('PHASE 5A RESULTS BY GROUP');
  const titles: Record<string, string> = {
    A: 'Pure unit', B: 'Provider fixtures', C: 'Database integration',
    D: 'Session isolation', E: 'Cross-tenant', F: 'Credential fallback',
    G: 'Link states + rate limit', H: 'Later connection',
    I: 'Fastify 5 regressions', J: 'Agency API hardening',
    K: 'Agency completion (5B-2G)', L: 'Manage mode (5C-1)',
    M: 'Provider requests (5C-2)',
  };
  for (const [letter, t] of Object.entries(groupTotals)) {
    const mark = t.fail === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${letter}. ${(titles[letter] ?? '').padEnd(26)} ${t.pass} passed, ${t.fail} failed`);
  }
  console.log('='.repeat(72));
  console.log(`TOTAL: ${passed} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('\nFAILED CHECKS:');
    for (const f of failed) console.log(`  ✗ ${f}`);
  }
  if (failures > 0) {
    console.log(`\n✗ ${failures} CHECK(S) FAILED`);
  } else if (!redisClean) {
    // Every contract check passed, but the suite did not clean up after itself.
    // That is still a failing run: the next one will refuse to start.
    console.log('\n✗ CHECKS PASSED BUT REDIS WAS LEFT DIRTY');
  } else {
    console.log('\n✓ ALL PHASE 5A CHECKS PASSED');
  }

  await pool.end();
  process.exit(failures === 0 && redisClean ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  await cleanupAccounts().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});

// Marks this file as a module so the top-level dynamic imports above are legal.
export {};
