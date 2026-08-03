import { query, withTransaction } from '../db/pool.js';
import { hasAtMostTwoDecimals, parseAmount } from './amount.js';

// COGS and OCAS services (D4 / D5 / E2 / E3).

/** E2: the required per-SKU set must reach this share of eligible revenue. */
export const COGS_COVERAGE_TARGET_PCT = 80;
/** E2: never show more than this many SKUs in the default required set. */
export const MAX_REQUIRED_SKUS = 20;

const NUMERIC_12_2_MAX = 9_999_999_999.99;

export type CogsMethod = 'per_sku' | 'blended';

export interface SkuRevenue {
  sku: string;
  revenue: number;
  cogs: number | null;
  zeroConfirmed: boolean;
}

export interface SkuCoverage {
  /** The default required set: smallest group reaching 80%, capped at 20. */
  required: SkuRevenue[];
  /** Every eligible SKU with revenue, so costs can be added beyond the top 20. */
  all: SkuRevenue[];
  /**
   * Denominator for coverage: trailing-12-month line-item revenue over eligible
   * (non-cancelled, non-test) orders.
   *
   * This is LINE-ITEM revenue (price x quantity), which is gross of order-level
   * discounts and refunds — unlike orders.total_net, which Phase 6 uses for RCM
   * revenue. Coverage is a RATIO, so numerator and denominator must be the same
   * measure; mixing line revenue with total_net would produce a coverage figure
   * that is wrong in both directions. Never present this as a revenue figure.
   */
  eligibleLineRevenue: number;
  /** Line revenue attributable to SKUs that already have a cost. */
  costedRevenue: number;
  /** costedRevenue / eligibleLineRevenue, as a percentage. */
  coveragePct: number;
  /** True when the top-20 cap cannot reach the target (E2's edge case). */
  cappedBelowTarget: boolean;
  /** Required SKUs still lacking a cost. */
  missingSkus: string[];
  /** Costed SKUs with cogs = 0 and no explicit confirmation. */
  unconfirmedZeroSkus: string[];
}

/**
 * Per-SKU revenue over the trailing 12 months, filtered by account_id, excluding
 * cancelled/test orders and blank/null SKUs, joined to any cost already entered.
 *
 * Month boundaries use the account's store timezone so the window matches the
 * ad-spend window and Phase 6's day math (trap #4).
 */
export async function getSkuCoverage(accountId: number): Promise<SkuCoverage> {
  const { rows } = await query<{
    sku: string; revenue: string; cogs: string | null; zero_confirmed: boolean | null;
  }>(
    `WITH tz AS (
       SELECT COALESCE(store_timezone, 'UTC') AS name FROM accounts WHERE id = $1
     ), win AS (
       SELECT (date_trunc('month', (now() AT TIME ZONE (SELECT name FROM tz)))
               - interval '11 months')::date AS start_month
     )
     SELECT li.sku,
            SUM(li.price * li.quantity)::numeric(14,2) AS revenue,
            MAX(sc.cogs)                               AS cogs,
            BOOL_OR(sc.zero_confirmed)                 AS zero_confirmed
       FROM line_items li
       JOIN orders o
         ON o.account_id = li.account_id AND o.id = li.order_id
       -- v_active_sku_costs, not sku_costs: the inactive method's retained values
       -- must never influence coverage (E3).
       LEFT JOIN v_active_sku_costs sc
         ON sc.account_id = li.account_id AND sc.sku = li.sku
      WHERE li.account_id = $1
        AND o.cancelled = false AND o.test = false
        AND li.sku IS NOT NULL AND btrim(li.sku) <> ''
        AND (o.created_at AT TIME ZONE (SELECT name FROM tz))
              >= (SELECT start_month FROM win)
      GROUP BY li.sku
      HAVING SUM(li.price * li.quantity) > 0
      ORDER BY revenue DESC`,
    [accountId],
  );

  const all: SkuRevenue[] = rows.map((r) => ({
    sku: r.sku,
    revenue: Number(r.revenue),
    cogs: r.cogs === null ? null : Number(r.cogs),
    zeroConfirmed: r.zero_confirmed === true,
  }));

  const eligibleLineRevenue = all.reduce((s, r) => s + r.revenue, 0);

  // Smallest group reaching the target, capped at MAX_REQUIRED_SKUS.
  const required: SkuRevenue[] = [];
  let running = 0;
  for (const row of all) {
    if (required.length >= MAX_REQUIRED_SKUS) break;
    required.push(row);
    running += row.revenue;
    if (eligibleLineRevenue > 0 && (running / eligibleLineRevenue) * 100 >= COGS_COVERAGE_TARGET_PCT) {
      break;
    }
  }
  const requiredShare = eligibleLineRevenue > 0 ? (running / eligibleLineRevenue) * 100 : 0;

  // Coverage counts EVERY costed SKU, not just the required ones, so entering
  // costs beyond the initial 20 genuinely improves coverage (E2).
  const costedRevenue = all.filter((r) => r.cogs !== null).reduce((s, r) => s + r.revenue, 0);
  const coveragePct = eligibleLineRevenue > 0 ? (costedRevenue / eligibleLineRevenue) * 100 : 0;

  return {
    required,
    all,
    eligibleLineRevenue: round2(eligibleLineRevenue),
    costedRevenue: round2(costedRevenue),
    coveragePct: round2(coveragePct),
    cappedBelowTarget: required.length >= MAX_REQUIRED_SKUS && requiredShare < COGS_COVERAGE_TARGET_PCT,
    missingSkus: required.filter((r) => r.cogs === null).map((r) => r.sku),
    unconfirmedZeroSkus: all
      .filter((r) => r.cogs !== null && r.cogs === 0 && !r.zeroConfirmed)
      .map((r) => r.sku),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message: string };

/** D4 method 2: > 0, < 100, max 2dp, finite, within NUMERIC(5,2). */
export function validateBlendedMargin(input: unknown): ValidationResult<number> {
  // parseAmount, not Number(): a whitespace-only field, an array and a boolean all
  // coerce to a number and none of them is one. See onboarding/amount.ts.
  const parsed = parseAmount(input);
  if (!parsed.ok) {
    return { ok: false, error: 'not_a_number', message: 'Enter a gross margin percentage.' };
  }
  const n = parsed.value;
  if (n <= 0 || n >= 100) {
    return {
      ok: false, error: 'out_of_range',
      message: 'Gross margin must be greater than 0 and less than 100.',
    };
  }
  if (!hasAtMostTwoDecimals(n)) {
    return {
      ok: false, error: 'too_precise',
      message: 'Gross margin supports at most two decimal places.',
    };
  }
  return { ok: true, value: n };
}

export interface SkuCostInput {
  sku: string;
  cogs: number;
  zeroConfirmed?: boolean;
}

/** D4 method 1 per-value rules. Ownership of the SKU is checked separately. */
export function validateSkuCost(input: unknown): ValidationResult<SkuCostInput> {
  const row = (input ?? {}) as { sku?: unknown; cogs?: unknown; zeroConfirmed?: unknown };
  if (typeof row.sku !== 'string' || !row.sku.trim()) {
    return { ok: false, error: 'sku_required', message: 'A SKU is required.' };
  }
  // An empty field is never read as zero (D4/D5) — and `'   '` is an empty field,
  // which `Number()` alone would have turned into a real 0 that the zero
  // confirmation below would then happily store. See onboarding/amount.ts.
  const parsed = parseAmount(row.cogs);
  if (!parsed.ok) {
    return { ok: false, error: 'not_a_number', message: `Enter a cost for ${row.sku}.` };
  }
  const n = parsed.value;
  if (n < 0) {
    return { ok: false, error: 'negative', message: `Cost for ${row.sku} cannot be negative.` };
  }
  if (n > NUMERIC_12_2_MAX) {
    return { ok: false, error: 'too_large', message: `Cost for ${row.sku} is too large.` };
  }
  if (!hasAtMostTwoDecimals(n)) {
    return {
      ok: false, error: 'too_precise',
      message: `Cost for ${row.sku} supports at most two decimal places.`,
    };
  }
  if (n === 0 && row.zeroConfirmed !== true) {
    return {
      ok: false, error: 'zero_unconfirmed',
      message: `Confirm that the true cost of ${row.sku} is zero.`,
    };
  }
  return { ok: true, value: { sku: row.sku.trim(), cogs: n, zeroConfirmed: row.zeroConfirmed === true } };
}

/** D5: finite, non-negative, within precision; zero only when confirmed. */
export function validateOcas(
  input: unknown,
  confirmedZero: boolean,
): ValidationResult<{ ocas: number; confirmedZero: boolean }> {
  // A blank field is never read as zero (D5). `'   '`, `'\t'` and `[]` all coerce
  // to 0 through `Number()`, and paired with `confirmedZero` below that stored a
  // CONFIRMED zero monthly operating cost nobody had entered — which makes the
  // "RCM >= OCAS -> self-funding" verdict trivially true. See onboarding/amount.ts.
  const parsed = parseAmount(input);
  if (!parsed.ok) {
    return { ok: false, error: 'not_a_number', message: 'Enter a monthly operating cost.' };
  }
  const n = parsed.value;
  if (n < 0) {
    return { ok: false, error: 'negative', message: 'Operating cost cannot be negative.' };
  }
  if (n > NUMERIC_12_2_MAX) {
    return { ok: false, error: 'too_large', message: 'Operating cost is too large.' };
  }
  if (!hasAtMostTwoDecimals(n)) {
    return {
      ok: false, error: 'too_precise',
      message: 'Operating cost supports at most two decimal places.',
    };
  }
  if (n === 0 && !confirmedZero) {
    // A zero OCAS makes the "RCM >= OCAS -> self-funding" verdict trivially
    // true, so it must be a deliberate statement rather than a blank field.
    return {
      ok: false, error: 'zero_unconfirmed',
      message: 'Confirm that the true monthly operating cost allocation is zero.',
    };
  }
  return { ok: true, value: { ocas: n, confirmedZero } };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function ensureAccountCostsRow(accountId: number): Promise<void> {
  await query(
    `INSERT INTO account_costs (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
}

/**
 * E3: switching method RETAINS the other method's values — 20 SKUs of entered
 * work is never silently destroyed. cogs_method alone decides which is active,
 * and the v_active_* views make the inactive values unreadable to every consumer
 * including Phase 6's raw SQL.
 */
export async function setCogsMethod(accountId: number, method: CogsMethod): Promise<void> {
  await ensureAccountCostsRow(accountId);
  await query(`UPDATE account_costs SET cogs_method = $2 WHERE account_id = $1`, [accountId, method]);
}

export async function setBlendedMargin(accountId: number, pct: number): Promise<void> {
  await ensureAccountCostsRow(accountId);
  await query(
    `UPDATE account_costs SET blended_margin_pct = $2, cogs_method = 'blended' WHERE account_id = $1`,
    [accountId, pct],
  );
}

export type SkuCostWriteResult =
  | { ok: true; written: number }
  | { ok: false; error: 'unknown_skus'; message: string; skus: string[] };

/**
 * Upsert per-SKU costs.
 *
 * Cross-tenant guard: every SKU must already appear in THIS account's
 * line_items. A SKU that belongs to another account (or to no account) is
 * rejected outright rather than silently stored, so cost rows can never be
 * seeded into an account from outside its own data.
 */
export async function upsertSkuCosts(
  accountId: number,
  rows: SkuCostInput[],
): Promise<SkuCostWriteResult> {
  if (rows.length === 0) return { ok: true, written: 0 };

  const skus = rows.map((r) => r.sku);
  const { rows: known } = await query<{ sku: string }>(
    `SELECT DISTINCT sku FROM line_items
      WHERE account_id = $1 AND sku = ANY($2::text[])`,
    [accountId, skus],
  );
  const knownSet = new Set(known.map((k) => k.sku));
  const unknown = skus.filter((s) => !knownSet.has(s));
  if (unknown.length > 0) {
    return {
      ok: false, error: 'unknown_skus', skus: unknown,
      message: `These SKUs are not in this account's order history: ${unknown.join(', ')}`,
    };
  }

  await ensureAccountCostsRow(accountId);
  await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO sku_costs (account_id, sku, cogs, zero_confirmed)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, sku)
         DO UPDATE SET cogs = EXCLUDED.cogs, zero_confirmed = EXCLUDED.zero_confirmed`,
        [accountId, r.sku, r.cogs, r.zeroConfirmed === true],
      );
    }
  });
  return { ok: true, written: rows.length };
}

export async function setOcas(
  accountId: number,
  ocas: number,
  confirmedZero: boolean,
): Promise<void> {
  await ensureAccountCostsRow(accountId);
  await query(
    `UPDATE account_costs SET ocas_monthly = $2, ocas_zero_confirmed = $3 WHERE account_id = $1`,
    [accountId, ocas, confirmedZero],
  );
}

export interface AccountCostsRow {
  cogs_method: CogsMethod | null;
  blended_margin_pct: string | null;
  ocas_monthly: string | null;
  ocas_zero_confirmed: boolean;
}

export async function getAccountCosts(accountId: number): Promise<AccountCostsRow> {
  const { rows } = await query<AccountCostsRow>(
    `SELECT cogs_method, blended_margin_pct, ocas_monthly, ocas_zero_confirmed
       FROM account_costs WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] ?? {
    cogs_method: null, blended_margin_pct: null, ocas_monthly: null, ocas_zero_confirmed: false,
  };
}
