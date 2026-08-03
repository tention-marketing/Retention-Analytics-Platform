import { api } from './client';
import { ApiError, apiClientError } from './errors';
import { isMoneyString, isMonthString, toCanonicalMoney } from '@/lib/money';
import {
  COGS_METHODS, CURRENCY_SOURCES,
  type AccountCostsResponse, type AccountCurrencyState, type AdSpendCoverage,
  type AdSpendRangeInput, type AdSpendRow, type AdSpendState, type CogsMethod,
  type CurrencySource, type FinancialCostsState, type FinancialWriteOutcome,
  type SkuCostInput, type SkuCoverage, type SkuRevenueCost, type ZeroSpendConflict,
} from '@/types/domain';

// The agency financial-input calls.
//
// EVERY ROUTE HERE IS `/accounts/:accountId/…`, AND THAT IS NOT A STYLE CHOICE.
// The backend exposes a second, CLIENT-facing set — /onboarding/currency,
// /onboarding/cogs, /onboarding/ocas, /onboarding/ad-spend — authenticated by a
// scoped onboarding-link session that this app does not have and must never
// obtain. Those routes take their account from the link, not from a path, so
// calling one from here would either 401 or (worse, if the model ever changed)
// write to whichever account a link happened to point at. The agency app writes
// to the account in the URL it is looking at, authorised by the agency session.
// There is a source-level test asserting no client route name appears here.
//
// AND NO accountId IN A WRITE BODY. The account is the path segment — the thing
// the session is authorised against. A body field naming a different account is
// ignored by the backend (verified: verify:financial-controls asserts the write
// lands on the path's account and leaves the body's account untouched), and
// sending one anyway would document a redirection this app does not perform.
//
// THIS FILE IS THE TRUST BOUNDARY. Two properties are enforced here and nowhere
// else:
//
//   1. MONEY STAYS A DECIMAL STRING. NUMERIC(12,2) arrives as "1000.00". Every
//      amount is validated as a non-negative two-decimal string and kept as one.
//      A `parseFloat` here is how "1000.00" renders as "1000" and how a value
//      round-trips back to the server changed.
//
//   2. A MALFORMED RESPONSE FAILS, IT DOES NOT DEGRADE. A coverage payload that
//      lost a field, a duplicate SKU, two rows for the same month and channel — a
//      UI that quietly skips those looks exactly like a UI reporting the truth,
//      and "advertising spend is complete" is a conclusion an agency acts on.

const MALFORMED = 'The server returned an unexpected response.';

function malformed(code: string): never {
  // The code is for branching and tests. The message is fixed: a validation
  // failure must never quote the payload that failed it.
  throw apiClientError(MALFORMED, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Exactly three uppercase ASCII letters, which is all the backend guarantees. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * A currency code from a RESPONSE.
 *
 * Uppercase-only, because the backend normalizes before storing. Accepting
 * lowercase here would hide a backend regression behind a cosmetic fix.
 */
function parseCurrencyCode(value: unknown, code: string): string {
  if (typeof value !== 'string' || !CURRENCY_CODE.test(value)) malformed(code);
  return value;
}

function nullableCurrencyCode(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return parseCurrencyCode(value, code);
}

/** A finite number in [min, max]. Used for percentages and ratio operands. */
function parseBoundedNumber(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    malformed(code);
  }
  return value;
}

/** A validated money string from a response. */
function parseMoney(value: unknown, code: string): string {
  if (!isMoneyString(value)) malformed(code);
  return toCanonicalMoney(value);
}

function nullableMoney(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return parseMoney(value, code);
}

function parseMonth(value: unknown, code: string): string {
  if (!isMonthString(value)) malformed(code);
  return value;
}

/**
 * A list of first-of-month strings, rejecting duplicates.
 *
 * A duplicated month in `missingMonths` would be shown to the agency as two
 * months to fill in. A duplicated month in `requiredMonths` would make the
 * counts on screen disagree with each other.
 */
function parseMonthList(value: unknown, code: string): string[] {
  if (!Array.isArray(value)) malformed(code);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const month = parseMonth(item, code);
    if (seen.has(month)) malformed(`${code}_duplicate`);
    seen.add(month);
    out.push(month);
  }
  return out;
}

function parseBoolean(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') malformed(code);
  return value;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

function parseCurrencyState(value: unknown): AccountCurrencyState {
  if (!isRecord(value)) malformed('malformed_currency_payload');
  return {
    currency: nullableCurrencyCode(value.currency, 'malformed_currency_payload'),
    // An unrecognised source is refused rather than coerced to null: 'shopify'
    // means the value is authoritative and uneditable, so a third value silently
    // read as "manual" would hand an agency an edit control it must not have.
    currencySource:
      value.currency_source === null || value.currency_source === undefined
        ? null
        : isMember<CurrencySource>(CURRENCY_SOURCES, value.currency_source)
          ? value.currency_source
          : malformed('malformed_currency_source'),
    shopifyCurrencyDetected:
      nullableCurrencyCode(value.shopify_currency_detected, 'malformed_currency_payload'),
  };
}

/** GET /accounts/:accountId/currency. */
export async function getAccountCurrency(
  accountId: number,
  signal?: AbortSignal,
): Promise<AccountCurrencyState> {
  return parseCurrencyState(
    await api.get<unknown>(`/accounts/${accountId}/currency`, signal ? { signal } : {}),
  );
}

/**
 * PUT /accounts/:accountId/currency.
 *
 * ONE FIELD. Trimmed and uppercased here so the request carries the canonical
 * form the backend stores — but the backend normalizes again, because a client
 * that normalizes is a convenience and never a control.
 */
export async function setAccountCurrency(
  accountId: number,
  currency: string,
): Promise<FinancialWriteOutcome> {
  await api.put<unknown>(`/accounts/${accountId}/currency`, {
    currency: currency.trim().toUpperCase(),
  });
  return { ok: true };
}

/**
 * POST /accounts/:accountId/currency/resolve-mismatch — BODYLESS.
 *
 * The route reads no body (verified against the running server: it answers 409
 * `no_mismatch` for an account with none, having been reached with no payload at
 * all), and the shared client only sets Content-Type when there IS a body — which
 * matters, because Fastify rejects a request declaring application/json and then
 * sending nothing.
 *
 * IT CONVERTS NOTHING. This records the agency's decision that the Shopify
 * currency is the right one; it does not touch a single money value. The UI
 * requires an explicit acknowledgement that the affected amounts have already
 * been re-entered, precisely because the server will not do it.
 */
export async function resolveAccountCurrencyMismatch(
  accountId: number,
): Promise<FinancialWriteOutcome> {
  await api.post<unknown>(`/accounts/${accountId}/currency/resolve-mismatch`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/**
 * A per-SKU cost, which arrives as a NUMBER rather than a NUMERIC string.
 *
 * Verified against the running backend: getSkuCoverage() maps its column through
 * `Number()`, so `33.33` is what comes over the wire — unlike ocas_monthly and
 * ad_spend.spend, which arrive as strings and stay strings. The float conversion
 * has therefore already happened server-side and cannot be undone here; what this
 * does is stop a SECOND one happening in the browser on every render, prefill and
 * resubmit, by fixing the value as a canonical two-decimal string at the edge.
 *
 * Still validated as money: non-negative, finite, at most two decimal places.
 */
function parseSkuCogs(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) malformed(code);
  if (Math.round(value * 100) !== value * 100) malformed(code);
  if (value > 9_999_999_999.99) malformed(code);
  // toFixed(2) on a value already known to have at most two decimal places is
  // exact for every magnitude NUMERIC(12,2) can hold.
  return toCanonicalMoney(value.toFixed(2));
}

function parseSkuRow(value: unknown): SkuRevenueCost {
  if (!isRecord(value)) malformed('malformed_sku_row');
  if (typeof value.sku !== 'string' || value.sku === '') malformed('malformed_sku_row');
  // Revenue is a ratio operand the backend already rounded. Non-negative and
  // finite; it is never added to anything here.
  const revenue = parseBoundedNumber(value.revenue, 0, Number.MAX_SAFE_INTEGER,
    'malformed_sku_revenue');
  return {
    sku: value.sku,
    revenue,
    cogs: parseSkuCogs(value.cogs, 'malformed_sku_cogs'),
    zeroConfirmed: parseBoolean(value.zeroConfirmed, 'malformed_sku_row'),
  };
}

/**
 * A SKU list, rejecting duplicates.
 *
 * The backend GROUPs BY sku, so a duplicate is impossible today — which is why
 * its appearance is treated as a regression rather than deduplicated. Two rows
 * for one SKU on screen means two cost fields writing to the same record, and
 * whichever one the user filled second silently wins.
 */
function parseSkuList(value: unknown, code: string): SkuRevenueCost[] {
  if (!Array.isArray(value)) malformed(code);
  const out: SkuRevenueCost[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = parseSkuRow(item);
    if (seen.has(row.sku)) malformed('duplicate_sku_in_response');
    seen.add(row.sku);
    out.push(row);
  }
  return out;
}

function parseStringList(value: unknown, code: string): string[] {
  if (!Array.isArray(value)) malformed(code);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') malformed(code);
    out.push(item);
  }
  return out;
}

function parseCoverage(value: unknown): SkuCoverage {
  if (!isRecord(value)) malformed('malformed_coverage_payload');
  return {
    required: parseSkuList(value.required, 'malformed_coverage_payload'),
    all: parseSkuList(value.all, 'malformed_coverage_payload'),
    eligibleLineRevenue: parseBoundedNumber(value.eligibleLineRevenue, 0,
      Number.MAX_SAFE_INTEGER, 'malformed_coverage_payload'),
    costedRevenue: parseBoundedNumber(value.costedRevenue, 0,
      Number.MAX_SAFE_INTEGER, 'malformed_coverage_payload'),
    // A percentage. Bounded at 100 because it is a share of a whole, and a
    // figure above it would mean the numerator and denominator had come from
    // different measures — the exact bug the domain note warns about.
    coveragePct: parseBoundedNumber(value.coveragePct, 0, 100, 'malformed_coverage_pct'),
    cappedBelowTarget: parseBoolean(value.cappedBelowTarget, 'malformed_coverage_payload'),
    missingSkus: parseStringList(value.missingSkus, 'malformed_coverage_payload'),
    unconfirmedZeroSkus: parseStringList(value.unconfirmedZeroSkus, 'malformed_coverage_payload'),
  };
}

function parseCostsState(value: unknown): FinancialCostsState {
  if (!isRecord(value)) malformed('malformed_costs_payload');
  return {
    cogsMethod:
      value.cogs_method === null || value.cogs_method === undefined
        ? null
        : isMember<CogsMethod>(COGS_METHODS, value.cogs_method)
          ? value.cogs_method
          : malformed('malformed_cogs_method'),
    // NUMERIC(5,2) arrives as a string. It is a PERCENTAGE, so it becomes a
    // number — it is never summed, only compared against 0 and 100.
    blendedMarginPct: (() => {
      const raw = value.blended_margin_pct;
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== 'string' || !/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
        malformed('malformed_blended_margin');
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n >= 100) malformed('malformed_blended_margin');
      return n;
    })(),
    // A money string, and null when never entered. NEVER defaulted to "0.00":
    // "no answer" and "the answer is zero" are different facts, and the whole
    // zero-confirmation mechanism exists to keep them apart.
    ocasMonthly: nullableMoney(value.ocas_monthly, 'malformed_ocas'),
    ocasZeroConfirmed: parseBoolean(value.ocas_zero_confirmed, 'malformed_costs_payload'),
  };
}

/** GET /accounts/:accountId/costs — costs and coverage in one round trip. */
export async function getAccountCosts(
  accountId: number,
  signal?: AbortSignal,
): Promise<AccountCostsResponse> {
  const body = await api.get<unknown>(`/accounts/${accountId}/costs`, signal ? { signal } : {});
  if (!isRecord(body)) malformed('malformed_costs_payload');
  return { costs: parseCostsState(body.costs), coverage: parseCoverage(body.coverage) };
}

/**
 * PUT /accounts/:accountId/costs with the blended method.
 *
 * A percentage, so NO CURRENCY IS REQUIRED — a gross margin is
 * currency-independent, which is exactly why the backend excludes it from the
 * money values a currency mismatch affects.
 */
export async function saveBlendedMargin(
  accountId: number,
  blendedMarginPct: number,
): Promise<FinancialWriteOutcome> {
  await api.put<unknown>(`/accounts/${accountId}/costs`, {
    method: 'blended',
    blendedMarginPct,
  });
  return { ok: true };
}

/**
 * PUT /accounts/:accountId/costs with per-SKU costs.
 *
 * PARTIAL SAVES ARE THE NORM. The backend upserts whatever it is given, so a user
 * who has costed six of twenty SKUs keeps that work — nothing here requires the
 * set to be complete before it will send.
 *
 * `zeroConfirmed` is sent ONLY when the amount is genuinely zero. Sending it
 * alongside a positive cost would be meaningless, and sending it by default would
 * pre-authorise a zero nobody confirmed.
 */
export async function savePerSkuCosts(
  accountId: number,
  rows: SkuCostInput[],
): Promise<FinancialWriteOutcome> {
  await api.put<unknown>(`/accounts/${accountId}/costs`, {
    method: 'per_sku',
    skus: rows.map((row) => ({
      sku: row.sku,
      cogs: row.cogs,
      ...(row.zeroConfirmed === true ? { zeroConfirmed: true } : {}),
    })),
  });
  return { ok: true };
}

/**
 * PUT /accounts/:accountId/costs/ocas.
 *
 * `confirmedZero` is sent only for a genuine zero, for the same reason as above.
 */
export async function saveOcas(
  accountId: number,
  ocasMonthly: string,
  confirmedZero: boolean,
): Promise<FinancialWriteOutcome> {
  await api.put<unknown>(`/accounts/${accountId}/costs/ocas`, {
    ocasMonthly,
    ...(confirmedZero ? { confirmedZero: true } : {}),
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ad spend
// ---------------------------------------------------------------------------

/**
 * The stored spend rows, rejecting a duplicated month+channel cell.
 *
 * The primary key is (account_id, month, channel, source), so two rows for one
 * cell can only differ by source — and V1 writes only 'manual'. Two cells with
 * the same month and channel on screen would show one month's spend twice and
 * make any total the agency computed by eye wrong.
 */
function parseAdSpendRows(value: unknown): AdSpendRow[] {
  if (!Array.isArray(value)) malformed('malformed_ad_spend_rows');
  const out: AdSpendRow[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) malformed('malformed_ad_spend_rows');
    const month = parseMonth(item.month, 'malformed_ad_spend_month');
    if (typeof item.channel !== 'string' || item.channel === '') {
      malformed('malformed_ad_spend_rows');
    }
    // 'manual' is the only source V1 produces. A future 'api'/'aggregator' value
    // is a V3 feature that needs its own UI treatment (it must not be presented
    // as something the agency typed), so an unknown source is refused rather than
    // silently rendered as manual.
    if (item.source !== 'manual') malformed('unsupported_ad_spend_source');
    const cell = `${month}|${item.channel.toLowerCase()}|${item.source}`;
    if (seen.has(cell)) malformed('duplicate_ad_spend_cell');
    seen.add(cell);
    out.push({
      month,
      channel: item.channel,
      spend: parseMoney(item.spend, 'malformed_ad_spend_amount'),
      source: item.source,
    });
  }
  return out;
}

function parseAdSpendCoverage(value: unknown): AdSpendCoverage {
  if (!isRecord(value)) malformed('malformed_ad_spend_coverage');
  const firstOrderMonth = value.firstOrderMonth === null || value.firstOrderMonth === undefined
    ? null
    : parseMonth(value.firstOrderMonth, 'malformed_ad_spend_coverage');
  const windowStart = value.windowStart === null || value.windowStart === undefined
    ? null
    : parseMonth(value.windowStart, 'malformed_ad_spend_coverage');
  const requiredMonths = parseMonthList(value.requiredMonths, 'malformed_required_months');
  // The 12-month cap is the backend's rule. Asserting it here does not
  // re-implement the window — it refuses a payload that has broken its own
  // contract, which is not something to render 40 month rows from.
  if (requiredMonths.length > 12) malformed('required_window_too_long');
  return {
    firstOrderMonth,
    currentMonth: parseMonth(value.currentMonth, 'malformed_ad_spend_coverage'),
    windowStart,
    requiredMonths,
    missingMonths: parseMonthList(value.missingMonths, 'malformed_missing_months'),
    contradictoryMonths: parseMonthList(value.contradictoryMonths,
      'malformed_contradictory_months'),
    coveredMonths: parseMonthList(value.coveredMonths, 'malformed_covered_months'),
    zeroConfirmedMonths: parseMonthList(value.zeroConfirmedMonths, 'malformed_zero_months'),
    complete: parseBoolean(value.complete, 'malformed_ad_spend_coverage'),
  };
}

/** GET /accounts/:accountId/ad-spend. */
export async function getAccountAdSpend(
  accountId: number,
  signal?: AbortSignal,
): Promise<AdSpendState> {
  const body = await api.get<unknown>(`/accounts/${accountId}/ad-spend`, signal ? { signal } : {});
  if (!isRecord(body)) malformed('malformed_ad_spend_payload');
  return {
    rows: parseAdSpendRows(body.rows),
    coverage: parseAdSpendCoverage(body.coverage),
    suggestedChannels: parseStringList(body.suggestedChannels, 'malformed_suggested_channels'),
  };
}

/**
 * PUT /accounts/:accountId/ad-spend.
 *
 * POSITIVE AMOUNTS ONLY. A zero-spend month is a claim, and it goes through
 * confirmZeroAdSpendMonths() below — the backend refuses `amount: 0` here with
 * `zero_requires_confirmation`, so this is the same rule stated on both sides
 * rather than a client-side courtesy.
 */
export async function saveAdSpendRanges(
  accountId: number,
  rows: AdSpendRangeInput[],
): Promise<FinancialWriteOutcome> {
  await api.put<unknown>(`/accounts/${accountId}/ad-spend`, {
    rows: rows.map((row) => ({
      channel: row.channel,
      amount: row.amount,
      startMonth: row.startMonth,
      endMonth: row.endMonth,
    })),
  });
  return { ok: true };
}

/**
 * Read the months out of a 409 `requires_replace`.
 *
 * `months` reaches us through ApiError's SAFE_DETAIL_KEYS allowlist, and is
 * validated here before anything is shown: these month strings are put in front
 * of an agency user about to authorise the deletion of real spend rows, so a
 * malformed list must not become part of that sentence. Returns null when the
 * error is not that conflict, or when the payload cannot be trusted.
 */
export function readZeroSpendConflict(error: unknown): ZeroSpendConflict | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409 || error.code !== 'requires_replace') return null;
  const raw = error.details?.months;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const months: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isMonthString(item) || seen.has(item)) return null;
    seen.add(item);
    months.push(item);
  }
  return { months };
}

export interface ZeroSpendRequest {
  months: string[];
  /**
   * Omitted on the FIRST attempt, always.
   *
   * Sending it up front would delete existing spend without anyone being told it
   * was there — the 409 is the whole mechanism by which the agency finds out.
   */
  replace?: boolean;
}

/**
 * POST /accounts/:accountId/ad-spend/zero.
 *
 * `confirmedZero: true` is not optional and is not a default the caller can
 * forget: there is no code path here that omits it, because the backend's refusal
 * is the point and a caller who has not confirmed should not be calling.
 */
export async function confirmZeroAdSpendMonths(
  accountId: number,
  request: ZeroSpendRequest,
): Promise<FinancialWriteOutcome> {
  await api.post<unknown>(`/accounts/${accountId}/ad-spend/zero`, {
    months: request.months,
    confirmedZero: true,
    ...(request.replace === true ? { replace: true } : {}),
  });
  return { ok: true };
}
