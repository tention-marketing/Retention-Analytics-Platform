import { describe, expect, it } from 'vitest';
import { ApiError, apiClientError, apiErrorFromResponse, apiErrorFromThrown } from '@/api/errors';
import { describeAccountFailure } from './accountErrors';

// Account-creation failures become fixed sentences, chosen here, and never
// anything the server said. These cases are the seven responses POST /accounts
// can actually produce.

const fromResponse = (status: number, body: unknown) => apiErrorFromResponse(status, body);

describe('describeAccountFailure', () => {
  it('maps the backend timezone rejection to an actionable sentence', () => {
    const failure = describeAccountFailure(fromResponse(400, { error: 'invalid_store_timezone' }));
    expect(failure.kind).toBe('invalid_timezone');
    expect(failure.message).toBe(
      'That timezone was not recognised. Choose one from the list and try again.',
    );
  });

  it.each([
    ['a name rejection', 400, { error: 'name required' }, 'invalid_request'],
    ['malformed JSON', 400, { code: 'FST_ERR_CTP_INVALID_JSON_BODY' }, 'invalid_request'],
    ['a blocked origin', 403, { error: 'forbidden_origin' }, 'invalid_request'],
    ['a non-JSON body', 415, { error: 'unsupported_media_type' }, 'invalid_request'],
    ['an expired session', 401, { error: 'unauthorized' }, 'session_expired'],
    ['a server fault', 500, { message: 'boom' }, 'server_error'],
    ['a bad gateway', 502, {}, 'server_error'],
    ['an unmapped status', 418, {}, 'unknown'],
  ])('maps %s to %s', (_label, status, body, kind) => {
    expect(describeAccountFailure(fromResponse(status, body)).kind).toBe(kind);
  });

  it('maps a transport failure to network, never to a credential problem', () => {
    expect(describeAccountFailure(apiErrorFromThrown(new TypeError('Failed to fetch'))).kind)
      .toBe('network');
  });

  it('maps an abort to cancelled', () => {
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    expect(describeAccountFailure(apiErrorFromThrown(aborted)).kind).toBe('cancelled');
  });

  it('maps a boundary-validation refusal to unknown', () => {
    expect(describeAccountFailure(apiClientError('x', 'malformed_account_payload')).kind)
      .toBe('unknown');
  });

  it('collapses a non-ApiError instead of reading its message', () => {
    const failure = describeAccountFailure(new Error('at Object.<anonymous> (/Users/x/a.ts:1:1)'));
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toBe('Something went wrong. The account was not created.');
  });

  it('never renders anything the server wrote', () => {
    // Every branch, checked against the strings a backend could put in a body.
    const hostile = [
      fromResponse(400, { message: 'column "store_timezone" violates check constraint' }),
      fromResponse(400, { error: 'invalid_store_timezone', message: 'ICU rejected Not/A_Timezone' }),
      fromResponse(500, { message: 'ENOENT at /Users/deploy/src/db/pool.ts:14:9' }),
      fromResponse(401, { message: 'session 8f3a-1c2d expired' }),
      apiClientError('internal detail', 'malformed_account_payload'),
      apiErrorFromThrown(new TypeError('Failed to fetch')),
    ];
    for (const error of hostile) {
      const { message } = describeAccountFailure(error);
      for (const leak of ['column', 'constraint', 'ICU', 'ENOENT', '/Users/', 'pool.ts',
        '8f3a', 'internal detail', 'Not/A_Timezone']) {
        expect(message, `${leak} leaked`).not.toContain(leak);
      }
    }
  });

  it('returns a non-empty sentence for every ApiError shape it can see', () => {
    for (const status of [400, 401, 403, 404, 409, 415, 422, 429, 500, 503]) {
      const { message } = describeAccountFailure(new ApiError({ status, kind: 'http', message: 'x' }));
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toBe('x');
    }
  });
});
