import { query } from './pool.js';
import { encrypt, decrypt } from '../crypto.js';
import type { ShopifyConnection } from '../sync/shopify/client.js';

interface ConnRow {
  account_id: number;
  provider: string;
  credentials_encrypted: string;
  shop_domain: string | null;
  status: string;
}

// Credentials are stored as an encrypted JSON blob so each provider can carry
// whatever fields it needs behind one encrypted column. For Shopify that is
// either `{ clientId, clientSecret }` (custom-app client_credentials grant) or
// `{ token }` (a static Admin API token, for seed/tests/manual installs).
type ShopifyCredentials = { clientId: string; clientSecret: string } | { token: string };

async function upsertShopifyCredentials(
  accountId: number,
  shopDomain: string,
  creds: ShopifyCredentials,
): Promise<void> {
  const enc = encrypt(JSON.stringify(creds));
  await query(
    `INSERT INTO connections (account_id, provider, credentials_encrypted, shop_domain, status)
     VALUES ($1, 'shopify', $2, $3, 'connected')
     ON CONFLICT (account_id, provider)
     DO UPDATE SET credentials_encrypted = EXCLUDED.credentials_encrypted,
                   shop_domain = EXCLUDED.shop_domain, status = 'connected'`,
    [accountId, enc, shopDomain],
  );
}

// Custom-app connection: store the client_credentials so the token manager can
// mint/refresh Admin API tokens on demand.
export async function upsertShopifyAppConnection(
  accountId: number,
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await upsertShopifyCredentials(accountId, shopDomain, { clientId, clientSecret });
}

// Static-token connection (seed/tests/manual). Retained for the legacy path.
export async function upsertShopifyConnection(
  accountId: number,
  shopDomain: string,
  token: string,
): Promise<void> {
  await upsertShopifyCredentials(accountId, shopDomain, { token });
}

export async function getShopifyConnection(accountId: number): Promise<ShopifyConnection | null> {
  const { rows } = await query<ConnRow>(
    `SELECT * FROM connections WHERE account_id = $1 AND provider = 'shopify'`,
    [accountId],
  );
  if (rows.length === 0 || !rows[0].shop_domain) return null;
  const creds = JSON.parse(decrypt(rows[0].credentials_encrypted)) as Partial<{
    clientId: string; clientSecret: string; token: string;
  }>;
  if (creds.clientId && creds.clientSecret) {
    return { shopDomain: rows[0].shop_domain, app: { clientId: creds.clientId, clientSecret: creds.clientSecret } };
  }
  if (creds.token) {
    return { shopDomain: rows[0].shop_domain, token: creds.token };
  }
  return null;
}

export async function getAccountIdByShopDomain(shopDomain: string): Promise<number | null> {
  const { rows } = await query<{ account_id: number }>(
    `SELECT account_id FROM connections WHERE provider = 'shopify' AND shop_domain = $1`,
    [shopDomain],
  );
  return rows[0]?.account_id ?? null;
}

export async function markSynced(accountId: number, provider: string): Promise<void> {
  await query(
    `UPDATE connections SET last_sync_at = now() WHERE account_id = $1 AND provider = $2`,
    [accountId, provider],
  );
}
