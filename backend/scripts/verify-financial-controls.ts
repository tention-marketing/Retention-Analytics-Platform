/**
 * Agency financial-input HTTP contract verification (Phase 5B-2F).
 *
 * WHY THIS SUITE EXISTS, given verify:onboarding already has ~100 checks over
 * currency, COGS and ad spend: those are SERVICE-level. They call
 * setManualCurrency(), validateSkuCost(), writeAdSpendRanges() and
 * getCoverageWindow() directly. Almost none of the agency financial ROUTES —
 * GET/PUT /accounts/:id/currency, POST /currency/resolve-mismatch,
 * GET/PUT /accounts/:id/costs, PUT /costs/ocas, GET/PUT /accounts/:id/ad-spend,
 * POST /ad-spend/zero — has ever been exercised over HTTP (confirmed by
 * enumerating every `url:` in that suite's agency group: only onboarding-links,
 * onboarding/status and progress appear). Phase 5B-2F is the first consumer of
 * these routes, so this is the first time the wire contract, the authorization
 * hook, the account-in-the-path rule and the fixed error codes matter.
 *
 * It is a SEPARATE script rather than an appendix to verify:onboarding or
 * verify:auth-security, following the precedent verify:accounts set: those two
 * are regression baselines with fixed totals, and folding new checks into them
 * makes "482 passed" mean something different from what it meant last week.
 *
 *   A. Authentication      — agency session works; anonymous and onboarding-link
 *                            sessions get 401 from every financial route.
 *   B. Tenant isolation    — the path decides the account; a body accountId
 *                            cannot redirect a write; account B is untouched;
 *                            B's SKU cannot be costed into A.
 *   C. Currency            — the GET contract, manual normalization, refusal once
 *                            Shopify is authoritative, mismatch preservation, and
 *                            resolution that converts and deletes nothing.
 *   D. COGS                — method selection, blended range/precision, per-SKU
 *                            ownership and precision, explicit zero, partial
 *                            saves, retained inactive values, the top-20 cap and
 *                            coverage beyond it.
 *   E. OCAS                — positive, explicit zero, blank-is-not-zero, and the
 *                            rejected edges.
 *   F. Ad spend            — positive ranges, the zero-row refusal, month and
 *                            range validation, overlap, channel normalization,
 *                            and the transactional zero/spend exclusion.
 *   G. Coverage window     — the 12-month cap, new-customer requirement, young
 *                            brands, and store-timezone month boundaries.
 *   H. Response hygiene    — no account_id, no SQL, no stack, no path, no
 *                            neighbouring account detail.
 *
 * Offline: no provider API is contacted, no real credential is used, no BullMQ
 * job is enqueued and no Queue is ever constructed — every route here is a
 * database read or write. Synthetic accounts are tracked by exact id and removed
 * on the way out.
 *
 * Run: `npm run verify:financial-controls`
 */
process.env.APP_BASE_URL = 'http://localhost:5173';

const { default: bcrypt } = await import('bcryptjs');
const { pool, query } = await import('../src/db/pool.js');
const { buildApp } = await import('../src/index.js');
const { redis } = await import('../src/queue/queues.js');
const { config } = await import('../src/config.js');
const security = await import('../src/auth/security.js');

// ---------------------------------------------------------------------------
// Redis precondition — the FIRST thing this suite does.
// ---------------------------------------------------------------------------
//
// The imports above only define things: queues.ts builds its IORedis client with
// lazyConnect and creates its Queue objects on first use, not on import. So this
// guard runs before buildApp() — whose rate limiter writes to Redis on the first
// request — before an account exists and before a session is minted. Nothing
// above this line mutates Redis.
//
// THIS SUITE ENQUEUES NOTHING. Every route it exercises is a plain database read
// or write; it never reaches a provider connect route, so no Queue is
// constructed and no `bull:*` key is written. Cleanup therefore removes
// rate-limit counters and nothing else — there is deliberately no BullMQ
// deletion to mirror the other suites with, because deleting shared queue
// structure keys this run did not create would be pure risk for no gain.
//
// The guard still matters: cleanup DEL's every `fastify-rate-limit-*` key, and
// the only thing that makes "every" mean "this run's" is having proved the
// database was empty first.
//
// IT INSPECTS NOTHING. Only DBSIZE is read: no KEYS, no GET, no TYPE, no TTL, no
// scan. If the database is not empty the suite refuses to start without having
// read, altered or deleted one value, and it never calls FLUSHDB or FLUSHALL.
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
    console.error('  It clears rate-limit counters by prefix during cleanup, which only');
    console.error('  means "the ones this run made" on a database nothing else writes to.');
    console.error('  Point REDIS_URL at a dedicated test database, or clear that database');
    console.error('  yourself once you are certain it holds nothing you need.');
    console.error('');
    console.error('  Nothing has been read, changed or deleted. No key was inspected.');
    await redis.quit().catch(() => undefined);
    process.exit(1);
  }

  console.log(`Redis precondition: DBSIZE is ${size} — dedicated and empty. Proceeding.`);
}

await requireEmptyRedis();

type App = ReturnType<typeof buildApp>;

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
    groupTotals[currentGroup]!.pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    groupTotals[currentGroup]!.fail++;
    failed.push(`[${currentGroup}] ${name}`);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

let ipCounter = 0;
/** Unique client IP per request so ordinary traffic never trips a limiter. */
function nextIp(): string {
  ipCounter++;
  return `172.22.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

/** @fastify/rate-limit's Redis store writes `fastify-rate-limit-<METHOD><route>-<key>`. */
const RATE_LIMIT_KEY_PREFIX = 'fastify-rate-limit-';

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------
const TEST_PREFIX = '__fincontrol_';
const TEST_PASSWORD = 'fincontrol-synthetic-password';

/**
 * Deliberately not 'UTC'. It matches the production column default, which is the
 * point: the coverage window and the COGS window are computed in the ACCOUNT's
 * timezone, and a suite whose accounts all sat in UTC would never exercise that.
 */
const STORE_TZ = 'America/Los_Angeles';

const createdAccounts: number[] = [];
const createdEmails: string[] = [];

/** Every table that can carry an account_id, ordered so FKs unwind cleanly. */
const ACCOUNT_TABLES = [
  'ad_spend_zero_months', 'onboarding_provider_choices', 'onboarding_links',
  'ad_spend', 'sku_costs', 'account_costs', 'rcm_config',
  'line_items', 'orders', 'customers', 'products', 'inventory_levels',
  'subscription_events', 'subscriptions', 'campaign_stats', 'campaigns',
  'connections', 'sync_errors',
];

async function makeAccount(
  label: string,
  opts: { tz?: string; currency?: string | null; source?: 'manual' | 'shopify' | null } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO accounts (name, store_timezone, currency, currency_source)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      `${TEST_PREFIX}${label}_${Date.now()}_${createdAccounts.length}`,
      opts.tz ?? STORE_TZ,
      opts.currency ?? null,
      opts.source ?? null,
    ],
  );
  createdAccounts.push(rows[0]!.id);
  return rows[0]!.id;
}

/**
 * A verified Shopify connection row, seeded DIRECTLY.
 *
 * This is a synthetic row, NOT a live Shopify connection: no domain is contacted,
 * no credential is real, and the encrypted blob is a fixed literal. It exists
 * because getRcmReadiness() gates every other blocker behind
 * `shopify_not_connected`, and the point of several checks below is what the
 * readiness payload says once that gate is open.
 */
async function seedShopifyConnection(accountId: number, domain: string): Promise<void> {
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
     VALUES ($1, 'shopify', $2, $3, 'connected')
     ON CONFLICT (account_id, provider) DO UPDATE
       SET shop_domain = EXCLUDED.shop_domain, status = 'connected'`,
    [accountId, 'synthetic-not-a-credential', domain],
  );
}

let orderSeq = 950_000_000;
async function insertOrder(
  accountId: number, monthIso: string, totalNet: number, isFirst: boolean,
): Promise<number> {
  const id = orderSeq++;
  await query(
    `INSERT INTO orders (account_id, id, customer_id, created_at, total_net, is_first_order,
                         cancelled, test)
     VALUES ($1, $2, $2, ($3::date + interval '15 hours')::timestamptz, $4, $5, false, false)`,
    [accountId, id, monthIso, totalNet, isFirst],
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
 * The code under test computes `date_trunc('month', now() AT TIME ZONE
 * accounts.store_timezone)`. Reading the month from the machine's clock instead
 * would make this suite's answers depend on which laptop ran it, and would
 * disagree with the account for the last seven hours of every Pacific month.
 */
function monthsAgo(n: number, timeZone: string = STORE_TZ): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error(`Could not read the current month in ${timeZone}`);
  }
  const total = year * 12 + (month - 1) - n;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12 + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of all) {
    const m = /^([^=]+)=([^;]*)/.exec(String(c));
    if (m && m[1] === name) return `${m[1]}=${m[2]}`;
  }
  return null;
}

async function agencyLogin(app: App): Promise<string> {
  const email = `${TEST_PREFIX}${Date.now()}_${createdEmails.length}@example.invalid`;
  createdEmails.push(email);
  await query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
    email, await bcrypt.hash(TEST_PASSWORD, security.BCRYPT_COST),
  ]);
  const res = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' },
    payload: { email, password: TEST_PASSWORD },
  });
  const cookie = cookieFrom(res, 'tention_sid');
  if (!cookie) throw new Error(`agency login did not set a session cookie (${res.statusCode})`);
  return cookie;
}

/** A client onboarding-link principal (cookie tention_onb), for group A. */
async function onboardingCookie(
  app: App, agencyCookie: string, accountId: number,
): Promise<string> {
  const minted = await app.inject({
    method: 'POST', url: `/accounts/${accountId}/onboarding-links`,
    headers: { cookie: agencyCookie, 'content-type': 'application/json' },
    remoteAddress: nextIp(), payload: {},
  });
  const { token } = minted.json() as { token: string };
  const exchanged = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' }, payload: { token },
  });
  const cookie = cookieFrom(exchanged, 'tention_onb');
  if (!cookie) throw new Error(`token exchange did not set a cookie (${exchanged.statusCode})`);
  return cookie;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
type Injected = Awaited<ReturnType<App['inject']>>;

function get(app: App, cookie: string | null, url: string): Promise<Injected> {
  return app.inject({
    method: 'GET', url, remoteAddress: nextIp(),
    headers: { ...(cookie ? { cookie } : {}) },
  });
}

function send(
  app: App, method: 'PUT' | 'POST', cookie: string | null, url: string, payload?: unknown,
): Promise<Injected> {
  return app.inject({
    method, url, remoteAddress: nextIp(),
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

function body(res: Injected): Record<string, unknown> {
  try {
    const parsed = res.json() as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorCode(res: Injected): string | null {
  const b = body(res);
  return typeof b.error === 'string' ? b.error : null;
}

/**
 * Does a response body disclose implementation internals?
 *
 * Looks for the shapes that actually leak from this stack: pg driver and SQL
 * fragments, stack frames, absolute deploy paths, and Node module internals.
 */
function leaksInternals(text: string): boolean {
  return /\b(?:select|insert|update|delete)\s|relation |column |syntax error|pg_|postgres/i.test(text)
    || /(^|\\n)\s*at\s+\S/.test(text)
    || /:\d+:\d+/.test(text)
    || /\/(?:Users|home|var|opt|srv|etc|root)\//.test(text)
    || /node_modules|node:internal|Error:/.test(text);
}

/** Every financial route, as (method, suffix, body) — used by groups A and H. */
function financialRoutes(): [('GET' | 'PUT' | 'POST'), string, unknown][] {
  return [
    ['GET', '/currency', undefined],
    ['PUT', '/currency', { currency: 'USD' }],
    ['POST', '/currency/resolve-mismatch', undefined],
    ['GET', '/skus', undefined],
    ['GET', '/costs', undefined],
    ['PUT', '/costs', { method: 'blended', blendedMarginPct: 50 }],
    ['PUT', '/costs/ocas', { ocasMonthly: 100 }],
    ['GET', '/ad-spend', undefined],
    ['PUT', '/ad-spend', { rows: [{ channel: 'Meta', amount: 10, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }] }],
    ['POST', '/ad-spend/zero', { months: [monthsAgo(1)], confirmedZero: true }],
  ];
}

async function costsOf(accountId: number): Promise<Record<string, unknown>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT cogs_method, blended_margin_pct, ocas_monthly, ocas_zero_confirmed
       FROM account_costs WHERE account_id = $1`, [accountId],
  );
  return rows[0] ?? {};
}

async function currencyOf(accountId: number): Promise<Record<string, unknown>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT currency, currency_source, shopify_currency_detected
       FROM accounts WHERE id = $1`, [accountId],
  );
  return rows[0] ?? {};
}

async function spendRows(accountId: number): Promise<{ month: string; channel: string; spend: string }[]> {
  const { rows } = await query<{ month: string; channel: string; spend: string }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, channel, spend
       FROM ad_spend WHERE account_id = $1 ORDER BY month, channel`, [accountId],
  );
  return rows;
}

async function zeroMonths(accountId: number): Promise<string[]> {
  const { rows } = await query<{ month: string }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month FROM ad_spend_zero_months
      WHERE account_id = $1 ORDER BY month`, [accountId],
  );
  return rows.map((r) => r.month);
}

// ===========================================================================
// A. Authentication
// ===========================================================================
async function groupA(app: App, agencyCookie: string): Promise<void> {
  group('A', 'Authentication');

  const acc = await makeAccount('auth', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(acc, `fincontrol-auth-${acc}.myshopify.invalid`);
  const first = await insertOrder(acc, monthsAgo(1), 100, true);
  await insertLineItem(acc, first, first, 'AUTH-SKU-1', 100);

  // --- the agency session may use all of them --------------------------
  for (const [method, suffix, payload] of financialRoutes()) {
    const url = `/accounts/${acc}${suffix}`;
    const res = method === 'GET'
      ? await get(app, agencyCookie, url)
      : await send(app, method, agencyCookie, url, payload);
    // 409 no_mismatch is a legitimate agency answer on an account with no
    // mismatch; what matters here is that the session was ACCEPTED.
    check(`agency session is accepted by ${method} ${suffix}`,
      res.statusCode !== 401 && res.statusCode !== 403, `${res.statusCode} ${res.body.slice(0, 120)}`);
  }

  // A SECOND, UNTOUCHED account for the rejection loops.
  //
  // The agency loop above legitimately wrote costs, spend and a zero confirmation
  // to `acc`, so asserting "nothing was written" against it afterwards would be
  // asserting against the successful calls. The unauthorized callers get their own
  // account, whose emptiness is therefore a fact about them.
  const untouched = await makeAccount('authUntouched', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(untouched, `fincontrol-untouched-${untouched}.myshopify.invalid`);
  const uFirst = await insertOrder(untouched, monthsAgo(1), 100, true);
  await insertLineItem(untouched, uFirst, uFirst, 'UNTOUCHED-SKU', 100);

  // --- anonymous --------------------------------------------------------
  for (const [method, suffix, payload] of financialRoutes()) {
    const url = `/accounts/${untouched}${suffix}`;
    const res = method === 'GET'
      ? await get(app, null, url)
      : await send(app, method, null, url, payload);
    check(`anonymous gets 401 from ${method} ${suffix}`, res.statusCode === 401, res.statusCode);
  }

  // --- forged cookie ----------------------------------------------------
  const forged = await get(app, 'tention_sid=not-a-real-session',
    `/accounts/${untouched}/currency`);
  check('a forged agency cookie gets 401', forged.statusCode === 401, forged.statusCode);

  // --- onboarding-link principal ----------------------------------------
  //
  // requireAuth reads session.userId, which a scoped onboarding session does not
  // have — so the isolation falls out of the existing guard with no per-route
  // code. That is exactly the property worth asserting, because it is invisible.
  const onb = await onboardingCookie(app, agencyCookie, untouched);
  for (const [method, suffix, payload] of financialRoutes()) {
    const url = `/accounts/${untouched}${suffix}`;
    const res = method === 'GET'
      ? await get(app, onb, url)
      : await send(app, method, onb, url, payload);
    check(`an onboarding-link session gets 401 from ${method} ${suffix}`,
      res.statusCode === 401, res.statusCode);
  }

  // Nothing an unauthenticated or scoped caller sent may have landed.
  const c = await currencyOf(untouched);
  check('no unauthorized call changed the currency', c.currency === 'USD', c);
  check('no unauthorized call created a costs row',
    Object.keys(await costsOf(untouched)).length === 0, await costsOf(untouched));
  check('no unauthorized call created a spend row', (await spendRows(untouched)).length === 0);
  check('no unauthorized call created a zero confirmation',
    (await zeroMonths(untouched)).length === 0);

  // Presenting both cookies must not downgrade the agency session.
  const both = await get(app, `${agencyCookie}; ${onb}`, `/accounts/${untouched}/currency`);
  check('an agency session still works when an onboarding cookie is also present',
    both.statusCode === 200, both.statusCode);
}

// ===========================================================================
// B. Tenant isolation
// ===========================================================================
async function groupB(app: App, cookie: string): Promise<void> {
  group('B', 'Tenant isolation');

  const a = await makeAccount('isoA', { currency: 'USD', source: 'manual' });
  const b = await makeAccount('isoB', { currency: 'GBP', source: 'manual' });
  await seedShopifyConnection(a, `fincontrol-isoa-${a}.myshopify.invalid`);
  await seedShopifyConnection(b, `fincontrol-isob-${b}.myshopify.invalid`);

  const oa = await insertOrder(a, monthsAgo(1), 500, true);
  await insertLineItem(a, oa, oa, 'ISO-A-SKU', 500);
  const ob = await insertOrder(b, monthsAgo(1), 500, true);
  await insertLineItem(b, ob, ob, 'ISO-B-SKU', 500);

  // --- a body accountId cannot redirect a write --------------------------
  const redirected = await send(app, 'PUT', cookie, `/accounts/${a}/costs/ocas`, {
    accountId: b, account_id: b, id: b, ocasMonthly: 4242,
  });
  check('a write with a body accountId still returns 200', redirected.statusCode === 200,
    redirected.statusCode);
  const ca = await costsOf(a);
  const cb = await costsOf(b);
  check('the OCAS landed on the account in the PATH', Number(ca.ocas_monthly) === 4242, ca);
  check('the account named in the BODY was not written', Object.keys(cb).length === 0, cb);

  // Same for currency and ad spend.
  const curRedirect = await send(app, 'PUT', cookie, `/accounts/${a}/currency`, {
    accountId: b, account_id: b, currency: 'JPY',
  });
  check('a currency write with a body accountId returns 200',
    curRedirect.statusCode === 200, `${curRedirect.statusCode} ${curRedirect.body.slice(0, 120)}`);
  check('the currency landed on the account in the PATH',
    (await currencyOf(a)).currency === 'JPY');
  check('account B keeps its own currency', (await currencyOf(b)).currency === 'GBP');
  // Put A back so the SKU-ownership checks below are not reading a surprise.
  await send(app, 'PUT', cookie, `/accounts/${a}/currency`, { currency: 'USD' });

  const spendRedirect = await send(app, 'PUT', cookie, `/accounts/${a}/ad-spend`, {
    accountId: b,
    rows: [{ channel: 'Meta', amount: 100, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }],
  });
  check('an ad-spend write with a body accountId returns 200', spendRedirect.statusCode === 200,
    spendRedirect.statusCode);
  check('the spend row landed on account A', (await spendRows(a)).length === 1);
  check('account B has no spend row', (await spendRows(b)).length === 0);

  // --- a SKU belonging only to B cannot be costed into A -----------------
  const crossSku = await send(app, 'PUT', cookie, `/accounts/${a}/costs`, {
    method: 'per_sku', skus: [{ sku: 'ISO-B-SKU', cogs: 10 }],
  });
  check("account B's SKU is refused for account A", crossSku.statusCode === 400,
    crossSku.statusCode);
  check('the refusal carries the fixed unknown_skus code', errorCode(crossSku) === 'unknown_skus',
    crossSku.body);
  const { rows: leaked } = await query<{ n: string }>(
    `SELECT count(*) n FROM sku_costs WHERE account_id = $1 AND sku = 'ISO-B-SKU'`, [a],
  );
  check("no sku_costs row was created for B's SKU under A", Number(leaked[0]!.n) === 0,
    leaked[0]);

  // A completely unknown SKU is refused identically — the response is not an
  // oracle for whether a SKU exists in some other account.
  const unknownSku = await send(app, 'PUT', cookie, `/accounts/${a}/costs`, {
    method: 'per_sku', skus: [{ sku: 'DOES-NOT-EXIST-ANYWHERE', cogs: 10 }],
  });
  check('an entirely unknown SKU is refused the same way',
    unknownSku.statusCode === 400 && errorCode(unknownSku) === 'unknown_skus', unknownSku.body);

  // --- account ids that are not accounts ---------------------------------
  for (const bad of ['abc', '0', '-1', '1.5', 'null', 'undefined', '%20', "1'or'1"]) {
    const res = await get(app, cookie, `/accounts/${bad}/costs`);
    check(`a malformed account id (${bad}) is a safe 400/404`,
      res.statusCode === 400 || res.statusCode === 404, res.statusCode);
    check(`a malformed account id (${bad}) discloses no internals`,
      !leaksInternals(res.body), res.body);
  }
  const missing = await get(app, cookie, '/accounts/999999999/costs');
  check('an unknown account id is 404 account_not_found',
    missing.statusCode === 404 && errorCode(missing) === 'account_not_found', missing.body);
  const missingWrite = await send(app, 'PUT', cookie, '/accounts/999999999/costs/ocas',
    { ocasMonthly: 1 });
  check('a write to an unknown account is 404 and writes nothing',
    missingWrite.statusCode === 404, missingWrite.statusCode);

  // --- A's data is not visible in B's responses --------------------------
  const bCosts = await get(app, cookie, `/accounts/${b}/costs`);
  check("account B's costs response does not mention A's SKU",
    !bCosts.body.includes('ISO-A-SKU'), bCosts.body.slice(0, 200));
  const bSpend = await get(app, cookie, `/accounts/${b}/ad-spend`);
  check("account B's ad-spend response has no rows from A",
    (body(bSpend).rows as unknown[]).length === 0);
}

// ===========================================================================
// C. Currency
// ===========================================================================
async function groupC(app: App, cookie: string): Promise<void> {
  group('C', 'Currency');

  // --- the GET contract on a brand-new account ---------------------------
  const fresh = await makeAccount('curFresh');
  const g = await get(app, cookie, `/accounts/${fresh}/currency`);
  check('GET /currency returns 200', g.statusCode === 200, g.statusCode);
  const gb = body(g);
  check('GET /currency returns exactly the three documented fields',
    JSON.stringify(Object.keys(gb).sort())
      === JSON.stringify(['currency', 'currency_source', 'shopify_currency_detected']),
    Object.keys(gb));
  check('an unset currency is null, not a guess', gb.currency === null);
  check('an unset source is null', gb.currency_source === null);
  check('nothing has been detected yet', gb.shopify_currency_detected === null);
  check('GET /currency carries no account_id', !('account_id' in gb) && !('accountId' in gb));

  // --- manual selection ---------------------------------------------------
  const ok = await send(app, 'PUT', cookie, `/accounts/${fresh}/currency`, { currency: 'usd' });
  check('a lowercase 3-letter code is accepted', ok.statusCode === 200, ok.statusCode);
  check('it comes back normalized to uppercase', body(ok).currency === 'USD', ok.body);
  const stored = await currencyOf(fresh);
  check('it is STORED uppercase', stored.currency === 'USD', stored);
  check('the source is recorded as manual', stored.currency_source === 'manual', stored);

  const padded = await send(app, 'PUT', cookie, `/accounts/${fresh}/currency`, { currency: '  eur ' });
  check('surrounding whitespace is trimmed', padded.statusCode === 200
    && body(padded).currency === 'EUR', padded.body);
  check('the trimmed value is what is stored', (await currencyOf(fresh)).currency === 'EUR');

  // --- rejected codes -----------------------------------------------------
  const badCodes: [string, unknown][] = [
    ['two letters', 'US'], ['four letters', 'USDX'], ['digits', 'US1'],
    ['empty', ''], ['whitespace only', '   '], ['null', null], ['a number', 840],
    ['an array', ['USD']], ['an object', { code: 'USD' }], ['a boolean', true],
    ['a symbol-laden code', 'U$D'], ['an accented code', 'ÜSD'],
    ['a SQL-shaped value', "USD'; DROP TABLE accounts; --"],
    ['an over-long value', 'U'.repeat(200)],
    ['a NUL-terminated value', 'USD\u0000'],
    ['a newline-separated pair', 'USD\nEUR'],
  ];
  for (const [label, value] of badCodes) {
    const res = await send(app, 'PUT', cookie, `/accounts/${fresh}/currency`, { currency: value });
    check(`an invalid currency (${label}) returns 400`, res.statusCode === 400, res.statusCode);
    check(`an invalid currency (${label}) carries the fixed invalid_code`,
      errorCode(res) === 'invalid_code', res.body);
    check(`an invalid currency (${label}) discloses no internals`,
      !leaksInternals(res.body), res.body);
  }
  check('no invalid code overwrote the stored value',
    (await currencyOf(fresh)).currency === 'EUR');

  // A missing body field is refused too, and never read as "clear it".
  const noField = await send(app, 'PUT', cookie, `/accounts/${fresh}/currency`, {});
  check('an omitted currency field is a 400, not a clear',
    noField.statusCode === 400 && errorCode(noField) === 'invalid_code', noField.body);
  check('the stored currency survived the omitted field',
    (await currencyOf(fresh)).currency === 'EUR');

  // --- Shopify authoritative ---------------------------------------------
  const shopAcc = await makeAccount('curShopify', { currency: 'USD', source: 'shopify' });
  await query(`UPDATE accounts SET shopify_currency_detected = 'USD' WHERE id = $1`, [shopAcc]);
  const refuse = await send(app, 'PUT', cookie, `/accounts/${shopAcc}/currency`, { currency: 'CAD' });
  check('a Shopify-authoritative currency cannot be changed manually',
    refuse.statusCode === 400, refuse.statusCode);
  check('the refusal carries the fixed shopify_authoritative code',
    errorCode(refuse) === 'shopify_authoritative', refuse.body);
  check('the Shopify currency is unchanged', (await currencyOf(shopAcc)).currency === 'USD');

  // Resolving a mismatch that does not exist is a 409, not a silent success.
  const noMismatch = await send(app, 'POST', cookie,
    `/accounts/${shopAcc}/currency/resolve-mismatch`);
  check('resolving a nonexistent mismatch returns 409',
    noMismatch.statusCode === 409, noMismatch.statusCode);
  check('it carries the fixed no_mismatch code', errorCode(noMismatch) === 'no_mismatch',
    noMismatch.body);
  check('the route is reachable with NO request body at all',
    noMismatch.statusCode === 409, noMismatch.statusCode);

  // --- mismatch: both currencies preserved, nothing converted -------------
  const mm = await makeAccount('curMismatch', { currency: 'CAD', source: 'manual' });
  await seedShopifyConnection(mm, `fincontrol-mm-${mm}.myshopify.invalid`);
  const mmOrder = await insertOrder(mm, monthsAgo(1), 1000, true);
  await insertLineItem(mm, mmOrder, mmOrder, 'MM-SKU', 1000);
  // Money in CAD: OCAS, one per-SKU cost, one spend row.
  await send(app, 'PUT', cookie, `/accounts/${mm}/costs/ocas`, { ocasMonthly: 1500.25 });
  await send(app, 'PUT', cookie, `/accounts/${mm}/costs`, {
    method: 'per_sku', skus: [{ sku: 'MM-SKU', cogs: 333.33 }],
  });
  await send(app, 'PUT', cookie, `/accounts/${mm}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 777.77, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }],
  });
  // Shopify now reports USD. Case 4 of Correction 1: preserve BOTH.
  await query(`UPDATE accounts SET shopify_currency_detected = 'USD' WHERE id = $1`, [mm]);

  const mmState = body(await get(app, cookie, `/accounts/${mm}/currency`));
  check('a mismatch keeps the currency the stored money is expressed in',
    mmState.currency === 'CAD', mmState);
  check('a mismatch reports the detected Shopify currency separately',
    mmState.shopify_currency_detected === 'USD', mmState);

  const mmReadiness = body(await get(app, cookie, `/accounts/${mm}/rcm-readiness`));
  const mmBlockers = (mmReadiness.blockers as { code: string }[]).map((x) => x.code);
  check('a mismatch blocks RCM readiness', mmBlockers.includes('currency_mismatch'), mmBlockers);

  // Snapshot every money value, then resolve, then compare.
  const beforeOcas = (await costsOf(mm)).ocas_monthly;
  const { rows: beforeSku } = await query<{ cogs: string }>(
    `SELECT cogs FROM sku_costs WHERE account_id = $1 AND sku = 'MM-SKU'`, [mm],
  );
  const beforeSpend = await spendRows(mm);

  const resolved = await send(app, 'POST', cookie, `/accounts/${mm}/currency/resolve-mismatch`);
  check('resolving a real mismatch returns 200', resolved.statusCode === 200, resolved.statusCode);
  check('the response reports the adopted currency', body(resolved).currency === 'USD',
    resolved.body);
  check('the response includes refreshed RCM readiness', 'rcmReadiness' in body(resolved));

  const afterState = await currencyOf(mm);
  check('the account currency is now the Shopify one', afterState.currency === 'USD', afterState);
  check('the source is now shopify', afterState.currency_source === 'shopify', afterState);
  check('the mismatch is gone because the DATA agrees, not because a flag was set',
    afterState.currency === afterState.shopify_currency_detected);

  const afterOcas = (await costsOf(mm)).ocas_monthly;
  const { rows: afterSku } = await query<{ cogs: string }>(
    `SELECT cogs FROM sku_costs WHERE account_id = $1 AND sku = 'MM-SKU'`, [mm],
  );
  const afterSpend = await spendRows(mm);
  check('resolution did not convert OCAS', String(afterOcas) === String(beforeOcas),
    { beforeOcas, afterOcas });
  check('resolution did not delete OCAS', afterOcas !== null && afterOcas !== undefined);
  check('resolution did not convert the per-SKU cost',
    afterSku[0]?.cogs === beforeSku[0]?.cogs, { before: beforeSku[0], after: afterSku[0] });
  check('resolution did not delete the per-SKU cost', afterSku.length === 1);
  check('resolution did not convert or delete the spend row',
    JSON.stringify(afterSpend) === JSON.stringify(beforeSpend), { beforeSpend, afterSpend });

  const mmReadiness2 = body(await get(app, cookie, `/accounts/${mm}/rcm-readiness`));
  const mmBlockers2 = (mmReadiness2.blockers as { code: string }[]).map((x) => x.code);
  check('the currency_mismatch blocker has cleared',
    !mmBlockers2.includes('currency_mismatch'), mmBlockers2);

  // Resolving twice is a 409, not a second silent write.
  const twice = await send(app, 'POST', cookie, `/accounts/${mm}/currency/resolve-mismatch`);
  check('resolving again returns 409 no_mismatch',
    twice.statusCode === 409 && errorCode(twice) === 'no_mismatch', twice.body);
}

// ===========================================================================
// D. COGS
// ===========================================================================
async function groupD(app: App, cookie: string): Promise<void> {
  group('D', 'Cost of goods');

  const acc = await makeAccount('cogs', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(acc, `fincontrol-cogs-${acc}.myshopify.invalid`);

  // 5 SKUs, sharply unequal revenue, so the "smallest group reaching 80%" logic
  // has something real to pick from.
  const revenues: [string, number][] = [
    ['COGS-A', 5000], ['COGS-B', 3000], ['COGS-C', 1000], ['COGS-D', 600], ['COGS-E', 400],
  ];
  for (const [sku, revenue] of revenues) {
    const o = await insertOrder(acc, monthsAgo(1), revenue, sku === 'COGS-A');
    await insertLineItem(acc, o, o, sku, revenue);
  }

  // --- the GET contract ---------------------------------------------------
  const g = await get(app, cookie, `/accounts/${acc}/costs`);
  check('GET /costs returns 200', g.statusCode === 200, g.statusCode);
  const gb = body(g);
  check('GET /costs returns exactly { costs, coverage }',
    JSON.stringify(Object.keys(gb).sort()) === JSON.stringify(['costs', 'coverage']),
    Object.keys(gb));
  const costs0 = gb.costs as Record<string, unknown>;
  check('costs returns exactly the four documented fields',
    JSON.stringify(Object.keys(costs0).sort())
      === JSON.stringify(['blended_margin_pct', 'cogs_method', 'ocas_monthly', 'ocas_zero_confirmed']),
    Object.keys(costs0));
  check('an unconfigured method is null, not a default', costs0.cogs_method === null);
  check('ocas_zero_confirmed is a real boolean, not null',
    costs0.ocas_zero_confirmed === false);
  const cov0 = gb.coverage as Record<string, unknown>;
  check('coverage returns exactly the nine documented fields',
    JSON.stringify(Object.keys(cov0).sort()) === JSON.stringify([
      'all', 'cappedBelowTarget', 'costedRevenue', 'coveragePct', 'eligibleLineRevenue',
      'missingSkus', 'required', 'unconfirmedZeroSkus',
    ].sort()),
    Object.keys(cov0));
  check('coverage carries no account_id', !('account_id' in cov0) && !('accountId' in cov0));

  const req0 = cov0.required as { sku: string; revenue: number; cogs: number | null; zeroConfirmed: boolean }[];
  check('a SKU row has exactly the four documented fields',
    JSON.stringify(Object.keys(req0[0]!).sort())
      === JSON.stringify(['cogs', 'revenue', 'sku', 'zeroConfirmed']),
    Object.keys(req0[0]!));
  check('the required set is ordered by revenue, highest first',
    req0[0]!.sku === 'COGS-A', req0.map((r) => r.sku));
  check('the required set is the SMALLEST group reaching 80%', req0.length === 2,
    req0.map((r) => r.sku));
  check('every eligible SKU is available in coverage.all',
    (cov0.all as unknown[]).length === 5);
  check('the eligible line-item denominator is the sum of line revenue',
    cov0.eligibleLineRevenue === 10000, cov0.eligibleLineRevenue);
  check('nothing is costed yet, so coveragePct is 0', cov0.coveragePct === 0);
  check('the top group DOES reach the target here, so cappedBelowTarget is false',
    cov0.cappedBelowTarget === false);
  check('missingSkus lists the required SKUs lacking a cost',
    JSON.stringify(cov0.missingSkus) === JSON.stringify(['COGS-A', 'COGS-B']), cov0.missingSkus);

  // --- blended -------------------------------------------------------------
  const bl = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'blended', blendedMarginPct: 62.55,
  });
  check('a valid blended margin returns 200', bl.statusCode === 200, bl.statusCode);
  check('the response echoes the accepted percentage', body(bl).blendedMarginPct === 62.55, bl.body);
  const afterBl = await costsOf(acc);
  check('the method is recorded as blended', afterBl.cogs_method === 'blended', afterBl);
  check('the percentage is stored', Number(afterBl.blended_margin_pct) === 62.55, afterBl);

  for (const [label, value] of [
    ['0', 0], ['100', 100], ['negative', -5], ['above 100', 100.01], ['exactly 100', 100],
  ] as [string, unknown][]) {
    const res = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
      method: 'blended', blendedMarginPct: value,
    });
    check(`a blended margin of ${label} is refused`, res.statusCode === 400, res.statusCode);
    check(`a blended margin of ${label} carries out_of_range`,
      errorCode(res) === 'out_of_range', res.body);
  }
  const precise = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'blended', blendedMarginPct: 62.555,
  });
  check('three decimal places are refused', precise.statusCode === 400
    && errorCode(precise) === 'too_precise', precise.body);
  const blank = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'blended', blendedMarginPct: '',
  });
  check('a blank blended margin is not_a_number, never zero',
    blank.statusCode === 400 && errorCode(blank) === 'not_a_number', blank.body);
  check('exactly two decimals are accepted', (await send(app, 'PUT', cookie,
    `/accounts/${acc}/costs`, { method: 'blended', blendedMarginPct: 0.01 })).statusCode === 200);
  check('no rejected value overwrote the retained margin',
    Number((await costsOf(acc)).blended_margin_pct) === 0.01);
  // Put it back to the real figure for the switch checks below.
  await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'blended', blendedMarginPct: 62.55,
  });

  // --- bad method ----------------------------------------------------------
  for (const m of ['per-sku', 'PER_SKU', 'blend', '', null, 5, {}, ['blended']]) {
    const res = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, { method: m });
    check(`an unrecognized method (${JSON.stringify(m)}) is bad_method`,
      res.statusCode === 400 && errorCode(res) === 'bad_method', res.body);
  }
  const noSkus = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, { method: 'per_sku' });
  check('per_sku with no skus array is skus_required',
    noSkus.statusCode === 400 && errorCode(noSkus) === 'skus_required', noSkus.body);

  // --- per-SKU -------------------------------------------------------------
  const partial = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-A', cogs: 2000 }],
  });
  check('a PARTIAL per-SKU save succeeds', partial.statusCode === 200, partial.statusCode);
  check('the response reports how many rows were written', body(partial).written === 1, partial.body);
  const pCov = body(partial).coverage as Record<string, unknown>;
  check('the response carries refreshed coverage', typeof pCov.coveragePct === 'number');
  check('one of two required SKUs still shows as missing',
    JSON.stringify(pCov.missingSkus) === JSON.stringify(['COGS-B']), pCov.missingSkus);
  check('coverage is the COSTED share of eligible line revenue, not "1 of 2 rows"',
    pCov.coveragePct === 50, pCov.coveragePct);
  check('switching to per_sku recorded the method',
    (await costsOf(acc)).cogs_method === 'per_sku');
  check('the blended margin was RETAINED, not deleted',
    Number((await costsOf(acc)).blended_margin_pct) === 62.55);

  // --- per-SKU value rules -------------------------------------------------
  for (const [label, cogs, code] of [
    ['negative', -1, 'negative'],
    ['three decimals', 10.123, 'too_precise'],
    ['too large', 1e13, 'too_large'],
    ['blank', '', 'not_a_number'],
    ['null', null, 'not_a_number'],
    ['not numeric', 'abc', 'not_a_number'],
  ] as [string, unknown, string][]) {
    const res = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
      method: 'per_sku', skus: [{ sku: 'COGS-B', cogs }],
    });
    check(`a per-SKU cost that is ${label} is refused`, res.statusCode === 400, res.statusCode);
    check(`a per-SKU cost that is ${label} carries ${code}`, errorCode(res) === code, res.body);
  }
  const noSku = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ cogs: 10 }],
  });
  check('a row with no sku is sku_required',
    noSku.statusCode === 400 && errorCode(noSku) === 'sku_required', noSku.body);

  // --- zero requires explicit confirmation ---------------------------------
  const zeroNo = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-B', cogs: 0 }],
  });
  check('a per-SKU cost of zero without confirmation is refused',
    zeroNo.statusCode === 400 && errorCode(zeroNo) === 'zero_unconfirmed', zeroNo.body);
  const { rows: noZeroRow } = await query<{ n: string }>(
    `SELECT count(*) n FROM sku_costs WHERE account_id = $1 AND sku = 'COGS-B'`, [acc],
  );
  check('the refused zero created no row', Number(noZeroRow[0]!.n) === 0);

  const zeroYes = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-B', cogs: 0, zeroConfirmed: true }],
  });
  check('a per-SKU cost of zero WITH confirmation is accepted', zeroYes.statusCode === 200,
    zeroYes.body);
  const { rows: zeroRow } = await query<{ cogs: string; zero_confirmed: boolean }>(
    `SELECT cogs, zero_confirmed FROM sku_costs WHERE account_id = $1 AND sku = 'COGS-B'`, [acc],
  );
  check('the confirmed zero is stored as zero', Number(zeroRow[0]!.cogs) === 0);
  check('the confirmation itself is stored', zeroRow[0]!.zero_confirmed === true);
  const zCov = body(zeroYes).coverage as Record<string, unknown>;
  check('a CONFIRMED zero does not appear in unconfirmedZeroSkus',
    (zCov.unconfirmedZeroSkus as string[]).length === 0, zCov.unconfirmedZeroSkus);
  check('a confirmed zero counts toward coverage', zCov.coveragePct === 80, zCov.coveragePct);
  // `zeroConfirmed: 'yes'` is not `true`. Only the boolean counts.
  const truthy = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-C', cogs: 0, zeroConfirmed: 'yes' }],
  });
  check('a truthy-but-not-true confirmation is still refused',
    truthy.statusCode === 400 && errorCode(truthy) === 'zero_unconfirmed', truthy.body);

  // --- costs beyond the initial required set raise coverage ---------------
  const beyond = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-D', cogs: 100 }, { sku: 'COGS-E', cogs: 50 }],
  });
  check('costs may be entered for SKUs beyond the required set', beyond.statusCode === 200,
    beyond.body);
  const bCov = body(beyond).coverage as Record<string, unknown>;
  check('coverage counts every costed SKU, not only the required ones',
    bCov.coveragePct === 90, bCov.coveragePct);
  check('the required set is unchanged by costing extra SKUs',
    (bCov.required as unknown[]).length === 2);

  // --- one bad row rejects the WHOLE request -------------------------------
  const mixed = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-C', cogs: 25 }, { sku: 'COGS-C', cogs: -1 }],
  });
  check('one invalid row rejects the entire batch', mixed.statusCode === 400, mixed.statusCode);
  const { rows: cRow } = await query<{ n: string }>(
    `SELECT count(*) n FROM sku_costs WHERE account_id = $1 AND sku = 'COGS-C'`, [acc],
  );
  check('the valid row in a rejected batch was not written', Number(cRow[0]!.n) === 0);

  // --- switching back restores the retained blended value ------------------
  const back = await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'blended', blendedMarginPct: 62.55,
  });
  check('switching back to blended succeeds', back.statusCode === 200, back.statusCode);
  const bothRetained = await costsOf(acc);
  check('the blended value is active again', bothRetained.cogs_method === 'blended');
  const { rows: skuStill } = await query<{ n: string }>(
    `SELECT count(*) n FROM sku_costs WHERE account_id = $1`, [acc],
  );
  check('every per-SKU cost was RETAINED across the switch', Number(skuStill[0]!.n) === 4,
    skuStill[0]);
  // But the inactive set must not influence coverage — that is what the
  // v_active_* views are for.
  const inactiveCov = body(await get(app, cookie, `/accounts/${acc}/costs`)).coverage as Record<string, unknown>;
  check('while blended is active, per-SKU coverage reads 0 (inactive values are unreadable)',
    inactiveCov.coveragePct === 0, inactiveCov.coveragePct);
  check('the retained rows still exist in the database while unreadable through coverage',
    Number(skuStill[0]!.n) === 4);
  // Switch forward once more: the retained values become visible again.
  await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'per_sku', skus: [{ sku: 'COGS-A', cogs: 2000 }],
  });
  const restoredCov = body(await get(app, cookie, `/accounts/${acc}/costs`)).coverage as Record<string, unknown>;
  check('switching back to per_sku makes the retained costs readable again',
    restoredCov.coveragePct === 90, restoredCov.coveragePct);

  // --- readiness follows the ACTIVE method only ----------------------------
  await send(app, 'PUT', cookie, `/accounts/${acc}/costs`, {
    method: 'blended', blendedMarginPct: 62.55,
  });
  const blReady = body(await get(app, cookie, `/accounts/${acc}/rcm-readiness`));
  const blCodes = (blReady.blockers as { code: string }[]).map((x) => x.code);
  check('with blended active, per-SKU coverage does not block readiness',
    !blCodes.includes('cogs_per_sku_incomplete'), blCodes);
  check('with blended active, the blended value satisfies the COGS gate',
    !blCodes.includes('cogs_blended_missing_or_invalid'), blCodes);

  // --- the top-20 cap, and coverage that cannot reach the target -----------
  //
  // 30 SKUs of EQUAL revenue. The arithmetic matters, and getting it wrong is how
  // this check silently stops testing anything: with N equal SKUs the top 20 are
  // 20/N of revenue, so 25 SKUs gives exactly 80% — which MEETS the target and
  // leaves cappedBelowTarget false. 26 is the smallest N that cannot reach it
  // (76.9%); 30 gives 66.7%, comfortably clear of the boundary in both directions.
  const capped = await makeAccount('cogsCap', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(capped, `fincontrol-cap-${capped}.myshopify.invalid`);
  for (let i = 0; i < 30; i++) {
    const o = await insertOrder(capped, monthsAgo(1), 100, i === 0);
    await insertLineItem(capped, o, o, `CAP-SKU-${String(i).padStart(2, '0')}`, 100);
  }
  const capCov = body(await get(app, cookie, `/accounts/${capped}/costs`)).coverage as Record<string, unknown>;
  check('the required set is capped at 20', (capCov.required as unknown[]).length === 20,
    (capCov.required as unknown[]).length);
  check('all 30 SKUs are still offered in coverage.all',
    (capCov.all as unknown[]).length === 30, (capCov.all as unknown[]).length);
  check('cappedBelowTarget is true when the top 20 cannot reach 80%',
    capCov.cappedBelowTarget === true, capCov);
  check('the top 20 of 30 equal SKUs is 66.67% of eligible line revenue — under target',
    capCov.eligibleLineRevenue === 3000, capCov.eligibleLineRevenue);

  // FILLING EVERY DISPLAYED ROW MUST NOT PRODUCE A COMPLETE STATE. This is E2's
  // whole point: the binding condition is revenue coverage, not "all 20 entered".
  const allRequired = (capCov.required as { sku: string }[]).map((r) => ({ sku: r.sku, cogs: 40 }));
  const filled = await send(app, 'PUT', cookie, `/accounts/${capped}/costs`, {
    method: 'per_sku', skus: allRequired,
  });
  check('all 20 required rows save successfully', filled.statusCode === 200, filled.body);
  const filledCov = body(filled).coverage as Record<string, unknown>;
  check('every displayed row is filled, yet actual coverage is 66.67 — not complete',
    filledCov.coveragePct === 66.67, filledCov.coveragePct);
  check('no required SKU is missing once all 20 are entered',
    (filledCov.missingSkus as string[]).length === 0, filledCov.missingSkus);
  check('cappedBelowTarget survives filling every displayed row',
    filledCov.cappedBelowTarget === true);
  const shortReady = body(await get(app, cookie, `/accounts/${capped}/rcm-readiness`));
  const shortCodes = (shortReady.blockers as { code: string }[]).map((x) => x.code);
  check('coverage below the target blocks readiness even with every row filled',
    shortCodes.includes('cogs_per_sku_incomplete'), shortCodes);
  const shortBlocker = (shortReady.blockers as { code: string; detail?: Record<string, unknown> }[])
    .find((b) => b.code === 'cogs_per_sku_incomplete');
  check('the blocker reports that the top SKUs cannot reach the target',
    shortBlocker?.detail?.topSkusCannotReachTarget === true, shortBlocker?.detail);

  // Costing SKUs BEYOND the initial 20 is what closes the gap.
  const beyondCap = (capCov.all as { sku: string }[]).slice(20).map((r) => ({ sku: r.sku, cogs: 40 }));
  const closed = await send(app, 'PUT', cookie, `/accounts/${capped}/costs`, {
    method: 'per_sku', skus: beyondCap,
  });
  check('costs may be entered for the SKUs beyond the initial 20',
    closed.statusCode === 200, closed.body);
  const closedCov = body(closed).coverage as Record<string, unknown>;
  check('costing the additional SKUs raises actual coverage to 100',
    closedCov.coveragePct === 100, closedCov.coveragePct);
  const closedReady = body(await get(app, cookie, `/accounts/${capped}/rcm-readiness`));
  const closedCodes = (closedReady.blockers as { code: string }[]).map((x) => x.code);
  check('reaching the target clears the COGS coverage blocker',
    !closedCodes.includes('cogs_per_sku_incomplete'), closedCodes);

  // --- no eligible SKU data ------------------------------------------------
  const bare = await makeAccount('cogsBare', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(bare, `fincontrol-bare-${bare}.myshopify.invalid`);
  const bareCov = body(await get(app, cookie, `/accounts/${bare}/costs`)).coverage as Record<string, unknown>;
  check('an account with no line items has an empty required set',
    (bareCov.required as unknown[]).length === 0);
  check('an account with no line items has an empty coverage.all',
    (bareCov.all as unknown[]).length === 0);
  check('an empty denominator does not produce NaN or Infinity',
    bareCov.coveragePct === 0 && bareCov.eligibleLineRevenue === 0, bareCov);
  check('an empty required set is not reported as capped',
    bareCov.cappedBelowTarget === false);
  check('blended margin is still available with no SKU data',
    (await send(app, 'PUT', cookie, `/accounts/${bare}/costs`,
      { method: 'blended', blendedMarginPct: 55 })).statusCode === 200);

  // --- cancelled and test orders are excluded from coverage ---------------
  const excl = await makeAccount('cogsExcl', { currency: 'USD', source: 'manual' });
  const good = await insertOrder(excl, monthsAgo(1), 100, true);
  await insertLineItem(excl, good, good, 'EXCL-GOOD', 100);
  const cancelled = orderSeq++;
  await query(
    `INSERT INTO orders (account_id, id, customer_id, created_at, total_net, is_first_order,
                         cancelled, test)
     VALUES ($1, $2, $2, ($3::date + interval '15 hours')::timestamptz, 900, false, true, false)`,
    [excl, cancelled, monthsAgo(1)],
  );
  await insertLineItem(excl, cancelled, cancelled, 'EXCL-CANCELLED', 900);
  const exclCov = body(await get(app, cookie, `/accounts/${excl}/costs`)).coverage as Record<string, unknown>;
  check('a cancelled order contributes no SKU revenue',
    (exclCov.all as { sku: string }[]).every((r) => r.sku !== 'EXCL-CANCELLED'),
    (exclCov.all as { sku: string }[]).map((r) => r.sku));
  check('only the eligible order counts toward the denominator',
    exclCov.eligibleLineRevenue === 100, exclCov.eligibleLineRevenue);
}

// ===========================================================================
// E. OCAS
// ===========================================================================
async function groupE(app: App, cookie: string): Promise<void> {
  group('E', 'Monthly operating costs');

  const acc = await makeAccount('ocas', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(acc, `fincontrol-ocas-${acc}.myshopify.invalid`);

  const ok = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`, { ocasMonthly: 12345.67 });
  check('a positive monthly OCAS is accepted', ok.statusCode === 200, ok.statusCode);
  check('the response echoes exactly { ocasMonthly, confirmedZero }',
    JSON.stringify(Object.keys(body(ok)).sort())
      === JSON.stringify(['confirmedZero', 'ocasMonthly']), Object.keys(body(ok)));
  check('the response echoes the accepted amount', body(ok).ocasMonthly === 12345.67, ok.body);
  check('confirmedZero is false for a positive amount', body(ok).confirmedZero === false);
  const stored = await costsOf(acc);
  check('the amount is stored', Number(stored.ocas_monthly) === 12345.67, stored);
  check('the stored zero-confirmation is false', stored.ocas_zero_confirmed === false);
  check('the stored value keeps two decimals as a NUMERIC string',
    stored.ocas_monthly === '12345.67', stored.ocas_monthly);

  for (const [label, value, code] of [
    ['negative', -1, 'negative'],
    ['three decimals', 1.234, 'too_precise'],
    ['too large', 1e13, 'too_large'],
    ['blank', '', 'not_a_number'],
    ['null', null, 'not_a_number'],
    ['whitespace', '   ', 'not_a_number'],
    ['not numeric', 'lots', 'not_a_number'],
    ['an array', [100], 'not_a_number'],
    ['Infinity as a string', 'Infinity', 'not_a_number'],
  ] as [string, unknown, string][]) {
    const res = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`, { ocasMonthly: value });
    check(`an OCAS that is ${label} is refused`, res.statusCode === 400, res.statusCode);
    check(`an OCAS that is ${label} carries ${code}`, errorCode(res) === code, res.body);
  }
  check('no rejected value overwrote the stored amount',
    Number((await costsOf(acc)).ocas_monthly) === 12345.67);
  const omitted = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`, {});
  check('an omitted ocasMonthly is not_a_number, never zero',
    omitted.statusCode === 400 && errorCode(omitted) === 'not_a_number', omitted.body);

  // --- zero requires explicit confirmation --------------------------------
  const zeroNo = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`, { ocasMonthly: 0 });
  check('an OCAS of zero without confirmation is refused', zeroNo.statusCode === 400,
    zeroNo.statusCode);
  check('it carries the fixed zero_unconfirmed code', errorCode(zeroNo) === 'zero_unconfirmed',
    zeroNo.body);
  check('the refused zero did not overwrite the stored amount',
    Number((await costsOf(acc)).ocas_monthly) === 12345.67);

  const truthy = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`, {
    ocasMonthly: 0, confirmedZero: 'yes',
  });
  check('a truthy-but-not-true confirmation is still refused',
    truthy.statusCode === 400 && errorCode(truthy) === 'zero_unconfirmed', truthy.body);

  const zeroYes = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`, {
    ocasMonthly: 0, confirmedZero: true,
  });
  check('an OCAS of zero WITH confirmation is accepted', zeroYes.statusCode === 200, zeroYes.body);
  check('the response reports the confirmation', body(zeroYes).confirmedZero === true);
  const zeroStored = await costsOf(acc);
  check('zero is stored as zero', Number(zeroStored.ocas_monthly) === 0, zeroStored);
  check('the confirmation is stored', zeroStored.ocas_zero_confirmed === true);
  const zReady = body(await get(app, cookie, `/accounts/${acc}/rcm-readiness`));
  const zCodes = (zReady.blockers as { code: string }[]).map((x) => x.code);
  check('a CONFIRMED zero OCAS does not block readiness',
    !zCodes.includes('ocas_zero_unconfirmed') && !zCodes.includes('ocas_missing'), zCodes);

  // Moving back to a positive amount clears the confirmation.
  const positiveAgain = await send(app, 'PUT', cookie, `/accounts/${acc}/costs/ocas`,
    { ocasMonthly: 500 });
  check('a positive amount after a confirmed zero is accepted',
    positiveAgain.statusCode === 200, positiveAgain.statusCode);
  check('the stored zero-confirmation is cleared when the amount is no longer zero',
    (await costsOf(acc)).ocas_zero_confirmed === false, await costsOf(acc));

  // An unset OCAS blocks readiness, and is distinguishable from a confirmed zero.
  const unset = await makeAccount('ocasUnset', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(unset, `fincontrol-ocasunset-${unset}.myshopify.invalid`);
  const uReady = body(await get(app, cookie, `/accounts/${unset}/rcm-readiness`));
  const uCodes = (uReady.blockers as { code: string }[]).map((x) => x.code);
  check('an unset OCAS blocks readiness as ocas_missing', uCodes.includes('ocas_missing'), uCodes);
  check('an unset OCAS reads as null, never 0',
    body(await get(app, cookie, `/accounts/${unset}/costs`)).costs !== undefined
    && ((body(await get(app, cookie, `/accounts/${unset}/costs`)).costs as Record<string, unknown>)
      .ocas_monthly === null));
}

// ===========================================================================
// F. Ad spend
// ===========================================================================
async function groupF(app: App, cookie: string): Promise<void> {
  group('F', 'Advertising spend');

  const acc = await makeAccount('spend', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(acc, `fincontrol-spend-${acc}.myshopify.invalid`);
  // First customers in months 3, 2 and 0 — month 1 gets an order but no NEW
  // customer, so it must not be required.
  for (const [n, isFirst] of [[3, true], [2, true], [1, false], [0, true]] as [number, boolean][]) {
    const o = await insertOrder(acc, monthsAgo(n), 500, isFirst);
    await insertLineItem(acc, o, o, 'SPEND-SKU', 500);
  }

  // --- the GET contract ---------------------------------------------------
  const g = await get(app, cookie, `/accounts/${acc}/ad-spend`);
  check('GET /ad-spend returns 200', g.statusCode === 200, g.statusCode);
  const gb = body(g);
  check('GET /ad-spend returns exactly { rows, coverage, suggestedChannels }',
    JSON.stringify(Object.keys(gb).sort())
      === JSON.stringify(['coverage', 'rows', 'suggestedChannels']), Object.keys(gb));
  check('rows is an empty array before anything is entered',
    Array.isArray(gb.rows) && (gb.rows as unknown[]).length === 0);
  const cov = gb.coverage as Record<string, unknown>;
  check('coverage returns exactly the nine documented fields',
    JSON.stringify(Object.keys(cov).sort()) === JSON.stringify([
      'complete', 'contradictoryMonths', 'coveredMonths', 'currentMonth', 'firstOrderMonth',
      'missingMonths', 'requiredMonths', 'windowStart', 'zeroConfirmedMonths',
    ]), Object.keys(cov));
  check('every month value is a YYYY-MM-DD first-of-month string',
    (cov.requiredMonths as string[]).every((m) => /^\d{4}-\d{2}-01$/.test(m)),
    cov.requiredMonths);
  check('suggestedChannels is a non-empty list of strings',
    Array.isArray(gb.suggestedChannels) && (gb.suggestedChannels as string[]).length > 0
    && (gb.suggestedChannels as unknown[]).every((c) => typeof c === 'string'));
  check('coverage carries no account_id', !('account_id' in cov) && !('accountId' in cov));

  const required = cov.requiredMonths as string[];
  check('the first order month is 3 months back', cov.firstOrderMonth === monthsAgo(3),
    cov.firstOrderMonth);
  check('the current month is the account-timezone month', cov.currentMonth === monthsAgo(0),
    cov.currentMonth);
  check('a month with an order but NO new customer is not required',
    !required.includes(monthsAgo(1)), required);
  check('exactly the three new-customer months are required', required.length === 3, required);
  check('coverage is incomplete before anything is entered', cov.complete === false);

  // --- THE ZERO-ROW REFUSAL (the Phase 5B-2F backend correction) ---------
  //
  // Before this checkpoint PUT /ad-spend accepted `amount: 0`, wrote ad_spend
  // with spend 0.00, and getCoverageWindow() counted the month as COVERED — so a
  // month could be marked answered without anyone stating the spend was truly
  // zero. That is the inference D3 forbids, and downstream it is a CAC of 0
  // feeding an RCM tier presented as complete.
  const zeroRow = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Synthetic Channel', amount: 0, startMonth: required[0], endMonth: required[0] }],
  });
  check('an ordinary spend row of 0 is refused', zeroRow.statusCode === 400, zeroRow.statusCode);
  check('it carries the fixed zero_requires_confirmation code',
    errorCode(zeroRow) === 'zero_requires_confirmation', zeroRow.body);
  check('the refusal creates no ad_spend row', (await spendRows(acc)).length === 0);
  const afterZeroCov = body(await get(app, cookie, `/accounts/${acc}/ad-spend`)).coverage as Record<string, unknown>;
  check('the refused zero did not make the month covered',
    !(afterZeroCov.coveredMonths as string[]).includes(required[0]!),
    afterZeroCov.coveredMonths);
  check('the refused zero did not make coverage complete', afterZeroCov.complete === false);
  check('the refused zero created no zero confirmation either',
    (await zeroMonths(acc)).length === 0);
  const strZero = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: '0', startMonth: required[0], endMonth: required[0] }],
  });
  check('a string "0" is refused too — coercion is not a way round it',
    strZero.statusCode === 400 && errorCode(strZero) === 'zero_requires_confirmation',
    strZero.body);
  const zeroDecimal = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 0.0, startMonth: required[0], endMonth: required[0] }],
  });
  check('0.0 is refused as well', zeroDecimal.statusCode === 400
    && errorCode(zeroDecimal) === 'zero_requires_confirmation', zeroDecimal.body);
  check('the smallest positive amount IS accepted', (await send(app, 'PUT', cookie,
    `/accounts/${acc}/ad-spend`,
    { rows: [{ channel: 'Penny', amount: 0.01, startMonth: required[0], endMonth: required[0] }] },
  )).statusCode === 200);
  await query(`DELETE FROM ad_spend WHERE account_id = $1`, [acc]);

  // --- positive rows -----------------------------------------------------
  const put = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 1000, startMonth: required[0], endMonth: required[2] }],
  });
  check('a positive multi-month range is accepted', put.statusCode === 200, put.statusCode);
  const pb = body(put);
  check('the response reports monthsWritten, rowsWritten and cleared confirmations',
    typeof pb.monthsWritten === 'number' && typeof pb.rowsWritten === 'number'
    && typeof pb.zeroConfirmationsCleared === 'number', Object.keys(pb));
  check('the response carries refreshed coverage', 'coverage' in pb);
  check('a range applies the amount to EVERY month it spans',
    (await spendRows(acc)).length === 4, await spendRows(acc));
  const listed = body(await get(app, cookie, `/accounts/${acc}/ad-spend`));
  const rows = listed.rows as Record<string, unknown>[];
  check('a listed row has exactly { month, channel, spend, source }',
    JSON.stringify(Object.keys(rows[0]!).sort())
      === JSON.stringify(['channel', 'month', 'source', 'spend']), Object.keys(rows[0]!));
  check('the stored spend is a two-decimal NUMERIC string, not a float',
    rows.every((r) => typeof r.spend === 'string' && /^\d+\.\d{2}$/.test(r.spend as string)),
    rows.map((r) => r.spend));
  check("source is 'manual' — the only V1 source", rows.every((r) => r.source === 'manual'));
  check('listed rows are newest month first',
    (rows[0]!.month as string) >= (rows[rows.length - 1]!.month as string));
  check('a listed row carries no account_id',
    rows.every((r) => !('account_id' in r) && !('accountId' in r)));
  const cov2 = listed.coverage as Record<string, unknown>;
  check('every required month is now covered',
    (cov2.missingMonths as string[]).length === 0, cov2.missingMonths);
  check('coverage is complete once every required month has spend',
    cov2.complete === true, cov2);

  // Re-submitting the same channel and month CORRECTS the amount.
  const correct = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 250.5, startMonth: required[0], endMonth: required[0] }],
  });
  check('resubmitting the same channel+month is accepted', correct.statusCode === 200);
  const corrected = (await spendRows(acc)).find((r) => r.month === required[0] && r.channel === 'Meta');
  check('the amount was corrected in place, not duplicated', corrected?.spend === '250.50',
    corrected);
  const { rows: dupCheck } = await query<{ n: string }>(
    `SELECT count(*) n FROM ad_spend WHERE account_id = $1 AND month = $2 AND channel = 'Meta'`,
    [acc, required[0]],
  );
  check('there is still exactly one row for that channel and month',
    Number(dupCheck[0]!.n) === 1);

  // --- range and month validation ----------------------------------------
  const nextMonthParts = (() => {
    const [y, m] = monthsAgo(0).split('-').map(Number);
    const total = y! * 12 + (m! - 1) + 1;
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  })();
  const future = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 10, startMonth: monthsAgo(0), endMonth: nextMonthParts }],
  });
  check('a future end month is refused', future.statusCode === 400, future.statusCode);
  check('it carries the fixed future_month code', errorCode(future) === 'future_month', future.body);

  const reversed = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 10, startMonth: monthsAgo(1), endMonth: monthsAgo(3) }],
  });
  check('a reversed range is refused', reversed.statusCode === 400, reversed.statusCode);
  check('it carries the fixed bad_range code', errorCode(reversed) === 'bad_range', reversed.body);

  const overlapping = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [
      { channel: 'Meta', amount: 10, startMonth: monthsAgo(3), endMonth: monthsAgo(1) },
      { channel: 'meta', amount: 20, startMonth: monthsAgo(2), endMonth: monthsAgo(0) },
    ],
  });
  check('overlapping same-channel rows are refused', overlapping.statusCode === 400,
    overlapping.statusCode);
  check('it carries the fixed overlapping_rows code',
    errorCode(overlapping) === 'overlapping_rows', overlapping.body);
  check('overlap detection is case-insensitive (Meta vs meta)',
    errorCode(overlapping) === 'overlapping_rows');

  const differentChannels = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [
      { channel: 'Google', amount: 10, startMonth: monthsAgo(2), endMonth: monthsAgo(2) },
      { channel: 'TikTok', amount: 20, startMonth: monthsAgo(2), endMonth: monthsAgo(2) },
    ],
  });
  check('different channels MAY share a month', differentChannels.statusCode === 200,
    differentChannels.body);

  const tooLong = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 10, startMonth: '2000-01', endMonth: monthsAgo(0) }],
  });
  check('an absurdly long range is refused', tooLong.statusCode === 400, tooLong.statusCode);
  check('it carries the fixed range_too_long code',
    errorCode(tooLong) === 'range_too_long', tooLong.body);

  for (const [label, month] of [
    ['not a date', 'last-march'], ['a full timestamp', '2026-03-01T00:00:00Z'],
    ['month 13', '2026-13'], ['month 00', '2026-00'], ['a two-digit year', '26-03'],
    ['empty', ''], ['null', null], ['a number', 202603],
  ] as [string, unknown][]) {
    const res = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
      rows: [{ channel: 'Meta', amount: 10, startMonth: month, endMonth: monthsAgo(0) }],
    });
    check(`a start month that is ${label} is bad_month`,
      res.statusCode === 400 && errorCode(res) === 'bad_month', res.body);
  }

  const noRows = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, { rows: [] });
  check('an empty rows array is no_rows',
    noRows.statusCode === 400 && errorCode(noRows) === 'no_rows', noRows.body);
  const noRowsField = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {});
  check('an omitted rows field is no_rows too',
    noRowsField.statusCode === 400 && errorCode(noRowsField) === 'no_rows', noRowsField.body);

  // --- channel rules ------------------------------------------------------
  const blankCh = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: '   ', amount: 10, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }],
  });
  check('a blank channel is channel_required',
    blankCh.statusCode === 400 && errorCode(blankCh) === 'channel_required', blankCh.body);
  const longCh = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: 'x'.repeat(65), amount: 10, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }],
  });
  check('a channel over 64 characters is channel_too_long',
    longCh.statusCode === 400 && errorCode(longCh) === 'channel_too_long', longCh.body);
  check('a channel of exactly 64 characters is accepted', (await send(app, 'PUT', cookie,
    `/accounts/${acc}/ad-spend`, {
      rows: [{ channel: 'y'.repeat(64), amount: 10, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }],
    })).statusCode === 200);
  const messyCh = await send(app, 'PUT', cookie, `/accounts/${acc}/ad-spend`, {
    rows: [{ channel: '  Paid   Social  ', amount: 10, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }],
  });
  check('a channel is trimmed and its inner whitespace collapsed', messyCh.statusCode === 200,
    messyCh.body);
  check('the normalized channel is what gets stored',
    (await spendRows(acc)).some((r) => r.channel === 'Paid Social'),
    (await spendRows(acc)).map((r) => r.channel));
  check('free-text channels outside the suggested list are allowed',
    (await spendRows(acc)).some((r) => r.channel === 'Paid Social'));

  // --- zero/spend mutual exclusion, transactionally -----------------------
  const zeroAcc = await makeAccount('spendZero', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(zeroAcc, `fincontrol-spendzero-${zeroAcc}.myshopify.invalid`);
  for (const n of [2, 1, 0]) {
    const o = await insertOrder(zeroAcc, monthsAgo(n), 400, true);
    await insertLineItem(zeroAcc, o, o, 'ZERO-SKU', 400);
  }
  const zRequired = (body(await get(app, cookie, `/accounts/${zeroAcc}/ad-spend`)).coverage as
    { requiredMonths: string[] }).requiredMonths;

  const unconfirmed = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [zRequired[0]],
  });
  check('confirming zero without confirmedZero:true is refused',
    unconfirmed.statusCode === 400, unconfirmed.statusCode);
  check('it carries the fixed zero_unconfirmed code',
    errorCode(unconfirmed) === 'zero_unconfirmed', unconfirmed.body);
  check('the refusal created no zero confirmation', (await zeroMonths(zeroAcc)).length === 0);
  const truthyZ = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [zRequired[0]], confirmedZero: 'yes',
  });
  check('a truthy-but-not-true confirmedZero is still refused',
    truthyZ.statusCode === 400 && errorCode(truthyZ) === 'zero_unconfirmed', truthyZ.body);
  const noMonths = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [], confirmedZero: true,
  });
  check('an empty months array is months_required',
    noMonths.statusCode === 400 && errorCode(noMonths) === 'months_required', noMonths.body);
  const badMonth = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: ['not-a-month'], confirmedZero: true,
  });
  check('a malformed month in the zero request is bad_month',
    badMonth.statusCode === 400 && errorCode(badMonth) === 'bad_month', badMonth.body);

  const confirmed = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [zRequired[0]], confirmedZero: true,
  });
  check('an explicit zero confirmation is accepted', confirmed.statusCode === 200,
    confirmed.body);
  check('the response reports how many months were confirmed',
    body(confirmed).monthsConfirmed === 1, confirmed.body);
  check('the response carries refreshed coverage', 'coverage' in body(confirmed));
  check('the zero confirmation is stored',
    (await zeroMonths(zeroAcc)).includes(zRequired[0]!));
  check('a confirmed zero creates NO ad_spend row', (await spendRows(zeroAcc)).length === 0);
  const zCov = body(confirmed).coverage as Record<string, unknown>;
  check('a confirmed zero counts the month as covered',
    (zCov.coveredMonths as string[]).includes(zRequired[0]!), zCov.coveredMonths);
  check('a confirmed zero appears in zeroConfirmedMonths',
    (zCov.zeroConfirmedMonths as string[]).includes(zRequired[0]!), zCov.zeroConfirmedMonths);
  check('no month is both covered-by-spend and confirmed-zero',
    (zCov.contradictoryMonths as string[]).length === 0);

  // Writing positive spend for a confirmed-zero month CLEARS the confirmation.
  const overwrite = await send(app, 'PUT', cookie, `/accounts/${zeroAcc}/ad-spend`, {
    rows: [{ channel: 'Meta', amount: 100, startMonth: zRequired[0], endMonth: zRequired[0] }],
  });
  check('writing positive spend over a confirmed zero is accepted',
    overwrite.statusCode === 200, overwrite.statusCode);
  check('the response reports the cleared confirmation',
    body(overwrite).zeroConfirmationsCleared === 1, overwrite.body);
  check('the zero confirmation is gone', !(await zeroMonths(zeroAcc)).includes(zRequired[0]!));
  check('the spend row exists', (await spendRows(zeroAcc)).length === 1);
  const exclCov = body(overwrite).coverage as Record<string, unknown>;
  check('no contradictory month resulted',
    (exclCov.contradictoryMonths as string[]).length === 0, exclCov.contradictoryMonths);

  // --- requires_replace ---------------------------------------------------
  const clash = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [zRequired[0]], confirmedZero: true,
  });
  check('confirming zero over existing spend returns 409', clash.statusCode === 409,
    clash.statusCode);
  check('it carries the fixed requires_replace code', errorCode(clash) === 'requires_replace',
    clash.body);
  const clashMonths = body(clash).months;
  check('the 409 names exactly which months already hold spend',
    Array.isArray(clashMonths) && (clashMonths as string[]).length === 1
    && (clashMonths as string[])[0] === zRequired[0], clashMonths);
  check('every returned month is a valid YYYY-MM-DD first-of-month',
    (clashMonths as string[]).every((m) => /^\d{4}-\d{2}-01$/.test(m)));
  check('the 409 deleted nothing', (await spendRows(zeroAcc)).length === 1);
  check('the 409 created no zero confirmation',
    !(await zeroMonths(zeroAcc)).includes(zRequired[0]!));

  const replaced = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [zRequired[0]], confirmedZero: true, replace: true,
  });
  check('an explicit replace is accepted', replaced.statusCode === 200, replaced.body);
  check('the response reports how many spend rows were removed',
    body(replaced).spendRowsRemoved === 1, replaced.body);
  check('the spend rows for that month are gone', (await spendRows(zeroAcc)).length === 0);
  check('the zero confirmation now exists',
    (await zeroMonths(zeroAcc)).includes(zRequired[0]!));
  const rCov = body(replaced).coverage as Record<string, unknown>;
  check('no contradictory state remains after a replace',
    (rCov.contradictoryMonths as string[]).length === 0, rCov.contradictoryMonths);

  // `replace: true` without `confirmedZero` is still refused — replace is not a
  // substitute for the confirmation.
  const replaceOnly = await send(app, 'POST', cookie, `/accounts/${zeroAcc}/ad-spend/zero`, {
    months: [zRequired[1]], replace: true,
  });
  check('replace:true alone does not satisfy the zero confirmation',
    replaceOnly.statusCode === 400 && errorCode(replaceOnly) === 'zero_unconfirmed',
    replaceOnly.body);

  // A contradictory state, forced directly into the database, is REPORTED.
  await query(
    `INSERT INTO ad_spend (account_id, month, channel, spend, source)
     VALUES ($1, $2, 'Forced', 50, 'manual')`, [zeroAcc, zRequired[0]],
  );
  const contra = body(await get(app, cookie, `/accounts/${zeroAcc}/ad-spend`)).coverage as Record<string, unknown>;
  check('a month holding BOTH states is reported as contradictory',
    (contra.contradictoryMonths as string[]).includes(zRequired[0]!),
    contra.contradictoryMonths);
  check('a contradictory month prevents coverage being reported complete',
    contra.complete === false, contra);
  const contraReady = body(await get(app, cookie, `/accounts/${zeroAcc}/rcm-readiness`));
  const contraCodes = (contraReady.blockers as { code: string }[]).map((x) => x.code);
  check('a contradictory month blocks RCM readiness',
    contraCodes.includes('contradictory_ad_spend_state'), contraCodes);
  // Resolving it through the safe positive path removes the confirmation.
  await send(app, 'PUT', cookie, `/accounts/${zeroAcc}/ad-spend`, {
    rows: [{ channel: 'Forced', amount: 50, startMonth: zRequired[0], endMonth: zRequired[0] }],
  });
  const fixed = body(await get(app, cookie, `/accounts/${zeroAcc}/ad-spend`)).coverage as Record<string, unknown>;
  check('writing positive spend resolves the contradiction',
    (fixed.contradictoryMonths as string[]).length === 0, fixed.contradictoryMonths);
}

// ===========================================================================
// G. Coverage window
// ===========================================================================
async function groupG(app: App, cookie: string): Promise<void> {
  group('G', 'Coverage window');

  // --- no eligible order history ------------------------------------------
  const bare = await makeAccount('winBare', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(bare, `fincontrol-winbare-${bare}.myshopify.invalid`);
  const bareCov = body(await get(app, cookie, `/accounts/${bare}/ad-spend`)).coverage as Record<string, unknown>;
  check('an account with no eligible orders has no first order month',
    bareCov.firstOrderMonth === null, bareCov);
  check('it has no window start', bareCov.windowStart === null);
  check('it requires NO months — there is no CAC to compute',
    (bareCov.requiredMonths as string[]).length === 0);
  check('it still reports the current month', typeof bareCov.currentMonth === 'string');
  check('coverage is not reported incomplete when nothing can be required',
    bareCov.complete === true, bareCov);
  const bareReady = body(await get(app, cookie, `/accounts/${bare}/rcm-readiness`));
  const bareCodes = (bareReady.blockers as { code: string }[]).map((x) => x.code);
  check('readiness is blocked by no_eligible_revenue_data, not by ad-spend coverage',
    bareCodes.includes('no_eligible_revenue_data')
    && !bareCodes.includes('ad_spend_coverage_incomplete'), bareCodes);

  // --- a young brand ------------------------------------------------------
  const young = await makeAccount('winYoung', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(young, `fincontrol-winyoung-${young}.myshopify.invalid`);
  for (const n of [1, 0]) {
    const o = await insertOrder(young, monthsAgo(n), 200, true);
    await insertLineItem(young, o, o, 'YOUNG-SKU', 200);
  }
  const yCov = body(await get(app, cookie, `/accounts/${young}/ad-spend`)).coverage as Record<string, unknown>;
  check('a young brand is never asked for months before its first order',
    yCov.windowStart === monthsAgo(1), yCov);
  check('a young brand requires only the months it has traded',
    (yCov.requiredMonths as string[]).length === 2, yCov.requiredMonths);
  check('no required month precedes the first order month',
    (yCov.requiredMonths as string[]).every((m) => m >= (yCov.firstOrderMonth as string)),
    yCov);

  // --- the 12-month cap ---------------------------------------------------
  const old = await makeAccount('winOld', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(old, `fincontrol-winold-${old}.myshopify.invalid`);
  for (let n = 0; n < 30; n++) {
    const o = await insertOrder(old, monthsAgo(n), 200, true);
    await insertLineItem(old, o, o, 'OLD-SKU', 200);
  }
  const oCov = body(await get(app, cookie, `/accounts/${old}/ad-spend`)).coverage as Record<string, unknown>;
  check('a long-trading brand still starts the window 11 months back',
    oCov.windowStart === monthsAgo(11), oCov);
  check('the window is at most 12 months', (oCov.requiredMonths as string[]).length <= 12,
    (oCov.requiredMonths as string[]).length);
  check('and here it is exactly 12', (oCov.requiredMonths as string[]).length === 12);
  check('the first order month is reported even when it is outside the window',
    oCov.firstOrderMonth === monthsAgo(29), oCov.firstOrderMonth);
  check('no required month precedes the window start',
    (oCov.requiredMonths as string[]).every((m) => m >= (oCov.windowStart as string)));
  check('no required month is in the future',
    (oCov.requiredMonths as string[]).every((m) => m <= (oCov.currentMonth as string)));

  // --- the store timezone decides the month boundary ----------------------
  //
  // Two accounts, identical order instants, different timezones. An order placed
  // at 04:00 UTC on the first of a month is still the PREVIOUS month in Los
  // Angeles. Whether these two agree is exactly the trap #4 failure mode.
  const utcAcc = await makeAccount('winUtc', { currency: 'USD', source: 'manual', tz: 'UTC' });
  const laAcc = await makeAccount('winLa', { currency: 'USD', source: 'manual', tz: 'America/Los_Angeles' });
  await seedShopifyConnection(utcAcc, `fincontrol-winutc-${utcAcc}.myshopify.invalid`);
  await seedShopifyConnection(laAcc, `fincontrol-winla-${laAcc}.myshopify.invalid`);
  // First of the previous UTC month at 04:00 UTC — the previous month in LA.
  const utcMonth = monthsAgo(1, 'UTC');
  for (const acc of [utcAcc, laAcc]) {
    const id = orderSeq++;
    await query(
      `INSERT INTO orders (account_id, id, customer_id, created_at, total_net, is_first_order,
                           cancelled, test)
       VALUES ($1, $2, $2, ($3::date + interval '4 hours')::timestamptz, 100, true, false, false)`,
      [acc, id, utcMonth],
    );
    await insertLineItem(acc, id, id, 'TZ-SKU', 100);
  }
  const utcCov = body(await get(app, cookie, `/accounts/${utcAcc}/ad-spend`)).coverage as Record<string, unknown>;
  const laCov = body(await get(app, cookie, `/accounts/${laAcc}/ad-spend`)).coverage as Record<string, unknown>;
  check('the UTC account attributes the order to the UTC month',
    utcCov.firstOrderMonth === utcMonth, utcCov.firstOrderMonth);
  check('the Los Angeles account attributes the same instant to the PREVIOUS month',
    laCov.firstOrderMonth === monthsAgo(2, 'UTC'), laCov.firstOrderMonth);
  check('the two accounts therefore disagree — the account timezone is what decides',
    utcCov.firstOrderMonth !== laCov.firstOrderMonth,
    { utc: utcCov.firstOrderMonth, la: laCov.firstOrderMonth });
  check('the current month is read in the account timezone too',
    utcCov.currentMonth === monthsAgo(0, 'UTC')
    && laCov.currentMonth === monthsAgo(0, 'America/Los_Angeles'),
    { utc: utcCov.currentMonth, la: laCov.currentMonth });

  // --- a month with only a repeat customer is not required ----------------
  const repeatOnly = await makeAccount('winRepeat', { currency: 'USD', source: 'manual' });
  await seedShopifyConnection(repeatOnly, `fincontrol-winrepeat-${repeatOnly}.myshopify.invalid`);
  const firstOrder = await insertOrder(repeatOnly, monthsAgo(2), 300, true);
  await insertLineItem(repeatOnly, firstOrder, firstOrder, 'REP-SKU', 300);
  const repeat = await insertOrder(repeatOnly, monthsAgo(1), 300, false);
  await insertLineItem(repeatOnly, repeat, repeat, 'REP-SKU', 300);
  const rCov = body(await get(app, cookie, `/accounts/${repeatOnly}/ad-spend`)).coverage as Record<string, unknown>;
  check('a month with only repeat orders is not required',
    !(rCov.requiredMonths as string[]).includes(monthsAgo(1)), rCov.requiredMonths);
  check('the new-customer month IS required',
    (rCov.requiredMonths as string[]).includes(monthsAgo(2)), rCov.requiredMonths);
  check('a not-required month is not reported as missing',
    !(rCov.missingMonths as string[]).includes(monthsAgo(1)), rCov.missingMonths);
}

// ===========================================================================
// H. Response hygiene
// ===========================================================================
async function groupH(app: App, cookie: string): Promise<void> {
  group('H', 'Response hygiene');

  const a = await makeAccount('hygA', { currency: 'USD', source: 'manual' });
  const neighbour = await makeAccount('hygNeighbour', { currency: 'JPY', source: 'manual' });
  await seedShopifyConnection(a, `fincontrol-hyga-${a}.myshopify.invalid`);
  await seedShopifyConnection(neighbour, `fincontrol-hygn-${neighbour}.myshopify.invalid`);
  const o = await insertOrder(a, monthsAgo(1), 100, true);
  await insertLineItem(a, o, o, 'HYG-SKU', 100);
  const on = await insertOrder(neighbour, monthsAgo(1), 100, true);
  await insertLineItem(neighbour, on, on, 'NEIGHBOUR-SECRET-SKU', 100);
  await send(app, 'PUT', cookie, `/accounts/${neighbour}/costs/ocas`, { ocasMonthly: 987654.32 });

  // Every successful financial response.
  for (const [method, suffix, payload] of financialRoutes()) {
    const url = `/accounts/${a}${suffix}`;
    const res = method === 'GET'
      ? await get(app, cookie, url)
      : await send(app, method, cookie, url, payload);
    check(`${method} ${suffix} exposes no account_id field`,
      !/"account_?[iI]d"/.test(res.body), res.body.slice(0, 160));
    check(`${method} ${suffix} discloses no SQL, stack, path or internal error`,
      !leaksInternals(res.body), res.body.slice(0, 200));
    check(`${method} ${suffix} does not mention the neighbouring account's SKU`,
      !res.body.includes('NEIGHBOUR-SECRET-SKU'));
    check(`${method} ${suffix} does not mention the neighbouring account's OCAS`,
      !res.body.includes('987654.32'));
    check(`${method} ${suffix} does not mention the neighbouring account's name`,
      !res.body.includes(`${TEST_PREFIX}hygNeighbour`));
  }

  // Every rejection path is a fixed code with a fixed sentence.
  const rejections: [string, 'PUT' | 'POST', string, unknown][] = [
    ['invalid currency', 'PUT', '/currency', { currency: '!!' }],
    ['bad method', 'PUT', '/costs', { method: 'nope' }],
    ['unknown sku', 'PUT', '/costs', { method: 'per_sku', skus: [{ sku: 'NEIGHBOUR-SECRET-SKU', cogs: 1 }] }],
    ['negative ocas', 'PUT', '/costs/ocas', { ocasMonthly: -1 }],
    ['zero spend row', 'PUT', '/ad-spend', { rows: [{ channel: 'Meta', amount: 0, startMonth: monthsAgo(1), endMonth: monthsAgo(1) }] }],
    ['unconfirmed zero', 'POST', '/ad-spend/zero', { months: [monthsAgo(1)] }],
  ];
  for (const [label, method, suffix, payload] of rejections) {
    const res = await send(app, method, cookie, `/accounts/${a}${suffix}`, payload);
    check(`the ${label} rejection carries a fixed machine code`,
      typeof errorCode(res) === 'string' && /^[a-z_]+$/.test(errorCode(res)!), res.body);
    check(`the ${label} rejection carries a single-sentence message`,
      typeof body(res).message === 'string'
      && !/[\n\r]/.test(body(res).message as string)
      && (body(res).message as string).length <= 300, res.body);
    check(`the ${label} rejection discloses no internals`, !leaksInternals(res.body), res.body);
    check(`the ${label} rejection exposes no account_id`, !/"account_?[iI]d"/.test(res.body));
  }
  // The unknown-SKU refusal necessarily echoes the SKU the caller submitted —
  // that is the caller's own input, not a disclosure. What matters is that it
  // does not confirm the SKU exists SOMEWHERE, and the message says only that it
  // is not in THIS account's history.
  const echo = await send(app, 'PUT', cookie, `/accounts/${a}/costs`, {
    method: 'per_sku', skus: [{ sku: 'NEIGHBOUR-SECRET-SKU', cogs: 1 }],
  });
  check('the unknown-SKU message does not say the SKU belongs to another account',
    !/another account|other account|account \d/i.test(body(echo).message as string),
    body(echo).message);

  // A wrong content type is refused without a stack trace.
  const badType = await app.inject({
    method: 'PUT', url: `/accounts/${a}/costs/ocas`, remoteAddress: nextIp(),
    headers: { cookie, 'content-type': 'text/plain' }, payload: 'ocasMonthly=1',
  });
  check('a non-JSON content type is refused', badType.statusCode >= 400, badType.statusCode);
  check('the content-type refusal discloses no internals', !leaksInternals(badType.body),
    badType.body);

  // Malformed JSON likewise.
  const badJson = await app.inject({
    method: 'PUT', url: `/accounts/${a}/costs/ocas`, remoteAddress: nextIp(),
    headers: { cookie, 'content-type': 'application/json' }, payload: '{"ocasMonthly":',
  });
  check('malformed JSON is refused', badJson.statusCode >= 400, badJson.statusCode);
  check('the malformed-JSON refusal discloses no internals', !leaksInternals(badJson.body),
    badJson.body);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  console.log('\nCleanup');

  // EXACT IDS for every account this run created — not a name pattern. The
  // fallback below uses starts_with, NOT LIKE: `_` is a LIKE wildcard matching
  // any single character, so `LIKE '__fincontrol_%'` would also match an account
  // named "XYfincontrolZ…". An over-broad DELETE against real tables is not a
  // risk worth carrying in a script that runs against a real database.
  let rows = 0;
  for (const id of createdAccounts) {
    for (const t of ACCOUNT_TABLES) {
      const r = await query(`DELETE FROM ${t} WHERE account_id = $1`, [id])
        .catch(() => ({ rowCount: 0 }));
      rows += r.rowCount ?? 0;
    }
  }
  const accts = createdAccounts.length
    ? await query(`DELETE FROM accounts WHERE id = ANY($1::int[])`, [createdAccounts])
    : { rowCount: 0 };
  console.log(`  removed ${rows} synthetic financial/commerce row(s)`);
  console.log(`  removed ${accts.rowCount ?? 0} synthetic account(s)`);

  // Belt and braces: anything this run named but failed to track by id.
  const stray = await query(`DELETE FROM accounts WHERE starts_with(name, $1)`, [TEST_PREFIX]);
  if ((stray.rowCount ?? 0) > 0) console.log(`  removed ${stray.rowCount} untracked account(s)`);

  const users = createdEmails.length
    ? await query(`DELETE FROM users WHERE email = ANY($1::text[])`, [createdEmails])
    : { rowCount: 0 };
  console.log(`  removed ${users.rowCount ?? 0} synthetic user(s)`);

  // --- rate-limit counters -------------------------------------------------
  //
  // The only Redis keys this suite produces: the logins and token exchanges above
  // go through @fastify/rate-limit's Redis store. They carry a TTL and would
  // expire on their own, but "returns Redis to how it found it" should not depend
  // on waiting — the next suite in the run would refuse to start.
  //
  // No BullMQ deletion here on purpose: this suite never reaches a connect route,
  // so it constructs no Queue and writes no `bull:*` key. Removing keys it did
  // not create would be risk without purpose.
  const rateKeys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}*`).catch(() => [] as string[]);
  if (rateKeys.length) await redis.del(...rateKeys).catch(() => undefined);
  console.log(`  removed ${rateKeys.length} rate-limit counter(s)`);
}

/**
 * Redis must end exactly as it began: empty.
 *
 * Reported as a hard precondition failure rather than as a counted check, so the
 * suite's total stays a measure of the contract it verifies rather than of its
 * own housekeeping. It does NOT clean up the leftovers — silently forcing the
 * database back to zero is how a cleanup bug survives for months. The names are
 * safe to print: the precondition proved the database was empty beforehand, so
 * every remaining key came from here.
 */
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const app = buildApp();
await app.ready();

try {
  const cookie = await agencyLogin(app);
  await groupA(app, cookie);
  await groupB(app, cookie);
  await groupC(app, cookie);
  await groupD(app, cookie);
  await groupE(app, cookie);
  await groupF(app, cookie);
  await groupG(app, cookie);
  await groupH(app, cookie);
} finally {
  await cleanup();
  await app.close();
  await pool.end();
}

const redisClean = await assertRedisEmpty();
redis.disconnect();

console.log(`\n${'='.repeat(72)}`);
console.log('AGENCY FINANCIAL CONTROL RESULTS BY GROUP');
const TITLES: Record<string, string> = {
  A: 'Authentication',
  B: 'Tenant isolation',
  C: 'Currency',
  D: 'Cost of goods',
  E: 'Monthly operating costs',
  F: 'Advertising spend',
  G: 'Coverage window',
  H: 'Response hygiene',
};
for (const [letter, totals] of Object.entries(groupTotals)) {
  const mark = totals.fail === 0 ? '✓' : '✗';
  console.log(`  ${mark} ${letter}. ${(TITLES[letter] ?? '').padEnd(26)}`
    + `${totals.pass} passed, ${totals.fail} failed`);
}
console.log('='.repeat(72));
console.log(`TOTAL: ${passed} passed, ${failures} failed`);

if (failures > 0) {
  console.log('\nFAILED CHECKS:');
  for (const name of failed) console.log(`  ✗ ${name}`);
  console.log(`\n✗ ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
if (!redisClean) {
  console.log('\n✗ CHECKS PASSED BUT REDIS WAS LEFT DIRTY');
  process.exit(1);
}
console.log('\n✓ ALL AGENCY FINANCIAL CONTROL CHECKS PASSED');
process.exit(0);

export {};
