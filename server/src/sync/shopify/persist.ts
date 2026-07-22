import type { PoolClient } from 'pg';
import { bulkUpsert } from '../../db/upserts.js';
import type { CustomerRow, OrderRow, LineItemRow, ProductRow } from './transform.js';

type Queryable = Pick<PoolClient, 'query'>;

export async function upsertCustomers(db: Queryable, accountId: number, rows: CustomerRow[]): Promise<number> {
  // Never overwrite the computed first_order_at from here.
  return bulkUpsert(
    db, 'customers',
    ['account_id', 'id', 'email', 'created_at'],
    ['account_id', 'id'],
    rows.map((c) => [accountId, c.id, c.email, c.created_at]),
    ['email', 'created_at'],
  );
}

export async function upsertProducts(db: Queryable, accountId: number, rows: ProductRow[]): Promise<number> {
  return bulkUpsert(
    db, 'products',
    ['account_id', 'id', 'title'],
    ['account_id', 'id'],
    rows.map((p) => [accountId, p.id, p.title]),
    ['title'],
  );
}

/**
 * Upsert orders and (re)write their line items. Line items are deleted and
 * reinserted per affected order so edited orders don't keep stale lines.
 * is_first_order / order_number_for_customer are intentionally NOT written here
 * — recomputeOrderSequence owns them.
 */
export async function upsertOrdersWithLineItems(
  db: Queryable,
  accountId: number,
  orders: OrderRow[],
  lineItems: LineItemRow[],
): Promise<number> {
  const written = await bulkUpsert(
    db, 'orders',
    ['account_id', 'id', 'customer_id', 'created_at', 'total_net', 'refunded_amount', 'cancelled', 'test'],
    ['account_id', 'id'],
    orders.map((o) => [
      accountId, o.id, o.customer_id, o.created_at,
      o.total_net, o.refunded_amount, o.cancelled, o.test,
    ]),
    ['customer_id', 'created_at', 'total_net', 'refunded_amount', 'cancelled', 'test'],
  );

  const orderIds = orders.map((o) => o.id);
  if (orderIds.length > 0) {
    // Delete in chunks to stay well under parameter limits.
    for (let i = 0; i < orderIds.length; i += 5000) {
      const chunk = orderIds.slice(i, i + 5000);
      await db.query(
        `DELETE FROM line_items WHERE account_id = $1 AND order_id = ANY($2::bigint[])`,
        [accountId, chunk],
      );
    }
  }
  await bulkUpsert(
    db, 'line_items',
    ['account_id', 'order_id', 'product_id', 'product_title', 'sku', 'quantity', 'price'],
    ['account_id', 'order_id', 'product_id'],
    lineItems.map((li) => [
      accountId, li.order_id, li.product_id, li.product_title, li.sku, li.quantity, li.price,
    ]),
  );
  return written;
}
