import { describe, expect, it, vi } from 'vitest';
import { isSelectableTimezone, listTimezones } from './timezones';

// The timezone picker's source of truth.
//
// These are usability checks, not security ones — the backend's normalizer is
// the control. What matters here is that the picker never offers a value the
// server would then refuse, and that it still works on an engine without
// Intl.supportedValuesOf.

describe('isSelectableTimezone', () => {
  it.each([
    'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'UTC',
    'Australia/Sydney', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5',
    'America/Port-au-Prince', 'Pacific/Auckland',
  ])('accepts the real zone %s', (zone) => {
    expect(isSelectableTimezone(zone)).toBe(true);
  });

  it.each(['Not/A_Timezone', 'America/Does_Not_Exist', 'Mars/Olympus_Mons', 'Europe/Londonn'])(
    'rejects the invented zone %s', (zone) => {
      expect(isSelectableTimezone(zone)).toBe(false);
    });

  it.each([['empty', ''], ['a space', ' '], ['spaces', '   '], ['a tab', '\t']])(
    'rejects %s', (_label, value) => {
      expect(isSelectableTimezone(value)).toBe(false);
    });

  it.each([
    ['undefined', undefined], ['null', null], ['a number', 5], ['a boolean', true],
    ['an array', ['UTC']], ['an object', { timeZone: 'UTC' }],
  ])('rejects the non-string %s', (_label, value) => {
    expect(isSelectableTimezone(value)).toBe(false);
  });

  // The check that is easiest to lose: Intl.DateTimeFormat itself accepts these.
  it.each(['+05:30', '-08:00', '-0800', '+0530', '+00:00'])(
    'rejects the UTC offset %s, which has no DST rules and which the backend refuses',
    (offset) => {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: offset })).not.toThrow();
      expect(isSelectableTimezone(offset)).toBe(false);
    });

  it('rejects an absurdly long value without consulting ICU', () => {
    expect(isSelectableTimezone(`A${'a'.repeat(500)}`)).toBe(false);
  });

  it("rejects a value that only becomes valid if you ignore what's around it", () => {
    expect(isSelectableTimezone('America/Los_Angeles\nEurope/London')).toBe(false);
    expect(isSelectableTimezone("UTC'; DROP TABLE accounts; --")).toBe(false);
  });

  it('accepts surrounding whitespace, since the form trims before sending', () => {
    expect(isSelectableTimezone('  UTC  ')).toBe(true);
  });
});

describe('listTimezones', () => {
  it('offers a substantial list on an engine with Intl.supportedValuesOf', () => {
    expect(typeof (Intl as { supportedValuesOf?: unknown }).supportedValuesOf).toBe('function');
    expect(listTimezones().length).toBeGreaterThan(100);
  });

  it('offers only zones the backend would accept', () => {
    for (const zone of listTimezones()) {
      expect(isSelectableTimezone(zone), zone).toBe(true);
    }
  });

  it('includes UTC and the common markets', () => {
    const zones = listTimezones();
    for (const zone of ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London',
      'Australia/Sydney']) {
      expect(zones).toContain(zone);
    }
  });

  it('is sorted and free of duplicates', () => {
    const zones = listTimezones();
    expect(new Set(zones).size).toBe(zones.length);
    expect([...zones].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(zones);
  });

  it('contains no UTC offset entry', () => {
    expect(listTimezones().filter((z) => /^[+-]/.test(z))).toEqual([]);
  });

  // --- the fallback path --------------------------------------------------
  //
  // `{...Intl}` would NOT work here: the members of a built-in namespace object
  // are non-enumerable, so spreading it yields `{}` and takes DateTimeFormat
  // with it — every zone would then fail validation and the test would pass for
  // entirely the wrong reason. The real DateTimeFormat is carried across
  // explicitly, so the only thing that changes is the enumeration API.
  function stubIntlWithout(supportedValuesOf: unknown): void {
    vi.stubGlobal('Intl', {
      DateTimeFormat: Intl.DateTimeFormat,
      ...(supportedValuesOf === undefined ? {} : { supportedValuesOf }),
    });
  }

  it('keeps ICU validation working under the stub (guards the test itself)', () => {
    stubIntlWithout(undefined);
    expect(isSelectableTimezone('Europe/London')).toBe(true);
    expect(isSelectableTimezone('Not/A_Timezone')).toBe(false);
  });

  it('falls back to a curated list when Intl.supportedValuesOf is absent', () => {
    stubIntlWithout(undefined);
    const zones = listTimezones();
    expect(zones.length).toBeGreaterThan(20);
    expect(zones).toContain('UTC');
    expect(zones).toContain('America/Los_Angeles');
  });

  it('validates every fallback entry too, so a smaller zone database is safe', () => {
    stubIntlWithout(undefined);
    for (const zone of listTimezones()) {
      expect(isSelectableTimezone(zone), zone).toBe(true);
    }
  });

  it('falls back when Intl.supportedValuesOf throws', () => {
    stubIntlWithout(() => {
      throw new RangeError('unsupported key');
    });
    expect(listTimezones()).toContain('UTC');
  });

  it('falls back when Intl.supportedValuesOf returns nothing usable', () => {
    stubIntlWithout(() => []);
    expect(listTimezones().length).toBeGreaterThan(20);
  });

  it('falls back when Intl.supportedValuesOf is not callable', () => {
    stubIntlWithout('nonsense');
    expect(listTimezones()).toContain('UTC');
  });
});
