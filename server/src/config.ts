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
  // Recharge. A single Admin API access token (per store). Stored encrypted per
  // connection; this env value is the default the connect route reads. Empty in
  // dev until a real store is connected.
  rechargeApiToken: process.env.RECHARGE_API_TOKEN ?? '',
  rechargeApiVersion: process.env.RECHARGE_API_VERSION ?? '2021-11',
  // Klaviyo. A single private API key (pk_…), stored encrypted per connection;
  // this env value is the default the connect route reads. Empty in dev.
  //
  // Revision 2026-07-15 is the newest STABLE revision (not a `.pre` beta) and is
  // supported by every endpoint Phase 4 touches — accounts, campaigns, flows,
  // metrics, profiles, campaign-values-reports, flow-values-reports. Its only
  // breaking change versus earlier revisions is the Conversations API (profile
  // conversations became plural), which this phase does not use.
  klaviyoApiKey: process.env.KLAVIYO_API_KEY ?? '',
  klaviyoApiRevision: process.env.KLAVIYO_API_REVISION ?? '2026-07-15',
  // Conversion metric for report `conversions`/`conversion_value`. Left blank,
  // the poller auto-discovers Shopify's "Placed Order" and refuses to guess when
  // the match is ambiguous (§0.2 spirit: never invent an input to a metric).
  klaviyoConversionMetricId: process.env.KLAVIYO_CONVERSION_METRIC_ID ?? '',
  // Reporting API hard limit is a 1-year window, so stats cover 12 months.
  //
  // `last_365_days`, NOT `last_12_months`: verified against the live API on
  // 2026-07-29, `last_12_months` means the 12 COMPLETE calendar months and
  // excludes the current one, so every campaign sent this month came back with no
  // stats at all (0 of 57 July sends). A trailing window includes them.
  klaviyoReportTimeframe: process.env.KLAVIYO_REPORT_TIMEFRAME ?? 'last_365_days',
  // Page budget for the identity-graph profile scan (100 profiles/page). A scan
  // that hits the budget is reported as partial rather than as a real rate.
  klaviyoProfilePageBudget: Number(process.env.KLAVIYO_PROFILE_PAGE_BUDGET ?? 50),
};
