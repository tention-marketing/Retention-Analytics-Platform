import { query } from '../db/pool.js';

// Currency and store timezone (D7 / E4 / E5 / E6 / Correction 1).
//
// V1 is one currency per account. Nothing is guessed, nothing is converted, and
// values in two currencies are never combined — so when Shopify contradicts a
// manually entered currency the only honest behaviour is to preserve BOTH values
// and raise a readiness blocker for agency resolution.

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && CURRENCY_RE.test(code.trim().toUpperCase());
}

export function normalizeCurrencyCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A timezone is valid only if the ICU database actually knows it. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface AccountCurrencyState {
  currency: string | null;
  currency_source: 'shopify' | 'manual' | null;
  shopify_currency_detected: string | null;
}

export async function getCurrencyState(accountId: number): Promise<AccountCurrencyState | null> {
  const { rows } = await query<AccountCurrencyState>(
    `SELECT currency, currency_source, shopify_currency_detected
       FROM accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/**
 * Does the account hold money values that are denominated in `accounts.currency`?
 *
 * Blended gross margin is deliberately excluded: it is a percentage, so it is
 * currency-independent and must not trigger a mismatch (E4). OCAS, per-SKU COGS
 * and ad spend are all money.
 */
export async function hasMoneyRows(accountId: number): Promise<boolean> {
  const { rows } = await query<{ present: boolean }>(
    `SELECT (
        EXISTS (SELECT 1 FROM account_costs WHERE account_id = $1 AND ocas_monthly IS NOT NULL)
     OR EXISTS (SELECT 1 FROM sku_costs     WHERE account_id = $1)
     OR EXISTS (SELECT 1 FROM ad_spend      WHERE account_id = $1)
     ) AS present`,
    [accountId],
  );
  return rows[0]?.present === true;
}

export type ShopifyCurrencyOutcome =
  | 'adopted_no_previous'      // case 1
  | 'confirmed_match'          // case 2
  | 'replaced_no_money_rows'   // case 3
  | 'mismatch_preserved';      // case 4

/**
 * Apply the currency Shopify reports (Correction 1). Four cases, and in every
 * one `shopify_currency_detected` is recorded so the detected value is never
 * lost:
 *
 *  1. no existing currency          → adopt Shopify's, source='shopify'
 *  2. manual value matches Shopify  → keep value, upgrade source to 'shopify'
 *  3. manual differs, no money rows → replace with Shopify's, source='shopify'
 *  4. manual differs, money rows    → KEEP the currency the existing values are
 *                                     expressed in, record Shopify's separately,
 *                                     and let getRcmReadiness() derive
 *                                     `currency_mismatch` from the two columns
 *
 * Nothing is converted, overwritten or deleted in case 4, and no boolean flag is
 * stored: resolving the data clears the blocker.
 */
export async function applyShopifyCurrency(
  accountId: number,
  shopifyCurrencyRaw: string,
): Promise<{ outcome: ShopifyCurrencyOutcome; currency: string; detected: string }> {
  const detected = normalizeCurrencyCode(shopifyCurrencyRaw);
  const state = await getCurrencyState(accountId);
  const existing = state?.currency ?? null;

  if (!existing) {
    await query(
      `UPDATE accounts SET currency = $2, currency_source = 'shopify',
              shopify_currency_detected = $2 WHERE id = $1`,
      [accountId, detected],
    );
    return { outcome: 'adopted_no_previous', currency: detected, detected };
  }

  if (existing === detected) {
    await query(
      `UPDATE accounts SET currency_source = 'shopify', shopify_currency_detected = $2
        WHERE id = $1`,
      [accountId, detected],
    );
    return { outcome: 'confirmed_match', currency: detected, detected };
  }

  if (!(await hasMoneyRows(accountId))) {
    await query(
      `UPDATE accounts SET currency = $2, currency_source = 'shopify',
              shopify_currency_detected = $2 WHERE id = $1`,
      [accountId, detected],
    );
    return { outcome: 'replaced_no_money_rows', currency: detected, detected };
  }

  // Case 4: preserve both. `currency` still describes the stored money values.
  await query(
    `UPDATE accounts SET shopify_currency_detected = $2 WHERE id = $1`,
    [accountId, detected],
  );
  return { outcome: 'mismatch_preserved', currency: existing, detected };
}

/** Store timezone from Shopify's ianaTimezone (E6). */
export async function applyShopifyTimezone(accountId: number, ianaTimezone: string): Promise<boolean> {
  if (!isValidTimezone(ianaTimezone)) return false;
  await query(`UPDATE accounts SET store_timezone = $2 WHERE id = $1`, [accountId, ianaTimezone]);
  return true;
}

export type ManualCurrencyResult =
  | { ok: true; currency: string }
  | { ok: false; error: 'invalid_code' | 'shopify_authoritative'; message: string };

/**
 * Manual currency selection, used only when Shopify has not supplied one (E4).
 * Once Shopify is authoritative, manual selection is refused — changing it is a
 * mismatch resolution, not a preference (E5).
 */
export async function setManualCurrency(
  accountId: number,
  codeRaw: unknown,
): Promise<ManualCurrencyResult> {
  if (!isValidCurrencyCode(codeRaw)) {
    return {
      ok: false,
      error: 'invalid_code',
      message: 'Enter a 3-letter currency code, for example USD.',
    };
  }
  const code = normalizeCurrencyCode(codeRaw);
  const state = await getCurrencyState(accountId);
  if (state?.currency_source === 'shopify') {
    return {
      ok: false,
      error: 'shopify_authoritative',
      message: 'Currency comes from the connected Shopify store and cannot be changed here.',
    };
  }
  await query(
    `UPDATE accounts SET currency = $2, currency_source = 'manual' WHERE id = $1`,
    [accountId, code],
  );
  return { ok: true, currency: code };
}

export type MismatchResolution =
  | { ok: true; currency: string }
  | { ok: false; error: 'no_mismatch'; message: string };

/**
 * AGENCY-ONLY mismatch resolution (E5). Adopts the detected Shopify currency as
 * the account currency. The agency is expected to have re-entered the affected
 * money values in that currency first — this call records the decision, it does
 * not convert anything.
 */
export async function resolveCurrencyMismatch(accountId: number): Promise<MismatchResolution> {
  const state = await getCurrencyState(accountId);
  if (!state?.shopify_currency_detected || state.currency === state.shopify_currency_detected) {
    return { ok: false, error: 'no_mismatch', message: 'This account has no currency mismatch.' };
  }
  await query(
    `UPDATE accounts SET currency = shopify_currency_detected, currency_source = 'shopify'
      WHERE id = $1`,
    [accountId],
  );
  return { ok: true, currency: state.shopify_currency_detected };
}

/** Derived, never stored (Correction 1). */
export function hasCurrencyMismatch(state: AccountCurrencyState): boolean {
  return (
    state.shopify_currency_detected !== null &&
    state.currency !== state.shopify_currency_detected
  );
}
