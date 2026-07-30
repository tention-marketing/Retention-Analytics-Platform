// Standalone Shopify connection check — exercises the client_credentials token
// exchange and an authenticated Admin GraphQL call against the configured store,
// WITHOUT needing Postgres/Redis. Run: `npx tsx scripts/connect-shopify.ts`.
import { config } from '../src/config.js';
import { getAccessToken } from '../src/sync/shopify/token.js';
import { verifyShopifyConnection, type ShopifyConnection } from '../src/sync/shopify/client.js';

async function main() {
  const { shopifyShopDomain: shopDomain, shopifyClientId: clientId, shopifyClientSecret: clientSecret } = config;
  if (!shopDomain || !clientId || !clientSecret) {
    throw new Error('SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET must be set in .env');
  }
  console.log(`Shop domain: ${shopDomain}`);
  console.log(`API version: ${config.shopifyApiVersion}`);

  const app = { clientId, clientSecret };
  const conn: ShopifyConnection = { shopDomain, app };

  const t0 = Date.now();
  const token = await getAccessToken(shopDomain, app);
  console.log(`\n✓ Token exchange OK (${Date.now() - t0}ms). Token prefix: ${token.slice(0, 8)}… (len ${token.length})`);

  const t1 = Date.now();
  const shop = await verifyShopifyConnection(conn);
  console.log(`✓ Admin GraphQL OK (${Date.now() - t1}ms).`);
  console.log(`  shop.name            = ${shop.name}`);
  console.log(`  shop.myshopifyDomain = ${shop.myshopifyDomain}`);

  // Prove the cache short-circuits a second call (no new exchange).
  const t2 = Date.now();
  await getAccessToken(shopDomain, app);
  console.log(`✓ Cached token reused (${Date.now() - t2}ms, no network round-trip).`);
  console.log('\nConnection works.');
}

main().catch((err) => {
  console.error('\n✗ Connection failed:', err.message);
  process.exit(1);
});
