import { describe, expect, it, vi } from 'vitest';
import { createQueryClient, shouldRetryQuery } from './queryClient';
import { ApiError, apiErrorFromResponse, apiErrorFromThrown } from '@/api/errors';

describe('query retry policy', () => {
  it.each([401, 403, 404, 409, 400, 422])('does not retry a %i', (status) => {
    expect(shouldRetryQuery(0, apiErrorFromResponse(status, {}))).toBe(false);
  });

  it('allows a limited retry for a transient 5xx', () => {
    const error = apiErrorFromResponse(503, {});
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(false);
  });

  it('allows a limited retry for a network failure', () => {
    expect(shouldRetryQuery(0, apiErrorFromThrown(new TypeError('Failed to fetch')))).toBe(true);
  });

  it('does not retry a rate-limited request — that would burn the remaining budget', () => {
    expect(shouldRetryQuery(0, apiErrorFromResponse(429, {}, new Headers()))).toBe(false);
  });

  it('does not retry an aborted request', () => {
    expect(shouldRetryQuery(0, apiErrorFromThrown(new DOMException('x', 'AbortError')))).toBe(false);
  });

  it('does not retry an unrecognised thrown value', () => {
    expect(shouldRetryQuery(0, new Error('boom'))).toBe(false);
    expect(shouldRetryQuery(0, 'boom')).toBe(false);
  });
});

describe('query client defaults', () => {
  it('never retries mutations', () => {
    const defaults = createQueryClient().getDefaultOptions();
    expect(defaults.mutations?.retry).toBe(false);
  });

  it('does no background refetching by default', () => {
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(defaults?.refetchOnWindowFocus).toBe(false);
    expect(defaults?.refetchOnReconnect).toBe(false);
    expect(defaults?.refetchInterval).toBe(false);
  });

  it('wires the retry predicate rather than a plain retry count', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    expect(typeof retry).toBe('function');
    expect((retry as typeof shouldRetryQuery)(0, apiErrorFromResponse(401, {}))).toBe(false);
  });

  it('does not persist its cache to browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const client = createQueryClient();
    client.setQueryData(['auth', 'me'], { id: 1, email: 'a@b.test' });
    await Promise.resolve();

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('gives a fresh client an empty cache, so logout can drop everything by replacing it', () => {
    const client = createQueryClient();
    client.setQueryData(['auth', 'me'], { id: 1 });
    expect(client.getQueryCache().getAll()).toHaveLength(1);

    client.clear();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('only ever sees ApiError, so no raw failure can drive retry decisions', () => {
    // Guards the assumption shouldRetryQuery is built on.
    expect(apiErrorFromResponse(500, {})).toBeInstanceOf(ApiError);
    expect(apiErrorFromThrown(new TypeError('x'))).toBeInstanceOf(ApiError);
  });
});
