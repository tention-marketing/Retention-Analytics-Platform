import { describe, expect, it } from 'vitest';
import {
  compareMonths, formatMoney, formatMonth, formatMonthShort, formatPercent, fromMonthInputValue,
  isDateString, isMonthString, isMoneyString, isZeroMoney, parseMoneyInput, toCanonicalMoney,
  toMonthInputValue,
} from './money';

// Money and month primitives.
//
// The two properties worth testing exhaustively are the two that go wrong
// silently: a money value that changes because it went through a float, and a
// month that renders as the previous one because it went through a Date.

describe('money strings', () => {
  it.each(['0', '0.0', '0.00', '1', '1.5', '1.50', '1000.00', '9999999999.99'])(
    'accepts %s', (value) => {
      expect(isMoneyString(value)).toBe(true);
    },
  );

  it.each([
    '-1', '-0.01', '1.234', '1e3', '1E3', '.5', '1.', '1,000.00', '$1', '1 ', ' 1', '',
    'abc', 'Infinity', 'NaN', '99999999999999.99',
  ])('rejects %s', (value) => {
    expect(isMoneyString(value)).toBe(false);
  });

  it.each([1000, null, undefined, true, [], {}, NaN])('rejects the non-string %s',
    (value) => {
      expect(isMoneyString(value)).toBe(false);
    });

  it('canonicalizes to two decimals by padding, not arithmetic', () => {
    expect(toCanonicalMoney('5')).toBe('5.00');
    expect(toCanonicalMoney('5.5')).toBe('5.50');
    expect(toCanonicalMoney('5.55')).toBe('5.55');
    expect(toCanonicalMoney('0')).toBe('0.00');
  });

  it('preserves large integer parts exactly, with no float rounding', () => {
    // 9007199254740993 is beyond Number.MAX_SAFE_INTEGER; a float round trip would
    // silently change it. Nothing here constructs a number, so it cannot.
    expect(toCanonicalMoney('9007199254740993.01')).toBe('9007199254740993.01');
  });

  it('recognises zero in every written form', () => {
    for (const value of ['0', '0.0', '0.00', '00', '00.00']) {
      expect(isZeroMoney(value)).toBe(true);
    }
    for (const value of ['0.01', '1.00', '10.00']) {
      expect(isZeroMoney(value)).toBe(false);
    }
  });
});

describe('parsing what a user typed', () => {
  it('treats a blank field as blank, never as zero', () => {
    // The distinction the whole zero-confirmation mechanism rests on.
    for (const value of ['', '   ', '\t', '\n']) {
      expect(parseMoneyInput(value)).toEqual({ ok: false, reason: 'blank' });
    }
  });

  it('accepts a plain decimal and canonicalizes it', () => {
    expect(parseMoneyInput('1000')).toEqual({ ok: true, value: '1000.00' });
    expect(parseMoneyInput(' 1000.5 ')).toEqual({ ok: true, value: '1000.50' });
    expect(parseMoneyInput('0')).toEqual({ ok: true, value: '0.00' });
  });

  it('rejects more than two decimal places', () => {
    expect(parseMoneyInput('1.234')).toEqual({ ok: false, reason: 'too_precise' });
  });

  it('rejects an amount beyond NUMERIC(12,2)', () => {
    expect(parseMoneyInput('99999999999.00')).toEqual({ ok: false, reason: 'too_large' });
    expect(parseMoneyInput('9999999999.99')).toEqual({ ok: true, value: '9999999999.99' });
  });

  it('rejects separators and symbols rather than silently reinterpreting them', () => {
    // "1,000" could mean a thousand or one — guessing is worse than asking.
    for (const value of ['1,000', '$100', '100 USD', '1 000']) {
      expect(parseMoneyInput(value).ok).toBe(false);
    }
  });

  it('rejects exponential notation and other numeric-looking text', () => {
    for (const value of ['1e3', 'Infinity', 'NaN', '--1', '1.2.3', '.']) {
      expect(parseMoneyInput(value).ok).toBe(false);
    }
  });

  it('ignores leading zeros when measuring magnitude', () => {
    expect(parseMoneyInput('0000000000001.00')).toEqual({ ok: true, value: '0000000000001.00' });
  });
});

describe('formatting money', () => {
  it('always shows the three-letter code, never a bare symbol', () => {
    expect(formatMoney('1000.00', 'USD')).toBe('1,000.00 USD');
    expect(formatMoney('1000.00', 'CAD')).toBe('1,000.00 CAD');
    // A symbol alone cannot distinguish those two.
    expect(formatMoney('1000.00', 'USD')).not.toContain('$');
  });

  it('groups thousands without touching the fraction', () => {
    expect(formatMoney('1234567.89', 'GBP')).toBe('1,234,567.89 GBP');
    expect(formatMoney('999.50', 'GBP')).toBe('999.50 GBP');
  });

  it('omits the code when no currency is known', () => {
    expect(formatMoney('10.00', null)).toBe('10.00');
  });

  it('formats a percentage without any currency', () => {
    expect(formatPercent(66.666)).toBe('66.7%');
    expect(formatPercent(80)).toBe('80.0%');
    expect(formatPercent(80, 0)).toBe('80%');
  });
});

describe('months never drift by timezone', () => {
  it('formats a first-of-month string from its own components', () => {
    expect(formatMonth('2026-03-01')).toBe('March 2026');
    expect(formatMonth('2026-01-01')).toBe('January 2026');
    expect(formatMonth('2026-12-01')).toBe('December 2026');
  });

  it('shows the SAME month regardless of the host timezone', () => {
    // The regression this exists to prevent: `new Date('2026-03-01')` is UTC
    // midnight, and rendering that anywhere west of Greenwich gives FEBRUARY. The
    // formatter reads the string, so the process timezone is irrelevant — asserted
    // by checking the value the naive approach would produce is NOT what we show.
    const naive = new Date('2026-03-01').toLocaleString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'America/Los_Angeles',
    });
    expect(naive).toBe('February 2026');
    expect(formatMonth('2026-03-01')).toBe('March 2026');
  });

  it.each([
    ['2026-01-01', 'Jan 2026'], ['2026-03-01', 'Mar 2026'], ['2026-09-01', 'Sep 2026'],
    ['2026-12-01', 'Dec 2026'],
  ])('shortens %s to %s', (input, expected) => {
    expect(formatMonthShort(input)).toBe(expected);
  });

  it('returns an unrecognised value unchanged rather than inventing a month', () => {
    expect(formatMonth('not-a-month')).toBe('not-a-month');
    expect(formatMonth('2026-13-01')).toBe('2026-13-01');
    expect(formatMonthShort('nonsense')).toBe('nonsense');
  });

  it('validates a first-of-month string', () => {
    expect(isMonthString('2026-03-01')).toBe(true);
    for (const value of ['2026-03-15', '2026-13-01', '2026-00-01', '2026-03', '', null, 5]) {
      expect(isMonthString(value)).toBe(false);
    }
  });

  it('validates any well-formed date', () => {
    expect(isDateString('2026-03-15')).toBe(true);
    expect(isDateString('2026-03-32')).toBe(false);
    expect(isDateString('2026-13-01')).toBe(false);
  });

  it('round-trips through an <input type="month"> value', () => {
    expect(toMonthInputValue('2026-03-01')).toBe('2026-03');
    expect(fromMonthInputValue('2026-03')).toBe('2026-03-01');
    expect(fromMonthInputValue(' 2026-03 ')).toBe('2026-03-01');
  });

  it('refuses a malformed month input value', () => {
    for (const value of ['2026-13', '2026-00', '26-03', '2026', '', 'March']) {
      expect(fromMonthInputValue(value)).toBeNull();
    }
  });

  it('compares months chronologically without a Date', () => {
    expect(compareMonths('2026-01-01', '2026-02-01')).toBe(-1);
    expect(compareMonths('2026-02-01', '2026-01-01')).toBe(1);
    expect(compareMonths('2026-01-01', '2026-01-01')).toBe(0);
    // A year boundary is not a special case for zero-padded ISO strings.
    expect(compareMonths('2025-12-01', '2026-01-01')).toBe(-1);
  });
});
