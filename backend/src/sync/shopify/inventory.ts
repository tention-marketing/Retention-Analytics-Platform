import { pool, query } from '../../db/pool.js';
import { bulkUpsert } from '../../db/upserts.js';
import { shopifyGraphQL, type ShopifyConnection } from './client.js';
import { gidToId } from './transform.js';

export interface InventoryLevel {
  product_id: number;
  available: number;
}

// Today's calendar date in the store's timezone (§4 timezones: store UTC,
// convert at query time). Falls back to UTC if the tz is invalid.
export function storeToday(storeTimezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: storeTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// DB-only: write one snapshot_date's levels. Idempotent per (product, date).
export async function writeInventorySnapshot(
  accountId: number,
  snapshotDate: string,
  levels: InventoryLevel[],
): Promise<number> {
  return bulkUpsert(
    pool,
    'inventory_levels',
    ['account_id', 'product_id', 'snapshot_date', 'available'],
    ['account_id', 'product_id', 'snapshot_date'],
    levels.map((l) => [accountId, l.product_id, snapshotDate, l.available]),
    ['available'],
  );
}

const INVENTORY_QUERY = `
query($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id
      variants(first: 100) { edges { node { inventoryQuantity } } }
    } }
  }
}`;

// Fetch available quantity per product (summed across variants) and snapshot it.
export async function snapshotInventory(accountId: number, conn: ShopifyConnection): Promise<number> {
  const tzRes = await query<{ store_timezone: string }>(
    `SELECT store_timezone FROM accounts WHERE id = $1`,
    [accountId],
  );
  const tz = tzRes.rows[0]?.store_timezone ?? 'UTC';
  const date = storeToday(tz);

  const levels: InventoryLevel[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await shopifyGraphQL(conn, INVENTORY_QUERY, { cursor });
    const page = data.products;
    for (const edge of page.edges) {
      const productId = gidToId(edge.node.id);
      if (productId == null) continue;
      let available = 0;
      for (const v of edge.node.variants.edges) {
        available += Number(v.node.inventoryQuantity ?? 0);
      }
      levels.push({ product_id: productId, available });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return writeInventorySnapshot(accountId, date, levels);
}
