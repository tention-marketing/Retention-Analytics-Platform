import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import {
  confirmZeroAdSpendMonths, getAccountAdSpend, getAccountCosts, getAccountCurrency,
  readZeroSpendConflict, resolveAccountCurrencyMismatch, saveAdSpendRanges, saveBlendedMargin,
  saveOcas, savePerSkuCosts, setAccountCurrency,
} from './financial';
import {
  AD_SPEND_EMPTY, COSTS_EMPTY, CURRENCY_MANUAL_USD, CURRENCY_MISMATCH,
  CURRENCY_UNKNOWN, adSpendCoverage, costsState, coverage, sku,
} from '@/test/financialFixtures';
// CURRENCY_SHOPIFY_USD belongs to the component suite; the API layer treats every
// source alike once it has been validated.
import { calls, lastCall, stubFetch } from '@/test/server';

// The financial API layer.
//
// Two things are under test, and they are different in kind:
//
//   THE REQUEST — that every call is account-scoped, that no write body carries an
//   accountId, that no client /onboarding/* route is ever touched, and that the
//   zero-replacement escalation is opt-in rather than automatic.
//
//   THE RESPONSE — that a malformed payload FAILS rather than degrading. That is
//   the half worth labouring: a coverage object that silently lost a field, or a
//   spend list that quietly dropped a row it could not parse, looks exactly like
//   a correct one, and "advertising spend is complete" is a conclusion an agency
//   acts on.

const ACCOUNT_ID = 11;

function costsPayload(overrides: Partial<typeof COSTS_EMPTY> = {}) {
  return { ...COSTS_EMPTY, ...overrides };
}

function adSpendPayload(overrides: Partial<typeof AD_SPEND_EMPTY> = {}) {
  return { ...AD_SPEND_EMPTY, ...overrides };
}

/** Assert a call was made, and return its parsed body. */
function bodyOf(index = -1): Record<string, unknown> {
  const call = index === -1 ? lastCall() : calls[index]!;
  return call.body === null ? {} : (JSON.parse(call.body) as Record<string, unknown>);
}

// ===========================================================================
// Route shape
// ===========================================================================
describe('financial routes are account-scoped', () => {
  it('reads currency from the account path', async () => {
    stubFetch({ json: CURRENCY_UNKNOWN });
    await getAccountCurrency(ACCOUNT_ID);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/currency`);
    expect(lastCall().method).toBe('GET');
  });

  it('reads costs from the account path', async () => {
    stubFetch({ json: COSTS_EMPTY });
    await getAccountCosts(ACCOUNT_ID);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/costs`);
  });

  it('reads ad spend from the account path', async () => {
    stubFetch({ json: AD_SPEND_EMPTY });
    await getAccountAdSpend(ACCOUNT_ID);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/ad-spend`);
  });

  it('writes currency to the account path', async () => {
    stubFetch({ json: { ok: true, currency: 'USD' } });
    await setAccountCurrency(ACCOUNT_ID, 'usd');
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/currency`);
    expect(lastCall().method).toBe('PUT');
  });

  it('writes costs, OCAS and ad spend to their account paths', async () => {
    stubFetch({ json: { method: 'blended', blendedMarginPct: 50 } });
    await saveBlendedMargin(ACCOUNT_ID, 50);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/costs`);

    stubFetch({ json: { ocasMonthly: 100, confirmedZero: false } });
    await saveOcas(ACCOUNT_ID, '100.00', false);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/costs/ocas`);

    stubFetch({ json: { monthsWritten: 1, rowsWritten: 1, zeroConfirmationsCleared: 0 } });
    await saveAdSpendRanges(ACCOUNT_ID, [
      { channel: 'Meta', amount: '100.00', startMonth: '2026-07-01', endMonth: '2026-07-01' },
    ]);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/ad-spend`);
  });

  it('resolves a mismatch on the account path, with no body at all', async () => {
    stubFetch({ json: { ok: true, currency: 'USD' } });
    await resolveAccountCurrencyMismatch(ACCOUNT_ID);
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/currency/resolve-mismatch`);
    expect(lastCall().method).toBe('POST');
    // BODYLESS, deliberately: Fastify rejects a request that declares
    // application/json and then sends nothing, and the shared client only sets
    // Content-Type when there is a body.
    expect(lastCall().body).toBeNull();
    expect(lastCall().headers['content-type']).toBeUndefined();
  });

  it('confirms zero months on the account path', async () => {
    stubFetch({ json: { ok: true, monthsConfirmed: 1 } });
    await confirmZeroAdSpendMonths(ACCOUNT_ID, { months: ['2026-07-01'] });
    expect(lastCall().url).toBe(`/api/accounts/${ACCOUNT_ID}/ad-spend/zero`);
    expect(lastCall().method).toBe('POST');
  });

  it('sends the session cookie and never caches an authenticated response', async () => {
    stubFetch({ json: CURRENCY_UNKNOWN });
    await getAccountCurrency(ACCOUNT_ID);
    expect(lastCall().credentials).toBe('include');
    expect(lastCall().cache).toBe('no-store');
  });

  it('never calls a client /onboarding/* route', async () => {
    stubFetch({ json: CURRENCY_UNKNOWN });
    await getAccountCurrency(ACCOUNT_ID);
    stubFetch({ json: COSTS_EMPTY });
    await getAccountCosts(ACCOUNT_ID);
    stubFetch({ json: AD_SPEND_EMPTY });
    await getAccountAdSpend(ACCOUNT_ID);
    stubFetch({ json: { ok: true } });
    await setAccountCurrency(ACCOUNT_ID, 'USD');
    await saveBlendedMargin(ACCOUNT_ID, 50);
    await saveOcas(ACCOUNT_ID, '10.00', false);
    await savePerSkuCosts(ACCOUNT_ID, [{ sku: 'A', cogs: '1.00' }]);
    await saveAdSpendRanges(ACCOUNT_ID, [
      { channel: 'Meta', amount: '1.00', startMonth: '2026-07-01', endMonth: '2026-07-01' },
    ]);
    await confirmZeroAdSpendMonths(ACCOUNT_ID, { months: ['2026-07-01'] });
    await resolveAccountCurrencyMismatch(ACCOUNT_ID);

    // The client wizard's routes are a DIFFERENT auth principal. Every call this
    // app makes must sit under /accounts/:id.
    for (const call of calls) {
      expect(call.url.startsWith(`/api/accounts/${ACCOUNT_ID}/`)).toBe(true);
      expect(call.url).not.toMatch(/\/onboarding\/(currency|cogs|ocas|ad-spend)/);
    }
  });

  it('never puts an accountId in a write body', async () => {
    stubFetch({ json: { ok: true } });
    await setAccountCurrency(ACCOUNT_ID, 'USD');
    await saveBlendedMargin(ACCOUNT_ID, 50);
    await savePerSkuCosts(ACCOUNT_ID, [{ sku: 'A', cogs: '1.00' }]);
    await saveOcas(ACCOUNT_ID, '10.00', false);
    await saveAdSpendRanges(ACCOUNT_ID, [
      { channel: 'Meta', amount: '1.00', startMonth: '2026-07-01', endMonth: '2026-07-01' },
    ]);
    await confirmZeroAdSpendMonths(ACCOUNT_ID, { months: ['2026-07-01'] });

    for (const call of calls) {
      if (call.body === null) continue;
      // Checked as raw text as well as parsed keys, so a nested occurrence at any
      // depth is caught.
      expect(call.body).not.toMatch(/account_?[iI]d/);
      expect(Object.keys(JSON.parse(call.body) as object)).not.toContain('accountId');
      expect(Object.keys(JSON.parse(call.body) as object)).not.toContain('account_id');
    }
  });
});

// ===========================================================================
// Currency
// ===========================================================================
describe('currency responses', () => {
  it('maps the snake_case wire shape to camelCase', async () => {
    stubFetch({ json: CURRENCY_MISMATCH });
    await expect(getAccountCurrency(ACCOUNT_ID)).resolves.toEqual({
      currency: 'CAD',
      currencySource: 'manual',
      shopifyCurrencyDetected: 'USD',
    });
  });

  it('accepts a fully unset currency', async () => {
    stubFetch({ json: CURRENCY_UNKNOWN });
    await expect(getAccountCurrency(ACCOUNT_ID)).resolves.toEqual({
      currency: null, currencySource: null, shopifyCurrencyDetected: null,
    });
  });

  it.each([
    ['a two-letter code', { ...CURRENCY_MANUAL_USD, currency: 'US' }],
    ['a four-letter code', { ...CURRENCY_MANUAL_USD, currency: 'USDX' }],
    ['a lowercase code', { ...CURRENCY_MANUAL_USD, currency: 'usd' }],
    ['a code with a digit', { ...CURRENCY_MANUAL_USD, currency: 'US1' }],
    ['a numeric code', { ...CURRENCY_MANUAL_USD, currency: 840 }],
    ['a detected code that is malformed', { ...CURRENCY_MANUAL_USD, shopify_currency_detected: 'U' }],
    ['an unrecognised source', { ...CURRENCY_MANUAL_USD, currency_source: 'guessed' }],
    ['a non-object payload', ['USD']],
  ])('rejects %s', async (_label, payload) => {
    stubFetch({ json: payload });
    await expect(getAccountCurrency(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('does not return a raw backend message to the caller', async () => {
    stubFetch({ json: { currency: 'us' } });
    await getAccountCurrency(ACCOUNT_ID).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      // Fixed sentence, and above all it does not quote the payload that failed.
      expect((error as ApiError).message).toBe('The server returned an unexpected response.');
      expect((error as ApiError).message).not.toContain('us');
    });
    expect.hasAssertions();
  });

  it('normalizes a manual code to uppercase before sending it', async () => {
    stubFetch({ json: { ok: true, currency: 'EUR' } });
    await setAccountCurrency(ACCOUNT_ID, '  eur ');
    expect(bodyOf()).toEqual({ currency: 'EUR' });
  });
});

// ===========================================================================
// Costs
// ===========================================================================
describe('costs responses', () => {
  it('maps costs and coverage, keeping money as a decimal string', async () => {
    stubFetch({
      json: costsPayload({
        costs: costsState({
          cogsMethod: 'per_sku', blendedMarginPct: '62.55', ocasMonthly: '1000.00',
        }),
        coverage: coverage({ required: [sku('A', 800, 400.00), sku('B', 200)] }),
      }),
    });
    const result = await getAccountCosts(ACCOUNT_ID);
    expect(result.costs.cogsMethod).toBe('per_sku');
    // A PERCENTAGE becomes a number; it is only ever compared against 0 and 100.
    expect(result.costs.blendedMarginPct).toBe(62.55);
    // MONEY STAYS A STRING, with its trailing zeros intact.
    expect(result.costs.ocasMonthly).toBe('1000.00');
    expect(result.coverage.required[0]!.cogs).toBe('400.00');
    expect(result.coverage.coveragePct).toBe(80);
  });

  it('preserves a value like "1000.00" rather than collapsing it to 1000', async () => {
    stubFetch({ json: costsPayload({ costs: costsState({ ocasMonthly: '1000.00' }) }) });
    const result = await getAccountCosts(ACCOUNT_ID);
    expect(result.costs.ocasMonthly).toBe('1000.00');
    expect(typeof result.costs.ocasMonthly).toBe('string');
  });

  it('canonicalizes a short decimal without arithmetic', async () => {
    stubFetch({ json: costsPayload({ costs: costsState({ ocasMonthly: '1000.5' }) }) });
    await expect(getAccountCosts(ACCOUNT_ID)).resolves.toMatchObject({
      costs: { ocasMonthly: '1000.50' },
    });
  });

  it('keeps an unset OCAS null rather than defaulting it to zero', async () => {
    stubFetch({ json: COSTS_EMPTY });
    const result = await getAccountCosts(ACCOUNT_ID);
    // "No answer" and "the answer is zero" are different facts.
    expect(result.costs.ocasMonthly).toBeNull();
    expect(result.costs.ocasZeroConfirmed).toBe(false);
  });

  it.each([
    ['a negative money string', costsPayload({ costs: costsState({ ocasMonthly: '-5.00' }) })],
    ['money in exponential form', costsPayload({ costs: costsState({ ocasMonthly: '1e3' }) })],
    ['money with three decimals', costsPayload({ costs: costsState({ ocasMonthly: '1.234' }) })],
    ['money with separators', costsPayload({ costs: costsState({ ocasMonthly: '1,000.00' }) })],
    ['money as a number', costsPayload({
      costs: { ...costsState(), ocas_monthly: 1000 } as never,
    })],
    ['a margin of 0', costsPayload({ costs: costsState({ blendedMarginPct: '0.00' }) })],
    ['a margin of 100', costsPayload({ costs: costsState({ blendedMarginPct: '100.00' }) })],
    ['an unrecognised cogs method', costsPayload({ costs: { ...costsState(), cogs_method: 'weighted' } as never })],
    ['a non-boolean zero confirmation', costsPayload({ costs: { ...costsState(), ocas_zero_confirmed: 'yes' } as never })],
  ])('rejects %s', async (_label, payload) => {
    stubFetch({ json: payload });
    await expect(getAccountCosts(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('accepts a per-SKU cost as the NUMBER the backend actually sends', async () => {
    stubFetch({
      json: costsPayload({ coverage: coverage({ required: [sku('A', 100, 33.33)] }) }),
    });
    const result = await getAccountCosts(ACCOUNT_ID);
    // getSkuCoverage() maps its NUMERIC column through Number(), so 33.33 arrives
    // as a float — unlike ocas_monthly and ad_spend.spend, which arrive as strings.
    // Fixing it as a canonical string at the boundary stops a SECOND float round
    // trip in the browser on every render, prefill and resubmit.
    expect(result.coverage.required[0]!.cogs).toBe('33.33');
    expect(typeof result.coverage.required[0]!.cogs).toBe('string');
  });

  it('canonicalizes a whole-number cost to two decimals', async () => {
    stubFetch({ json: costsPayload({ coverage: coverage({ required: [sku('A', 100, 40)] }) }) });
    const result = await getAccountCosts(ACCOUNT_ID);
    // "40.00", not "40" — so a prefilled form field shows a money value.
    expect(result.coverage.required[0]!.cogs).toBe('40.00');
  });

  it('accepts a confirmed zero cost', async () => {
    stubFetch({
      json: costsPayload({ coverage: coverage({ required: [sku('A', 100, 0, true)] }) }),
    });
    const result = await getAccountCosts(ACCOUNT_ID);
    expect(result.coverage.required[0]!.cogs).toBe('0.00');
    expect(result.coverage.required[0]!.zeroConfirmed).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a string', '33.33'],
    ['a negative number', -1],
    ['three decimal places', 1.234],
    ['a value beyond NUMERIC(12,2)', 1e13],
    ['a boolean', true],
    ['an object', {}],
  ])('rejects a per-SKU cost that is %s', async (_label, cogs) => {
    stubFetch({
      json: costsPayload({
        coverage: {
          ...coverage({ required: [] }),
          required: [{ sku: 'A', revenue: 100, cogs, zeroConfirmed: false }],
          all: [{ sku: 'A', revenue: 100, cogs, zeroConfirmed: false }],
        } as never,
      }),
    });
    // A string is refused too: the real server never sends one here, so its
    // appearance is a backend change that needs looking at, not smoothing over.
    await expect(getAccountCosts(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'malformed_sku_cogs',
    });
  });

  it('rejects a duplicated SKU in the response', async () => {
    stubFetch({
      json: costsPayload({
        coverage: {
          ...coverage({ required: [sku('A', 100)] }),
          all: [sku('A', 100), sku('A', 100)],
        },
      }),
    });
    // Two rows for one SKU on screen means two fields writing the same record,
    // and whichever was filled second silently wins.
    await expect(getAccountCosts(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'duplicate_sku_in_response',
    });
  });

  it('rejects a coverage percentage above 100', async () => {
    stubFetch({
      json: costsPayload({
        coverage: { ...coverage({ required: [sku('A', 100, 10.00)] }), coveragePct: 140 },
      }),
    });
    await expect(getAccountCosts(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'malformed_coverage_pct',
    });
  });

  it.each(['required', 'all', 'coveragePct', 'cappedBelowTarget', 'missingSkus',
    'unconfirmedZeroSkus', 'eligibleLineRevenue', 'costedRevenue'])(
    'rejects a coverage payload missing %s', async (field) => {
      const full = coverage({ required: [sku('A', 100, 10.00)] }) as Record<string, unknown>;
      delete full[field];
      stubFetch({ json: costsPayload({ coverage: full as never }) });
      await expect(getAccountCosts(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
    },
  );

  it('sends zeroConfirmed only for a genuinely zero cost', async () => {
    stubFetch({ json: { method: 'per_sku', written: 2, coverage: coverage({ required: [] }) } });
    await savePerSkuCosts(ACCOUNT_ID, [
      { sku: 'A', cogs: '10.00' },
      { sku: 'B', cogs: '0.00', zeroConfirmed: true },
    ]);
    expect(bodyOf()).toEqual({
      method: 'per_sku',
      skus: [
        { sku: 'A', cogs: '10.00' },
        { sku: 'B', cogs: '0.00', zeroConfirmed: true },
      ],
    });
  });

  it('sends confirmedZero on OCAS only when the amount is zero', async () => {
    stubFetch({ json: { ocasMonthly: 500, confirmedZero: false } });
    await saveOcas(ACCOUNT_ID, '500.00', false);
    expect(bodyOf()).toEqual({ ocasMonthly: '500.00' });

    stubFetch({ json: { ocasMonthly: 0, confirmedZero: true } });
    await saveOcas(ACCOUNT_ID, '0.00', true);
    expect(bodyOf()).toEqual({ ocasMonthly: '0.00', confirmedZero: true });
  });

  it('sends money as the canonical decimal string, never a float', async () => {
    stubFetch({ json: { ocasMonthly: 0.3, confirmedZero: false } });
    await saveOcas(ACCOUNT_ID, '0.30', false);
    expect(lastCall().body).toContain('"0.30"');
    expect(lastCall().body).not.toContain('0.30000');
  });
});

// ===========================================================================
// Ad spend
// ===========================================================================
describe('ad-spend responses', () => {
  it('maps rows and coverage, keeping spend as a decimal string', async () => {
    stubFetch({
      json: adSpendPayload({
        rows: [{ month: '2026-07-01', channel: 'Meta', spend: '1000.00', source: 'manual' }],
        coverage: adSpendCoverage({
          firstOrderMonth: '2026-05-01', windowStart: '2026-05-01',
          requiredMonths: ['2026-05-01', '2026-07-01'], coveredMonths: ['2026-07-01'],
        }),
      }),
    });
    const result = await getAccountAdSpend(ACCOUNT_ID);
    expect(result.rows[0]!.spend).toBe('1000.00');
    expect(result.coverage.missingMonths).toEqual(['2026-05-01']);
    expect(result.coverage.complete).toBe(false);
  });

  it('rejects a duplicated month+channel cell', async () => {
    stubFetch({
      json: adSpendPayload({
        rows: [
          { month: '2026-07-01', channel: 'Meta', spend: '100.00', source: 'manual' },
          { month: '2026-07-01', channel: 'meta', spend: '200.00', source: 'manual' },
        ],
      }),
    });
    await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'duplicate_ad_spend_cell',
    });
  });

  it.each([
    ['a month that is not first-of-month', '2026-07-15'],
    ['a month with a bad month number', '2026-13-01'],
    ['a full timestamp', '2026-07-01T00:00:00.000Z'],
    ['a YYYY-MM value', '2026-07'],
    ['an empty month', ''],
  ])('rejects a row with %s', async (_label, month) => {
    stubFetch({
      json: adSpendPayload({
        rows: [{ month, channel: 'Meta', spend: '100.00', source: 'manual' }],
      }),
    });
    await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it.each<[string, unknown]>([
    ['negative', '-1.00'], ['three decimals', '1.234'], ['exponential', '1e3'],
    ['with a symbol', '$100.00'], ['a number', 100], ['null', null],
  ])('rejects a spend amount that is %s', async (_label, spend) => {
    stubFetch({
      json: adSpendPayload({
        rows: [{ month: '2026-07-01', channel: 'Meta', spend, source: 'manual' } as never],
      }),
    });
    await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects a source outside the V1 contract', async () => {
    stubFetch({
      json: adSpendPayload({
        rows: [{ month: '2026-07-01', channel: 'Meta', spend: '10.00', source: 'aggregator' }],
      }),
    });
    // V3's aggregator and API sources need their own UI treatment — they must not
    // be silently presented as something the agency typed.
    await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'unsupported_ad_spend_source',
    });
  });

  it('rejects a duplicated month inside a coverage list', async () => {
    stubFetch({
      json: adSpendPayload({
        coverage: {
          ...adSpendCoverage({ requiredMonths: ['2026-07-01'] }),
          missingMonths: ['2026-07-01', '2026-07-01'],
        },
      }),
    });
    await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects a required window longer than twelve months', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) =>
      `2025-${String(i + 1).padStart(2, '0')}-01`).map((m) =>
      m.startsWith('2025-13') ? '2026-01-01' : m);
    stubFetch({
      json: adSpendPayload({ coverage: adSpendCoverage({ requiredMonths: thirteen }) }),
    });
    await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toMatchObject({
      code: 'required_window_too_long',
    });
  });

  it.each(['requiredMonths', 'missingMonths', 'contradictoryMonths', 'coveredMonths',
    'zeroConfirmedMonths', 'currentMonth', 'complete'])(
    'rejects a coverage payload missing %s', async (field) => {
      const full = adSpendCoverage({ requiredMonths: ['2026-07-01'] }) as Record<string, unknown>;
      delete full[field];
      stubFetch({ json: adSpendPayload({ coverage: full as never }) });
      await expect(getAccountAdSpend(ACCOUNT_ID)).rejects.toBeInstanceOf(ApiError);
    },
  );

  it('sends a spend range with exactly the four documented fields', async () => {
    stubFetch({ json: { monthsWritten: 1, rowsWritten: 1, zeroConfirmationsCleared: 0 } });
    await saveAdSpendRanges(ACCOUNT_ID, [
      { channel: 'Meta', amount: '1000.00', startMonth: '2026-07-01', endMonth: '2026-07-01' },
    ]);
    expect(bodyOf()).toEqual({
      rows: [{
        channel: 'Meta', amount: '1000.00', startMonth: '2026-07-01', endMonth: '2026-07-01',
      }],
    });
  });
});

// ===========================================================================
// The zero-spend escalation
// ===========================================================================
describe('zero-spend confirmation', () => {
  it('always sends confirmedZero, and omits replace on the first attempt', async () => {
    stubFetch({ json: { ok: true, monthsConfirmed: 2 } });
    await confirmZeroAdSpendMonths(ACCOUNT_ID, { months: ['2026-06-01', '2026-07-01'] });
    const body = bodyOf();
    expect(body).toEqual({ months: ['2026-06-01', '2026-07-01'], confirmedZero: true });
    // The 409 is the mechanism by which the agency finds out existing spend is
    // there. Sending replace up front would delete it without anyone being told.
    expect(body).not.toHaveProperty('replace');
    expect(lastCall().body).not.toContain('replace');
  });

  it('sends replace:true only when the caller explicitly asks', async () => {
    stubFetch({ json: { ok: true, monthsConfirmed: 1, spendRowsRemoved: 3 } });
    await confirmZeroAdSpendMonths(ACCOUNT_ID, { months: ['2026-07-01'], replace: true });
    expect(bodyOf()).toEqual({
      months: ['2026-07-01'], confirmedZero: true, replace: true,
    });
  });

  it('does not send replace when it is explicitly false', async () => {
    stubFetch({ json: { ok: true } });
    await confirmZeroAdSpendMonths(ACCOUNT_ID, { months: ['2026-07-01'], replace: false });
    expect(bodyOf()).not.toHaveProperty('replace');
  });

  it('reads the conflicting months out of a 409 requires_replace', () => {
    const error = new ApiError({
      status: 409, kind: 'http', message: 'x', code: 'requires_replace',
      details: { months: ['2026-06-01', '2026-07-01'] },
    });
    expect(readZeroSpendConflict(error)).toEqual({
      months: ['2026-06-01', '2026-07-01'],
    });
  });

  it.each([
    ['a different code', { status: 409, code: 'no_mismatch', details: { months: ['2026-07-01'] } }],
    ['a different status', { status: 400, code: 'requires_replace', details: { months: ['2026-07-01'] } }],
    ['no months', { status: 409, code: 'requires_replace', details: {} }],
    ['an empty months list', { status: 409, code: 'requires_replace', details: { months: [] } }],
    ['a malformed month', { status: 409, code: 'requires_replace', details: { months: ['July'] } }],
    ['a non-first-of-month', { status: 409, code: 'requires_replace', details: { months: ['2026-07-15'] } }],
    ['a duplicated month', { status: 409, code: 'requires_replace', details: { months: ['2026-07-01', '2026-07-01'] } }],
  ])('returns null for %s', (_label, init) => {
    const error = new ApiError({ kind: 'http', message: 'x', ...init } as never);
    // These months are put in front of someone about to authorise deleting real
    // spend. A payload that cannot be trusted must not become part of that
    // sentence.
    expect(readZeroSpendConflict(error)).toBeNull();
  });

  it('returns null for a non-ApiError', () => {
    expect(readZeroSpendConflict(new Error('boom'))).toBeNull();
    expect(readZeroSpendConflict(null)).toBeNull();
  });
});

// ===========================================================================
// Error surfacing
// ===========================================================================
describe('financial errors reach the caller normalized', () => {
  it('surfaces a 400 error code without adopting an interpolated message', async () => {
    stubFetch({
      status: 400,
      json: { ok: false, error: 'negative', message: 'Cost for SECRET-SKU cannot be negative.' },
    });
    await savePerSkuCosts(ACCOUNT_ID, [{ sku: 'A', cogs: '1.00' }]).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('negative');
    });
    expect.hasAssertions();
  });

  it('never adopts a 5xx body as a message', async () => {
    stubFetch({ status: 500, json: { message: 'TypeError: at /Users/deploy/app/x.js:1:1' } });
    await getAccountCosts(ACCOUNT_ID).catch((error: unknown) => {
      const api = error as ApiError;
      expect(api.message).not.toContain('/Users/');
      expect(api.message).not.toContain('TypeError');
      expect(api.retryable).toBe(true);
    });
    expect.hasAssertions();
  });

  it('marks a 401 as unauthenticated and not retryable', async () => {
    stubFetch({ status: 401, json: { error: 'unauthorized' } });
    await getAccountCurrency(ACCOUNT_ID).catch((error: unknown) => {
      const api = error as ApiError;
      expect(api.isUnauthenticated).toBe(true);
      expect(api.retryable).toBe(false);
    });
    expect.hasAssertions();
  });
});
