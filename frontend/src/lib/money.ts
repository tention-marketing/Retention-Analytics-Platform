// Money and month primitives for the financial controls.
//
// TWO RULES, both of which exist because of what this data is.
//
// 1. MONEY STAYS A DECIMAL STRING. PostgreSQL NUMERIC(12,2) arrives over JSON as
//    a string — "1000.00", not 1000 — and it is kept that way end to end. Parsing
//    it into a JS number to render it is how "1000.00" becomes "1000" on screen,
//    how 0.1 + 0.2 becomes 0.30000000000000004, and how a value round-trips back
//    to the server subtly different from the one the user typed. Nothing here
//    calls parseFloat on a stored amount. The only place a number appears is a
//    COVERAGE PERCENTAGE, which is a ratio the backend already computed and
//    rounded, and which is never added to anything.
//
// 2. A MONTH IS PARSED BY ITS COMPONENTS, NEVER BY Date. `new Date('2026-03-01')`
//    is parsed as UTC midnight, and rendering that in any timezone west of
//    Greenwich shows FEBRUARY. Every month in this feature is a first-of-month
//    date string from the backend, so the year and month are read off the string
//    directly and never routed through a Date at all.

/** A non-negative decimal with at most two places. Validated, never assumed. */
const MONEY_RE = /^\d{1,13}(\.\d{1,2})?$/;

/** A first-of-month date, as every month value on these routes is. */
const MONTH_RE = /^(\d{4})-(\d{2})-01$/;

/** Any valid YYYY-MM-DD, for the few places a non-first-of-month would be a bug. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Is this a decimal money string the backend could have sent, or that it will
 * accept back?
 *
 * Rejects: negatives, exponential notation, more than two decimal places, a bare
 * '.', thousands separators, currency symbols, whitespace, and anything that is
 * not a string. Accepts "0", "0.00", "1000.00", "12345.6".
 */
export function isMoneyString(value: unknown): value is string {
  return typeof value === 'string' && MONEY_RE.test(value);
}

/**
 * Normalize a money string to exactly two decimal places, WITHOUT arithmetic.
 *
 * String surgery rather than `toFixed`: toFixed goes through a binary float, and
 * the whole point of keeping these values as strings is that they never do. This
 * only pads or trims the fractional part, so "5" becomes "5.00" and "5.5"
 * becomes "5.50" with the integer digits untouched.
 */
export function toCanonicalMoney(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export type MoneyParse =
  | { ok: true; value: string }
  | { ok: false; reason: 'blank' | 'not_a_number' | 'negative' | 'too_precise' | 'too_large' };

/**
 * Validate what a user typed into a money field.
 *
 * `reason` is distinct from the backend's error codes on purpose: this runs
 * BEFORE a request, so it can tell the user which rule they broke without a
 * round trip. It is not a substitute for the server's validation — the server is
 * the only authority, and it re-checks every one of these.
 *
 * A BLANK FIELD IS NOT ZERO, and that is the reason 'blank' is its own reason
 * rather than collapsing into 'not_a_number'. Zero is a claim about the business
 * ("our operating cost really is nothing"), and it must be stated deliberately;
 * an empty box is the absence of an answer.
 */
export function parseMoneyInput(raw: string): MoneyParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'blank' };
  // NEGATIVE IS CHECKED FIRST, before the general shape test. A leading '-' fails
  // that test too, so testing shape first would report "-5" as "not a number" —
  // which is both wrong and unhelpful, since the user typed a perfectly good
  // number and broke a different rule.
  if (/^-/.test(trimmed) && /^-\d*(\.\d*)?$/.test(trimmed)) {
    return { ok: false, reason: 'negative' };
  }
  // Strip nothing else: a comma or a currency symbol is a value this app should
  // ask the user to correct, not silently reinterpret.
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '.') {
    return { ok: false, reason: 'not_a_number' };
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > 2) return { ok: false, reason: 'too_precise' };
  // NUMERIC(12,2) holds ten integer digits. Compared as a digit count so no
  // number is ever constructed from the input.
  const digits = (whole ?? '').replace(/^0+(?=\d)/, '');
  if (digits.length > 10) return { ok: false, reason: 'too_large' };
  return { ok: true, value: toCanonicalMoney(trimmed === '' ? '0' : trimmed) };
}

/** True when a validated money string represents exactly zero. */
export function isZeroMoney(value: string): boolean {
  return /^0+(\.0{1,2})?$/.test(value);
}

/**
 * Format a money string for display, with thousands separators and its currency
 * CODE — never a bare symbol.
 *
 * The integer part is grouped by string manipulation; the fraction is passed
 * through untouched. A symbol alone ("$1,000.00") does not say whether that is
 * US, Canadian, Australian or Hong Kong dollars, and this product's whole
 * premise is not presenting an ambiguous number as a finding.
 */
export function formatMoney(value: string, currency: string | null): string {
  const [whole = '0', fraction = '00'] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = `${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  return currency ? `${amount} ${currency}` : amount;
}

/** A percentage the backend already computed and rounded. Never money. */
export function formatPercent(value: number, places = 1): string {
  return `${value.toFixed(places)}%`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export function isMonthString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * "2026-03-01" → "March 2026". NO Date OBJECT IS CONSTRUCTED.
 *
 * This is the timezone-drift bug the checkpoint calls out by name: routing the
 * string through `new Date()` parses it as UTC midnight, and `toLocaleString` in
 * any negative-offset timezone then renders the PREVIOUS month. An agency in Los
 * Angeles would be told their February spend was missing while looking at a
 * March row. Reading the two numbers off the string cannot drift, because no
 * instant is ever involved.
 */
export function formatMonth(value: string): string {
  const m = MONTH_RE.exec(value) ?? DATE_RE.exec(value);
  if (!m) return value;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return value;
  return `${MONTH_NAMES[month - 1]} ${m[1]}`;
}

/** "2026-03-01" → "Mar 2026", for dense lists and table cells. */
export function formatMonthShort(value: string): string {
  const full = formatMonth(value);
  if (full === value) return value;
  const [name, year] = full.split(' ');
  return `${(name ?? '').slice(0, 3)} ${year}`;
}

/** "2026-03-01" → "2026-03", the value an <input type="month"> holds. */
export function toMonthInputValue(value: string): string {
  return isMonthString(value) || isDateString(value) ? value.slice(0, 7) : '';
}

/** "2026-03" → "2026-03-01", the value the backend expects. */
export function fromMonthInputValue(value: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/**
 * Compare two month strings. Lexicographic, which is also chronological for
 * zero-padded ISO dates — and needs no Date.
 */
export function compareMonths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
