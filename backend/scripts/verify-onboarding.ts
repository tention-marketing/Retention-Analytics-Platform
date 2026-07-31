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

async function makeAccount(name: string, tz = 'America/Los_Angeles'): Promise<number> {
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

function monthsAgo(n: number): string {
  const d = new Date();
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() - n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
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
  const ordersBefore = Number((await query<{ n: string }>(
    `SELECT count(*) n FROM orders WHERE account_id = $1`, [acc])).rows[0].n);
  await app.inject({
    method: 'POST', url: '/onboarding/connections/klaviyo', headers: { cookie: link.cookie },
    remoteAddress: nextIp(), payload: { apiKey: 'pk_later_rotated_0000000000000000000' },
  });
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
// Main
// ===========================================================================
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
  } finally {
    console.log('\nCleanup');
    await cleanupAccounts();
    await query(`DELETE FROM users WHERE email LIKE 'verify5a_%'`).catch(() => undefined);
    // Remove the backfill jobs the fixture connects enqueued, so a verification
    // run leaves no work behind for a real worker to pick up.
    for (const [queueName, jobId] of [
      ['shopify-backfill', 'backfill'],
      ['recharge-backfill', 'recharge-backfill'],
      ['klaviyo-poll', 'klaviyo-backfill'],
    ] as [string, string][]) {
      for (const id of createdAccounts) {
        const keys = await redis.keys(`bull:${queueName}:*${jobId}-${id}*`).catch(() => []);
        if (keys.length) await redis.del(...keys).catch(() => undefined);
      }
      for (const k of ['meta', 'id', 'wait', 'events', 'marker']) {
        await redis.del(`bull:${queueName}:${k}`).catch(() => undefined);
      }
    }
    // Rate-limit counters this run created. They carry a TTL and would expire on
    // their own, but leaving them behind means Redis is not returned to the state
    // the run found it in.
    const rlKeys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}*`).catch(() => []);
    if (rlKeys.length) await redis.del(...rlKeys).catch(() => undefined);
    console.log(`  cleared ${rlKeys.length} rate-limit counters`);
    console.log(`  cleaned ${createdAccounts.length} throwaway accounts`);
    await app.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log('PHASE 5A RESULTS BY GROUP');
  const titles: Record<string, string> = {
    A: 'Pure unit', B: 'Provider fixtures', C: 'Database integration',
    D: 'Session isolation', E: 'Cross-tenant', F: 'Credential fallback',
    G: 'Link states + rate limit', H: 'Later connection',
    I: 'Fastify 5 regressions', J: 'Agency API hardening',
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
  console.log(failures === 0 ? '\n✓ ALL PHASE 5A CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);

  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  await cleanupAccounts().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(1);
});

// Marks this file as a module so the top-level dynamic imports above are legal.
export {};
