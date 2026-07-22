// Full connection path against a live DB: create/find an account, persist the
// Shopify app connection (encrypted), read it back, verify, and backfill.
// Run: `npx tsx scripts/connect-shopify-db.ts`
import { config } from '../server/src/config.js';
import { pool, query } from '../server/src/db/pool.js';
import { upsertShopifyAppConnection, getShopifyConnection } from '../server/src/db/connections.js';
import { verifyShopifyConnection } from '../server/src/sync/shopify/client.js';
import { runShopifyBackfill } from '../server/src/sync/shopify/backfill.js';

async function main() {
  const shopDomain = config.shopifyShopDomain;

  // Reuse an existing brand if one is present, else create one.
  const existing = await query<{ id: number }>('SELECT id FROM accounts ORDER BY id LIMIT 1');
  const accountId = existing.rows[0]?.id
    ?? (await query<{ id: number }>(
      `INSERT INTO accounts (name) VALUES ($1) RETURNING id`, ['fmxhre-rw'],
    )).rows[0].id;
  console.log(`Using account ${accountId}`);

  await upsertShopifyAppConnection(accountId, shopDomain, config.shopifyClientId, config.shopifyClientSecret);
  console.log('✓ Connection persisted (client_credentials encrypted at rest)');

  const conn = await getShopifyConnection(accountId);
  if (!conn?.app) throw new Error('read-back did not return an app connection');
  console.log(`✓ Read back from DB: shop=${conn.shopDomain}, mode=app (clientId ${conn.app.clientId.slice(0, 6)}…)`);

  const shop = await verifyShopifyConnection(conn);
  console.log(`✓ Verified via DB-loaded connection: ${shop.name} (${shop.myshopifyDomain})`);

  const status = await query(
    `SELECT provider, shop_domain, status, last_sync_at FROM connections WHERE account_id = $1`,
    [accountId],
  );
  console.log('  connections row:', status.rows[0]);

  console.log('\nRunning backfill…');
  const result = await runShopifyBackfill(accountId);
  console.log('✓ Backfill complete:', result);

  const synced = await query<{ last_sync_at: Date }>(
    `SELECT last_sync_at FROM connections WHERE account_id = $1 AND provider = 'shopify'`,
    [accountId],
  );
  console.log(`  last_sync_at = ${synced.rows[0].last_sync_at?.toISOString()}`);
  console.log('\nStore connected.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('\n✗ Failed:', err.message);
  await pool.end();
  process.exit(1);
});
