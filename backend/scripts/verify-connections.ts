/**
 * Account-scoped provider connection verification (Phase 5B-2E).
 *
 *   A. Route surface — the three account-scoped connection routes and the skip
 *      route exist, and the account comes from the PATH, never the body.
 *   B. Authorization — anonymous callers and client onboarding-link sessions are
 *      rejected from every one of them.
 *   C. Credential handling — nothing echoes a submitted credential, everything
 *      is encrypted at rest, and no .env credential can be substituted.
 *   D. Idempotency — reconnecting updates the one connection row rather than
 *      creating a second, and supersedes a prior skip/request choice.
 *   E. Status mapping — 400 / 502 answers match the Shopify route exactly.
 *   F. Skip — records a choice, creates no connection row, and needs no body.
 *
 * OFFLINE. Every outbound provider call is intercepted by the mock below; no
 * real Shopify, Klaviyo or Recharge endpoint is contacted and no real credential
 * is used. Every credential here is an obvious synthetic literal.
 *
 * Nothing in this file prints a submitted credential.
 *
 * Separate from verify:onboarding on purpose: that suite is an established
 * baseline whose total is quoted in every checkpoint report, and folding new
 * checks into it would make "482 passed" mean something different next week.
 *
 * Run: `npm run verify:connections`
 */
process.env.APP_BASE_URL = 'http://localhost:5173';

const { default: bcrypt } = await import('bcryptjs');
const { pool, query } = await import('../src/db/pool.js');
const { buildApp } = await import('../src/index.js');
const { redis } = await import('../src/queue/queues.js');
const security = await import('../src/auth/security.js');
const { decrypt } = await import('../src/crypto.js');
const { config } = await import('../src/config.js');

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
function nextIp(): string {
  ipCounter++;
  return `172.24.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

// ---------------------------------------------------------------------------
// Synthetic credentials. Obvious literals, never a real key shape.
// ---------------------------------------------------------------------------
const TEST_PREFIX = '__connsec_';
const TEST_PASSWORD = 'connsec-synthetic-password';

/**
 * A permanent domain unique to one account.
 *
 * findDomainConflict() refuses the same .myshopify.com domain across two
 * accounts — correct, and the reason a single shared fixture domain cannot be
 * reused: the second account gets domain_conflict rather than a connection.
 */
function shopDomainFor(accountId: number, variant = 1): string {
  return `synthetic-shop-${accountId}-${variant}.myshopify.com`;
}
const CLIENT_ID = 'synthetic-client-id';
const CLIENT_SECRET = 'synthetic-client-secret';
const CLIENT_SECRET_2 = 'synthetic-client-secret-rotated';
const KLAVIYO_KEY = 'synthetic-klaviyo-key';
const KLAVIYO_KEY_2 = 'synthetic-klaviyo-key-rotated';
const RECHARGE_TOKEN = 'synthetic-recharge-token';
const RECHARGE_TOKEN_2 = 'synthetic-recharge-token-rotated';

/** Every submitted secret, for the "never echoed" sweep. */
const ALL_SECRETS = [
  CLIENT_ID, CLIENT_SECRET, CLIENT_SECRET_2,
  KLAVIYO_KEY, KLAVIYO_KEY_2, RECHARGE_TOKEN, RECHARGE_TOKEN_2,
];

/** The .env values that must never appear in an outbound provider request. */
const ENV_SENTINELS: Record<string, string> = {
  KLAVIYO_API_KEY: config.klaviyoApiKey ?? '',
  SHOPIFY_CLIENT_ID: config.shopifyClientId ?? '',
  SHOPIFY_CLIENT_SECRET: config.shopifyClientSecret ?? '',
  SHOPIFY_SHOP_DOMAIN: config.shopifyShopDomain ?? '',
};

// ---------------------------------------------------------------------------
// Mock provider APIs. Verification is all these services do here.
// ---------------------------------------------------------------------------
interface FetchRecord { url: string; headers: Record<string, string>; body: string }
let fetchLog: FetchRecord[] = [];
/** Flip to make the next verification round-trip fail, for the 502 path. */
let failVerification = false;

function fakeResponse(body: unknown): unknown {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installMockFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: {
    headers?: Record<string, string>; body?: unknown;
  }) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === 'string' ? init.body : '';
    fetchLog.push({ url, headers, body });

    if (failVerification) throw new TypeError('fetch failed');

    const u = new URL(url);
    if (u.pathname === '/admin/oauth/access_token') {
      return fakeResponse({ access_token: 'synthetic-shopify-access-token', expires_in: 86400 });
    }
    if (u.pathname.endsWith('/graphql.json')) {
      return fakeResponse({
        data: {
          shop: {
            name: 'Synthetic Shop', myshopifyDomain: u.hostname,
            currencyCode: 'USD', ianaTimezone: 'America/New_York',
          },
        },
      });
    }
    if (u.pathname === '/api/accounts') {
      return fakeResponse({
        data: [{ id: 'SYNTH1', attributes: { contact_information: { organization_name: 'Synthetic Klaviyo' } } }],
      });
    }
    if (u.pathname === '/store') return fakeResponse({ store: { name: 'Synthetic Recharge' } });
    throw new Error(`unexpected fetch to ${url}`);
  };
}

/** Did any outbound request carry an .env sentinel rather than what we sent? */
function envCredentialLeaked(): string | null {
  for (const rec of fetchLog) {
    const haystack = `${rec.url} ${JSON.stringify(rec.headers)} ${rec.body}`;
    for (const [name, value] of Object.entries(ENV_SENTINELS)) {
      if (value && haystack.includes(value)) return name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixtures
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

async function agencyLogin(app: App): Promise<string> {
  const email = `${TEST_PREFIX}${Date.now()}@example.invalid`;
  await query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [
    email, await bcrypt.hash(TEST_PASSWORD, security.BCRYPT_COST),
  ]);
  const res = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' },
    payload: { email, password: TEST_PASSWORD },
  });
  const cookie = cookieFrom(res, 'tention_sid');
  if (!cookie) throw new Error(`agency login failed (${res.statusCode})`);
  return cookie;
}

let acctSeq = 0;
/** Every account this run created, so its queue jobs can be removed by id. */
const createdAccounts: number[] = [];

async function makeAccount(app: App, cookie: string): Promise<number> {
  acctSeq++;
  const res = await app.inject({
    method: 'POST', url: '/accounts', remoteAddress: nextIp(),
    headers: { cookie, 'content-type': 'application/json' },
    payload: { name: `${TEST_PREFIX}acct_${Date.now()}_${acctSeq}`, store_timezone: 'UTC' },
  });
  const id = (res.json() as { id: number }).id;
  createdAccounts.push(id);
  return id;
}

async function onboardingCookie(app: App, agency: string, accountId: number): Promise<string> {
  const minted = await app.inject({
    method: 'POST', url: `/accounts/${accountId}/onboarding-links`,
    headers: { cookie: agency, 'content-type': 'application/json' },
    remoteAddress: nextIp(), payload: {},
  });
  const { token } = minted.json() as { token: string };
  const exchanged = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' }, payload: { token },
  });
  const cookie = cookieFrom(exchanged, 'tention_onb');
  if (!cookie) throw new Error(`token exchange failed (${exchanged.statusCode})`);
  return cookie;
}

/** POST with a JSON body, the way the browser client sends one. */
function post(app: App, cookie: string | null, url: string, payload?: unknown) {
  return app.inject({
    method: 'POST', url, remoteAddress: nextIp(),
    headers: {
      accept: 'application/json',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

async function connectionRow(accountId: number, provider: string) {
  const { rows } = await query<{ credentials_encrypted: string; status: string; shop_domain: string | null }>(
    `SELECT credentials_encrypted, status, shop_domain FROM connections
      WHERE account_id = $1 AND provider = $2`,
    [accountId, provider],
  );
  return rows;
}

/** No submitted secret may appear anywhere in a response body. */
function echoesASecret(body: string): string | null {
  for (const secret of ALL_SECRETS) {
    if (body.includes(secret)) return secret.slice(0, 12);
  }
  return null;
}

// ===========================================================================
// A. Route surface
// ===========================================================================
async function groupA(app: App, cookie: string): Promise<void> {
  group('A', 'The account-scoped routes exist and take the account from the path');

  const acc = await makeAccount(app, cookie);

  const k = await post(app, cookie, `/accounts/${acc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY });
  check('POST /accounts/:id/connections/klaviyo exists', k.statusCode !== 404, k.statusCode);
  check('klaviyo connect succeeds', [200, 202].includes(k.statusCode), k.statusCode);

  const r = await post(app, cookie, `/accounts/${acc}/connections/recharge`, { token: RECHARGE_TOKEN });
  check('POST /accounts/:id/connections/recharge exists', r.statusCode !== 404, r.statusCode);
  check('recharge connect succeeds', [200, 202].includes(r.statusCode), r.statusCode);

  const s = await post(app, cookie, `/accounts/${acc}/connections/shopify/credentials`, {
    shopDomain: shopDomainFor(acc), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  check('POST /accounts/:id/connections/shopify/credentials still works',
    [200, 202].includes(s.statusCode), s.statusCode);

  // --- the account comes from the PATH ---------------------------------
  const other = await makeAccount(app, cookie);
  const spoof = await post(app, cookie, `/accounts/${other}/connections/klaviyo`, {
    apiKey: KLAVIYO_KEY, accountId: acc,
  });
  check('a body accountId is ignored: the path account is written',
    [200, 202].includes(spoof.statusCode) && (await connectionRow(other, 'klaviyo')).length === 1,
    spoof.statusCode);
  check('the spoofed account gained no second row',
    (await connectionRow(acc, 'klaviyo')).length === 1);

  // --- no env fallback --------------------------------------------------
  for (const [label, url, payload] of [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`, { apiKey: '' }],
    ['recharge', `/accounts/${acc}/connections/recharge`, { token: '' }],
  ] as [string, string, unknown][]) {
    const res = await post(app, cookie, url, payload);
    check(`${label}: a blank credential is refused, not filled from .env`,
      res.statusCode === 400
      && (res.json() as { code?: string }).code === 'missing_credentials', res.body);
  }
  for (const [label, url, payload] of [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`, { useEnvCredentials: true }],
    ['recharge', `/accounts/${acc}/connections/recharge`, { useEnvCredentials: true }],
  ] as [string, string, unknown][]) {
    const res = await post(app, cookie, url, payload);
    check(`${label}: useEnvCredentials is not honoured`, res.statusCode === 400, res.body);
  }
  check('no outbound request carried an .env credential', envCredentialLeaked() === null,
    envCredentialLeaked());

  // --- `mode` is not reachable -------------------------------------------
  // 'sync' would run a full backfill inline inside the request. The route never
  // reads it, so a caller cannot ask for that.
  fetchLog = [];
  const modeRes = await post(app, cookie, `/accounts/${acc}/connections/klaviyo`, {
    apiKey: KLAVIYO_KEY, mode: 'sync',
  });
  check('mode:sync is ignored — the response still reports a queued backfill',
    (modeRes.json() as { queued?: boolean }).queued === true, modeRes.body.slice(0, 120));
  check('mode:sync did not trigger an inline backfill',
    !fetchLog.some((f) => f.url.includes('/campaigns')), fetchLog.map((f) => f.url));

  // --- the frontend needs no optional fields -----------------------------
  const minimalK = await post(app, cookie, `/accounts/${acc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY });
  check('klaviyo works with apiKey alone', [200, 202].includes(minimalK.statusCode));
  const minimalR = await post(app, cookie, `/accounts/${acc}/connections/recharge`, { token: RECHARGE_TOKEN });
  check('recharge works with token alone', [200, 202].includes(minimalR.statusCode));
}

// ===========================================================================
// B. Authorization
// ===========================================================================
async function groupB(app: App, cookie: string): Promise<void> {
  group('B', 'Only an agency session may drive these routes');

  const acc = await makeAccount(app, cookie);
  const onb = await onboardingCookie(app, cookie, acc);

  const targets: [string, string, unknown][] = [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY }],
    ['recharge', `/accounts/${acc}/connections/recharge`, { token: RECHARGE_TOKEN }],
    ['shopify', `/accounts/${acc}/connections/shopify/credentials`,
      { shopDomain: shopDomainFor(acc), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }],
    ['skip', `/accounts/${acc}/connections/klaviyo/skip`, undefined],
  ];

  for (const [label, url, payload] of targets) {
    const anon = await post(app, null, url, payload);
    check(`anonymous is rejected from ${label}`, anon.statusCode === 401, anon.statusCode);

    const link = await post(app, onb, url, payload);
    check(`an onboarding-link session is rejected from ${label}`, link.statusCode === 401,
      link.statusCode);
  }

  check('no connection row was created by any rejected request',
    (await connectionRow(acc, 'klaviyo')).length === 0
    && (await connectionRow(acc, 'recharge')).length === 0
    && (await connectionRow(acc, 'shopify')).length === 0);
  const choices = await query<{ n: string }>(
    `SELECT count(*) n FROM onboarding_provider_choices WHERE account_id = $1`, [acc],
  );
  check('no provider choice was recorded by any rejected request',
    Number(choices.rows[0]!.n) === 0);
}

// ===========================================================================
// C. Credential handling
// ===========================================================================
async function groupC(app: App, cookie: string): Promise<void> {
  group('C', 'Credentials are never echoed and never stored in the clear');

  const acc = await makeAccount(app, cookie);

  const responses: [string, string][] = [];
  const k = await post(app, cookie, `/accounts/${acc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY });
  responses.push(['klaviyo', k.body]);
  const r = await post(app, cookie, `/accounts/${acc}/connections/recharge`, { token: RECHARGE_TOKEN });
  responses.push(['recharge', r.body]);
  const s = await post(app, cookie, `/accounts/${acc}/connections/shopify/credentials`, {
    shopDomain: shopDomainFor(acc), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  check('shopify connect succeeds', [200, 202].includes(s.statusCode),
    `${s.statusCode} ${s.body.slice(0, 120)}`);
  responses.push(['shopify', s.body]);

  for (const [label, body] of responses) {
    check(`${label}: the response echoes no submitted credential`,
      echoesASecret(body) === null, echoesASecret(body));
  }

  // --- encrypted at rest -------------------------------------------------
  for (const [provider, secret] of [
    ['klaviyo', KLAVIYO_KEY], ['recharge', RECHARGE_TOKEN], ['shopify', CLIENT_SECRET],
  ] as [string, string][]) {
    const rows = await connectionRow(acc, provider);
    check(`${provider}: a connection row exists`, rows.length === 1, rows.length);
    // Guarded: without this a missing row throws here and the remaining checks
    // never run, hiding whatever else is broken.
    const stored = rows[0]?.credentials_encrypted ?? '';
    check(`${provider}: the stored credential is not plaintext`,
      stored !== '' && !stored.includes(secret));
    const decrypted = stored === ''
      ? {}
      : JSON.parse(decrypt(stored)) as Record<string, string>;
    const roundTripped = decrypted.apiKey ?? decrypted.token ?? decrypted.clientSecret;
    check(`${provider}: it decrypts back to exactly what was submitted`,
      roundTripped === secret);
  }

  // --- failure paths ------------------------------------------------------
  failVerification = true;
  const failAcc = await makeAccount(app, cookie);
  for (const [label, url, payload] of [
    ['klaviyo', `/accounts/${failAcc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY }],
    ['recharge', `/accounts/${failAcc}/connections/recharge`, { token: RECHARGE_TOKEN }],
  ] as [string, string, unknown][]) {
    const res = await post(app, cookie, url, payload);
    check(`${label}: a failed verification is 502`, res.statusCode === 502, res.statusCode);
    check(`${label}: the 502 body has code verification_failed`,
      (res.json() as { code?: string }).code === 'verification_failed', res.body.slice(0, 120));
    check(`${label}: the 502 echoes no credential`, echoesASecret(res.body) === null);
    check(`${label}: a failed verification stores nothing`,
      (await connectionRow(failAcc, label)).length === 0);
  }
  failVerification = false;

  // A failure must not disturb an existing, working connection.
  failVerification = true;
  const rotateFail = await post(app, cookie, `/accounts/${acc}/connections/klaviyo`, {
    apiKey: 'synthetic-wrong-key',
  });
  failVerification = false;
  const survivingRows = await connectionRow(acc, 'klaviyo');
  check('a failed re-verification leaves the existing connection untouched',
    rotateFail.statusCode === 502
    && survivingRows.length === 1
    && (JSON.parse(decrypt(survivingRows[0]!.credentials_encrypted)) as Record<string, string>)
      .apiKey === KLAVIYO_KEY,
    rotateFail.statusCode);
}

// ===========================================================================
// D. Reconnect updates rather than duplicates
// ===========================================================================
async function groupD(app: App, cookie: string): Promise<void> {
  group('D', 'Reconnecting rotates the one row; a connection supersedes a choice');

  const acc = await makeAccount(app, cookie);

  for (const [provider, url, first, second, field] of [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`,
      { apiKey: KLAVIYO_KEY }, { apiKey: KLAVIYO_KEY_2 }, 'apiKey'],
    ['recharge', `/accounts/${acc}/connections/recharge`,
      { token: RECHARGE_TOKEN }, { token: RECHARGE_TOKEN_2 }, 'token'],
  ] as [string, string, unknown, unknown, string][]) {
    await post(app, cookie, url, first);
    check(`${provider}: one row after the first connect`,
      (await connectionRow(acc, provider)).length === 1);

    await post(app, cookie, url, second);
    const rows = await connectionRow(acc, provider);
    check(`${provider}: still ONE row after reconnecting`, rows.length === 1, rows.length);
    check(`${provider}: the row now holds the rotated credential`,
      (JSON.parse(decrypt(rows[0]!.credentials_encrypted)) as Record<string, string>)[field]
        === (second as Record<string, string>)[field]);
    check(`${provider}: the superseded credential is gone from the row`,
      !rows[0]!.credentials_encrypted.includes(
        (first as Record<string, string>)[field] as string));
  }

  // --- Shopify domain rotation -------------------------------------------
  await post(app, cookie, `/accounts/${acc}/connections/shopify/credentials`, {
    shopDomain: shopDomainFor(acc, 1), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  await post(app, cookie, `/accounts/${acc}/connections/shopify/credentials`, {
    shopDomain: shopDomainFor(acc, 2), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET_2,
  });
  const shopRows = await connectionRow(acc, 'shopify');
  check('shopify: still ONE row after re-verifying', shopRows.length === 1, shopRows.length);
  check('shopify: the row holds the new domain',
    shopRows[0]?.shop_domain === shopDomainFor(acc, 2), shopRows[0]?.shop_domain);
  check('shopify: the rotated secret replaced the old one', (() => {
    const stored = shopRows[0]?.credentials_encrypted ?? '';
    if (stored === '') return false;
    const creds = JSON.parse(decrypt(stored)) as Record<string, string>;
    return creds.clientSecret === CLIENT_SECRET_2;
  })());

  // --- the same domain cannot be claimed by a second account ---------------
  const rival = await makeAccount(app, cookie);
  const conflict = await post(app, cookie, `/accounts/${rival}/connections/shopify/credentials`, {
    shopDomain: shopDomainFor(acc, 2), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  check('shopify: another account cannot claim the same permanent domain',
    conflict.statusCode === 400
    && (conflict.json() as { code?: string }).code === 'domain_conflict',
    `${conflict.statusCode} ${conflict.body.slice(0, 120)}`);
  check('shopify: the conflict message names no other account',
    !/account\s+\d/i.test(conflict.body), conflict.body.slice(0, 160));
  check('shopify: the rival account got no connection row',
    (await connectionRow(rival, 'shopify')).length === 0);

  // --- a connection supersedes a prior choice -----------------------------
  const skipAcc = await makeAccount(app, cookie);
  await post(app, cookie, `/accounts/${skipAcc}/connections/klaviyo/skip`);
  const skipped = await query<{ choice: string }>(
    `SELECT choice FROM onboarding_provider_choices WHERE account_id = $1 AND provider = 'klaviyo'`,
    [skipAcc],
  );
  check('a skip records the choice', skipped.rows[0]?.choice === 'skipped', skipped.rows[0]);

  await post(app, cookie, `/accounts/${skipAcc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY });
  const after = await query<{ choice: string }>(
    `SELECT choice FROM onboarding_provider_choices WHERE account_id = $1 AND provider = 'klaviyo'`,
    [skipAcc],
  );
  check('connecting supersedes the skipped choice', after.rows[0]?.choice === 'pending',
    after.rows[0]);

  const status = await app.inject({
    method: 'GET', url: `/accounts/${skipAcc}/onboarding/status`,
    headers: { cookie }, remoteAddress: nextIp(),
  });
  const providers = (status.json() as { providers: { provider: string; state: string }[] }).providers;
  check('status now reports klaviyo as connected, not skipped',
    providers.find((p) => p.provider === 'klaviyo')?.state === 'connected', providers);
}

// ===========================================================================
// E. Status mapping matches the Shopify route
// ===========================================================================
async function groupE(app: App, cookie: string): Promise<void> {
  group('E', 'All three providers answer with the same status mapping');

  const acc = await makeAccount(app, cookie);

  // missing credentials -> 400
  for (const [label, url, payload] of [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`, {}],
    ['recharge', `/accounts/${acc}/connections/recharge`, {}],
    ['shopify', `/accounts/${acc}/connections/shopify/credentials`, { shopDomain: shopDomainFor(acc) }],
  ] as [string, string, unknown][]) {
    const res = await post(app, cookie, url, payload);
    check(`${label}: missing credentials -> 400 missing_credentials`,
      res.statusCode === 400 && (res.json() as { code?: string }).code === 'missing_credentials',
      `${res.statusCode} ${res.body.slice(0, 90)}`);
  }

  // non-string credential is treated as missing, not as a crash
  for (const [label, url, payload] of [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`, { apiKey: 12345 }],
    ['recharge', `/accounts/${acc}/connections/recharge`, { token: { nested: true } }],
  ] as [string, string, unknown][]) {
    const res = await post(app, cookie, url, payload);
    check(`${label}: a non-string credential is a clean 400`, res.statusCode === 400,
      `${res.statusCode} ${res.body.slice(0, 90)}`);
  }

  // verification failure -> 502, on all three
  failVerification = true;
  for (const [label, url, payload] of [
    ['klaviyo', `/accounts/${acc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY }],
    ['recharge', `/accounts/${acc}/connections/recharge`, { token: RECHARGE_TOKEN }],
    ['shopify', `/accounts/${acc}/connections/shopify/credentials`,
      { shopDomain: shopDomainFor(acc), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }],
  ] as [string, string, unknown][]) {
    const res = await post(app, cookie, url, payload);
    check(`${label}: verification failure -> 502`, res.statusCode === 502, res.statusCode);
  }
  failVerification = false;

  // bad / unknown account, on all three
  for (const [label, path] of [
    ['klaviyo', 'connections/klaviyo'], ['recharge', 'connections/recharge'],
    ['shopify', 'connections/shopify/credentials'],
  ] as [string, string][]) {
    const bad = await post(app, cookie, `/accounts/abc/${path}`, { apiKey: KLAVIYO_KEY, token: RECHARGE_TOKEN });
    check(`${label}: a non-numeric account id -> 400 bad_account_id`,
      bad.statusCode === 400 && (bad.json() as { error?: string }).error === 'bad_account_id',
      bad.body.slice(0, 90));
    const unknown = await post(app, cookie, `/accounts/99999999/${path}`, { apiKey: KLAVIYO_KEY, token: RECHARGE_TOKEN });
    check(`${label}: an unknown account -> 404 account_not_found`,
      unknown.statusCode === 404 && (unknown.json() as { error?: string }).error === 'account_not_found',
      unknown.body.slice(0, 90));
  }

  // success codes
  const queuedRes = await post(app, cookie, `/accounts/${acc}/connections/klaviyo`, { apiKey: KLAVIYO_KEY });
  check('a queued backfill answers 202 with queued:true',
    queuedRes.statusCode === 202 && (queuedRes.json() as { queued?: boolean }).queued === true,
    queuedRes.statusCode);
  check('the success body carries ok:true',
    (queuedRes.json() as { ok?: boolean }).ok === true);
}

// ===========================================================================
// F. Skip
// ===========================================================================
async function groupF(app: App, cookie: string): Promise<void> {
  group('F', 'Skipping records a choice and creates no connection');

  const acc = await makeAccount(app, cookie);

  // The browser sends a bodyless POST with no content-type. Fastify rejects a
  // bodyless request that still DECLARES json, so this shape matters.
  const bodyless = await app.inject({
    method: 'POST', url: `/accounts/${acc}/connections/klaviyo/skip`,
    headers: { cookie, accept: 'application/json' }, remoteAddress: nextIp(),
  });
  check('a bodyless skip with no content-type succeeds', bodyless.statusCode === 200,
    bodyless.statusCode);
  const body = bodyless.json() as { provider?: string; state?: string; providers?: unknown[] };
  check('it answers {provider, state:skipped, providers[]}',
    body.provider === 'klaviyo' && body.state === 'skipped' && Array.isArray(body.providers),
    body);

  const declaredJson = await app.inject({
    method: 'POST', url: `/accounts/${acc}/connections/recharge/skip`,
    headers: { cookie, 'content-type': 'application/json' }, remoteAddress: nextIp(),
  });
  check('declaring json with no body is rejected by Fastify, as expected',
    declaredJson.statusCode === 400, declaredJson.statusCode);

  check('skipping creates NO connection row',
    (await connectionRow(acc, 'klaviyo')).length === 0);
  const choice = await query<{ choice: string }>(
    `SELECT choice FROM onboarding_provider_choices WHERE account_id = $1 AND provider = 'klaviyo'`,
    [acc],
  );
  check('skipping records choice=skipped', choice.rows[0]?.choice === 'skipped');

  const repeat = await app.inject({
    method: 'POST', url: `/accounts/${acc}/connections/klaviyo/skip`,
    headers: { cookie }, remoteAddress: nextIp(),
  });
  check('skipping twice is idempotent', repeat.statusCode === 200);
  const rows = await query<{ n: string }>(
    `SELECT count(*) n FROM onboarding_provider_choices WHERE account_id = $1 AND provider = 'klaviyo'`,
    [acc],
  );
  check('and leaves exactly one choice row', Number(rows.rows[0]!.n) === 1);

  const badProvider = await app.inject({
    method: 'POST', url: `/accounts/${acc}/connections/stripe/skip`,
    headers: { cookie }, remoteAddress: nextIp(),
  });
  check('an unknown provider -> 400 bad_provider',
    badProvider.statusCode === 400
    && (badProvider.json() as { error?: string }).error === 'bad_provider', badProvider.body);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  console.log('\nCleanup');
  // starts_with(), never LIKE: `_` is a LIKE wildcard and this prefix starts
  // with two of them.
  const scoped = `(SELECT id FROM accounts WHERE starts_with(name, '${TEST_PREFIX}'))`;
  for (const table of ['connections', 'onboarding_provider_choices', 'onboarding_links']) {
    const res = await query(`DELETE FROM ${table} WHERE account_id IN ${scoped}`)
      .catch(() => ({ rowCount: 0 }));
    console.log(`  removed ${res.rowCount ?? 0} ${table} row(s)`);
  }
  const accts = await query(`DELETE FROM accounts WHERE starts_with(name, $1)`, [TEST_PREFIX]);
  const users = await query(`DELETE FROM users WHERE starts_with(email, $1)`, [TEST_PREFIX]);
  console.log(`  removed ${accts.rowCount ?? 0} synthetic account(s)`);
  console.log(`  removed ${users.rowCount ?? 0} synthetic user(s)`);

  // Queue keys. A BullMQ job id carries the numeric ACCOUNT ID, not the account
  // name, so a name-prefix filter matches nothing — every connect in this run
  // enqueues a backfill, and leaving those behind would hand real work to a
  // worker and leave Redis dirtier than the run found it.
  let removed = 0;
  for (const [queueName, jobPrefix] of [
    ['shopify-backfill', 'backfill'],
    ['recharge-backfill', 'recharge-backfill'],
    ['klaviyo-poll', 'klaviyo-backfill'],
  ] as [string, string][]) {
    for (const id of createdAccounts) {
      const keys = await redis.keys(`bull:${queueName}:*${jobPrefix}-${id}*`).catch(() => []);
      if (keys.length) {
        await redis.del(...keys).catch(() => undefined);
        removed += keys.length;
      }
    }
    // The queue's own structure keys, created merely by constructing a Queue.
    for (const k of ['meta', 'id', 'wait', 'events', 'marker']) {
      removed += await redis.del(`bull:${queueName}:${k}`).catch(() => 0);
    }
  }
  const rateKeys = await redis.keys('fastify-rate-limit-*').catch(() => [] as string[]);
  if (rateKeys.length) {
    await redis.del(...rateKeys).catch(() => undefined);
    removed += rateKeys.length;
  }
  console.log(`  removed ${removed} run-specific Redis key(s)`);

  const leftover = await redis.dbsize().catch(() => -1);
  console.log(`  redis DBSIZE now: ${leftover}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
installMockFetch();
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
} finally {
  await cleanup();
  await app.close();
  await pool.end();
  redis.disconnect();
}

console.log(`\n${'='.repeat(72)}`);
console.log('ACCOUNT-SCOPED CONNECTION RESULTS BY GROUP');
const TITLES: Record<string, string> = {
  A: 'Route surface',
  B: 'Authorization',
  C: 'Credential handling',
  D: 'Reconnect idempotency',
  E: 'Status mapping',
  F: 'Skip',
};
for (const [letter, totals] of Object.entries(groupTotals)) {
  console.log(`  ${totals.fail === 0 ? '✓' : '✗'} ${letter}. ${(TITLES[letter] ?? '').padEnd(24)}`
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
console.log('\n✓ ALL ACCOUNT-SCOPED CONNECTION CHECKS PASSED');
process.exit(0);

export {};
