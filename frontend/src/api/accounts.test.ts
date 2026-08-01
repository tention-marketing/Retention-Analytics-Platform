import { describe, expect, it } from 'vitest';
import { createAccount, fetchAccounts } from './accounts';
import { ApiError } from './errors';
import { queryKeys } from './queryKeys';
import { calls, lastCall, stubFetch, stubFetchNetworkError } from '@/test/server';

// The account API boundary.
//
// Two jobs: send the request the backend actually documents, and refuse to hand
// the app a value that has not been checked field by field. Everything below is
// synthetic — no real brand name, no real credential.

/**
 * Run a call that must reject, and hand back the ApiError.
 *
 * `.catch(e => e)` would type the result as a union with the success value, and
 * a call that unexpectedly RESOLVED would then sail past the assertions instead
 * of failing the test.
 */
async function captureError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

const ROW = {
  id: 7,
  name: 'Synthetic Brand',
  store_timezone: 'Europe/London',
  onboarding_complete: false,
  created_at: '2026-01-15T09:30:00.000Z',
};

describe('fetchAccounts', () => {
  it('requests GET /api/accounts with the session cookie and no store', async () => {
    stubFetch({ json: [ROW] });
    await fetchAccounts();

    const call = lastCall();
    expect(call.url).toBe('/api/accounts');
    expect(call.method).toBe('GET');
    expect(call.credentials).toBe('include');
    expect(call.cache).toBe('no-store');
    expect(call.body).toBeNull();
  });

  it('returns validated accounts', async () => {
    stubFetch({ json: [ROW] });
    await expect(fetchAccounts()).resolves.toEqual([ROW]);
  });

  it('returns an empty array for an empty directory', async () => {
    stubFetch({ json: [] });
    await expect(fetchAccounts()).resolves.toEqual([]);
  });

  it('drops any field the backend adds that the app has not modelled', async () => {
    // A future column must not reach a component without passing through the
    // type and the parser first.
    stubFetch({ json: [{ ...ROW, rcm_tier: 'gold', revenue: 1_000_000 }] });
    const [account] = await fetchAccounts();
    expect(Object.keys(account ?? {}).sort()).toEqual([
      'created_at', 'id', 'name', 'onboarding_complete', 'store_timezone',
    ]);
  });

  it('passes an abort signal through', async () => {
    stubFetch({ json: [] });
    const controller = new AbortController();
    await fetchAccounts(controller.signal);
    expect(lastCall().signal).toBe(controller.signal);
  });

  // --- boundary validation ------------------------------------------------
  const MALFORMED: [string, unknown][] = [
    ['a non-array body', { accounts: [ROW] }],
    ['a string body', 'not json'],
    ['null', null],
    ['a row missing id', [{ ...ROW, id: undefined }]],
    ['a row with a string id', [{ ...ROW, id: '7' }]],
    ['a row with a zero id', [{ ...ROW, id: 0 }]],
    ['a row with a negative id', [{ ...ROW, id: -1 }]],
    ['a row with a fractional id', [{ ...ROW, id: 7.5 }]],
    ['a row missing name', [{ ...ROW, name: undefined }]],
    ['a row with a numeric name', [{ ...ROW, name: 42 }]],
    ['a row missing store_timezone', [{ ...ROW, store_timezone: undefined }]],
    ['a row with an empty store_timezone', [{ ...ROW, store_timezone: '' }]],
    ['a row missing onboarding_complete', [{ ...ROW, onboarding_complete: undefined }]],
    ['a row with a string onboarding_complete', [{ ...ROW, onboarding_complete: 'false' }]],
    ['a row missing created_at', [{ ...ROW, created_at: undefined }]],
    ['a row with a numeric created_at', [{ ...ROW, created_at: 1_700_000_000 }]],
    ['a null row', [null]],
    ['a nested array row', [[ROW]]],
  ];

  it.each(MALFORMED)('rejects %s at the boundary', async (_label, body) => {
    stubFetch({ json: body });
    await expect(fetchAccounts()).rejects.toBeInstanceOf(ApiError);
  });

  it('fails the whole request rather than silently dropping a bad row', async () => {
    // A directory that quietly omits what it could not parse is indistinguishable
    // from a complete one.
    stubFetch({ json: [ROW, { ...ROW, id: 'nope' }] });
    await expect(fetchAccounts()).rejects.toMatchObject({ code: 'malformed_accounts_payload' });
  });

  it('describes a malformed payload without quoting it', async () => {
    stubFetch({ json: [{ ...ROW, id: '<script>alert(1)</script>' }] });
    const error = await captureError(fetchAccounts);
    expect(error.message).toBe('The server returned an unexpected response.');
    expect(error.message).not.toContain('script');
  });

  it('propagates a 401 as an ApiError rather than an empty list', async () => {
    stubFetch({ status: 401, json: { error: 'unauthorized' } });
    const error = await captureError(fetchAccounts);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
  });

  it('propagates a network failure', async () => {
    stubFetchNetworkError();
    await expect(fetchAccounts()).rejects.toMatchObject({ kind: 'network', status: 0 });
  });
});

describe('createAccount', () => {
  const CREATED = { id: 12, name: 'Synthetic Brand', store_timezone: 'Asia/Tokyo' };

  it('POSTs the backend field names verbatim', async () => {
    stubFetch({ status: 201, json: CREATED });
    await createAccount({ name: 'Synthetic Brand', store_timezone: 'Asia/Tokyo' });

    const call = lastCall();
    expect(call.url).toBe('/api/accounts');
    expect(call.method).toBe('POST');
    expect(call.credentials).toBe('include');
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      name: 'Synthetic Brand',
      store_timezone: 'Asia/Tokyo',
    });
  });

  it('sends no field the backend does not accept', async () => {
    stubFetch({ status: 201, json: CREATED });
    await createAccount({ name: 'Synthetic Brand', store_timezone: 'Asia/Tokyo' });
    expect(Object.keys(JSON.parse(lastCall().body ?? '{}')).sort())
      .toEqual(['name', 'store_timezone']);
  });

  it('makes exactly one request', async () => {
    stubFetch({ status: 201, json: CREATED });
    await createAccount({ name: 'Synthetic Brand', store_timezone: 'Asia/Tokyo' });
    expect(calls).toHaveLength(1);
  });

  it('returns only the three fields the 201 actually carries', async () => {
    stubFetch({ status: 201, json: CREATED });
    await expect(createAccount({ name: 'Synthetic Brand', store_timezone: 'Asia/Tokyo' }))
      .resolves.toEqual(CREATED);
  });

  it.each([
    ['a missing id', { name: 'x', store_timezone: 'UTC' }],
    ['a string id', { id: '12', name: 'x', store_timezone: 'UTC' }],
    ['a missing name', { id: 12, store_timezone: 'UTC' }],
    ['a missing store_timezone', { id: 12, name: 'x' }],
    ['an array body', [CREATED]],
    ['a null body', null],
  ])('rejects a 201 with %s, so no navigation to an undefined id can happen',
    async (_label, body) => {
      stubFetch({ status: 201, json: body });
      await expect(createAccount({ name: 'x', store_timezone: 'UTC' }))
        .rejects.toMatchObject({ code: 'malformed_account_payload' });
    });

  it('surfaces the backend timezone rejection as a machine code, not prose', async () => {
    stubFetch({ status: 400, json: { error: 'invalid_store_timezone' } });
    const error = await captureError(
      () => createAccount({ name: 'x', store_timezone: 'Not/A_Timezone' }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_store_timezone');
  });
});

describe('account query keys', () => {
  it('are stable', () => {
    expect(queryKeys.accounts.list()).toEqual(['accounts', 'list']);
    expect(queryKeys.accounts.detail(7)).toEqual(['accounts', 'detail', 7]);
  });

  it('nest under the invalidation prefix', () => {
    const prefix = queryKeys.accounts.all();
    for (const key of [queryKeys.accounts.list(), queryKeys.accounts.detail(7)]) {
      expect(key.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });

  it('carry nothing but literals and a resource id', () => {
    // Keys live in memory and in devtools, and are the cache's identity. An
    // email, a cookie, a token or a password in one would be a credential stored
    // somewhere nobody thinks of as storage.
    const flat = [
      ...queryKeys.accounts.all(),
      ...queryKeys.accounts.list(),
      ...queryKeys.accounts.detail(7),
    ];
    for (const part of flat) {
      expect(['string', 'number']).toContain(typeof part);
    }
    const serialized = JSON.stringify(flat).toLowerCase();
    for (const secret of [
      'password', 'token', 'cookie', 'session', 'tention_sid', 'tention_onb',
      'secret', 'credential', 'authorization', '@',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
