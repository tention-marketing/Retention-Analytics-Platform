import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://tention:tention@localhost:5432/tention'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
  sessionSecret: required('SESSION_SECRET', 'dev_session_secret_change_me_min_32_chars'),
  encryptionKey: required('ENCRYPTION_KEY', 'ZGV2X2VuY3J5cHRpb25fa2V5XzMyX2J5dGVzX2xvbmc='),
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  // Shopify. The webhook shared secret (app API secret) is used to verify
  // incoming webhook HMACs. Optional in dev until a real app is connected.
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET ?? '',
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? '2024-10',
  // Shopify custom app installed on the store. The client_credentials grant
  // (client_id + client_secret → short-lived Admin API access token, ~24h) is
  // exchanged at connect time; see sync/shopify/token.ts. Empty in dev until a
  // real app is configured.
  shopifyShopDomain: process.env.SHOPIFY_SHOP_DOMAIN ?? '',
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID ?? '',
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? '',
};
