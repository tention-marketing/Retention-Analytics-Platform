// The one place a money-or-percentage field becomes a number.
//
// WHY THIS FILE EXISTS. Every financial validator used to open with the same two
// lines:
//
//     const n = typeof input === 'number' ? input : Number(input);
//     if (input === null || input === undefined || input === '' || !Number.isFinite(n)) …
//
// `Number()` is far more willing than that guard assumes, and the gap is not
// cosmetic — it lands exactly on the rule D4/D5 exist to enforce, that AN EMPTY
// FIELD IS NEVER READ AS ZERO:
//
//     Number('   ')  === 0      a whitespace-only field
//     Number('\t')   === 0      a tabbed-through field
//     Number([])     === 0      an empty array
//     Number([100])  === 100    a single-element array
//     Number(true)   === 1      a boolean
//
// The first four are blanks that arrive as zero. `''` was caught by name; `'   '`
// was not, and it is the same field with a space in it. Combined with the
// explicit zero confirmation those validators require, the consequence was
// concrete: submitting a whitespace-only OCAS with the zero box ticked stored a
// CONFIRMED zero monthly operating cost, and the same for a per-SKU cost —
// exactly the fabricated zero the confirmation was designed to make impossible.
// A zero OCAS makes the "RCM >= OCAS -> self-funding" verdict trivially true, so
// it must be a deliberate statement rather than a field nobody filled in.
//
// A UI that only ever sends canonical decimal strings would not trigger this, and
// that is not the point: server-side validation is the only authority, and "the
// frontend does not do that" is not an access control.
//
// SO: exactly two input shapes are numbers. A `number` that is finite, and a
// `string` that is non-blank once trimmed and parses to a finite number. Nothing
// else — no array, no boolean, no object, no null, no undefined. Every value any
// of these fields could legitimately hold is still accepted; the range and
// precision rules that follow are unchanged and stay with their own validators.
export type AmountParse =
  | { ok: true; value: number }
  | { ok: false };

export function parseAmount(input: unknown): AmountParse {
  if (typeof input === 'number') {
    // Catches NaN and both infinities.
    return Number.isFinite(input) ? { ok: true, value: input } : { ok: false };
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return { ok: false };
    const n = Number(trimmed);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
  }
  return { ok: false };
}

/** True when `n` has at most two decimal places — the NUMERIC(_,2) columns' limit. */
export function hasAtMostTwoDecimals(n: number): boolean {
  // Scale, round, compare. Reading the decimal digits off the string form would
  // misjudge exponential notation (1e-3 has no '.' in it at all).
  return Math.round(n * 100) === n * 100;
}
