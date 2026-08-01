// IANA timezone choices for the create-account form.
//
// THE BACKEND IS THE AUTHORITY. Everything here is a usability feature: it stops
// someone typing `Amerca/Los_Angeles` and finding out after a round trip. The
// real control is normalizeStoreTimezone in backend/src/accounts/timezone.ts,
// which rejects anything ICU does not know and is what actually stands between a
// bad value and the column. Nothing in this file is a security boundary, and no
// change here can weaken one.
//
// NO DEPENDENCY, AND NO BROWSER-GUESSED DEFAULT. The browser already ships the
// zone database; a tz-name package would be a second, staler copy of it. And the
// field starts empty rather than pre-filled from the agency user's own
// `Intl.DateTimeFormat().resolvedOptions().timeZone` — the person creating the
// account is in an agency office, the brand's store is somewhere else, and a
// default that happens to be right in the office is the kind of wrong that
// nobody notices until a churn curve is a day out.

/**
 * Zones offered when `Intl.supportedValuesOf` is unavailable.
 *
 * Not a "best guess" list: every entry is checked against ICU by
 * isSelectableTimezone before it is offered, so an environment that lacks the
 * enumeration API but has a smaller zone database still cannot present a name it
 * would then reject. Chosen for coverage of the UTC offset range plus the
 * markets a DTC brand is actually likely to be in.
 */
const FALLBACK_TIMEZONES = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Toronto',
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'Atlantic/Reykjavik',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Africa/Cairo',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
] as const;

/**
 * Mirrors the backend's shape rule, and exists for the same reason.
 *
 * Since ES2024 `Intl.DateTimeFormat` also accepts UTC offsets — `+05:30`
 * resolves without throwing. An offset is not a zone name: it has no DST rules,
 * so a store on it would drift by an hour twice a year, and the backend refuses
 * it. Offering one here would produce a picker whose value the server rejects.
 * Requiring a leading letter excludes the whole offset family.
 */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Would the backend accept this?
 *
 * Deliberately the same two checks in the same order as the server's normalizer:
 * the name shape, then whether ICU actually knows it. Kept as a duplicate rather
 * than shared because the two run in different runtimes — but if they ever
 * disagree, the server's answer is the one that counts and the form must show
 * the server's error, which is exactly what the mutation's failure path does.
 */
export function isSelectableTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 64) return false;
  if (!IANA_NAME.test(trimmed)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/** `Intl.supportedValuesOf('timeZone')`, or null where the API is absent. */
function enumerateFromIntl(): string[] | null {
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supportedValuesOf !== 'function') return null;
  try {
    const values = supportedValuesOf('timeZone');
    return Array.isArray(values) && values.length > 0 ? values : null;
  } catch {
    // An engine that has the method but not the 'timeZone' key throws RangeError.
    return null;
  }
}

/**
 * The zone names to offer, sorted, each one already known to be acceptable.
 *
 * `UTC` is appended because several engines omit it from the enumeration even
 * though every one of them accepts it, and a brand that genuinely runs on UTC
 * should not have to fight the picker.
 */
export function listTimezones(): string[] {
  const source = enumerateFromIntl() ?? [...FALLBACK_TIMEZONES];
  const unique = new Set<string>();
  for (const zone of source) {
    if (isSelectableTimezone(zone)) unique.add(zone);
  }
  if (isSelectableTimezone('UTC')) unique.add('UTC');
  return [...unique].sort((a, b) => a.localeCompare(b, 'en'));
}
