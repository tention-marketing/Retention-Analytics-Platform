import type { RouteStub } from './server';

// Shared financial-route fixtures.
//
// The account workspace now renders the financial-inputs section, so EVERY test
// that mounts that page issues three more requests — currency, costs and ad
// spend. stubFetchRoutes throws on an unrouted call by design (an unstubbed
// request is a test bug, not a 404 to swallow), so those three have to be part of
// every workspace's base routes.
//
// Kept in one place rather than copied into each suite: the payloads have to match
// the real response shapes exactly, because api/financial.ts validates them
// strictly and rejects anything malformed. Three divergent hand-written copies of
// these objects would drift, and the drift would show up as a "malformed response"
// failure in a suite testing something else entirely.
//
// EVERY VALUE HERE IS SYNTHETIC. The SKUs, channels and amounts are obviously
// fake and no real brand's figures appear.

export function financialRouteKeys(accountId: number) {
  return {
    currency: `GET /api/accounts/${accountId}/currency`,
    setCurrency: `PUT /api/accounts/${accountId}/currency`,
    resolveMismatch: `POST /api/accounts/${accountId}/currency/resolve-mismatch`,
    costs: `GET /api/accounts/${accountId}/costs`,
    saveCosts: `PUT /api/accounts/${accountId}/costs`,
    saveOcas: `PUT /api/accounts/${accountId}/costs/ocas`,
    adSpend: `GET /api/accounts/${accountId}/ad-spend`,
    saveAdSpend: `PUT /api/accounts/${accountId}/ad-spend`,
    zeroAdSpend: `POST /api/accounts/${accountId}/ad-spend/zero`,
  } as const;
}

/** Wire shape of GET /accounts/:id/currency — snake_case, as the columns are. */
export const CURRENCY_UNKNOWN = {
  currency: null,
  currency_source: null,
  shopify_currency_detected: null,
};

export const CURRENCY_MANUAL_USD = {
  currency: 'USD',
  currency_source: 'manual',
  shopify_currency_detected: null,
};

export const CURRENCY_SHOPIFY_USD = {
  currency: 'USD',
  currency_source: 'shopify',
  shopify_currency_detected: 'USD',
};

/** Case 4 of Correction 1: both values kept, nothing converted. */
export const CURRENCY_MISMATCH = {
  currency: 'CAD',
  currency_source: 'manual',
  shopify_currency_detected: 'USD',
};

/**
 * A SKU row AS THE WIRE CARRIES IT.
 *
 * `cogs` is a NUMBER here, not a string, because that is what the backend sends:
 * getSkuCoverage() maps its NUMERIC column through `Number()`. ocas_monthly and
 * ad_spend.spend are strings; this one is not, and a fixture that pretended
 * otherwise would let the boundary validator pass a payload the real server never
 * produces.
 */
export interface SkuFixture {
  sku: string;
  revenue: number;
  cogs: number | null;
  zeroConfirmed: boolean;
}

export function sku(
  name: string,
  revenue: number,
  cogs: number | null = null,
  zeroConfirmed = false,
): SkuFixture {
  return { sku: name, revenue, cogs, zeroConfirmed };
}

/**
 * A coverage payload with the arithmetic done for you.
 *
 * `coveragePct` is computed from the rows rather than passed in, so a fixture
 * cannot state a percentage its own rows contradict — the boundary validator
 * bounds it at 100, and a hand-written 85 next to rows summing to 40 would be a
 * fixture that tests nothing real.
 */
export function coverage(options: {
  required: SkuFixture[];
  all?: SkuFixture[];
  cappedBelowTarget?: boolean;
}) {
  const all = options.all ?? options.required;
  const eligible = all.reduce((sum, row) => sum + row.revenue, 0);
  const costed = all.filter((row) => row.cogs !== null).reduce((sum, row) => sum + row.revenue, 0);
  const pct = eligible > 0 ? Math.round((costed / eligible) * 10000) / 100 : 0;
  return {
    required: options.required,
    all,
    eligibleLineRevenue: eligible,
    costedRevenue: costed,
    coveragePct: pct,
    cappedBelowTarget: options.cappedBelowTarget ?? false,
    missingSkus: options.required.filter((row) => row.cogs === null).map((row) => row.sku),
    unconfirmedZeroSkus: all
      .filter((row) => row.cogs === 0 && !row.zeroConfirmed)
      .map((row) => row.sku),
  };
}

/** Wire shape of the `costs` half of GET /accounts/:id/costs. */
export function costsState(options: {
  cogsMethod?: 'per_sku' | 'blended' | null;
  blendedMarginPct?: string | null;
  ocasMonthly?: string | null;
  ocasZeroConfirmed?: boolean;
} = {}) {
  return {
    cogs_method: options.cogsMethod ?? null,
    blended_margin_pct: options.blendedMarginPct ?? null,
    ocas_monthly: options.ocasMonthly ?? null,
    ocas_zero_confirmed: options.ocasZeroConfirmed ?? false,
  };
}

export const COSTS_EMPTY = {
  costs: costsState(),
  coverage: coverage({ required: [] }),
};

export function adSpendCoverage(options: {
  firstOrderMonth?: string | null;
  currentMonth?: string;
  windowStart?: string | null;
  requiredMonths?: string[];
  missingMonths?: string[];
  contradictoryMonths?: string[];
  coveredMonths?: string[];
  zeroConfirmedMonths?: string[];
  complete?: boolean;
} = {}) {
  const required = options.requiredMonths ?? [];
  const covered = options.coveredMonths ?? [];
  const zero = options.zeroConfirmedMonths ?? [];
  const missing = options.missingMonths ?? required.filter((m) => !covered.includes(m));
  const contradictory = options.contradictoryMonths ?? [];
  return {
    firstOrderMonth: options.firstOrderMonth ?? null,
    currentMonth: options.currentMonth ?? '2026-08-01',
    windowStart: options.windowStart ?? null,
    requiredMonths: required,
    missingMonths: missing,
    contradictoryMonths: contradictory,
    coveredMonths: covered,
    zeroConfirmedMonths: zero,
    complete: options.complete ?? (missing.length === 0 && contradictory.length === 0),
  };
}

export const SUGGESTED_CHANNELS = [
  'Meta', 'Google', 'TikTok', 'Pinterest', 'Snapchat', 'Amazon', 'Influencer', 'Affiliate', 'Other',
] as const;

/** One stored spend row, as the wire carries it. */
export interface AdSpendRowFixture {
  month: string;
  channel: string;
  spend: string;
  source: string;
}

export const AD_SPEND_EMPTY: {
  rows: AdSpendRowFixture[];
  coverage: ReturnType<typeof adSpendCoverage>;
  suggestedChannels: string[];
} = {
  // Typed explicitly: an empty literal infers `never[]`, and every suite that
  // spreads this fixture and adds a row would then fail to compile.
  rows: [],
  coverage: adSpendCoverage(),
  suggestedChannels: [...SUGGESTED_CHANNELS],
};

/**
 * The three GET routes every workspace render needs, all in their "nothing
 * configured yet" state.
 *
 * A suite testing something unrelated to money gets a workspace that loads
 * cleanly; a suite testing the financial controls overrides whichever of the
 * three it cares about.
 */
export function financialBaseRoutes(accountId: number): Record<string, RouteStub> {
  const keys = financialRouteKeys(accountId);
  return {
    [keys.currency]: { json: CURRENCY_UNKNOWN },
    [keys.costs]: { json: COSTS_EMPTY },
    [keys.adSpend]: { json: AD_SPEND_EMPTY },
  };
}
