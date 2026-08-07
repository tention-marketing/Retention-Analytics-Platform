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
  // Round to two decimals, back to a number, compare. `n` is only INSPECTED —
  // nothing here is stored, and every validator returns the value it parsed, so
  // this can never silently round a client's money.
  //
  // THIS USED TO BE `Math.round(n * 100) === n * 100`, and that scaling step is
  // the bug it now avoids. Multiplying a decimal by 100 is not exact in binary
  // floating point, so the two sides differed for values that have exactly two
  // decimal places:
  //
  //     19.99 * 100 === 1998.9999999999998    a price
  //     20.01 * 100 === 2001.0000000000002    a cost
  //      0.07 * 100 === 7.000000000000001     a unit cost
  //      1.13 * 100 === 112.99999999999999    a spend figure
  //
  // 13.13% of the two-decimal values between 0.01 and 10000.00 landed on that
  // error and were refused as `too_precise` — a message telling a client that
  // 19.99 has more than two decimal places. It hit all four financial inputs at
  // once (per-SKU COGS, OCAS, ad spend, blended margin), because all four share
  // this one helper, and it hit both a JSON number and the decimal string a
  // browser form submits. Downstream that is an RCM input nobody can enter.
  //
  // toFixed does the scaling in decimal rather than by binary multiplication, so
  // the comparison asks the question the rule actually means: is `n` equal to
  // itself rounded to two places? A genuine third decimal changes the value and
  // is still rejected (1.005, 1.2345, 0.125), and exponential notation is still
  // judged correctly — 1e-3 rounds to 0.00, which is not 1e-3 — which the
  // previous comment rightly flagged as the trap in reading decimal digits off a
  // string. This does not read digits; it compares numbers.
  return Number(n.toFixed(2)) === n;
}
