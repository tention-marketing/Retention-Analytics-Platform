import { describe, expect, it } from 'vitest';
import {
  ApiError, apiErrorFromResponse, apiErrorFromThrown, isDisplayableMessage,
  parseRetryAfter, toDisplayMessage,
} from './errors';

// The exact string logSyncError writes into sync_errors, and the shape of
// anything that could escape a 5xx. Nothing derived from it may be rendered.
const STACK_TRACE = [
  'TypeError: fetch failed',
  '    at request (/Users/deployuser/app/node_modules/undici/lib/core/request.js:112:15)',
  '    at async node:internal/deps/undici/undici:14976:13',
].join('\n');

describe('isDisplayableMessage', () => {
  it.each([
    'Enter a gross margin percentage.',
    'Connect at least one platform to finish setup.',
    'Product costs currently cover 42.5% of revenue; 80% is needed.',
  ])('accepts a backend message written for a user: %s', (message) => {
    expect(isDisplayableMessage(message)).toBe(true);
  });

  it.each([
    ['a stack trace', STACK_TRACE],
    ['a bare Error string', 'TypeError: Cannot read properties of undefined'],
    ['a frame line', '    at Object.<anonymous> (/app/dist/index.js:1:1)'],
    ['an absolute deploy path', 'failed reading /Users/deployuser/app/.env'],
    ['a node_modules reference', 'crash inside node_modules/pg/lib/client.js'],
    ['a node internal', 'at node:internal/process/task_queues'],
    ['an empty string', '   '],
    ['a non-string', 42],
    ['an overlong blob', 'x'.repeat(301)],
  ])('rejects %s', (_label, value) => {
    expect(isDisplayableMessage(value)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('60')).toBe(60);
  });

  it('parses an HTTP-date into remaining seconds', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const seconds = parseRetryAfter(future);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(31);
  });

  it('clamps a past date to zero rather than returning a negative delay', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it.each([null, '', 'soon', 'NaN'])('returns null for %s', (raw) => {
    expect(parseRetryAfter(raw)).toBeNull();
  });
});

describe('backend error envelopes', () => {
  it('reads a bare { error } code envelope', () => {
    const error = apiErrorFromResponse(401, { error: 'unauthorized' });
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthorized');
    expect(error.message).toBe('Your session has expired. Please sign in again.');
    expect(error.isUnauthenticated).toBe(true);
  });

  it('reads an { error, message } envelope', () => {
    const error = apiErrorFromResponse(400, { error: 'bad_ttl', message: 'ttlDays must be 1-90.' });
    expect(error.code).toBe('bad_ttl');
    expect(error.message).toBe('ttlDays must be 1-90.');
  });

  it('reads a { code, message } envelope', () => {
    const error = apiErrorFromResponse(400, {
      code: 'invalid_domain', message: 'Enter the permanent Shopify domain.',
    });
    expect(error.code).toBe('invalid_domain');
    expect(error.message).toBe('Enter the permanent Shopify domain.');
  });

  it('reads an { ok:false, error, message } envelope', () => {
    const error = apiErrorFromResponse(400, {
      ok: false, error: 'invalid_code', message: 'Enter a 3-letter currency code, for example USD.',
    });
    expect(error.code).toBe('invalid_code');
    expect(error.message).toContain('3-letter currency code');
  });

  it('reads a { connected:false, error } envelope', () => {
    const error = apiErrorFromResponse(400, {
      connected: false, error: 'accountId (number) required',
    });
    // A sentence in `error` is a message, not a code.
    expect(error.code).toBeNull();
    expect(error.message).toBe('accountId (number) required');
  });

  it('reads a Fastify statusCode envelope without adopting its 5xx message', () => {
    const error = apiErrorFromResponse(500, {
      statusCode: 500, error: 'Internal Server Error',
      message: "Cannot read properties of undefined (reading 'rows')",
    });
    expect(error.message).toBe('The server could not complete this request.');
    expect(error.message).not.toContain('undefined');
  });
});

describe('safety of the rendered message', () => {
  it('never adopts a stack trace as the user-facing message', () => {
    const error = apiErrorFromResponse(400, { error: 'sync_failed', message: STACK_TRACE });
    expect(error.message).not.toContain('at async');
    expect(error.message).not.toContain('/Users/');
    expect(error.message).toBe('That request was not valid.');
  });

  it('never adopts a raw string body as the message', () => {
    const error = apiErrorFromResponse(502, '<html><body>Bad Gateway</body></html>');
    expect(error.message).not.toContain('html');
  });

  it('drops every body field outside the safe-detail allowlist', () => {
    const error = apiErrorFromResponse(409, {
      completed: false,
      onboardingBlockers: [{ code: 'no_platform_connected', message: 'Connect at least one platform.' }],
      internalTrace: STACK_TRACE,
      sqlState: '23505',
      credentials: 'pk_live_secret',
    });
    expect(error.details).toEqual({
      onboardingBlockers: [{ code: 'no_platform_connected', message: 'Connect at least one platform.' }],
    });
    expect(JSON.stringify(error.details)).not.toContain('pk_live_secret');
    expect(JSON.stringify(error.details)).not.toContain('sqlState');
    expect(JSON.stringify(error)).not.toContain('at async');
  });

  it('exposes no stack property of its own to render', () => {
    const error = apiErrorFromResponse(500, {});
    expect(Object.keys(error)).not.toContain('response');
    expect(Object.keys(error)).not.toContain('body');
    expect(Object.keys(error)).not.toContain('raw');
  });
});

describe('rate limiting', () => {
  it('recognizes a 429 and preserves the retry delay', () => {
    const error = apiErrorFromResponse(
      429,
      { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 5 minutes' },
      new Headers({ 'retry-after': '300' }),
    );
    expect(error.isRateLimited).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(300);
  });

  it('survives a 429 with no Retry-After header', () => {
    const error = apiErrorFromResponse(429, {}, new Headers());
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBeNull();
    expect(error.message).toBe('Too many attempts. Please wait a moment and try again.');
  });

  it('never echoes a submitted email or password', () => {
    const error = apiErrorFromResponse(
      429,
      { statusCode: 429, error: 'Too Many Requests', email: 'staff@agency.test', password: 'hunter2000' },
      new Headers({ 'retry-after': '60' }),
    );
    const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
    expect(serialized).not.toContain('staff@agency.test');
    expect(serialized).not.toContain('hunter2000');
  });
});

describe('retryable classification', () => {
  it.each([
    [400, false], [401, false], [403, false], [404, false], [409, false], [422, false],
    [408, true], [429, true], [500, true], [502, true], [503, true],
  ])('status %i -> retryable %s', (status, expected) => {
    expect(apiErrorFromResponse(status, {}).retryable).toBe(expected);
  });

  it('treats a network failure as retryable and an abort as not', () => {
    expect(apiErrorFromThrown(new TypeError('Failed to fetch')).retryable).toBe(true);
    expect(apiErrorFromThrown(new DOMException('aborted', 'AbortError')).retryable).toBe(false);
  });
});

describe('field errors', () => {
  it('extracts displayable per-field messages', () => {
    const error = apiErrorFromResponse(400, {
      error: 'validation', fieldErrors: { name: 'Name is required.', ttlDays: 'Must be 1-90.' },
    });
    expect(error.fieldErrors).toEqual({ name: 'Name is required.', ttlDays: 'Must be 1-90.' });
  });

  it('drops a field message that is not safe to display', () => {
    const error = apiErrorFromResponse(400, { fieldErrors: { name: STACK_TRACE } });
    expect(error.fieldErrors).toBeNull();
  });
});

describe('toDisplayMessage', () => {
  it('passes through an ApiError message', () => {
    expect(toDisplayMessage(new ApiError({ status: 404, kind: 'http', message: 'That was not found.' })))
      .toBe('That was not found.');
  });

  it.each([
    ['a raw Error with a stack-ish message', new Error(STACK_TRACE)],
    ['a thrown string', 'boom at /Users/dev/app/x.js'],
    ['null', null],
    ['an object', { message: 'internal detail' }],
  ])('collapses %s to a generic sentence', (_label, thrown) => {
    const message = toDisplayMessage(thrown);
    expect(message).toBe('Something went wrong.');
    expect(message).not.toContain('/Users/');
  });
});
