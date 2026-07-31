import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply } from 'fastify';
import { config } from '../config.js';

// Shared agency-authentication security primitives.
//
// Extracted into one module so the rules below have a single implementation and
// a single place to be tested, rather than being re-derived inline in each
// route handler where one of them can quietly go missing.

// ---------------------------------------------------------------------------
// 1. Password verification with equal work on every path
// ---------------------------------------------------------------------------

/** Cost factor for every password hash this system writes. */
export const BCRYPT_COST = 10;

/**
 * Dummy hash compared against when the submitted email matches no user.
 *
 * WHY THIS EXISTS: bcrypt comparison is deliberately expensive (~48 ms at cost
 * 10). If the unknown-email branch skips that work, the response comes back
 * measurably sooner, and an unauthenticated attacker can enumerate which email
 * addresses have agency accounts purely from response latency — without ever
 * guessing a password. So the unknown-email path must perform the same
 * cryptographic work as the known-email path.
 *
 * THIS REPLACED A BROKEN VERSION. The previous code compared against the string
 * literal `'$2a$10$invalidinvalid…'`, which is only 45 characters after the cost
 * prefix where a real bcrypt digest is 53. bcryptjs rejects a malformed digest
 * immediately instead of deriving a key, so that comparison took 0.015 ms
 * against 48 ms for a real one — a ~3000x difference, and a wide-open
 * enumeration oracle sitting directly beneath a comment claiming it was closed.
 * Length matters here, so the value is generated rather than written by hand.
 *
 * Properties that make this safe:
 *   - computed ONCE at module load, never per request;
 *   - a real bcrypt digest at the same cost factor as stored hashes, so the
 *     comparison performs genuinely equivalent work;
 *   - derived from 32 random bytes, so no submitted password can ever match it
 *     (and verifyCredential ignores the result on this path regardless);
 *   - not a secret. It protects nothing; it only burns the right amount of CPU.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomBytes(32).toString('base64'), BCRYPT_COST);

/**
 * Indirection seam for the bcrypt comparison.
 *
 * Verification needs to prove *how many times* the comparison runs on each
 * code path — one call for a known email, one for an unknown one — and a
 * timing measurement cannot prove that on noisy CI. Routing every comparison
 * through this object lets a test substitute a counting implementation. It is
 * never replaced in production.
 */
export const passwordVerifier = {
  compare: (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash),
};

/**
 * Verify a submitted password against a stored hash, or against the dummy hash
 * when no user was found.
 *
 * EXACTLY ONE comparison happens on every path, including the unknown-user
 * path. The `storedHash === null` re-check means an unknown user is rejected
 * even in the impossible case that the dummy hash matched.
 *
 * Callers must not branch on user existence before calling this — that branch
 * is what reintroduces the timing difference.
 */
export async function verifyCredential(
  submittedPassword: string,
  storedHash: string | null,
): Promise<boolean> {
  const matched = await passwordVerifier.compare(
    submittedPassword,
    storedHash ?? DUMMY_PASSWORD_HASH,
  );
  return storedHash !== null && matched;
}

/**
 * Cost/algorithm metadata for the dummy hash, so tests can assert equivalence
 * with stored hashes WITHOUT the hash value ever being returned or printed.
 */
export function describeDummyHash(): { algorithm: string; cost: number; digestLength: number } {
  return {
    algorithm: DUMMY_PASSWORD_HASH.slice(0, 3),
    cost: bcrypt.getRounds(DUMMY_PASSWORD_HASH),
    digestLength: DUMMY_PASSWORD_HASH.length,
  };
}

// ---------------------------------------------------------------------------
// 2. Cache policy
// ---------------------------------------------------------------------------

/**
 * Forbid storage of an authentication or session-state response.
 *
 * `no-store` is the directive that actually matters: it stops shared caches,
 * disk caches and the browser back/forward cache from retaining a response that
 * describes who is signed in. `Pragma: no-cache` is the HTTP/1.0 companion for
 * intermediaries that predate Cache-Control; it does not conflict with it.
 *
 * The frontend also sends `cache: 'no-store'` on its requests, but a request
 * hint is a client-side courtesy. The response has to say so itself, because
 * the caches in between answer to the response, not to the fetch options.
 */
export function setNoStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
}

// ---------------------------------------------------------------------------
// 3. Request origin
// ---------------------------------------------------------------------------

export type OriginVerdict =
  | { allowed: true; reason: 'trusted_origin' | 'no_browser_origin' }
  | { allowed: false; reason: 'cross_origin' | 'cross_site_fetch' };

/**
 * The one browser origin permitted to make state-changing auth requests.
 *
 * Derived from APP_BASE_URL, which is authoritative first-party configuration.
 * It is NEVER derived from `request.host`, `X-Forwarded-Host` or
 * `X-Forwarded-Proto`: those are attacker-controllable, and Fastify's
 * `trustProxy` is off, so the forwarded headers are not even parsed.
 */
export const TRUSTED_ORIGIN = config.appOrigin;

/**
 * Decide whether a state-changing auth request may proceed.
 *
 * The threat is a cross-origin page causing the browser to POST /auth/login or
 * /auth/logout with the user's ambient cookies attached. Two independent
 * signals close it:
 *
 *   Sec-Fetch-Site — sent by current browsers and not settable by page script.
 *     Anything other than `same-origin` or `none` is rejected outright, which
 *     also covers `same-site` (a sibling subdomain is still not this app).
 *   Origin — sent by browsers on every cross-origin request and on same-origin
 *     POSTs. It must equal the configured first-party origin exactly. A
 *     sandboxed or opaque context sends the literal string "null", which is not
 *     the trusted origin and is therefore rejected.
 *
 * A request carrying NEITHER header is allowed, deliberately. That combination
 * does not occur for a browser-issued cross-origin POST — it means a
 * command-line or server-to-server client, which has no ambient cookie jar for
 * an attacker to ride. Rejecting it would break the verification suites and
 * every server-side caller while blocking no browser attack. This is the
 * considered position, not an accident: the protection here is against browsers
 * being used as confused deputies, and a client that is not a browser cannot be
 * one.
 */
export function classifyRequestOrigin(headers: Record<string, unknown>): OriginVerdict {
  const read = (name: string): string | undefined => {
    const value = headers[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  };

  const secFetchSite = read('sec-fetch-site');
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { allowed: false, reason: 'cross_site_fetch' };
  }

  const origin = read('origin');
  if (origin === undefined) return { allowed: true, reason: 'no_browser_origin' };
  if (origin === TRUSTED_ORIGIN) return { allowed: true, reason: 'trusted_origin' };
  return { allowed: false, reason: 'cross_origin' };
}

// ---------------------------------------------------------------------------
// 4. Content type
// ---------------------------------------------------------------------------

/**
 * Is this request body declared as JSON?
 *
 * A cross-origin `fetch` or an HTML `<form>` can send
 * `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`
 * with no CORS preflight at all — they are "simple requests". Requiring JSON
 * means any cross-origin attempt must first pass a preflight, which no CORS
 * configuration on this server will ever approve.
 *
 * Fastify already refuses urlencoded and multipart with a 415, but it ships a
 * built-in `text/plain` parser, so a text/plain POST previously reached the
 * login handler and was rejected only incidentally, by failing body validation.
 * That is the one simple-request content type that could reach the handler, so
 * it is now closed explicitly rather than by luck.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  return /^application\/json\s*(?:;.*)?$/i.test(contentType.trim());
}

/** Does this request carry a body that needs a content type at all? */
export function requestHasBody(headers: Record<string, unknown>): boolean {
  const length = headers['content-length'];
  if (typeof length === 'string' && length !== '' && length !== '0') return true;
  if (headers['transfer-encoding'] !== undefined) return true;
  // A declared content type implies an intent to send a body even when the
  // length is absent or zero.
  return headers['content-type'] !== undefined;
}
