import { describe, expect, it } from 'vitest';
import {
  createOnboardingLink, getAgencyOnboardingStatus, getOnboardingLinks, revokeOnboardingLink,
  ONBOARDING_LINK_TTL_DAYS,
} from './onboarding';
import { ApiError } from './errors';
import { queryKeys } from './queryKeys';
import { calls, lastCall, stubFetch, stubFetchNetworkError } from '@/test/server';

// The agency onboarding API boundary.
//
// SYNTHETIC EVERYTHING. The token below is assembled at runtime rather than
// written as a literal, because documentPolicy.test.ts refuses any 43-character
// base64url run in source — a fixture realistic enough to satisfy the validator
// is also realistic enough to be mistaken for a leaked credential.
const SYNTHETIC_TOKEN = 'synthetic-test-token'.padEnd(43, 'z');
const SETUP_URL = `https://app.example.invalid/onboarding#token=${SYNTHETIC_TOKEN}`;

const CREATED = {
  id: 5,
  expiresAt: '2026-08-15T02:30:19.852Z',
  token: SYNTHETIC_TOKEN,
  url: SETUP_URL,
  note: 'The token is shown once and cannot be retrieved again. Reissue if lost.',
};

const LINK_ROW = {
  id: 5,
  status: 'active',
  expires_at: '2026-08-15T02:30:19.855Z',
  revoked_at: null,
  first_used_at: null,
  completed_at: null,
  created_at: '2026-08-01T02:30:19.854Z',
};

const STATUS = {
  onboardingComplete: false,
  onboardingBlockers: [
    { code: 'no_platform_connected', message: 'Connect at least one platform to finish setup.', step: 'connect' },
  ],
  rcmReadiness: {
    ready: false,
    blockers: [{ code: 'shopify_not_connected', message: 'Connect Shopify to turn on RCM analytics.', step: 'connect' }],
    details: { shopifyConnected: false, cogsCoveragePct: null },
  },
  providers: [
    { provider: 'shopify', state: 'undecided', connectionStatus: null, requestedDomain: null, shopDomain: null, lastSyncAt: null },
  ],
  capabilities: { connected: [], available: [], fullExperience: false },
  progress: [
    { provider: 'shopify', state: 'not_started', counts: {}, lastSyncAt: null, jobId: null, jobState: null, attemptsMade: null, failure: null, recentFailures: [] },
  ],
  links: [LINK_ROW],
  uiStates: {
    onboardingInProgress: true, onboardingComplete: false, limitedAnalyticsAvailable: false,
    shopifyNotConnected: true, rcmSetupIncomplete: false, rcmReady: false, syncStillRunning: false,
  },
};

async function captureError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

// ===========================================================================
// Creation
// ===========================================================================
describe('createOnboardingLink', () => {
  it('POSTs to the account-scoped route', async () => {
    stubFetch({ status: 201, json: CREATED });
    await createOnboardingLink(7);

    const call = lastCall();
    expect(call.url).toBe('/api/accounts/7/onboarding-links');
    expect(call.method).toBe('POST');
    expect(call.credentials).toBe('include');
    expect(call.cache).toBe('no-store');
  });

  it('sends exactly one request', async () => {
    stubFetch({ status: 201, json: CREATED });
    await createOnboardingLink(7);
    expect(calls).toHaveLength(1);
  });

  it('requests the fixed 14-day lifetime, matching the copy shown to the agency', async () => {
    stubFetch({ status: 201, json: CREATED });
    await createOnboardingLink(7);
    expect(ONBOARDING_LINK_TTL_DAYS).toBe(14);
    expect(JSON.parse(lastCall().body ?? '{}')).toEqual({ ttlDays: 14 });
  });

  it('returns the validated URL and metadata', async () => {
    stubFetch({ status: 201, json: CREATED });
    await expect(createOnboardingLink(7)).resolves.toEqual({
      id: 5,
      expiresAt: '2026-08-15T02:30:19.852Z',
      url: SETUP_URL,
    });
  });

  it('DISCARDS the separate token field from the domain model', async () => {
    stubFetch({ status: 201, json: CREATED });
    const issued = await createOnboardingLink(7);

    // The token still exists — inside the URL, where the server put it. What
    // must not exist is a second, separately addressable copy.
    expect(Object.keys(issued).sort()).toEqual(['expiresAt', 'id', 'url']);
    expect(issued).not.toHaveProperty('token');
    expect(issued).not.toHaveProperty('note');
  });

  it('returns the server URL verbatim rather than reassembling one', async () => {
    stubFetch({ status: 201, json: CREATED });
    const issued = await createOnboardingLink(7);
    expect(issued.url).toBe(CREATED.url);
  });

  // --- response validation ------------------------------------------------
  it.each([
    ['a missing id', { ...CREATED, id: undefined }],
    ['a string id', { ...CREATED, id: '5' }],
    ['a zero id', { ...CREATED, id: 0 }],
    ['a missing expiresAt', { ...CREATED, expiresAt: undefined }],
    ['an unparseable expiresAt', { ...CREATED, expiresAt: 'soon' }],
    ['an array body', [CREATED]],
    ['a null body', null],
  ])('rejects %s', async (_label, body) => {
    stubFetch({ status: 201, json: body });
    await expect(createOnboardingLink(7)).rejects.toBeInstanceOf(ApiError);
  });

  // --- URL validation -----------------------------------------------------
  const BAD_URLS: [string, unknown, string][] = [
    ['a missing url', undefined, 'malformed_setup_url'],
    ['a non-string url', 42, 'malformed_setup_url'],
    ['an unparseable url', 'not a url', 'malformed_setup_url'],
    ['a relative url', `/onboarding#token=${SYNTHETIC_TOKEN}`, 'malformed_setup_url'],
    ['a javascript: url', `javascript:alert('${SYNTHETIC_TOKEN}')`, 'setup_url_bad_scheme'],
    ['a data: url', `data:text/html,${SYNTHETIC_TOKEN}`, 'setup_url_bad_scheme'],
    ['a ftp: url', `ftp://example.invalid/onboarding#token=${SYNTHETIC_TOKEN}`, 'setup_url_bad_scheme'],
    [
      'embedded credentials',
      `https://user:pass@app.example.invalid/onboarding#token=${SYNTHETIC_TOKEN}`,
      'setup_url_has_credentials',
    ],
    [
      'a token in the QUERY STRING',
      `https://app.example.invalid/onboarding?token=${SYNTHETIC_TOKEN}`,
      'setup_url_has_query',
    ],
    [
      'a query string alongside the fragment',
      `https://app.example.invalid/onboarding?ref=email#token=${SYNTHETIC_TOKEN}`,
      'setup_url_has_query',
    ],
    [
      'a token in the PATH',
      `https://app.example.invalid/onboarding/${SYNTHETIC_TOKEN}`,
      'setup_url_bad_path',
    ],
    [
      'a path that is not the onboarding route',
      `https://app.example.invalid/setup#token=${SYNTHETIC_TOKEN}`,
      'setup_url_bad_path',
    ],
    ['no fragment at all', 'https://app.example.invalid/onboarding', 'setup_url_bad_fragment'],
    ['an empty fragment', 'https://app.example.invalid/onboarding#', 'setup_url_bad_fragment'],
    [
      'a fragment with the wrong key',
      `https://app.example.invalid/onboarding#t=${SYNTHETIC_TOKEN}`,
      'setup_url_bad_fragment',
    ],
    [
      'a second fragment parameter riding along',
      `https://app.example.invalid/onboarding#token=${SYNTHETIC_TOKEN}&next=/admin`,
      'setup_url_bad_fragment',
    ],
    ['a short token', 'https://app.example.invalid/onboarding#token=abc', 'setup_url_bad_fragment'],
    [
      'a token with characters outside base64url',
      `https://app.example.invalid/onboarding#token=${'!'.repeat(43)}`,
      'setup_url_bad_fragment',
    ],
  ];

  it.each(BAD_URLS)('rejects %s', async (_label, url, code) => {
    stubFetch({ status: 201, json: { ...CREATED, url } });
    const error = await captureError(() => createOnboardingLink(7));
    expect(error.code).toBe(code);
  });

  it('never quotes the rejected URL in the error it raises', async () => {
    stubFetch({ status: 201, json: { ...CREATED, url: `https://evil.invalid/onboarding?token=${SYNTHETIC_TOKEN}` } });
    const error = await captureError(() => createOnboardingLink(7));
    expect(error.message).toBe('The server returned an unexpected response.');
    expect(error.message).not.toContain(SYNTHETIC_TOKEN);
    expect(error.message).not.toContain('evil.invalid');
  });

  it('propagates a 401 for the shared session-expiry path', async () => {
    stubFetch({ status: 401, json: { error: 'unauthorized' } });
    const error = await captureError(() => createOnboardingLink(7));
    expect(error.status).toBe(401);
  });
});

// ===========================================================================
// Listing
// ===========================================================================
describe('getOnboardingLinks', () => {
  it('GETs the account-scoped route with the session cookie', async () => {
    stubFetch({ json: [LINK_ROW] });
    await getOnboardingLinks(7);

    const call = lastCall();
    expect(call.url).toBe('/api/accounts/7/onboarding-links');
    expect(call.method).toBe('GET');
    expect(call.credentials).toBe('include');
    expect(call.body).toBeNull();
  });

  it('returns validated summaries', async () => {
    stubFetch({ json: [LINK_ROW] });
    await expect(getOnboardingLinks(7)).resolves.toEqual([LINK_ROW]);
  });

  it('preserves the backend order rather than re-sorting', async () => {
    const older = { ...LINK_ROW, id: 4 };
    stubFetch({ json: [LINK_ROW, older] });
    expect((await getOnboardingLinks(7)).map((l) => l.id)).toEqual([5, 4]);
  });

  it('accepts an empty directory', async () => {
    stubFetch({ json: [] });
    await expect(getOnboardingLinks(7)).resolves.toEqual([]);
  });

  it('accepts populated timestamps', async () => {
    const used = {
      ...LINK_ROW,
      status: 'revoked',
      revoked_at: '2026-08-02T00:00:00.000Z',
      first_used_at: '2026-08-01T10:00:00.000Z',
      completed_at: '2026-08-01T11:00:00.000Z',
    };
    stubFetch({ json: [used] });
    await expect(getOnboardingLinks(7)).resolves.toEqual([used]);
  });

  // THE TRIPWIRE. These fields were removed from the backend deliberately.
  it.each([
    ['token', { ...LINK_ROW, token: SYNTHETIC_TOKEN }],
    ['token_hash', { ...LINK_ROW, token_hash: 'a'.repeat(64) }],
    ['tokenHash', { ...LINK_ROW, tokenHash: 'a'.repeat(64) }],
    ['a reconstructed url', { ...LINK_ROW, url: SETUP_URL }],
  ])('REJECTS a summary carrying %s rather than dropping it', async (_label, row) => {
    stubFetch({ json: [row] });
    const error = await captureError(() => getOnboardingLinks(7));
    expect(error.code).toBe('link_payload_contains_secret');
  });

  it('does not leak the secret it refused', async () => {
    stubFetch({ json: [{ ...LINK_ROW, token: SYNTHETIC_TOKEN }] });
    const error = await captureError(() => getOnboardingLinks(7));
    expect(error.message).not.toContain(SYNTHETIC_TOKEN);
  });

  it.each([
    ['a non-array body', { links: [LINK_ROW] }],
    ['a null row', [null]],
    ['an unknown status', [{ ...LINK_ROW, status: 'pending' }]],
    ['a missing status', [{ ...LINK_ROW, status: undefined }]],
    ['a string id', [{ ...LINK_ROW, id: '5' }]],
    ['an unparseable expires_at', [{ ...LINK_ROW, expires_at: 'whenever' }]],
    ['a missing created_at', [{ ...LINK_ROW, created_at: undefined }]],
    ['a non-ISO revoked_at', [{ ...LINK_ROW, revoked_at: 'yesterday' }]],
  ])('rejects %s', async (_label, body) => {
    stubFetch({ json: body });
    await expect(getOnboardingLinks(7)).rejects.toBeInstanceOf(ApiError);
  });

  it('fails the whole list rather than dropping one bad row', async () => {
    stubFetch({ json: [LINK_ROW, { ...LINK_ROW, id: 'nope' }] });
    await expect(getOnboardingLinks(7)).rejects.toBeInstanceOf(ApiError);
  });
});

// ===========================================================================
// Revocation
// ===========================================================================
describe('revokeOnboardingLink', () => {
  it('DELETEs the account-scoped path', async () => {
    stubFetch({ json: { revoked: true, id: 5 } });
    await revokeOnboardingLink(7, 5);
    expect(lastCall().url).toBe('/api/accounts/7/onboarding-links/5');
    expect(lastCall().method).toBe('DELETE');
  });

  it('never calls the removed unscoped route', async () => {
    stubFetch({ json: { revoked: true, id: 5 } });
    await revokeOnboardingLink(7, 5);
    // The backend deleted `DELETE /onboarding-links/:linkId` during hardening
    // because it made the account in the URL decorative.
    expect(calls.every((c) => !/^\/api\/onboarding-links\//.test(c.url))).toBe(true);
  });

  it('sends no body and no Content-Type, which the backend requires', async () => {
    stubFetch({ json: { revoked: true, id: 5 } });
    await revokeOnboardingLink(7, 5);

    const call = lastCall();
    expect(call.body).toBeNull();
    // Fastify rejects a bodyless request that still declares JSON with
    // FST_ERR_CTP_EMPTY_JSON_BODY, before the handler ever runs.
    expect(call.headers['content-type']).toBeUndefined();
    expect(call.credentials).toBe('include');
  });

  it('sends exactly one request', async () => {
    stubFetch({ json: { revoked: true, id: 5 } });
    await revokeOnboardingLink(7, 5);
    expect(calls).toHaveLength(1);
  });

  it('propagates the identical 404 used for foreign and nonexistent links', async () => {
    stubFetch({ status: 404, json: { error: 'link_not_found' } });
    const error = await captureError(() => revokeOnboardingLink(7, 5));
    expect(error.status).toBe(404);
  });

  it('propagates a network failure', async () => {
    stubFetchNetworkError();
    await expect(revokeOnboardingLink(7, 5)).rejects.toMatchObject({ kind: 'network' });
  });
});

// ===========================================================================
// Status
// ===========================================================================
describe('getAgencyOnboardingStatus', () => {
  it('GETs the account-scoped status route', async () => {
    stubFetch({ json: STATUS });
    await getAgencyOnboardingStatus(7);
    expect(lastCall().url).toBe('/api/accounts/7/onboarding/status');
    expect(lastCall().credentials).toBe('include');
  });

  it('keeps the two blocker groups separate', async () => {
    stubFetch({ json: STATUS });
    const parsed = await getAgencyOnboardingStatus(7);

    expect(parsed.onboardingBlockers.map((b) => b.code)).toEqual(['no_platform_connected']);
    expect(parsed.rcmReadiness.blockers.map((b) => b.code)).toEqual(['shopify_not_connected']);
    // The union is never formed. A brand can finish client setup with Klaviyo
    // alone and still be far from an RCM figure.
    expect(parsed.onboardingBlockers).not.toEqual(parsed.rcmReadiness.blockers);
  });

  it('drops the queue internals the agency payload carries', async () => {
    stubFetch({ json: STATUS });
    const parsed = await getAgencyOnboardingStatus(7);
    const [progress] = parsed.progress;
    expect(Object.keys(progress ?? {}).sort())
      .toEqual(['counts', 'failure', 'lastSyncAt', 'message', 'provider', 'state']);
    expect(progress).not.toHaveProperty('jobId');
    expect(progress).not.toHaveProperty('jobState');
    expect(progress).not.toHaveProperty('attemptsMade');
  });

  it('models neither capabilities nor the embedded link list', async () => {
    stubFetch({ json: STATUS });
    const parsed = await getAgencyOnboardingStatus(7);
    // `links` is owned by the dedicated links query — one resource, one cache.
    expect(parsed).not.toHaveProperty('links');
    expect(parsed).not.toHaveProperty('capabilities');
  });

  it('keeps only the allowlisted blocker detail keys', async () => {
    stubFetch({
      json: {
        ...STATUS,
        onboardingBlockers: [{
          code: 'provider_undecided',
          message: 'Tell us about every platform.',
          step: 'connect',
          detail: {
            providers: ['shopify', 'klaviyo'],
            months: ['2026-07-01'],
            skus: ['SKU-1'],
            internalQueueKey: 'bull:backfill:42',
            agencyOnlyResolution: true,
          },
        }],
      },
    });
    const parsed = await getAgencyOnboardingStatus(7);
    expect(parsed.onboardingBlockers[0]?.detail).toEqual({
      providers: ['shopify', 'klaviyo'],
      months: ['2026-07-01'],
      skus: ['SKU-1'],
    });
  });

  it('parses a classified failure', async () => {
    stubFetch({
      json: {
        ...STATUS,
        progress: [{
          provider: 'klaviyo', state: 'failed', counts: { campaigns: 3 }, lastSyncAt: null,
          message: 'We hit a problem importing your data.',
          failure: {
            code: 'provider_auth_failed', category: 'auth', provider: 'klaviyo',
            stage: 'klaviyo.backfill', retryable: false,
            publicMessage: 'Authentication with Klaviyo failed.',
            occurredAt: '2026-08-01T00:00:00.000Z',
          },
          recentFailures: [],
        }],
      },
    });
    const parsed = await getAgencyOnboardingStatus(7);
    expect(parsed.progress[0]?.failure?.publicMessage).toBe('Authentication with Klaviyo failed.');
    expect(parsed.progress[0]?.counts).toEqual({ campaigns: 3 });
  });

  // THE OTHER TRIPWIRE. Both fields were removed when the backend was hardened;
  // their return would mean a stack trace is back on the wire.
  it.each([
    ['failedReason on a progress entry', { failedReason: 'Error: ECONNREFUSED at /srv/app/x.ts:1:1' }],
    ['recentErrors on a progress entry', { recentErrors: [{ error: 'stack trace' }] }],
  ])('REJECTS %s', async (_label, extra) => {
    stubFetch({ json: { ...STATUS, progress: [{ ...STATUS.progress[0], ...extra }] } });
    const error = await captureError(() => getAgencyOnboardingStatus(7));
    expect(error.code).toBe('progress_payload_contains_raw_error');
  });

  it('rejects a failure object that smuggles raw text alongside its classification', async () => {
    stubFetch({
      json: {
        ...STATUS,
        progress: [{
          ...STATUS.progress[0], state: 'failed',
          failure: {
            code: 'sync_failed', category: 'internal', provider: 'shopify',
            stage: 'shopify.backfill', retryable: true, publicMessage: 'The sync failed.',
            occurredAt: null,
            failedReason: 'TypeError: fetch failed at /Users/deploy/src/sync.ts:9:3',
          },
        }],
      },
    });
    const error = await captureError(() => getAgencyOnboardingStatus(7));
    expect(error.code).toBe('progress_payload_contains_raw_error');
    expect(error.message).not.toContain('/Users/deploy');
  });

  it.each([
    ['a null body', null],
    ['a missing onboardingComplete', { ...STATUS, onboardingComplete: undefined }],
    ['a non-boolean onboardingComplete', { ...STATUS, onboardingComplete: 'no' }],
    ['missing providers', { ...STATUS, providers: undefined }],
    ['missing progress', { ...STATUS, progress: undefined }],
    ['a blocker with no code', { ...STATUS, onboardingBlockers: [{ message: 'x' }] }],
    ['a blocker with no message', { ...STATUS, onboardingBlockers: [{ code: 'x' }] }],
    ['a non-array blocker list', { ...STATUS, onboardingBlockers: 'none' }],
    ['a missing rcmReadiness', { ...STATUS, rcmReadiness: undefined }],
    ['a non-boolean rcm ready', { ...STATUS, rcmReadiness: { ready: 'yes', blockers: [] } }],
    ['an unknown provider', { ...STATUS, providers: [{ ...STATUS.providers[0], provider: 'stripe' }] }],
    ['an unknown provider state', { ...STATUS, providers: [{ ...STATUS.providers[0], state: 'pending' }] }],
    ['an unknown sync state', { ...STATUS, progress: [{ ...STATUS.progress[0], state: 'thinking' }] }],
    ['missing uiStates', { ...STATUS, uiStates: undefined }],
    ['a non-boolean uiState flag', { ...STATUS, uiStates: { ...STATUS.uiStates, rcmReady: 'no' } }],
  ])('rejects %s', async (_label, body) => {
    stubFetch({ json: body });
    await expect(getAgencyOnboardingStatus(7)).rejects.toBeInstanceOf(ApiError);
  });

  it('drops non-numeric count values rather than rendering them', async () => {
    stubFetch({
      json: {
        ...STATUS,
        progress: [{ ...STATUS.progress[0], counts: { orders: 12, broken: 'many', negative: -3 } }],
      },
    });
    const parsed = await getAgencyOnboardingStatus(7);
    expect(parsed.progress[0]?.counts).toEqual({ orders: 12 });
  });
});

// ===========================================================================
// Query keys
// ===========================================================================
describe('onboarding query keys', () => {
  it('are scoped under the account', () => {
    expect(queryKeys.accounts.onboardingStatus(7))
      .toEqual(['accounts', 'detail', 7, 'onboarding-status']);
    expect(queryKeys.accounts.onboardingLinks(7))
      .toEqual(['accounts', 'detail', 7, 'onboarding-links']);
  });

  it('sit under the account invalidation prefix', () => {
    const prefix = queryKeys.accounts.all();
    for (const key of [
      queryKeys.accounts.onboardingStatus(7),
      queryKeys.accounts.onboardingLinks(7),
    ]) {
      expect(key.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });

  it('carry nothing but literals and a resource id', () => {
    const flat = [
      ...queryKeys.accounts.onboardingStatus(7),
      ...queryKeys.accounts.onboardingLinks(7),
    ];
    for (const part of flat) expect(['string', 'number']).toContain(typeof part);

    const serialized = JSON.stringify(flat).toLowerCase();
    for (const forbidden of [
      'token', 'secret', 'password', 'cookie', 'session', 'tention_sid', 'tention_onb',
      'credential', 'authorization', '#', 'http',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
