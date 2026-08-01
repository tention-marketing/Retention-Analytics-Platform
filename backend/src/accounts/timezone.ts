// Store-timezone validation for account writes.
//
// WHY THIS IS A SERVER CONCERN. `accounts.store_timezone` is not cosmetic: it is
// the timezone every date boundary in the product is computed in — trap #4's
// churn day math (`date(cancelled_at) − date(started_at)` in the STORE
// timezone), the ad-spend coverage window's "current month", the cohort month
// each order falls into. Postgres raises on an unknown zone name inside
// `AT TIME ZONE`, so a bad value stored here does not degrade a number, it makes
// whole queries throw for that account long after the request that caused it.
// Before this module the route stored whatever string arrived: `Not/A_Timezone`
// was accepted and persisted.
//
// The frontend also offers a validated picker. That is a usability feature, not
// a control — nothing stops a request being made without it — so the check here
// is written as if no client validation existed at all.
//
// NO DEPENDENCY. ICU ships with Node and already holds the zone database; a
// tz-name package would be a second, staler copy of what `Intl` can answer.

/**
 * Longest real IANA name ("America/Argentina/ComodRivadavia") is 31 characters.
 * The cap is not the check — it just keeps a megabyte of text from reaching the
 * regex and ICU at all.
 */
const MAX_LENGTH = 64;

/**
 * The shape of an IANA zone name: slash-separated components, the first
 * beginning with a letter.
 *
 * THIS IS NOT REDUNDANT WITH THE ICU CHECK BELOW — it rejects something ICU
 * accepts. Since ES2024, `Intl.DateTimeFormat` also takes UTC offsets: `+05:30`
 * resolves happily, and `-0800` resolves to `-08:00`. Those are not zone names,
 * they have no DST rules, and Postgres treats them with the opposite sign
 * convention inside `AT TIME ZONE` — so storing one would silently shift every
 * date boundary for that account. Requiring a leading letter excludes the whole
 * offset family before ICU is consulted.
 *
 * `+` and `-` are allowed inside a component because real names use them:
 * `Etc/GMT+5`, `America/Port-au-Prince`. `.` is not, because no zone name
 * contains one.
 */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** What ICU resolves a zone name to, or null when it does not know the name. */
function resolveWithIcu(candidate: string): string | null {
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: candidate })
      .resolvedOptions().timeZone;
    return typeof resolved === 'string' && resolved !== '' ? resolved : null;
  } catch {
    // RangeError for every name the zone database does not contain.
    return null;
  }
}

/**
 * Validate a submitted store timezone and return the value to store, or null
 * when it is not a usable IANA zone name.
 *
 * Null means REJECT. The caller answers 400; it must never fall back to a
 * default, because substituting `UTC` or `America/Los_Angeles` for a value the
 * user got wrong produces an account whose every date boundary is quietly
 * computed in the wrong place, with nothing on screen ever saying so.
 *
 * CANONICALIZATION IS CONDITIONAL. ICU normalizes case (`america/los_angeles` →
 * `America/Los_Angeles`) and folds links onto their canonical target
 * (`US/Pacific` → `America/Los_Angeles`), which is worth keeping so the column
 * holds one spelling per zone. But the resolved value is only adopted when it
 * would itself have passed this function's checks AND resolving it again
 * returns itself — a fixed point. Without that second condition an engine whose
 * resolution is not idempotent, or which answers with an offset form, could talk
 * us into storing something we would have refused had it arrived in the request.
 * When the check does not hold, the validated input is stored verbatim.
 */
export function normalizeStoreTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_LENGTH) return null;
  if (!IANA_NAME.test(trimmed)) return null;

  const resolved = resolveWithIcu(trimmed);
  if (resolved === null) return null;
  if (resolved === trimmed) return trimmed;

  const canonicalIsSafe =
    resolved.length <= MAX_LENGTH &&
    IANA_NAME.test(resolved) &&
    resolveWithIcu(resolved) === resolved;

  return canonicalIsSafe ? resolved : trimmed;
}

/**
 * Used only when the request omits `store_timezone` entirely, which is a
 * different thing from getting it wrong. Matches the column default in
 * 001_init.sql so an omitted field behaves exactly as it did before this
 * validation existed.
 */
export const DEFAULT_STORE_TIMEZONE = 'America/Los_Angeles';
