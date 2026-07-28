import type { PoolClient } from 'pg';
import { bulkUpsert } from '../../db/upserts.js';
import type { SubscriptionRow, SubscriptionEventRow } from './transform.js';

type Queryable = Pick<PoolClient, 'query'>;

const SUB_COLS = [
  'account_id', 'id', 'recharge_customer_id', 'shopify_customer_id', 'email',
  'product_id', 'plan_type', 'status', 'started_at', 'cancelled_at',
  'cancel_reason', 'acquisition_channel',
] as const;

/**
 * Upsert subscriptions. On conflict every field refreshes from Recharge EXCEPT
 * shopify_customer_id, which uses COALESCE(existing, incoming): a re-poll can
 * fill a previously-null id but can never wipe a link the identity graph
 * resolved via the email fallback (§4.4). Hand-written (not bulkUpsert) so we
 * can express that COALESCE; chunked the same way to stay under param limits.
 */
export async function upsertSubscriptions(
  db: Queryable,
  accountId: number,
  rows: SubscriptionRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = SUB_COLS.length;
  const maxRowsPerChunk = Math.max(1, Math.floor(60_000 / cols));
  const updateAssignments = SUB_COLS
    .filter((c) => c !== 'account_id' && c !== 'id')
    .map((c) =>
      c === 'shopify_customer_id'
        ? `shopify_customer_id = COALESCE(subscriptions.shopify_customer_id, EXCLUDED.shopify_customer_id)`
        : `${c} = EXCLUDED.${c}`,
    )
    .join(', ');

  let written = 0;
  for (let start = 0; start < rows.length; start += maxRowsPerChunk) {
    const chunk = rows.slice(start, start + maxRowsPerChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((s, ri) => {
      const row = [
        accountId, s.id, s.recharge_customer_id, s.shopify_customer_id, s.email,
        s.product_id, s.plan_type, s.status, s.started_at, s.cancelled_at,
        s.cancel_reason, s.acquisition_channel,
      ];
      values.push(...row);
      return `(${row.map((_, ci) => `$${ri * cols + ci + 1}`).join(',')})`;
    });
    const res = await db.query(
      `INSERT INTO subscriptions (${SUB_COLS.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (account_id, id) DO UPDATE SET ${updateAssignments}`,
      values,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

// De-duplicate on the full PK so a single INSERT can't touch the same row twice
// (Postgres rejects that within one ON CONFLICT statement).
function dedupeEvents(accountId: number, rows: SubscriptionEventRow[]): unknown[][] {
  const seen = new Set<string>();
  const out: unknown[][] = [];
  for (const e of rows) {
    const key = `${e.subscription_id}|${e.event_type}|${e.occurred_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([accountId, e.subscription_id, e.event_type, e.occurred_at]);
  }
  return out;
}

export async function upsertSubscriptionEvents(
  db: Queryable,
  accountId: number,
  rows: SubscriptionEventRow[],
): Promise<number> {
  return bulkUpsert(
    db,
    'subscription_events',
    ['account_id', 'subscription_id', 'event_type', 'occurred_at'],
    ['account_id', 'subscription_id', 'event_type', 'occurred_at'],
    dedupeEvents(accountId, rows),
    [], // PK-only table: nothing to update, DO NOTHING on conflict
  );
}
