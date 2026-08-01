/**
 * Account write-path verification (Phase 5B-2C, step 1).
 *
 *   A. Timezone normalizer — the pure function, exhaustively, including the
 *      offset forms ICU accepts but Postgres would misread.
 *   B. POST /accounts acceptance — a valid zone is stored, surrounding
 *      whitespace is handled, and the successful response contract is unchanged.
 *   C. POST /accounts rejection — every invalid shape is a fixed 400 that
 *      creates NO account and discloses no SQL, driver text or stack frame.
 *   D. Authorization — neither an anonymous caller nor a client onboarding-link
 *      session can create an account.
 *
 * Offline: no provider API is contacted and no real credential is used. Every
 * user and account created here is synthetic and removed on the way out.
 *
 * This suite is deliberately SEPARATE from verify:auth-security and
 * verify:onboarding rather than appended to either. Those two are established
 * regression baselines with fixed totals; folding new checks into them would
 * make a future "168 passed" or "464 passed" mean something different from what
 * it meant last week, which is how a baseline stops being one.
 *
 * Run: `npm run verify:accounts`
 */
process.env.APP_BASE_URL = 'http://localhost:5173';

const { default: bcrypt } = await import('bcryptjs');
const { pool, query } = await import('../src/db/pool.js');
const { buildApp } = await import('../src/index.js');
const { redis } = await import('../src/queue/queues.js');
const security = await import('../src/auth/security.js');
const { DEFAULT_STORE_TIMEZONE, normalizeStoreTimezone } =
  await import('../src/accounts/timezone.js');

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
  return `172.20.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

// ---------------------------------------------------------------------------
// Synthetic fixtures. Every name is obviously fake and shares one prefix so
// cleanup is exact; the password is a literal here and is never a real one.
// ---------------------------------------------------------------------------
const TEST_PREFIX = '__acctsec_';
const TEST_PASSWORD = 'acctsec-synthetic-password';

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of all) {
    const m = /^([^=]+)=([^;]*)/.exec(String(c));
    if (m && m[1] === name) return `${m[1]}=${m[2]}`;
  }
  return null;
}

const createdEmails: string[] = [];
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

/** A client onboarding-link principal (cookie tention_onb), for group D. */
async function onboardingCookie(app: App, agencyCookie: string, accountId: number): Promise<string> {
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

function post(app: App, cookie: string | null, payload: unknown) {
  return app.inject({
    method: 'POST', url: '/accounts', remoteAddress: nextIp(),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    payload: payload as never,
  });
}

async function countAccountsNamed(name: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT count(*) n FROM accounts WHERE name = $1', [name],
  );
  return Number(rows[0]!.n);
}

/**
 * Does a response body disclose implementation internals?
 *
 * Looks for the shapes that actually leak from this stack: pg driver and SQL
 * fragments, stack frames, absolute deploy paths, and Node module internals.
 */
function leaksInternals(body: string): boolean {
  return /\b(?:select|insert|update|delete)\s|relation |column |syntax error|pg_|postgres/i.test(body)
    || /(^|\\n)\s*at\s+\S/.test(body)
    || /:\d+:\d+/.test(body)
    || /\/(?:Users|home|var|opt|srv|etc|root)\//.test(body)
    || /node_modules|node:internal|Error:/.test(body);
}

// ===========================================================================
// A. The timezone normalizer, as a pure function
// ===========================================================================
function groupA(): void {
  group('A', 'Timezone normalizer (pure, no database)');

  // --- accepted -------------------------------------------------------
  for (const tz of [
    'America/Los_Angeles', 'UTC', 'Europe/London', 'Asia/Tokyo',
    'Australia/Sydney', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince',
    'Etc/GMT+5', 'Pacific/Auckland',
  ]) {
    check(`accepts ${tz}`, normalizeStoreTimezone(tz) !== null);
  }

  // --- rejected: the names the checkpoint names explicitly -------------
  for (const tz of ['Not/A_Timezone', 'America/Does_Not_Exist', 'Mars/Olympus_Mons',
    'America/Los_Angeles_Extra', 'Europe/Londonn']) {
    check(`rejects the invalid name ${JSON.stringify(tz)}`, normalizeStoreTimezone(tz) === null);
  }

  // --- rejected: empty and whitespace ----------------------------------
  for (const tz of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
    check(`rejects the empty/whitespace value ${JSON.stringify(tz)}`,
      normalizeStoreTimezone(tz) === null);
  }

  // --- rejected: non-strings -------------------------------------------
  const nonStrings: [string, unknown][] = [
    ['undefined', undefined], ['null', null], ['0', 0], ['1', 1], ['-1', -1], ['12.5', 12.5],
    ['NaN', NaN], ['true', true], ['false', false], ['{}', {}], ['[]', []],
    ["['UTC']", ['UTC']], ["{timeZone:'UTC'}", { timeZone: 'UTC' }],
    ['Symbol', Symbol('UTC')], ['a String object', new String('UTC')],
    ['a Date', new Date(0)], ['a function', () => 'UTC'],
  ];
  for (const [label, value] of nonStrings) {
    check(`rejects the non-string value ${label}`, normalizeStoreTimezone(value) === null);
  }

  // --- rejected: UTC offsets, which ICU accepts but are not zone names --
  // This is the check most likely to be lost in a refactor: every one of these
  // resolves without throwing inside Intl.DateTimeFormat.
  for (const tz of ['+05:30', '-08:00', '-0800', '+0530', '+00:00', '-00:00', '+5', '−08:00']) {
    check(`rejects the UTC offset ${JSON.stringify(tz)}`, normalizeStoreTimezone(tz) === null);
  }

  // --- rejected: injection-shaped and absurd input ----------------------
  for (const tz of [
    "UTC'; DROP TABLE accounts; --",
    'UTC; SELECT 1',
    '../../etc/passwd',
    'America/Los Angeles',
    'America/Los_Angeles\nEurope/London',
    '<script>alert(1)</script>',
    'A'.repeat(65),
    'America/'.repeat(20),
  ]) {
    check(`rejects hostile input ${JSON.stringify(tz.slice(0, 32))}`,
      normalizeStoreTimezone(tz) === null);
  }

  // --- trimming ---------------------------------------------------------
  check('trims leading whitespace', normalizeStoreTimezone('  UTC') === 'UTC');
  check('trims trailing whitespace', normalizeStoreTimezone('UTC  ') === 'UTC');
  check('trims both sides', normalizeStoreTimezone('  Europe/London  ') === 'Europe/London');
  check('trims tabs and newlines',
    normalizeStoreTimezone('\tAmerica/Los_Angeles\n') === 'America/Los_Angeles');
  check('trimming does not rescue an invalid name',
    normalizeStoreTimezone('  Not/A_Timezone  ') === null);

  // --- canonicalization, and its safety condition -----------------------
  check('canonicalizes case', normalizeStoreTimezone('america/los_angeles') === 'America/Los_Angeles');
  check('canonicalizes a link to its target',
    normalizeStoreTimezone('US/Pacific') === 'America/Los_Angeles');
  check('leaves an already-canonical name untouched',
    normalizeStoreTimezone('Europe/London') === 'Europe/London');

  // Whatever the engine returns must itself be storable — that is the whole
  // point of the fixed-point condition in the normalizer.
  for (const tz of ['UTC', 'GMT', 'US/Pacific', 'america/los_angeles', 'Etc/GMT+5',
    'Asia/Calcutta', 'Europe/Kyiv', 'EST5EDT']) {
    const out = normalizeStoreTimezone(tz);
    const stable = out !== null && normalizeStoreTimezone(out) === out;
    check(`the stored value for ${tz} is itself accepted (idempotent)`, stable, out);
  }

  check('the omitted-field default is itself a valid zone',
    normalizeStoreTimezone(DEFAULT_STORE_TIMEZONE) === DEFAULT_STORE_TIMEZONE);
  check('the omitted-field default matches the 001_init column default',
    DEFAULT_STORE_TIMEZONE === 'America/Los_Angeles');

  // Postgres must accept every value this function is willing to store. A name
  // ICU knows but Postgres does not would throw inside AT TIME ZONE later.
  check('normalizer never returns an empty or blank string', (() => {
    for (const tz of ['UTC', 'US/Pacific', 'america/los_angeles', 'Etc/GMT+5']) {
      const out = normalizeStoreTimezone(tz);
      if (typeof out !== 'string' || out.trim() === '') return false;
    }
    return true;
  })());
}

// ===========================================================================
// B. POST /accounts — acceptance
// ===========================================================================
async function groupB(app: App, cookie: string, keep: number[]): Promise<void> {
  group('B', 'POST /accounts stores a valid timezone');

  const okName = `${TEST_PREFIX}valid_${Date.now()}`;
  const okRes = await post(app, cookie, { name: okName, store_timezone: 'Europe/London' });
  check('a valid timezone returns 201', okRes.statusCode === 201, okRes.statusCode);
  const okBody = okRes.statusCode === 201 ? (okRes.json() as Record<string, unknown>) : {};
  if (typeof okBody.id === 'number') keep.push(okBody.id);

  check('the successful response contract is unchanged (id, name, store_timezone)',
    JSON.stringify(Object.keys(okBody).sort()) === JSON.stringify(['id', 'name', 'store_timezone']),
    Object.keys(okBody));
  check('the response echoes the accepted timezone', okBody.store_timezone === 'Europe/London');
  check('the response echoes the trimmed name', okBody.name === okName);
  check('the response id is a number', typeof okBody.id === 'number');

  const stored = await query<{ store_timezone: string; name: string }>(
    'SELECT name, store_timezone FROM accounts WHERE id = $1', [okBody.id],
  );
  check('the row is stored with the accepted timezone',
    stored.rows[0]?.store_timezone === 'Europe/London', stored.rows[0]);

  // --- whitespace -------------------------------------------------------
  const wsName = `${TEST_PREFIX}ws_${Date.now()}`;
  const wsRes = await post(app, cookie, { name: `  ${wsName}  `, store_timezone: '  Asia/Tokyo  ' });
  check('surrounding whitespace around a valid timezone is accepted', wsRes.statusCode === 201,
    wsRes.statusCode);
  const wsBody = wsRes.statusCode === 201 ? (wsRes.json() as Record<string, unknown>) : {};
  if (typeof wsBody.id === 'number') keep.push(wsBody.id);
  check('whitespace is trimmed before storage, not stored', wsBody.store_timezone === 'Asia/Tokyo',
    wsBody.store_timezone);
  check('the name is trimmed too', wsBody.name === wsName, wsBody.name);
  const wsStored = await query<{ store_timezone: string }>(
    'SELECT store_timezone FROM accounts WHERE id = $1', [wsBody.id],
  );
  check('the stored timezone has no surrounding whitespace',
    wsStored.rows[0]?.store_timezone === 'Asia/Tokyo', wsStored.rows[0]);

  // --- canonicalization over the wire -----------------------------------
  const canonName = `${TEST_PREFIX}canon_${Date.now()}`;
  const canonRes = await post(app, cookie, { name: canonName, store_timezone: 'us/pacific' });
  check('a link name in the wrong case is accepted', canonRes.statusCode === 201, canonRes.statusCode);
  const canonBody = canonRes.statusCode === 201 ? (canonRes.json() as Record<string, unknown>) : {};
  if (typeof canonBody.id === 'number') keep.push(canonBody.id);
  check('it is stored canonically', canonBody.store_timezone === 'America/Los_Angeles',
    canonBody.store_timezone);

  // --- the omitted field is not the same as an invalid one ---------------
  const omitName = `${TEST_PREFIX}omit_${Date.now()}`;
  const omitRes = await post(app, cookie, { name: omitName });
  check('an omitted store_timezone still succeeds (unchanged behaviour)',
    omitRes.statusCode === 201, omitRes.statusCode);
  const omitBody = omitRes.statusCode === 201 ? (omitRes.json() as Record<string, unknown>) : {};
  if (typeof omitBody.id === 'number') keep.push(omitBody.id);
  check('an omitted store_timezone uses the documented column default',
    omitBody.store_timezone === DEFAULT_STORE_TIMEZONE, omitBody.store_timezone);

  // --- unrelated fields are unaffected -----------------------------------
  const noName = await post(app, cookie, { store_timezone: 'UTC' });
  check('a missing name returns 400', noName.statusCode === 400, noName.statusCode);
  check('a missing name keeps its own error code',
    (noName.json() as { error?: string }).error === 'name required',
    noName.body);
  const blankName = await post(app, cookie, { name: '   ', store_timezone: 'UTC' });
  check('a whitespace-only name returns 400', blankName.statusCode === 400, blankName.statusCode);

  // A bad name AND a bad timezone: the name check runs first, unchanged.
  const bothBad = await post(app, cookie, { name: '  ', store_timezone: 'Not/A_Timezone' });
  check('name validation still precedes timezone validation',
    bothBad.statusCode === 400 && (bothBad.json() as { error?: string }).error === 'name required',
    bothBad.body);

  // The newly created rows must be visible through the read contract used by
  // the frontend, with exactly the five documented fields.
  const list = await app.inject({ method: 'GET', url: '/accounts', headers: { cookie },
    remoteAddress: nextIp() });
  const rows = list.json() as Record<string, unknown>[];
  const found = rows.find((r) => r.id === okBody.id);
  check('GET /accounts returns the new account', found !== undefined);
  check('GET /accounts exposes exactly the five documented fields',
    found !== undefined && JSON.stringify(Object.keys(found).sort())
      === JSON.stringify(['created_at', 'id', 'name', 'onboarding_complete', 'store_timezone']),
    found ? Object.keys(found) : null);
  check('onboarding_complete is a boolean', typeof found?.onboarding_complete === 'boolean');
  check('created_at serializes as a string', typeof found?.created_at === 'string');
}

// ===========================================================================
// C. POST /accounts — rejection
// ===========================================================================
async function groupC(app: App, cookie: string): Promise<void> {
  group('C', 'POST /accounts refuses an invalid timezone and creates nothing');

  interface Case { label: string; tz: unknown }
  const cases: Case[] = [
    { label: 'Not/A_Timezone', tz: 'Not/A_Timezone' },
    { label: 'America/Does_Not_Exist', tz: 'America/Does_Not_Exist' },
    { label: 'an empty string', tz: '' },
    { label: 'a whitespace-only string', tz: '   ' },
    { label: 'a tab-only string', tz: '\t' },
    { label: 'null', tz: null },
    { label: 'a number', tz: 5 },
    { label: 'a boolean', tz: true },
    { label: 'an array', tz: ['UTC'] },
    { label: 'an object', tz: { timeZone: 'UTC' } },
    { label: 'a UTC offset (+05:30)', tz: '+05:30' },
    { label: 'a UTC offset (-0800)', tz: '-0800' },
    { label: 'an over-long value', tz: `A${'a'.repeat(200)}` },
    { label: 'a SQL-shaped value', tz: "UTC'; DROP TABLE accounts; --" },
    { label: 'a NUL-terminated value', tz: 'UTC\u0000' },
  ];

  let seq = 0;
  for (const c of cases) {
    seq++;
    const name = `${TEST_PREFIX}reject_${Date.now()}_${seq}`;
    const res = await post(app, cookie, { name, store_timezone: c.tz });

    check(`${c.label} returns 400`, res.statusCode === 400, res.statusCode);
    check(`${c.label} returns the fixed machine-readable code`,
      res.body === JSON.stringify({ error: 'invalid_store_timezone' }), res.body);
    check(`${c.label} creates no account`, (await countAccountsNamed(name)) === 0);
    check(`${c.label} discloses no SQL, driver text or stack frame`,
      !leaksInternals(res.body), res.body);
    check(`${c.label} does not echo the submitted value`,
      typeof c.tz !== 'string' || c.tz.trim() === ''
        || !res.body.includes(c.tz.trim().slice(0, 12)),
      res.body);
  }

  // The rejection must be byte-identical across every reason, so the response
  // is not an oracle for which check failed.
  const bodies = new Set<string>();
  for (const tz of ['Not/A_Timezone', '', '   ', 5, null, '+05:30']) {
    const res = await post(app, cookie, { name: `${TEST_PREFIX}same_${Date.now()}`, store_timezone: tz });
    bodies.add(`${res.statusCode}|${res.body}`);
  }
  check('every rejection reason produces a byte-identical response', bodies.size === 1,
    [...bodies]);

  // And nothing at all was written by the whole group.
  const leftovers = await query<{ n: string }>(
    `SELECT count(*) n FROM accounts WHERE starts_with(name, $1)`, [`${TEST_PREFIX}reject_`],
  );
  check('the rejection cases left no rows behind', Number(leftovers.rows[0]!.n) === 0,
    leftovers.rows[0]);
  const sameLeftovers = await query<{ n: string }>(
    `SELECT count(*) n FROM accounts WHERE starts_with(name, $1)`, [`${TEST_PREFIX}same_`],
  );
  check('the byte-identity cases left no rows behind', Number(sameLeftovers.rows[0]!.n) === 0);

  // No invalid timezone reached the column by any route this suite exercised.
  const bad = await query<{ n: string }>(
    `SELECT count(*) n FROM accounts
      WHERE starts_with(name, $1) AND store_timezone NOT IN
            ('Europe/London','Asia/Tokyo','America/Los_Angeles')`, [TEST_PREFIX],
  );
  check('no synthetic account holds an unexpected timezone', Number(bad.rows[0]!.n) === 0,
    bad.rows[0]);
}

// ===========================================================================
// D. Authorization
// ===========================================================================
async function groupD(app: App, agencyCookie: string, keep: number[]): Promise<void> {
  group('D', 'Only an agency session may create an account');

  // --- anonymous ---------------------------------------------------------
  const anonName = `${TEST_PREFIX}anon_${Date.now()}`;
  const anon = await post(app, null, { name: anonName, store_timezone: 'UTC' });
  check('an unauthenticated request returns 401', anon.statusCode === 401, anon.statusCode);
  check('an unauthenticated request creates no account',
    (await countAccountsNamed(anonName)) === 0);
  check('the 401 discloses nothing about the request',
    !anon.body.includes('UTC') && !anon.body.includes(anonName) && !leaksInternals(anon.body),
    anon.body);

  // A garbage session cookie is not a session.
  const forgedName = `${TEST_PREFIX}forged_${Date.now()}`;
  const forged = await post(app, 'tention_sid=not-a-real-session', {
    name: forgedName, store_timezone: 'UTC',
  });
  check('a forged agency cookie returns 401', forged.statusCode === 401, forged.statusCode);
  check('a forged agency cookie creates no account',
    (await countAccountsNamed(forgedName)) === 0);

  // --- onboarding-link principal ------------------------------------------
  // The client onboarding session (cookie tention_onb) is a different principal
  // with a different decorator. It must not be able to mint brands.
  const hostRes = await post(app, agencyCookie, {
    name: `${TEST_PREFIX}linkhost_${Date.now()}`, store_timezone: 'UTC',
  });
  const hostId = (hostRes.json() as { id: number }).id;
  keep.push(hostId);
  const onbCookie = await onboardingCookie(app, agencyCookie, hostId);

  const onbName = `${TEST_PREFIX}onb_${Date.now()}`;
  const onb = await post(app, onbCookie, { name: onbName, store_timezone: 'UTC' });
  check('an onboarding-link session returns 401 from POST /accounts',
    onb.statusCode === 401, onb.statusCode);
  check('an onboarding-link session creates no account',
    (await countAccountsNamed(onbName)) === 0);
  check('an onboarding-link session cannot read GET /accounts either',
    (await app.inject({ method: 'GET', url: '/accounts', headers: { cookie: onbCookie },
      remoteAddress: nextIp() })).statusCode === 401);

  // Presenting the onboarding cookie alongside a valid agency cookie must not
  // downgrade the agency session, and vice versa — the two are disjoint.
  const bothName = `${TEST_PREFIX}both_${Date.now()}`;
  const both = await post(app, `${agencyCookie}; ${onbCookie}`, {
    name: bothName, store_timezone: 'UTC',
  });
  check('an agency session still works when an onboarding cookie is also present',
    both.statusCode === 201, both.statusCode);
  if (both.statusCode === 201) keep.push((both.json() as { id: number }).id);

  // An invalid timezone must be refused for an authenticated caller too — the
  // 401 above must not be the only thing standing between bad input and the DB.
  const authBadName = `${TEST_PREFIX}authbad_${Date.now()}`;
  const authBad = await post(app, agencyCookie, {
    name: authBadName, store_timezone: 'Not/A_Timezone',
  });
  check('an authenticated caller is still refused an invalid timezone',
    authBad.statusCode === 400
    && authBad.body === JSON.stringify({ error: 'invalid_store_timezone' }), authBad.body);
  check('that refusal creates no account', (await countAccountsNamed(authBadName)) === 0);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  console.log('\nCleanup');
  // starts_with, NOT LIKE. `_` is a LIKE wildcard matching any single
  // character, so `LIKE '__acctsec_%'` would also match an account named
  // "XYacctsecZ…". An over-broad DELETE against the accounts table is not a risk
  // worth carrying in a script that runs against a real database.
  const links = await query(
    `DELETE FROM onboarding_links WHERE account_id IN
       (SELECT id FROM accounts WHERE starts_with(name, $1))`, [TEST_PREFIX],
  ).catch(() => ({ rowCount: 0 }));
  const accts = await query(`DELETE FROM accounts WHERE starts_with(name, $1)`, [TEST_PREFIX]);
  const users = await query(`DELETE FROM users WHERE starts_with(email, $1)`, [TEST_PREFIX]);
  console.log(`  removed ${links.rowCount ?? 0} onboarding link(s)`);
  console.log(`  removed ${accts.rowCount ?? 0} synthetic account(s)`);
  console.log(`  removed ${users.rowCount ?? 0} synthetic user(s)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const app = buildApp();
await app.ready();

try {
  groupA();
  const cookie = await agencyLogin(app);
  const keep: number[] = [];
  await groupB(app, cookie, keep);
  await groupC(app, cookie);
  await groupD(app, cookie, keep);
} finally {
  await cleanup();
  await app.close();
  await pool.end();
  redis.disconnect();
}

console.log(`\n${'='.repeat(72)}`);
console.log('ACCOUNT WRITE-PATH RESULTS BY GROUP');
const TITLES: Record<string, string> = {
  A: 'Timezone normalizer',
  B: 'Valid timezone accepted',
  C: 'Invalid timezone refused',
  D: 'Authorization',
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
console.log('\n✓ ALL ACCOUNT WRITE-PATH CHECKS PASSED');
process.exit(0);

export {};
