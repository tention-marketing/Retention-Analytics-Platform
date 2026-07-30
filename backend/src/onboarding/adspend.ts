import { query, withTransaction } from '../db/pool.js';

// Manual monthly advertising spend (D3 / E1 / Correction 4).
//
// §0 locks V1 to manual monthly entry per channel, normalized into the
// source-agnostic ad_spend model so V3's APIs slot in without touching RCM logic.
// Nothing here talks to Meta, Google or TikTok.

const NUMERIC_12_2_MAX = 9_999_999_999.99;
const MAX_WINDOW_MONTHS = 12;

/** Suggested channels; free text is also accepted (D3). */
export const SUGGESTED_CHANNELS = [
  'Meta', 'Google', 'TikTok', 'Pinterest', 'Snapchat', 'Amazon', 'Influencer', 'Affiliate', 'Other',
] as const;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message: string };

export function normalizeChannel(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'channel_required', message: 'A channel name is required.' };
  }
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (trimmed.length > 64) {
    return { ok: false, error: 'channel_too_long', message: 'Channel name is too long (max 64).' };
  }
  return { ok: true, value: trimmed };
}

export function validateSpendAmount(input: unknown): ValidationResult<number> {
  const n = typeof input === 'number' ? input : Number(input);
  if (input === null || input === undefined || input === '' || !Number.isFinite(n)) {
    // Never read an empty field as zero (D3).
    return { ok: false, error: 'not_a_number', message: 'Enter a monthly spend amount.' };
  }
  if (n < 0) return { ok: false, error: 'negative', message: 'Spend cannot be negative.' };
  if (n > NUMERIC_12_2_MAX) return { ok: false, error: 'too_large', message: 'Spend is too large.' };
  if (Math.round(n * 100) !== n * 100) {
    return { ok: false, error: 'too_precise', message: 'Spend supports at most two decimal places.' };
  }
  return { ok: true, value: n };
}

/** Normalize any YYYY-MM or YYYY-MM-DD to the first day of that month. */
export function normalizeMonth(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}(-\d{2})?$/.test(input.trim())) {
    return { ok: false, error: 'bad_month', message: 'Use a month in YYYY-MM format.' };
  }
  const [y, m] = input.trim().split('-');
  const month = Number(m);
  if (month < 1 || month > 12) {
    return { ok: false, error: 'bad_month', message: 'Month must be between 01 and 12.' };
  }
  return { ok: true, value: `${y}-${m}-01` };
}

function addMonths(monthIso: string, delta: number): string {
  const [y, m] = monthIso.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`;
}

function monthRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let cur = startIso;
  while (cur <= endIso) {
    out.push(cur);
    cur = addMonths(cur, 1);
    if (out.length > 240) break; // hard stop; range validity is checked by callers
  }
  return out;
}

// ---------------------------------------------------------------------------
// Required coverage window (E1)
// ---------------------------------------------------------------------------

export interface CoverageWindow {
  firstOrderMonth: string | null;
  currentMonth: string;
  windowStart: string | null;
  /** Months in the window with >= 1 new customer. */
  requiredMonths: string[];
  /** Required months with neither a spend row nor a confirmed zero. */
  missingMonths: string[];
  /** Months holding BOTH real spend and a confirmed zero (Correction 4). */
  contradictoryMonths: string[];
  coveredMonths: string[];
  zeroConfirmedMonths: string[];
  complete: boolean;
}

/**
 * E1, exactly as approved:
 *
 *   first_order_month = month of earliest eligible (non-test, non-cancelled) order
 *   current_month     = month containing now, in accounts.store_timezone
 *   window_start      = max(first_order_month, current_month - 11 months)
 *   required months   = months in that window with >= 1 new customer
 *
 * A month with no new customers is NOT required: CAC is month spend / new
 * customers that month (§4.5), so a zero denominator has no CAC to compute and
 * demanding spend for it would be busywork.
 *
 * All month boundaries are computed in the account's validated store timezone.
 */
export async function getCoverageWindow(accountId: number): Promise<CoverageWindow> {
  const { rows } = await query<{
    first_order_month: string | null;
    current_month: string;
    window_start: string | null;
  }>(
    `WITH tz AS (
       SELECT COALESCE(store_timezone, 'UTC') AS name FROM accounts WHERE id = $1
     ), bounds AS (
       SELECT
         (SELECT date_trunc('month', min(o.created_at AT TIME ZONE (SELECT name FROM tz)))::date
            FROM orders o
           WHERE o.account_id = $1 AND o.cancelled = false AND o.test = false
         ) AS first_order_month,
         date_trunc('month', (now() AT TIME ZONE (SELECT name FROM tz)))::date AS current_month
     )
     SELECT to_char(first_order_month, 'YYYY-MM-DD') AS first_order_month,
            to_char(current_month,     'YYYY-MM-DD') AS current_month,
            to_char(GREATEST(first_order_month,
                             current_month - interval '11 months'), 'YYYY-MM-DD') AS window_start
       FROM bounds`,
    [accountId],
  );

  const firstOrderMonth = rows[0]?.first_order_month ?? null;
  const currentMonth = rows[0]?.current_month ?? monthOfNowUtc();
  const windowStart = rows[0]?.window_start ?? null;

  if (!firstOrderMonth || !windowStart) {
    // No eligible order history: no month can be required. Readiness is still
    // blocked by no_eligible_revenue_data (E1b) — coverage is simply not the
    // thing standing in the way.
    return {
      firstOrderMonth: null, currentMonth, windowStart: null,
      requiredMonths: [], missingMonths: [], contradictoryMonths: [],
      coveredMonths: [], zeroConfirmedMonths: [], complete: true,
    };
  }

  const newCustomerMonths = await query<{ month: string }>(
    `WITH tz AS (
       SELECT COALESCE(store_timezone, 'UTC') AS name FROM accounts WHERE id = $1
     )
     SELECT DISTINCT
            to_char(date_trunc('month', (o.created_at AT TIME ZONE (SELECT name FROM tz)))::date,
                    'YYYY-MM-DD') AS month
       FROM orders o
      WHERE o.account_id = $1 AND o.cancelled = false AND o.test = false
        AND o.is_first_order = true
        AND (o.created_at AT TIME ZONE (SELECT name FROM tz)) >= $2::date
        AND (o.created_at AT TIME ZONE (SELECT name FROM tz))
              < ($3::date + interval '1 month')`,
    [accountId, windowStart, currentMonth],
  );
  const newCustomerSet = new Set(newCustomerMonths.rows.map((r) => r.month));
  const requiredMonths = monthRange(windowStart, currentMonth).filter((m) => newCustomerSet.has(m));

  const spendMonths = await query<{ month: string }>(
    `SELECT DISTINCT to_char(month, 'YYYY-MM-DD') AS month FROM ad_spend WHERE account_id = $1`,
    [accountId],
  );
  const zeroMonths = await query<{ month: string }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month FROM ad_spend_zero_months WHERE account_id = $1`,
    [accountId],
  );
  const spendSet = new Set(spendMonths.rows.map((r) => r.month));
  const zeroSet = new Set(zeroMonths.rows.map((r) => r.month));

  const contradictoryMonths = [...zeroSet].filter((m) => spendSet.has(m)).sort();
  const coveredMonths = requiredMonths.filter((m) => spendSet.has(m) || zeroSet.has(m));
  const missingMonths = requiredMonths.filter((m) => !spendSet.has(m) && !zeroSet.has(m));

  return {
    firstOrderMonth, currentMonth, windowStart,
    requiredMonths, missingMonths, contradictoryMonths,
    coveredMonths, zeroConfirmedMonths: [...zeroSet].sort(),
    complete: missingMonths.length === 0 && contradictoryMonths.length === 0,
  };
}

function monthOfNowUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface AdSpendRangeInput {
  channel: string;
  amount: number;
  startMonth: string;
  endMonth: string;
}

export type RangeParseResult =
  | { ok: true; entries: AdSpendRangeInput[] }
  | { ok: false; error: string; message: string };

/** Validate and normalize the wizard's channel x month-range rows. */
export function parseAdSpendRanges(input: unknown, currentMonth: string): RangeParseResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: 'no_rows', message: 'Add at least one channel.' };
  }
  const entries: AdSpendRangeInput[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const channel = normalizeChannel(row.channel);
    if (!channel.ok) return channel;
    const amount = validateSpendAmount(row.amount);
    if (!amount.ok) return amount;
    const start = normalizeMonth(row.startMonth);
    if (!start.ok) return start;
    const end = normalizeMonth(row.endMonth);
    if (!end.ok) return end;

    if (start.value > end.value) {
      return {
        ok: false, error: 'bad_range',
        message: `${channel.value}: the start month is after the end month.`,
      };
    }
    if (end.value > currentMonth) {
      return {
        ok: false, error: 'future_month',
        message: `${channel.value}: spend cannot be recorded for a future month.`,
      };
    }
    if (monthRange(start.value, end.value).length > MAX_WINDOW_MONTHS * 2) {
      return {
        ok: false, error: 'range_too_long',
        message: `${channel.value}: that range is longer than this wizard supports.`,
      };
    }

    // Case-insensitive dedupe of overlapping rows for the same channel.
    const key = channel.value.toLowerCase();
    for (const m of monthRange(start.value, end.value)) {
      const cell = `${key}|${m}`;
      if (seen.has(cell)) {
        return {
          ok: false, error: 'overlapping_rows',
          message: `${channel.value}: ${m.slice(0, 7)} appears in more than one row.`,
        };
      }
      seen.add(cell);
    }
    entries.push({ channel: channel.value, amount: amount.value, startMonth: start.value, endMonth: end.value });
  }
  return { ok: true, entries };
}

export interface AdSpendWriteResult {
  monthsWritten: number;
  rowsWritten: number;
  zeroConfirmationsCleared: number;
}

/**
 * Expand each channel x range into one ad_spend row per month (source='manual').
 *
 * Correction 4: writing spend for a month REMOVES that month's confirmed-zero
 * record in the SAME transaction, so the two states can never coexist. A failure
 * anywhere rolls the whole thing back, leaving neither a half-written range nor
 * an orphaned zero record.
 */
export async function writeAdSpendRanges(
  accountId: number,
  entries: AdSpendRangeInput[],
): Promise<AdSpendWriteResult> {
  const touchedMonths = new Set<string>();
  let rowsWritten = 0;

  const cleared = await withTransaction(async (client) => {
    for (const e of entries) {
      for (const month of monthRange(e.startMonth, e.endMonth)) {
        await client.query(
          `INSERT INTO ad_spend (account_id, month, channel, spend, source)
           VALUES ($1, $2, $3, $4, 'manual')
           ON CONFLICT (account_id, month, channel, source)
           DO UPDATE SET spend = EXCLUDED.spend`,
          [accountId, month, e.channel, e.amount],
        );
        touchedMonths.add(month);
        rowsWritten++;
      }
    }
    const months = [...touchedMonths];
    if (months.length === 0) return 0;
    const res = await client.query(
      `DELETE FROM ad_spend_zero_months WHERE account_id = $1 AND month = ANY($2::date[])`,
      [accountId, months],
    );
    return res.rowCount ?? 0;
  });

  return { monthsWritten: touchedMonths.size, rowsWritten, zeroConfirmationsCleared: cleared };
}

export type ZeroConfirmResult =
  | { ok: true; monthsConfirmed: number; spendRowsRemoved: number }
  | { ok: false; error: 'requires_replace'; message: string; months: string[] };

/**
 * Record explicitly confirmed zero-spend months.
 *
 * Correction 4: when real spend already exists for a month, confirming zero
 * requires an explicit `replace` — spend a client entered is never silently
 * deleted. With replace, the delete and the confirmation happen in ONE
 * transaction so a failure cannot leave both states present.
 */
export async function confirmZeroMonths(
  accountId: number,
  months: string[],
  opts: { replace?: boolean } = {},
): Promise<ZeroConfirmResult> {
  if (months.length === 0) return { ok: true, monthsConfirmed: 0, spendRowsRemoved: 0 };

  const { rows: clashes } = await query<{ month: string }>(
    `SELECT DISTINCT to_char(month, 'YYYY-MM-DD') AS month FROM ad_spend
      WHERE account_id = $1 AND month = ANY($2::date[])`,
    [accountId, months],
  );
  if (clashes.length > 0 && opts.replace !== true) {
    const list = clashes.map((c) => c.month);
    return {
      ok: false, error: 'requires_replace', months: list,
      message:
        `Spend is already recorded for ${list.map((m) => m.slice(0, 7)).join(', ')}. ` +
        'Confirm that you want to replace it with zero.',
    };
  }

  const removed = await withTransaction(async (client) => {
    const del = await client.query(
      `DELETE FROM ad_spend WHERE account_id = $1 AND month = ANY($2::date[])`,
      [accountId, months],
    );
    for (const month of months) {
      await client.query(
        `INSERT INTO ad_spend_zero_months (account_id, month) VALUES ($1, $2)
         ON CONFLICT (account_id, month) DO UPDATE SET confirmed_at = now()`,
        [accountId, month],
      );
    }
    return del.rowCount ?? 0;
  });

  return { ok: true, monthsConfirmed: months.length, spendRowsRemoved: removed };
}

export interface AdSpendRow {
  month: string;
  channel: string;
  spend: string;
  source: string;
}

export async function listAdSpend(accountId: number): Promise<AdSpendRow[]> {
  const { rows } = await query<AdSpendRow>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, channel, spend, source
       FROM ad_spend WHERE account_id = $1 ORDER BY month DESC, channel`,
    [accountId],
  );
  return rows;
}
