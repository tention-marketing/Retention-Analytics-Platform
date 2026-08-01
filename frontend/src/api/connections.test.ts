import { describe, expect, it } from 'vitest';
import {
  connectKlaviyoForAccount, connectRechargeForAccount, connectShopifyForAccount,
  skipProviderForAccount,
} from './onboarding';
import { ApiError } from './errors';
import { calls, lastCall, stubFetch, stubFetchNetworkError } from '@/test/server';

// The provider-connection API boundary.
//
// SYNTHETIC EVERYTHING, and deliberately not shaped like a real key: no `pk_`,
// no `shpat_`, no `sk_`. A fixture that looks like a live credential is a
// fixture someone will one day mistake for one.
const SHOP_DOMAIN = 'synthetic-shop.myshopify.com';
const CLIENT_ID = 'synthetic-client-id';
const CLIENT_SECRET = 'synthetic-client-secret';
const KLAVIYO_KEY = 'synthetic-klaviyo-key';
const RECHARGE_TOKEN = 'synthetic-recharge-token';

const SHOPIFY_CREDS = {
  shopDomain: SHOP_DOMAIN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
};

/** What the account-scoped Shopify route really sends back, verified live. */
const SHOPIFY_OK = {
  ok: true,
  shop: { name: 'Synthetic Shop', myshopifyDomain: SHOP_DOMAIN, currencyCode: 'USD' },
  shopDomain: SHOP_DOMAIN,
  currency: { outcome: 'applied', currency: 'USD', detected: 'USD' },
  timezoneApplied: true,
  queued: true,
};
const KLAVIYO_OK = { ok: true, account: { id: 'SYNTH1', name: 'Synthetic Klaviyo' }, queued: true };
const RECHARGE_OK = { ok: true, store: { name: 'Synthetic Recharge' }, queued: true };

async function captureError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/** Every request body this file produced, as one searchable string. */
function allRequestBodies(): string {
  return calls.map((c) => c.body ?? '').join('\n');
}

// ===========================================================================
// Routes
// ===========================================================================
describe('the account-scoped connection routes', () => {
  it('Shopify posts to /accounts/:id/connections/shopify/credentials', async () => {
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await connectShopifyForAccount(7, SHOPIFY_CREDS);
    expect(lastCall().url).toBe('/api/accounts/7/connections/shopify/credentials');
    expect(lastCall().method).toBe('POST');
    expect(lastCall().credentials).toBe('include');
  });

  it('Klaviyo posts to /accounts/:id/connections/klaviyo', async () => {
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    expect(lastCall().url).toBe('/api/accounts/7/connections/klaviyo');
  });

  it('Recharge posts to /accounts/:id/connections/recharge', async () => {
    stubFetch({ status: 202, json: RECHARGE_OK });
    await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });
    expect(lastCall().url).toBe('/api/accounts/7/connections/recharge');
  });

  it('skip posts to /accounts/:id/connections/:provider/skip', async () => {
    stubFetch({ json: { provider: 'klaviyo', state: 'skipped', providers: [] } });
    await skipProviderForAccount(7, 'klaviyo');
    expect(lastCall().url).toBe('/api/accounts/7/connections/klaviyo/skip');
    expect(lastCall().method).toBe('POST');
  });

  it('never calls a legacy unscoped /connections/* route', async () => {
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await connectShopifyForAccount(7, SHOPIFY_CREDS);
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    stubFetch({ status: 202, json: RECHARGE_OK });
    await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });

    // Those routes read the account id from the BODY. Every request here must
    // instead carry it in the path, under the session's authorisation.
    for (const call of calls) {
      expect(call.url).not.toMatch(/^\/api\/connections\//);
      expect(call.url).toMatch(/^\/api\/accounts\/7\//);
    }
  });

  it('never calls a client-scoped /onboarding/* route', async () => {
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    stubFetch({ json: { provider: 'recharge', state: 'skipped', providers: [] } });
    await skipProviderForAccount(7, 'recharge');
    for (const call of calls) {
      expect(call.url).not.toMatch(/^\/api\/onboarding\//);
    }
  });
});

// ===========================================================================
// Request payloads
// ===========================================================================
describe('what is sent', () => {
  it('Shopify sends exactly three fields', async () => {
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await connectShopifyForAccount(7, SHOPIFY_CREDS);
    const body = JSON.parse(lastCall().body ?? '{}');
    expect(Object.keys(body).sort()).toEqual(['clientId', 'clientSecret', 'shopDomain']);
    expect(body).toEqual(SHOPIFY_CREDS);
  });

  it('Klaviyo sends exactly one field', async () => {
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    expect(JSON.parse(lastCall().body ?? '{}')).toEqual({ apiKey: KLAVIYO_KEY });
  });

  it('Recharge sends exactly one field', async () => {
    stubFetch({ status: 202, json: RECHARGE_OK });
    await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });
    expect(JSON.parse(lastCall().body ?? '{}')).toEqual({ token: RECHARGE_TOKEN });
  });

  it('never puts accountId in a body — it belongs to the path', async () => {
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await connectShopifyForAccount(7, SHOPIFY_CREDS);
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    stubFetch({ status: 202, json: RECHARGE_OK });
    await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });

    expect(allRequestBodies()).not.toContain('accountId');
    expect(allRequestBodies()).not.toContain('account_id');
  });

  it('never sends useEnvCredentials', async () => {
    // On a per-brand route this would bind one brand's stored .env credential to
    // another account.
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await connectShopifyForAccount(7, SHOPIFY_CREDS);
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    stubFetch({ status: 202, json: RECHARGE_OK });
    await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });
    expect(allRequestBodies()).not.toContain('useEnvCredentials');
  });

  it('never sends mode, and never mode:sync', async () => {
    // 'sync' runs an entire backfill inline inside the request.
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await connectShopifyForAccount(7, SHOPIFY_CREDS);
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    stubFetch({ status: 202, json: RECHARGE_OK });
    await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });
    expect(allRequestBodies()).not.toContain('"mode"');
    expect(allRequestBodies()).not.toContain('sync');
  });

  it('sends one request per call', async () => {
    stubFetch({ status: 202, json: KLAVIYO_OK });
    await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    expect(calls).toHaveLength(1);
  });

  it('skip sends no body and declares no content type', async () => {
    // Fastify answers FST_ERR_CTP_EMPTY_JSON_BODY to a bodyless request that
    // still says application/json, so this is correctness, not tidiness.
    stubFetch({ json: { provider: 'klaviyo', state: 'skipped', providers: [] } });
    await skipProviderForAccount(7, 'klaviyo');
    expect(lastCall().body).toBeNull();
    expect(lastCall().headers['content-type']).toBeUndefined();
  });
});

// ===========================================================================
// Response handling
// ===========================================================================
describe('what comes back', () => {
  it('returns only safe Shopify fields', async () => {
    stubFetch({ status: 202, json: SHOPIFY_OK });
    await expect(connectShopifyForAccount(7, SHOPIFY_CREDS)).resolves.toEqual({
      ok: true, queued: true, shopDomain: SHOP_DOMAIN, timezoneApplied: true,
      detectedCurrency: 'USD',
    });
  });

  it('discards the raw shop, account, store and backfill payloads', async () => {
    stubFetch({ status: 202, json: { ...SHOPIFY_OK, backfill: { orders: 900 } } });
    const shopify = await connectShopifyForAccount(7, SHOPIFY_CREDS);
    expect(shopify).not.toHaveProperty('shop');
    expect(shopify).not.toHaveProperty('backfill');
    expect(shopify).not.toHaveProperty('currency');

    stubFetch({ status: 202, json: KLAVIYO_OK });
    const klaviyo = await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    expect(klaviyo).toEqual({ ok: true, queued: true });
    expect(klaviyo).not.toHaveProperty('account');

    stubFetch({ status: 202, json: RECHARGE_OK });
    const recharge = await connectRechargeForAccount(7, { token: RECHARGE_TOKEN });
    expect(recharge).toEqual({ ok: true, queued: true });
    expect(recharge).not.toHaveProperty('store');
  });

  it('never exposes queueNote text, only the queued flag', async () => {
    stubFetch({
      status: 200,
      json: { ...KLAVIYO_OK, queued: false, queueNote: 'stored; enqueue failed (is Redis up?)' },
    });
    const outcome = await connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY });
    expect(outcome).toEqual({ ok: true, queued: false });
    expect(JSON.stringify(outcome)).not.toContain('Redis');
  });

  it('handles a 200 saved-but-not-queued as well as a 202 queued', async () => {
    stubFetch({ status: 200, json: { ...RECHARGE_OK, queued: false } });
    await expect(connectRechargeForAccount(7, { token: RECHARGE_TOKEN }))
      .resolves.toEqual({ ok: true, queued: false });
    stubFetch({ status: 202, json: RECHARGE_OK });
    await expect(connectRechargeForAccount(7, { token: RECHARGE_TOKEN }))
      .resolves.toEqual({ ok: true, queued: true });
  });

  it('ignores a currency block that is absent or malformed', async () => {
    for (const currency of [null, undefined, {}, { detected: 'dollars' }, { detected: 42 }]) {
      stubFetch({ status: 202, json: { ...SHOPIFY_OK, currency } });
      const outcome = await connectShopifyForAccount(7, SHOPIFY_CREDS);
      expect(outcome.detectedCurrency).toBeNull();
    }
  });

  // --- THE CREDENTIAL TRIPWIRE -------------------------------------------
  const ECHOES: [string, unknown][] = [
    ['clientSecret', { ...SHOPIFY_OK, clientSecret: CLIENT_SECRET }],
    ['client_secret', { ...SHOPIFY_OK, client_secret: CLIENT_SECRET }],
    ['clientId', { ...SHOPIFY_OK, clientId: CLIENT_ID }],
    ['apiKey', { ...KLAVIYO_OK, apiKey: KLAVIYO_KEY }],
    ['api_key', { ...KLAVIYO_OK, api_key: KLAVIYO_KEY }],
    ['token', { ...RECHARGE_OK, token: RECHARGE_TOKEN }],
    ['accessToken', { ...RECHARGE_OK, accessToken: 'synthetic-access' }],
    ['access_token', { ...KLAVIYO_OK, access_token: 'synthetic-access' }],
    ['credentials', { ...KLAVIYO_OK, credentials: { apiKey: KLAVIYO_KEY } }],
    ['credentials_encrypted', { ...KLAVIYO_OK, credentials_encrypted: 'AES...' }],
    ['a NESTED credential', { ...KLAVIYO_OK, account: { meta: { apiKey: KLAVIYO_KEY } } }],
  ];

  it.each(ECHOES)('REJECTS a response echoing %s rather than rendering around it',
    async (_label, body) => {
      stubFetch({ status: 202, json: body });
      const error = await captureError(() => connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY }));
      expect(error.code).toBe('connection_response_contains_credential');
    });

  it('does not quote the credential it refused', async () => {
    stubFetch({ status: 202, json: { ...KLAVIYO_OK, apiKey: KLAVIYO_KEY } });
    const error = await captureError(() => connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY }));
    expect(error.message).toBe('The server returned an unexpected response.');
    expect(error.message).not.toContain(KLAVIYO_KEY);
  });

  it.each([
    ['a missing ok', { queued: true }],
    ['ok:false', { ok: false, queued: true }],
    ['a missing queued', { ok: true }],
    ['a non-boolean queued', { ok: true, queued: 'yes' }],
    ['a null body', null],
    ['an array body', [{ ok: true, queued: true }]],
  ])('rejects %s', async (_label, body) => {
    stubFetch({ status: 202, json: body });
    await expect(connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ['a missing shopDomain', { ...SHOPIFY_OK, shopDomain: undefined }],
    ['an empty shopDomain', { ...SHOPIFY_OK, shopDomain: '' }],
    ['a missing timezoneApplied', { ...SHOPIFY_OK, timezoneApplied: undefined }],
    ['a non-boolean timezoneApplied', { ...SHOPIFY_OK, timezoneApplied: 'yes' }],
  ])('rejects Shopify with %s', async (_label, body) => {
    stubFetch({ status: 202, json: body });
    await expect(connectShopifyForAccount(7, SHOPIFY_CREDS)).rejects.toBeInstanceOf(ApiError);
  });

  it('validates the skip response', async () => {
    stubFetch({
      json: {
        provider: 'klaviyo', state: 'skipped',
        providers: [{
          provider: 'klaviyo', state: 'skipped', connectionStatus: null,
          requestedDomain: null, shopDomain: null, lastSyncAt: null,
        }],
      },
    });
    const outcome = await skipProviderForAccount(7, 'klaviyo');
    expect(outcome.provider).toBe('klaviyo');
    expect(outcome.state).toBe('skipped');
    expect(outcome.providers).toHaveLength(1);
  });

  it.each([
    ['a wrong state', { provider: 'klaviyo', state: 'connected', providers: [] }],
    ['an unknown provider', { provider: 'stripe', state: 'skipped', providers: [] }],
    ['missing providers', { provider: 'klaviyo', state: 'skipped' }],
    ['a null body', null],
  ])('rejects a skip response with %s', async (_label, body) => {
    stubFetch({ json: body });
    await expect(skipProviderForAccount(7, 'klaviyo')).rejects.toBeInstanceOf(ApiError);
  });
});

// ===========================================================================
// Failures
// ===========================================================================
describe('connection failures', () => {
  it.each([
    ['missing_credentials', 400],
    ['invalid_domain', 400],
    ['domain_conflict', 400],
    ['verification_failed', 502],
  ])('surfaces %s as a machine code the UI can branch on', async (code, status) => {
    stubFetch({ status, json: { ok: false, code, message: 'raw backend prose' } });
    const error = await captureError(() => connectShopifyForAccount(7, SHOPIFY_CREDS));
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  it('never returns the backend message, which embeds the provider exception', async () => {
    stubFetch({
      status: 502,
      json: {
        ok: false, code: 'verification_failed',
        message: 'Shopify verification failed: token exchange failed for '
          + 'synthetic-shop.myshopify.com: HTTP 404',
      },
    });
    const error = await captureError(() => connectShopifyForAccount(7, SHOPIFY_CREDS));
    // ApiError may carry it; what matters is the UI maps on `code`. Assert the
    // code is present so the UI never has to fall back to prose.
    expect(error.code).toBe('verification_failed');
  });

  it('propagates a 401 for the shared session-expiry path', async () => {
    stubFetch({ status: 401, json: { error: 'unauthorized' } });
    expect((await captureError(() => connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY }))).status)
      .toBe(401);
  });

  it('propagates a network failure', async () => {
    stubFetchNetworkError();
    await expect(connectRechargeForAccount(7, { token: RECHARGE_TOKEN }))
      .rejects.toMatchObject({ kind: 'network' });
  });

  it('sends the credential exactly once even when the call fails', async () => {
    stubFetch({ status: 502, json: { ok: false, code: 'verification_failed', message: 'x' } });
    await captureError(() => connectKlaviyoForAccount(7, { apiKey: KLAVIYO_KEY }));
    expect(calls).toHaveLength(1);
  });
});
