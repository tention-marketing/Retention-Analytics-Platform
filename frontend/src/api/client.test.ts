import { describe, expect, it, vi } from 'vitest';
import { API_BASE, api, normalizeApiBase, resolveApiUrl } from './client';
import { ApiError } from './errors';
import {
  calls, lastCall, stubFetch, stubFetchNetworkError, stubFetchNeverResolves, stubFetchSequence,
} from '@/test/server';

describe('API base configuration', () => {
  it('uses /api as its base', () => {
    expect(API_BASE).toBe('/api');
  });

  it('defaults to /api when nothing is configured', () => {
    expect(normalizeApiBase(undefined)).toBe('/api');
  });

  it('strips a trailing slash so paths do not double up', () => {
    expect(normalizeApiBase('/api/')).toBe('/api');
  });

  it.each([
    ['an absolute http URL', 'http://localhost:3000'],
    ['an absolute https URL', 'https://api.example.com'],
    ['a scheme-relative URL', '//api.example.com'],
    ['a bare hostname', 'api.example.com'],
  ])('refuses %s as a base — it would send the session cookie off-origin', (_label, base) => {
    expect(() => normalizeApiBase(base)).toThrow(/same-origin absolute path/);
  });
});

describe('target restriction', () => {
  it('resolves a path inside the base', () => {
    expect(resolveApiUrl('/auth/me')).toBe('/api/auth/me');
  });

  it('preserves the query string', () => {
    expect(resolveApiUrl('/accounts?limit=5')).toBe('/api/accounts?limit=5');
  });

  it('drops the fragment, which is where a 5C onboarding token would live', () => {
    expect(resolveApiUrl('/onboarding#token=secret')).toBe('/api/onboarding');
  });

  it.each([
    ['an absolute https URL', 'https://evil.example.com/steal'],
    ['an absolute http URL', 'http://evil.example.com/steal'],
    ['a scheme-relative URL', '//evil.example.com/steal'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a path with no leading slash', 'auth/me'],
    ['an empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(() => resolveApiUrl(path)).toThrow(ApiError);
  });

  it('rejects traversal that escapes the base after URL normalization', () => {
    expect(() => resolveApiUrl('/../auth/me')).toThrow(/outside the API base/);
    expect(() => resolveApiUrl('/../../etc/passwd')).toThrow(/outside the API base/);
  });

  it('reports a client-kind error without contacting the network', async () => {
    stubFetch({ json: { ok: true } });
    await expect(api.get('https://evil.example.com')).rejects.toMatchObject({
      kind: 'client',
      status: 0,
      code: 'invalid_api_path',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('request construction', () => {
  it('always sends credentials: include so the httpOnly agency cookie is attached', async () => {
    stubFetch({ json: { id: 1 } });
    await api.get('/auth/me');
    expect(lastCall().credentials).toBe('include');
  });

  it('sends credentials on every verb', async () => {
    for (const call of [
      () => api.get('/x'),
      () => api.post('/x', { a: 1 }),
      () => api.put('/x', { a: 1 }),
      () => api.patch('/x', { a: 1 }),
      () => api.delete('/x'),
    ]) {
      stubFetch({ json: {} });
      await call();
      expect(lastCall().credentials).toBe('include');
    }
  });

  it('prefixes the request with the API base', async () => {
    stubFetch({ json: {} });
    await api.get('/auth/me');
    expect(lastCall().url).toBe('/api/auth/me');
  });

  it('encodes a JSON body and sets the content type', async () => {
    stubFetch({ json: {} });
    await api.post('/accounts', { name: 'Acme', store_timezone: 'UTC' });
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toBe(JSON.stringify({ name: 'Acme', store_timezone: 'UTC' }));
  });

  it('sends no body and no content-type when none was supplied', async () => {
    stubFetch({ json: {} });
    await api.post('/accounts/1/currency/resolve-mismatch');
    const call = lastCall();
    expect(call.body).toBeNull();
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('does not let a caller override the client-controlled headers', async () => {
    stubFetch({ json: {} });
    await api.post('/x', { a: 1 }, { headers: { 'Content-Type': 'text/plain' } });
    expect(lastCall().headers['content-type']).toBe('application/json');
  });

  it('never caches authenticated responses and refuses to follow redirects', async () => {
    stubFetch({ json: {} });
    await api.get('/auth/me');
    expect(lastCall().cache).toBe('no-store');
    expect(lastCall().redirect).toBe('error');
  });

  it('never sends useEnvCredentials', async () => {
    stubFetch({ json: {} });
    await api.post('/accounts/1/connections/shopify/credentials', {
      shopDomain: 'x.myshopify.com', clientId: 'id', clientSecret: 'secret',
    });
    expect(lastCall().body).not.toContain('useEnvCredentials');
  });
});

describe('response parsing', () => {
  it('parses a successful JSON response', async () => {
    stubFetch({ json: { id: 7, email: 'a@b.test' } });
    await expect(api.get('/auth/me')).resolves.toEqual({ id: 7, email: 'a@b.test' });
  });

  it('returns null for an empty 204', async () => {
    stubFetch({ status: 204 });
    await expect(api.delete('/accounts/1/onboarding-links/2')).resolves.toBeNull();
  });

  it('returns null for a 200 with no body', async () => {
    stubFetch({ status: 200, text: '' });
    await expect(api.get('/x')).resolves.toBeNull();
  });

  it('does not throw when a JSON content-type carries malformed JSON', async () => {
    stubFetch({ status: 200, text: '{not json', contentType: 'application/json' });
    await expect(api.get('/x')).resolves.toBe('{not json');
  });
});

describe('error normalization through the client', () => {
  it.each([
    [400, { error: 'name required' }],
    [401, { error: 'unauthorized' }],
    [403, { error: 'forbidden' }],
    [404, { error: 'account_not_found' }],
    [409, { completed: false, onboardingBlockers: [] }],
    [500, { statusCode: 500, error: 'Internal Server Error', message: 'boom' }],
  ])('turns a %i into an ApiError', async (status, body) => {
    stubFetch({ status, json: body });
    const error = await api.get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
  });

  it('handles an HTML error page without crashing or rendering it', async () => {
    stubFetch({ status: 502, text: '<html><body>Bad Gateway</body></html>', contentType: 'text/html' });
    const error = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).not.toContain('<html>');
    expect(error.message).toBe('The server could not complete this request.');
  });

  it('handles a completely empty error body', async () => {
    stubFetch({ status: 500 });
    const error = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.message).toBe('The server could not complete this request.');
  });

  it('normalizes a network failure without leaking the underlying TypeError', async () => {
    stubFetchNetworkError(new TypeError('Failed to fetch at /Users/dev/app/node_modules/x.js'));
    const error = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('network');
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('/Users/');
    expect(error.message).not.toContain('TypeError');
  });

  it('reports an aborted request as aborted and not retryable', async () => {
    stubFetchNeverResolves();
    const controller = new AbortController();
    const pending = api.get('/slow', { signal: controller.signal });
    controller.abort();
    const error = (await pending.catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('aborted');
    expect(error.retryable).toBe(false);
  });

  it('forwards the AbortSignal to fetch so cancellation is real', async () => {
    stubFetch({ json: {} });
    const controller = new AbortController();
    await api.get('/x', { signal: controller.signal });
    expect(lastCall().signal).toBe(controller.signal);
  });
});

describe('retry policy', () => {
  it('does not automatically retry a mutation', async () => {
    stubFetchSequence([{ status: 500, json: {} }, { status: 200, json: { ok: true } }]);
    await expect(api.post('/accounts', { name: 'Acme' })).rejects.toBeInstanceOf(ApiError);
    // Exactly one attempt: retry belongs to the caller's policy, never here.
    expect(calls).toHaveLength(1);
  });

  it('does not automatically retry a GET either — that is the query client\'s job', async () => {
    stubFetchSequence([{ status: 503, json: {} }, { status: 200, json: { ok: true } }]);
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});

describe('storage and logging discipline', () => {
  it('never touches localStorage or sessionStorage', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const localGet = vi.spyOn(Storage.prototype, 'getItem');
    stubFetch({ json: { id: 1 } });
    await api.get('/auth/me');
    await api.post('/auth/login', { email: 'a@b.test', password: 'hunter2000' }).catch(() => undefined);
    expect(localSet).not.toHaveBeenCalled();
    expect(localGet).not.toHaveBeenCalled();
  });

  it('never reads document.cookie', async () => {
    const cookieSpy = vi.spyOn(document, 'cookie', 'get');
    stubFetch({ json: { id: 1 } });
    await api.get('/auth/me');
    expect(cookieSpy).not.toHaveBeenCalled();
  });

  it('logs nothing — not the body, not the credentials, not the error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    stubFetch({ status: 401, json: { error: 'unauthorized' } });
    await api.post('/auth/login', { email: 'a@b.test', password: 'hunter2000' }).catch(() => undefined);

    for (const spy of [log, warn, error, debug]) expect(spy).not.toHaveBeenCalled();
  });
});
