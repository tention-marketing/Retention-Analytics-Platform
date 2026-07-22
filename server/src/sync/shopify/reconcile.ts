import { withTransaction } from '../../db/pool.js';
import { getShopifyConnection, markSynced } from '../../db/connections.js';
import { runBulkQuery, type ShopifyConnection } from './client.js';
import { ordersBulkQuery, customersBulkQuery } from './queries.js';
import { parseBulkOrderLines, parseBulkCustomerLines } from './transform.js';
import { upsertCustomers, upsertOrdersWithLineItems } from './persist.js';
import { recomputeOrderSequence } from './sequence.js';
import { logSyncError } from '../errors.js';

// ISO timestamp for `now - hours`, formatted for a Shopify `updated_at:>=` query.
export function sinceTimestamp(hours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - hours * 3600_000).toISOString();
}

/**
 * Nightly reconciliation (§4.1): re-pull everything updated in the last 48h and
 * re-upsert. Catches missed/late webhooks and out-of-band edits. Recompute runs
 * account-wide because a re-pulled order can shift another order's sequence.
 */
export async function runShopifyReconcile(
  accountId: number,
  hours = 48,
  connArg?: ShopifyConnection,
): Promise<{ orders: number; customers: number }> {
  const conn = connArg ?? (await getShopifyConnection(accountId));
  if (!conn) throw new Error(`no shopify connection for account ${accountId}`);

  try {
    const since = sinceTimestamp(hours);
    const filter = `updated_at:>=${since}`;

    const customers = parseBulkCustomerLines(await runBulkQuery(conn, customersBulkQuery(filter)));
    const { orders, lineItems } = parseBulkOrderLines(await runBulkQuery(conn, ordersBulkQuery(filter)));

    await withTransaction(async (client) => {
      await upsertCustomers(client, accountId, customers);
      await upsertOrdersWithLineItems(client, accountId, orders, lineItems);
      await recomputeOrderSequence(client, accountId);
    });

    await markSynced(accountId, 'shopify');
    return { orders: orders.length, customers: customers.length };
  } catch (err) {
    await logSyncError(accountId, 'shopify.reconcile', err);
    throw err;
  }
}
