import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Recompute order_number_for_customer / is_first_order and customers.first_order_at.
 *
 * Excluded orders (cancelled or test, per §8) do NOT get a sequence number and
 * are never counted as a first order — numbering is over eligible orders only,
 * ranked by created_at then id (stable tiebreak). Pass a customerId to rescope
 * to one customer after a webhook; omit to recompute the whole account after a
 * backfill/reconcile.
 */
export async function recomputeOrderSequence(
  db: Queryable,
  accountId: number,
  customerId?: number | null,
): Promise<void> {
  const scope = customerId != null ? 'AND customer_id = $2' : '';
  const params = customerId != null ? [accountId, customerId] : [accountId];

  // 1. Eligible orders: rank per customer.
  await db.query(
    `WITH ranked AS (
       SELECT id,
              row_number() OVER (PARTITION BY customer_id ORDER BY created_at, id) AS rn
       FROM orders
       WHERE account_id = $1 ${scope}
         AND customer_id IS NOT NULL AND cancelled = false AND test = false
     )
     UPDATE orders o
        SET order_number_for_customer = r.rn,
            is_first_order = (r.rn = 1)
       FROM ranked r
      WHERE o.account_id = $1 AND o.id = r.id`,
    params,
  );

  // 2. Excluded orders (cancelled/test): clear sequence, never first.
  await db.query(
    `UPDATE orders
        SET order_number_for_customer = NULL, is_first_order = false
      WHERE account_id = $1 ${scope}
        AND (cancelled = true OR test = true OR customer_id IS NULL)`,
    params,
  );

  // 3. first_order_at = earliest eligible order per affected customer.
  await db.query(
    `UPDATE customers c
        SET first_order_at = sub.first_at
       FROM (
         SELECT customer_id, min(created_at) AS first_at
           FROM orders
          WHERE account_id = $1 ${scope}
            AND customer_id IS NOT NULL AND cancelled = false AND test = false
          GROUP BY customer_id
       ) sub
      WHERE c.account_id = $1 AND c.id = sub.customer_id`,
    params,
  );
}
