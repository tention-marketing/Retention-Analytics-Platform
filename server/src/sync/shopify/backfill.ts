import { withTransaction } from '../../db/pool.js';
import { getShopifyConnection, markSynced } from '../../db/connections.js';
import { runBulkQuery, type ShopifyConnection } from './client.js';
import { ordersBulkQuery, customersBulkQuery, productsBulkQuery } from './queries.js';
import {
  parseBulkOrderLines, parseBulkCustomerLines, parseBulkProductLines,
} from './transform.js';
import { upsertCustomers, upsertProducts, upsertOrdersWithLineItems } from './persist.js';
import { recomputeOrderSequence } from './sequence.js';
import { logSyncError } from '../errors.js';
import { snapshotInventory } from './inventory.js';

export interface BackfillResult {
  products: number;
  customers: number;
  orders: number;
  lineItems: number;
}

/**
 * Full history backfill via Bulk Operations: products → customers → orders
 * (with line items) → recompute order sequence → inventory snapshot.
 * Refunds are captured inline on each order (currentSubtotalPrice reflects
 * returns; totalRefunded gives refunded_amount), per the money model in
 * transform.ts. Bulk ops are serialized (one per shop at a time).
 */
export async function runShopifyBackfill(accountId: number, connArg?: ShopifyConnection): Promise<BackfillResult> {
  const conn = connArg ?? (await getShopifyConnection(accountId));
  if (!conn) throw new Error(`no shopify connection for account ${accountId}`);

  try {
    const productObjs = await runBulkQuery(conn, productsBulkQuery());
    const products = parseBulkProductLines(productObjs);

    const customerObjs = await runBulkQuery(conn, customersBulkQuery());
    const customers = parseBulkCustomerLines(customerObjs);

    const orderObjs = await runBulkQuery(conn, ordersBulkQuery());
    const { orders, lineItems } = parseBulkOrderLines(orderObjs);

    await withTransaction(async (client) => {
      await upsertProducts(client, accountId, products);
      await upsertCustomers(client, accountId, customers);
      await upsertOrdersWithLineItems(client, accountId, orders, lineItems);
      await recomputeOrderSequence(client, accountId);
    });

    // Inventory is a separate GraphQL sweep (not part of the orders bulk op).
    await snapshotInventory(accountId, conn).catch((e) =>
      logSyncError(accountId, 'shopify.inventory', e),
    );

    await markSynced(accountId, 'shopify');
    return {
      products: products.length,
      customers: customers.length,
      orders: orders.length,
      lineItems: lineItems.length,
    };
  } catch (err) {
    await logSyncError(accountId, 'shopify.backfill', err);
    throw err;
  }
}
