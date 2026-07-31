// Safe internal return paths.
//
// After a redirect to /login the app remembers where the user was headed and
// sends them back there. That remembered value is attacker-reachable — it comes
// from router state seeded by a URL — so if it were used unchecked, a crafted
// link could bounce someone from a genuine login straight to an external page
// that looks like the app and asks for the password again. An open redirect on
// the login route is a phishing primitive, not a routing bug.
//
// A value is usable only if it is unambiguously a path within this origin.

const PLACEHOLDER_ORIGIN = 'https://return-path-check.invalid';

/**
 * Control characters (NUL, CR, LF, TAB and friends).
 *
 * Parsers strip or reinterpret these, which is how a value whose first two
 * characters look like a plain path can still resolve to an external authority.
 */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Is this a same-origin internal path?
 *
 * Rejects, in order: non-strings and empties; anything not starting with `/`
 * (so `https://evil.example` and `javascript:alert(1)` are out); `//evil` and
 * `/\evil`, which browsers treat as protocol-relative authorities; control
 * characters; and finally anything that changes origin once a real URL parser
 * resolves it, which catches encodings the string checks above do not anticipate.
 */
export function isSafeReturnPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (!value.startsWith('/')) return false;
  // `//host` and `/\host` are authority forms, not paths.
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  if (hasControlCharacters(value)) return false;

  let resolved: URL;
  try {
    resolved = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return false;
  }
  // A path that resolves anywhere other than the placeholder origin was not a
  // path. `javascript:` resolves to an opaque origin and fails here too.
  if (resolved.origin !== PLACEHOLDER_ORIGIN) return false;
  // Never send the user back to the login page itself — that is the redirect
  // loop this whole mechanism exists to avoid.
  if (resolved.pathname === '/login') return false;
  return true;
}

/** The path to return to, or `/` when the candidate is missing or unsafe. */
export function safeReturnPath(value: unknown, fallback = '/'): string {
  return isSafeReturnPath(value) ? value : fallback;
}

/** Capture the current location as a return path, for the login redirect. */
export function toReturnPath(location: { pathname: string; search: string }): string {
  return safeReturnPath(`${location.pathname}${location.search}`);
}
