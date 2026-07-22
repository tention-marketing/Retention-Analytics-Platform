// Shopify custom-app token manager (client_credentials grant).
//
// A Shopify custom app authenticates with client_credentials: POST the
// client_id + client_secret to /admin/oauth/access_token and receive a
// short-lived Admin API access token (Shopify returns expires_in, typically
// ~24h). Tokens are cached in-process per shop and refreshed lazily just
// before expiry — every shopifyGraphQL() call resolves through here, and the
// sync jobs run well within a 24h window, so the cached token is always
// refreshed before it lapses without needing a standalone timer (which would
// double up across the API server and the worker processes). A 401 on any call
// also force-refreshes and retries once (see client.ts).

export interface ShopifyAppCredentials {
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Refresh this far ahead of the real expiry so an in-flight request never
// races the boundary.
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
// Fallback lifetime if Shopify omits expires_in for some reason.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache = new Map<string, CachedToken>();
// Dedupe concurrent fetches for the same shop so a burst of calls triggers one
// token request, not N.
const inflight = new Map<string, Promise<string>>();

interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
  error?: string;
  error_description?: string;
}

async function fetchAccessToken(
  shopDomain: string,
  creds: ShopifyAppCredentials,
): Promise<CachedToken> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  const body = (await res.json().catch(() => ({}))) as AccessTokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`Shopify client_credentials token exchange failed for ${shopDomain}: ${detail}`);
  }

  const ttlMs = body.expires_in ? body.expires_in * 1000 : DEFAULT_TTL_MS;
  return { token: body.access_token, expiresAt: Date.now() + ttlMs };
}

/**
 * Return a valid Admin API access token for the shop, exchanging fresh
 * credentials when the cache is empty, near expiry, or `force`d (e.g. after a
 * 401). Concurrent callers for the same shop share one in-flight exchange.
 */
export async function getAccessToken(
  shopDomain: string,
  creds: ShopifyAppCredentials,
  force = false,
): Promise<string> {
  const cached = cache.get(shopDomain);
  if (!force && cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return cached.token;
  }

  const pending = inflight.get(shopDomain);
  if (pending && !force) return pending;

  const p = fetchAccessToken(shopDomain, creds)
    .then((t) => {
      cache.set(shopDomain, t);
      return t.token;
    })
    .finally(() => {
      // Only clear if this promise is still the registered one.
      if (inflight.get(shopDomain) === p) inflight.delete(shopDomain);
    });
  inflight.set(shopDomain, p);
  return p;
}

// Drop a shop's cached token (used on disconnect / full deletion so a revoked
// app can't keep serving a live token from memory).
export function clearTokenCache(shopDomain?: string): void {
  if (shopDomain) {
    cache.delete(shopDomain);
    inflight.delete(shopDomain);
  } else {
    cache.clear();
    inflight.clear();
  }
}
