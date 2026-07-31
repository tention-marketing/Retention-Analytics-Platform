/**
 * Agency authentication security verification (pre-Phase 5B-2B).
 *
 *   A. Password-comparison equality — the unknown-email path must do the same
 *      cryptographic work as the known-email path, proven by counting the
 *      comparisons rather than by timing a noisy CI box.
 *   B. Session fixation — a successful login must rotate the session id, and the
 *      pre-login id must never become authenticated.
 *   C. Cache policy — no authentication or session-state response may be stored.
 *   D. Content type — only JSON reaches the login handler.
 *   E. Request origin — a cross-origin browser request cannot drive login or
 *      logout with ambient cookies.
 *   F. Response allowlists — successful and failed responses expose nothing but
 *      the two safe fields, and failures stay byte-identical.
 *   G. Rate limiting — still engaged, still leaking nothing.
 *   H. Cookie isolation — agency and onboarding sessions remain disjoint.
 *
 * Offline: no provider API is contacted and no real credential is used. Every
 * user and account created here is synthetic and removed on the way out.
 *
 * Nothing in this file prints a submitted password, a password hash, or a
 * session cookie value.
 *
 * Run: `npm run verify:auth-security`
 */
process.env.APP_BASE_URL = 'http://localhost:5173';

const { default: bcrypt } = await import('bcryptjs');
const { pool, query } = await import('../src/db/pool.js');
const { buildApp } = await import('../src/index.js');
const { redis } = await import('../src/queue/queues.js');
const { config } = await import('../src/config.js');
const security = await import('../src/auth/security.js');

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
    groupTotals[currentGroup].pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    groupTotals[currentGroup].fail++;
    failed.push(`[${currentGroup}] ${name}`);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

let ipCounter = 0;
/** Unique client IP per request so ordinary traffic never trips the limiter. */
function nextIp(): string {
  ipCounter++;
  return `172.16.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

const RATE_LIMIT_PREFIX = 'fastify-rate-limit-';
async function clearRateLimit(ip: string): Promise<void> {
  const keys = await redis.keys(`${RATE_LIMIT_PREFIX}*${ip}`).catch(() => []);
  if (keys.length) await redis.del(...keys).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Synthetic fixtures. Emails are obviously fake and share one prefix so cleanup
// is exact; the password is a literal in this file and is never a real one.
// ---------------------------------------------------------------------------
const TEST_PREFIX = 'authsec_';
const TEST_PASSWORD = 'authsec-synthetic-password';
const WRONG_PASSWORD = 'authsec-wrong-password';
const SHORT_WRONG_PASSWORD = 'nope';

let userSeq = 0;
async function seedUser(): Promise<string> {
  userSeq++;
  const email = `${TEST_PREFIX}${Date.now()}_${userSeq}@example.invalid`;
  const hash = await bcrypt.hash(TEST_PASSWORD, security.BCRYPT_COST);
  await query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, hash],
  );
  return email;
}

function unknownEmail(): string {
  userSeq++;
  return `${TEST_PREFIX}ghost_${Date.now()}_${userSeq}@example.invalid`;
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

function setCookieList(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map(String);
}

const createdAccounts: number[] = [];
async function makeAccount(name: string): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO accounts (name) VALUES ($1) RETURNING id`,
    [`__authsec_${name}_${Date.now()}`],
  );
  createdAccounts.push(rows[0].id);
  return rows[0].id;
}

function login(app: App, email: string, password: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: { email, password },
  });
}

// ===========================================================================
// A. Password-comparison equality
// ===========================================================================
async function groupA(app: App): Promise<void> {
  group('A', 'Credential verification does equal work on every path');

  const meta = security.describeDummyHash();
  check('dummy hash uses the bcrypt algorithm', meta.algorithm === '$2a' || meta.algorithm === '$2b',
    meta.algorithm);
  check(`dummy hash cost matches stored hashes (${security.BCRYPT_COST})`,
    meta.cost === security.BCRYPT_COST, meta.cost);
  check('dummy hash is a full-length bcrypt digest (60 chars)', meta.digestLength === 60,
    meta.digestLength);

  // A real stored hash, for cost comparison. Never printed.
  const storedMeta = bcrypt.getRounds(await bcrypt.hash('x'.repeat(12), security.BCRYPT_COST));
  check('a freshly stored hash has the same cost as the dummy', storedMeta === meta.cost);

  // --- comparison call counting ---------------------------------------
  // The seam in auth/security.ts lets the real bcrypt call be wrapped in a
  // counter. Timing cannot prove a call count; this can.
  const original = security.passwordVerifier.compare;
  let calls: { hashLength: number }[] = [];
  security.passwordVerifier.compare = async (plain: string, hash: string) => {
    calls.push({ hashLength: hash.length });
    return original(plain, hash);
  };

  const known = await seedUser();
  const ghost = unknownEmail();

  async function countFor(label: string, email: string, password: string): Promise<number> {
    calls = [];
    await login(app, email, password);
    void label;
    return calls.length;
  }

  try {
    check('existing email + wrong password performs exactly one comparison',
      (await countFor('wrong', known, WRONG_PASSWORD)) === 1);
    check('unknown email performs exactly one comparison',
      (await countFor('ghost', ghost, WRONG_PASSWORD)) === 1);
    check('short wrong password performs exactly one comparison',
      (await countFor('short', known, SHORT_WRONG_PASSWORD)) === 1);
    check('correct credentials perform exactly one comparison',
      (await countFor('good', known, TEST_PASSWORD)) === 1);

    // The unknown-email comparison must be against a full-length digest, which
    // is what makes it cost the same. This is the exact regression that was
    // live before this checkpoint: the old dummy was 52 chars and bcryptjs
    // rejected it without deriving a key.
    calls = [];
    await login(app, unknownEmail(), WRONG_PASSWORD);
    check('unknown-email comparison uses a full-length (60 char) digest',
      calls.length === 1 && calls[0]!.hashLength === 60, calls);

    calls = [];
    const malformed = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
      headers: { 'content-type': 'application/json' },
      payload: { email: known },
    });
    check('a malformed request never enters credential verification',
      calls.length === 0 && malformed.statusCode === 400, { calls: calls.length, status: malformed.statusCode });

    calls = [];
    const emptyBody = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
      headers: { 'content-type': 'application/json' }, payload: {},
    });
    check('an empty body never enters credential verification',
      calls.length === 0 && emptyBody.statusCode === 400, { calls: calls.length });
  } finally {
    security.passwordVerifier.compare = original;
  }

  // --- direct unit behaviour of verifyCredential ------------------------
  const realHash = await bcrypt.hash(TEST_PASSWORD, security.BCRYPT_COST);
  check('verifyCredential accepts the right password against a stored hash',
    (await security.verifyCredential(TEST_PASSWORD, realHash)) === true);
  check('verifyCredential rejects a wrong password against a stored hash',
    (await security.verifyCredential(WRONG_PASSWORD, realHash)) === false);
  check('verifyCredential rejects any password when there is no stored hash',
    (await security.verifyCredential(TEST_PASSWORD, null)) === false);

  // --- secondary, advisory timing evidence -----------------------------
  // Deliberately NOT the regression test: wall-clock timing is noisy. The call
  // counts above are the proof; this is corroboration.
  async function medianMs(email: string): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      await login(app, email, WRONG_PASSWORD);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return samples[2]!;
  }
  const knownMs = await medianMs(known);
  const ghostMs = await medianMs(unknownEmail());
  const ratio = Math.max(knownMs, ghostMs) / Math.max(1, Math.min(knownMs, ghostMs));
  console.log(`    (advisory: known ${knownMs.toFixed(1)}ms vs unknown ${ghostMs.toFixed(1)}ms, ratio ${ratio.toFixed(2)}x)`);
  check('advisory timing: known and unknown emails are within 3x of each other',
    ratio < 3, { knownMs: knownMs.toFixed(1), ghostMs: ghostMs.toFixed(1) });
}

// ===========================================================================
// B. Session fixation
// ===========================================================================
async function groupB(app: App): Promise<void> {
  group('B', 'Session rotation on login (fixation)');

  // Structural proof first: saveUninitialized=false means an unauthenticated
  // request is issued no session cookie at all, so there is normally nothing to
  // fixate. Rotation is defence in depth on top of that.
  const anon = await app.inject({ method: 'GET', url: '/auth/me', remoteAddress: nextIp() });
  check('an unauthenticated request is issued NO agency cookie (saveUninitialized=false)',
    anon.statusCode === 401 && cookieFrom(anon, 'tention_sid') === null,
    setCookieList(anon));

  const email = await seedUser();

  // A pre-authentication cookie an attacker might have planted.
  const planted = 'tention_sid=attacker-planted-session-identifier';
  const good = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json', cookie: planted },
    payload: { email, password: TEST_PASSWORD },
  });
  check('login succeeds', good.statusCode === 200, good.statusCode);

  const issued = cookieFrom(good, 'tention_sid');
  check('login issues a session cookie', issued !== null);
  check('the issued session id is NOT the planted one', issued !== planted);
  check('the issued session id is not a prefix-match of the planted one',
    issued !== null && !issued.includes('attacker-planted-session-identifier'));

  check('the planted pre-authentication id cannot authenticate',
    (await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: planted },
    })).statusCode === 401);
  check('the newly issued id authenticates',
    (await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: issued! },
    })).statusCode === 200);

  // Two successive logins must not reuse an id.
  const second = await login(app, email, TEST_PASSWORD);
  const secondCookie = cookieFrom(second, 'tention_sid');
  check('a second login issues a different session id again',
    secondCookie !== null && secondCookie !== issued, { same: secondCookie === issued });

  // Failed login must create nothing.
  const badLogin = await login(app, email, WRONG_PASSWORD);
  check('a failed login returns 401', badLogin.statusCode === 401);
  check('a failed login issues no session cookie',
    cookieFrom(badLogin, 'tention_sid') === null, setCookieList(badLogin));
  const ghostLogin = await login(app, unknownEmail(), WRONG_PASSWORD);
  check('a failed login for an unknown email issues no session cookie',
    cookieFrom(ghostLogin, 'tention_sid') === null, setCookieList(ghostLogin));

  // Rotation must not disturb an onboarding session in another tab.
  const acc = await makeAccount('rotation');
  const links = await import('../src/onboarding/links.js');
  const minted = await links.mintOnboardingLink(acc, null);
  const exchanged = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    payload: { token: minted.token },
  });
  const onbCookie = cookieFrom(exchanged, 'tention_onb');
  check('an onboarding session can be established', onbCookie !== null);

  const bothBefore = `${issued}; ${onbCookie}`;
  const rotateWithBoth = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json', cookie: bothBefore },
    payload: { email, password: TEST_PASSWORD },
  });
  check('logging in while an onboarding session exists still succeeds',
    rotateWithBoth.statusCode === 200);
  check('agency rotation emits no directive for the onboarding cookie',
    !setCookieList(rotateWithBoth).some((c) => c.startsWith('tention_onb=')),
    setCookieList(rotateWithBoth));
  check('the onboarding session still authenticates after agency rotation',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', remoteAddress: nextIp(), headers: { cookie: onbCookie! },
    })).statusCode === 200);

  // Logout isolation, both directions.
  const rotated = cookieFrom(rotateWithBoth, 'tention_sid')!;
  const agencyLogout = await app.inject({
    method: 'POST', url: '/auth/logout', remoteAddress: nextIp(),
    headers: { cookie: `${rotated}; ${onbCookie}` },
  });
  check('agency logout succeeds', agencyLogout.statusCode === 200);
  check('agency logout emits no directive for the onboarding cookie',
    !setCookieList(agencyLogout).some((c) => c.startsWith('tention_onb=')));
  check('agency logout invalidates the agency session',
    (await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: rotated },
    })).statusCode === 401);
  check('agency logout leaves the onboarding session working',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', remoteAddress: nextIp(), headers: { cookie: onbCookie! },
    })).statusCode === 200);

  const stillAgency = await login(app, email, TEST_PASSWORD);
  const agencyCookie2 = cookieFrom(stillAgency, 'tention_sid')!;
  const onbLogout = await app.inject({
    method: 'POST', url: '/onboarding/logout', remoteAddress: nextIp(),
    headers: { cookie: `${agencyCookie2}; ${onbCookie}` },
  });
  check('onboarding logout succeeds', onbLogout.statusCode === 200);
  check('onboarding logout DOES clear the onboarding cookie',
    setCookieList(onbLogout).some((c) => /^tention_onb=;/.test(c) || (/^tention_onb=/.test(c) && /Max-Age=0/i.test(c))));
  // @fastify/session refreshes a live agency cookie's expiry on any request that
  // carries it, so a `tention_sid` directive may legitimately appear here. What
  // must never appear is a CLEARING directive — an empty value or Max-Age=0.
  check('onboarding logout emits no CLEARING directive for the agency cookie',
    !setCookieList(onbLogout).some(
      (c) => /^tention_sid=;/.test(c) || (/^tention_sid=/.test(c) && /Max-Age=0/i.test(c))),
    setCookieList(onbLogout).map((c) => c.replace(/=[^;]*/, '=<redacted>')));
  check('onboarding logout leaves the agency session working',
    (await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: agencyCookie2 },
    })).statusCode === 200);
}

// ===========================================================================
// C. Cache policy
// ===========================================================================
async function groupC(app: App): Promise<void> {
  group('C', 'Authentication responses are never stored');

  const email = await seedUser();
  const session = cookieFrom(await login(app, email, TEST_PASSWORD), 'tention_sid')!;

  const rlIp = '172.31.0.5';
  await clearRateLimit(rlIp);
  let limited = null as null | Awaited<ReturnType<App['inject']>>;
  for (let i = 0; i < 14; i++) {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: rlIp,
      headers: { 'content-type': 'application/json' },
      payload: { email, password: WRONG_PASSWORD },
    });
    if (res.statusCode === 429) { limited = res; break; }
  }

  const cases: [string, Awaited<ReturnType<App['inject']>>][] = [
    ['successful login', await login(app, email, TEST_PASSWORD)],
    ['failed login', await login(app, email, WRONG_PASSWORD)],
    ['malformed login', await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
      headers: { 'content-type': 'application/json' }, payload: {},
    })],
    ['authenticated /auth/me', await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: session },
    })],
    ['unauthenticated /auth/me', await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(),
    })],
    ['successful logout', await app.inject({
      method: 'POST', url: '/auth/logout', remoteAddress: nextIp(), headers: { cookie: session },
    })],
    ['already-logged-out logout', await app.inject({
      method: 'POST', url: '/auth/logout', remoteAddress: nextIp(),
    })],
  ];
  if (limited) cases.push(['rate-limited 429', limited]);

  for (const [label, res] of cases) {
    const cc = String(res.headers['cache-control'] ?? '');
    check(`${label}: Cache-Control includes no-store`, cc.includes('no-store'), cc || '(absent)');
  }
  check('the 429 case was actually reached and asserted', limited !== null);
  check('Pragma: no-cache accompanies it for HTTP/1.0 intermediaries',
    String(cases[0]![1].headers['pragma'] ?? '') === 'no-cache', cases[0]![1].headers['pragma']);
  check('no conflicting cache directive is set alongside no-store',
    !String(cases[0]![1].headers['cache-control'] ?? '').includes('max-age='),
    cases[0]![1].headers['cache-control']);
  check('the 429 keeps its Retry-After header despite the cache hook',
    limited !== null && limited.headers['retry-after'] !== undefined,
    limited?.headers['retry-after']);

  await clearRateLimit(rlIp);
}

// ===========================================================================
// D. Content type
// ===========================================================================
async function groupD(app: App): Promise<void> {
  group('D', 'Only JSON reaches the login handler');

  const email = await seedUser();
  const form = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(TEST_PASSWORD)}`;

  check('intended JSON login works',
    (await login(app, email, TEST_PASSWORD)).statusCode === 200);
  check('application/json with a charset parameter is accepted',
    (await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    })).statusCode === 200);

  for (const [label, ct, body] of [
    ['form-urlencoded', 'application/x-www-form-urlencoded', form],
    ['text/plain', 'text/plain', JSON.stringify({ email, password: TEST_PASSWORD })],
    ['multipart/form-data', 'multipart/form-data; boundary=zzz', form],
    ['application/xml', 'application/xml', '<login/>'],
  ] as [string, string, string][]) {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
      headers: { 'content-type': ct }, payload: body,
    });
    check(`${label} login is refused with 415`, res.statusCode === 415, res.statusCode);
    check(`${label} refusal does not authenticate`, cookieFrom(res, 'tention_sid') === null);
    check(`${label} refusal echoes no credential`,
      !res.body.includes(email) && !res.body.includes(TEST_PASSWORD), res.body.slice(0, 80));
  }

  const badJson = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' },
    payload: `{"email":"${email}","password":"${TEST_PASSWORD}"`,
  });
  check('malformed JSON returns a safe 400', badJson.statusCode === 400, badJson.statusCode);
  check('the malformed-JSON body contains no submitted password',
    !badJson.body.includes(TEST_PASSWORD), badJson.body.slice(0, 90));
  check('the malformed-JSON body contains no stack trace',
    !badJson.body.includes('at ') && !badJson.body.includes('/Users/'));

  // Logout carries no body, so it must not be forced to declare a content type.
  check('logout with no body and no content-type is accepted',
    (await app.inject({ method: 'POST', url: '/auth/logout', remoteAddress: nextIp() })).statusCode === 200);
  check('logout with a text/plain body is refused',
    (await app.inject({
      method: 'POST', url: '/auth/logout', remoteAddress: nextIp(),
      headers: { 'content-type': 'text/plain' }, payload: 'x',
    })).statusCode === 415);
}

// ===========================================================================
// E. Request origin
// ===========================================================================
async function groupE(app: App): Promise<void> {
  group('E', 'Cross-origin auth requests are refused');

  const email = await seedUser();
  const trusted = config.appOrigin;
  check('the trusted origin is derived from APP_BASE_URL',
    trusted === 'http://localhost:5173', trusted);

  check('first-party-origin JSON login succeeds',
    (await login(app, email, TEST_PASSWORD, { origin: trusted })).statusCode === 200);
  check('a first-party same-origin fetch (Sec-Fetch-Site) succeeds',
    (await login(app, email, TEST_PASSWORD, {
      origin: trusted, 'sec-fetch-site': 'same-origin',
    })).statusCode === 200);
  check('a request with no Origin at all still succeeds (non-browser client)',
    (await login(app, email, TEST_PASSWORD)).statusCode === 200);

  for (const [label, headers] of [
    ['evil.example origin', { origin: 'https://evil.example' }],
    ['opaque null origin', { origin: 'null' }],
    ['look-alike origin', { origin: 'http://localhost:5173.evil.example' }],
    ['trusted host, wrong scheme', { origin: 'https://localhost:5173' }],
    ['trusted host, wrong port', { origin: 'http://localhost:5174' }],
    ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }],
    ['same-site (sibling subdomain) fetch', { 'sec-fetch-site': 'same-site' }],
  ] as [string, Record<string, string>][]) {
    const res = await login(app, email, TEST_PASSWORD, headers);
    check(`login from ${label} is refused with 403`, res.statusCode === 403, res.statusCode);
    check(`login from ${label} issues no session`, cookieFrom(res, 'tention_sid') === null);
    check(`login from ${label} reveals no email or password`,
      !res.body.includes(email) && !res.body.includes(TEST_PASSWORD), res.body.slice(0, 80));
  }

  // Cross-origin logout must not be able to destroy a live session.
  const session = cookieFrom(await login(app, email, TEST_PASSWORD), 'tention_sid')!;
  const evilLogout = await app.inject({
    method: 'POST', url: '/auth/logout', remoteAddress: nextIp(),
    headers: { cookie: session, origin: 'https://evil.example' },
  });
  check('cross-origin logout is refused with 403', evilLogout.statusCode === 403, evilLogout.statusCode);
  check('a refused cross-origin logout did NOT destroy the session',
    (await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: session },
    })).statusCode === 200);

  check('no GET /auth/logout route exists',
    (await app.inject({ method: 'GET', url: '/auth/logout', remoteAddress: nextIp() })).statusCode === 404);

  // Forwarded headers must not be able to nominate a trusted origin.
  const forged = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      'x-forwarded-host': 'localhost:5173',
      'x-forwarded-proto': 'http',
      host: 'localhost:5173',
    },
    payload: { email, password: TEST_PASSWORD },
  });
  check('X-Forwarded-Host / X-Forwarded-Proto cannot whitelist an evil origin',
    forged.statusCode === 403, forged.statusCode);

  // No credentialed CORS is available to a browser.
  const preflight = await app.inject({
    method: 'OPTIONS', url: '/auth/login', remoteAddress: nextIp(),
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  check('no CORS preflight is answered for login',
    preflight.headers['access-control-allow-origin'] === undefined, preflight.headers['access-control-allow-origin']);
  check('no credentialed CORS header is emitted on a normal response',
    (await login(app, email, TEST_PASSWORD, { origin: trusted }))
      .headers['access-control-allow-credentials'] === undefined);

  // Direct unit coverage of the classifier.
  check('classifier: missing origin is allowed as a non-browser client',
    security.classifyRequestOrigin({}).allowed === true);
  check('classifier: trusted origin is allowed',
    security.classifyRequestOrigin({ origin: trusted }).allowed === true);
  check('classifier: unknown origin is refused',
    security.classifyRequestOrigin({ origin: 'https://evil.example' }).allowed === false);
  check('classifier: cross-site fetch is refused even with no Origin',
    security.classifyRequestOrigin({ 'sec-fetch-site': 'cross-site' }).allowed === false);
}

// ===========================================================================
// F. Response allowlists
// ===========================================================================
async function groupF(app: App): Promise<void> {
  group('F', 'Auth responses expose only safe fields');

  const email = await seedUser();
  const ok = await login(app, email, TEST_PASSWORD);
  const body = ok.json() as Record<string, unknown>;

  check('successful login returns exactly { id, email }',
    JSON.stringify(Object.keys(body).sort()) === '["email","id"]', Object.keys(body));
  check('login id is a number', typeof body.id === 'number');
  check('login email matches the submitted address', body.email === email);

  const session = cookieFrom(ok, 'tention_sid')!;
  const me = await app.inject({
    method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: session },
  });
  const meBody = me.json() as Record<string, unknown>;
  check('/auth/me returns exactly { id, email }',
    JSON.stringify(Object.keys(meBody).sort()) === '["email","id"]', Object.keys(meBody));

  const FORBIDDEN = [
    'password', 'passwordHash', 'password_hash', 'role', 'permissions', 'accountIds',
    'organization', 'accessToken', 'refreshToken', 'sessionId', 'sid', 'cookie', 'redis',
    'created_at', '$2a$', '$2b$',
  ];
  for (const field of FORBIDDEN) {
    check(`login response contains no "${field}"`, !ok.body.includes(field), ok.body);
    check(`/auth/me response contains no "${field}"`, !me.body.includes(field), me.body);
  }
  check('login response does not contain the session cookie value',
    !ok.body.includes(session.split('=')[1]!.slice(0, 12)));

  // Generic, byte-identical failures.
  const wrong = await login(app, email, WRONG_PASSWORD);
  const ghost = await login(app, unknownEmail(), WRONG_PASSWORD);
  const short = await login(app, email, SHORT_WRONG_PASSWORD);
  check('wrong password returns 401', wrong.statusCode === 401);
  check('unknown email returns 401', ghost.statusCode === 401);
  check('short wrong password returns 401', short.statusCode === 401);
  check('wrong password and unknown email are byte-identical',
    wrong.body === ghost.body, { wrong: wrong.body, ghost: ghost.body });
  check('short wrong password is byte-identical to the others',
    short.body === wrong.body, short.body);
  check('no failure response echoes the submitted email',
    !wrong.body.includes(email) && !ghost.body.includes(email) && !short.body.includes(email));
  check('no failure response echoes the submitted password',
    !wrong.body.includes(WRONG_PASSWORD) && !short.body.includes(SHORT_WRONG_PASSWORD));

  const missingField = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json' }, payload: { email },
  });
  check('a missing field remains a generic 400', missingField.statusCode === 400);
  check('the 400 echoes no email', !missingField.body.includes(email), missingField.body);
}

// ===========================================================================
// G. Rate limiting
// ===========================================================================
async function groupG(app: App): Promise<void> {
  group('G', 'Login rate limiting is intact');

  const email = await seedUser();
  const rlIp = '172.31.9.9';
  const otherIp = '172.31.9.10';
  await clearRateLimit(rlIp);
  await clearRateLimit(otherIp);

  let firstLimited = 0;
  for (let i = 1; i <= 15; i++) {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: rlIp,
      headers: { 'content-type': 'application/json' },
      payload: { email, password: WRONG_PASSWORD },
    });
    if (res.statusCode === 429) { firstLimited = i; break; }
  }
  check('repeated attempts from one source reach 429', firstLimited > 0, firstLimited);
  check('the limit still allows at least 10 attempts before engaging',
    firstLimited >= 10, firstLimited);

  const limited = await app.inject({
    method: 'POST', url: '/auth/login', remoteAddress: rlIp,
    headers: { 'content-type': 'application/json' },
    payload: { email, password: TEST_PASSWORD },
  });
  check('a correct password is still throttled once the limit engages',
    limited.statusCode === 429, limited.statusCode);
  check('the 429 body echoes no email or password',
    !limited.body.includes(email) && !limited.body.includes(TEST_PASSWORD), limited.body);
  check('the 429 body exposes no Redis or stack detail',
    !limited.body.includes('redis') && !limited.body.includes('at ')
    && !limited.body.includes('/Users/'), limited.body);
  check('the 429 issues no session cookie', cookieFrom(limited, 'tention_sid') === null);

  check('a different source is not collaterally blocked',
    (await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: otherIp,
      headers: { 'content-type': 'application/json' },
      payload: { email, password: TEST_PASSWORD },
    })).statusCode === 200);

  // A refused request must not consume budget by reaching the limiter's counter
  // in a way that helps an attacker, nor bypass it to reach the handler.
  const beforeKeys = (await redis.keys(`${RATE_LIMIT_PREFIX}*${otherIp}`)).length;
  check('the limiter counter is Redis-backed', beforeKeys > 0);

  await clearRateLimit(rlIp);
  await clearRateLimit(otherIp);
}

// ===========================================================================
// H. Cookie attributes and isolation
// ===========================================================================
async function groupH(app: App): Promise<void> {
  group('H', 'Cookie attributes and agency/onboarding isolation');

  const email = await seedUser();
  const res = await login(app, email, TEST_PASSWORD);
  const directive = setCookieList(res).find((c) => c.startsWith('tention_sid='))!;

  check('agency login sets exactly one cookie', setCookieList(res).length === 1, setCookieList(res).length);
  check('agency cookie is HttpOnly', /HttpOnly/i.test(directive));
  check('agency cookie is SameSite=Lax or stricter',
    /SameSite=(Lax|Strict)/i.test(directive), directive.replace(/=[^;]*/, '=<redacted>'));
  check('agency cookie is Path=/', /Path=\//.test(directive));
  check('config.isProd is false in this run, so Secure must be absent',
    config.isProd === false);
  check('agency cookie omits Secure in development', !/Secure/i.test(directive));

  const acc = await makeAccount('cookies');
  const links = await import('../src/onboarding/links.js');
  const minted = await links.mintOnboardingLink(acc, null);
  const exchanged = await app.inject({
    method: 'POST', url: '/onboarding/session', remoteAddress: nextIp(),
    payload: { token: minted.token },
  });
  check('token exchange sets only the onboarding cookie',
    setCookieList(exchanged).some((c) => c.startsWith('tention_onb='))
    && !setCookieList(exchanged).some((c) => c.startsWith('tention_sid=')));

  const onbCookie = cookieFrom(exchanged, 'tention_onb')!;
  check('an onboarding-only session cannot call GET /auth/me',
    (await app.inject({
      method: 'GET', url: '/auth/me', remoteAddress: nextIp(), headers: { cookie: onbCookie },
    })).statusCode === 401);
  const agencyCookie = cookieFrom(res, 'tention_sid')!;
  check('an agency-only session cannot call GET /onboarding/me',
    (await app.inject({
      method: 'GET', url: '/onboarding/me', remoteAddress: nextIp(), headers: { cookie: agencyCookie },
    })).statusCode === 401);
  check('an agency-only session cannot call POST /onboarding/logout',
    (await app.inject({
      method: 'POST', url: '/onboarding/logout', remoteAddress: nextIp(),
      headers: { cookie: agencyCookie },
    })).statusCode === 401);
}

// ===========================================================================
// Main
// ===========================================================================
async function cleanup(): Promise<void> {
  console.log('\nCleanup');

  const ACCOUNT_TABLES = [
    'ad_spend_zero_months', 'onboarding_provider_choices', 'onboarding_links',
    'ad_spend', 'sku_costs', 'account_costs', 'connections', 'sync_errors',
  ];
  for (const id of createdAccounts) {
    for (const t of ACCOUNT_TABLES) {
      await query(`DELETE FROM ${t} WHERE account_id = $1`, [id]).catch(() => undefined);
    }
    await query(`DELETE FROM accounts WHERE id = $1`, [id]).catch(() => undefined);
  }
  console.log(`  removed ${createdAccounts.length} throwaway account(s)`);

  const users = await query(`DELETE FROM users WHERE email LIKE '${TEST_PREFIX}%'`)
    .catch(() => ({ rowCount: 0 }));
  console.log(`  removed ${users.rowCount ?? 0} synthetic user(s)`);

  const rlKeys = await redis.keys(`${RATE_LIMIT_PREFIX}*`).catch(() => []);
  if (rlKeys.length) await redis.del(...rlKeys).catch(() => undefined);
  console.log(`  cleared ${rlKeys.length} rate-limit counter(s)`);
}

async function main(): Promise<void> {
  console.log('Agency authentication security verification (offline; no provider API is contacted)');

  const app = buildApp();
  await app.ready();

  try {
    await groupA(app);
    await groupB(app);
    await groupC(app);
    await groupD(app);
    await groupE(app);
    await groupF(app);
    await groupG(app);
    await groupH(app);
  } finally {
    await cleanup();
    await app.close();
  }

  console.log('\n' + '='.repeat(72));
  console.log('AGENCY AUTH SECURITY RESULTS BY GROUP');
  const titles: Record<string, string> = {
    A: 'Credential timing equality', B: 'Session rotation', C: 'No-store cache policy',
    D: 'Content-type enforcement', E: 'Cross-origin protection', F: 'Response allowlists',
    G: 'Rate limiting', H: 'Cookie isolation',
  };
  for (const [letter, t] of Object.entries(groupTotals)) {
    const mark = t.fail === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${letter}. ${(titles[letter] ?? '').padEnd(28)} ${t.pass} passed, ${t.fail} failed`);
  }
  console.log('='.repeat(72));
  console.log(`TOTAL: ${passed} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('\nFAILED CHECKS:');
    for (const f of failed) console.log(`  ✗ ${f}`);
  }
  console.log(failures === 0 ? '\n✓ ALL AUTH SECURITY CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);

  await pool.end();
  await redis.quit().catch(() => undefined);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nFATAL:', err);
  await cleanup().catch(() => undefined);
  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(1);
});

export {};
