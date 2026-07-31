import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

/**
 * Strict boolean flag parsing for security-relevant switches.
 *
 * Only the exact string 'true' enables. '1', 'yes', 'TRUE', ' true ' and an
 * empty value all read as false, so a plausible-looking typo in a deploy
 * environment fails CLOSED rather than open. Exported so the rule itself is
 * covered by tests rather than only its effect.
 */
export function parseStrictBooleanFlag(raw: string | undefined): boolean {
  return raw === 'true';
}

const appBaseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

/**
 * Origin of the first-party application URL, validated at boot.
 *
 * This is the ONLY browser origin trusted for state-changing authentication
 * requests (routes/auth.ts). It is derived from configuration rather than from
 * `request.host` or `X-Forwarded-Host`, which a caller controls — deriving a
 * trust decision from an attacker-supplied header is the classic way an origin
 * check ends up validating nothing. Failing at boot beats discovering a
 * malformed APP_BASE_URL on the first login attempt.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`APP_BASE_URL must be an absolute URL (e.g. https://app.example.com), got: ${url}`);
  }
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://tention:tention@localhost:5432/tention'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
  sessionSecret: required('SESSION_SECRET', 'dev_session_secret_change_me_min_32_chars'),
  encryptionKey: required('ENCRYPTION_KEY', 'ZGV2X2VuY3J5cHRpb25fa2V5XzMyX2J5dGVzX2xvbmc='),
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
  // POST /auth/register creates an agency staff user with access to EVERY
  // account, so it is closed unless this is set to the exact string 'true'.
  // Any other value — unset, empty, '1', 'yes', 'TRUE' — leaves it closed, so a
  // typo can never accidentally open public signup in production.
  //
  // The frontend has no say in this: it is read from the process environment at
  // boot and never echoed to a browser. The production-safe way to create the
  // first user is `npm run bootstrap:user`, which writes to Postgres directly
  // and needs no HTTP route open at all.
  allowAgencyRegistration: parseStrictBooleanFlag(process.env.ALLOW_AGENCY_REGISTRATION),
  // Base URL the client-facing onboarding link is built from. The token is placed
  // in the URL FRAGMENT (`/onboarding#token=…`), which browsers never transmit,
  // so it cannot reach server access logs, proxy logs, or a referer header.
  appBaseUrl,
  /** Scheme+host+port of appBaseUrl. The only trusted browser origin. */
  appOrigin: originOf(appBaseUrl),
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
