import { describe, expect, it, vi } from 'vitest';
import { describeLoginFailure, isStillSignedOut, type LoginFailure } from './authErrors';
import { ApiError, apiErrorFromResponse, apiErrorFromThrown } from './errors';
import { api } from './client';
import { calls, lastCall, stubFetch, stubFetchSequence } from '@/test/server';

// The EXACT bodies POST /auth/login returns, captured from the running backend
// rather than assumed. Every mapping below is asserted against these.
const BACKEND = {
  forbiddenOrigin: { status: 403, body: { error: 'forbidden_origin' } },
  unsupportedMedia: { status: 415, body: { error: 'unsupported_media_type' } },
  missingField: { status: 400, body: { error: 'email and password required' } },
  malformedJson: {
    status: 400,
    body: {
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      error: 'Bad Request',
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    },
  },
  invalidCredentials: { status: 401, body: { error: 'invalid credentials' } },
} as const;

const EMAIL = 'staff@agency.test';
const PASSWORD = 'a-real-looking-password-1234';

function failureFor(status: number, body: unknown, headers?: Headers): LoginFailure {
  return describeLoginFailure(apiErrorFromResponse(status, body, headers));
}

describe('the three new backend responses map to their specified messages', () => {
  it('403 displays the safe origin-blocked message', () => {
    const failure = failureFor(BACKEND.forbiddenOrigin.status, BACKEND.forbiddenOrigin.body);
    expect(failure.kind).toBe('blocked_origin');
    expect(failure.message).toBe(
      'This login request was blocked. Open the application from its official address and try again.',
    );
  });

  it('415 displays the safe request-format message', () => {
    const failure = failureFor(BACKEND.unsupportedMedia.status, BACKEND.unsupportedMedia.body);
    expect(failure.kind).toBe('unsupported_request_format');
    expect(failure.message).toBe(
      'The login request could not be sent correctly. Refresh the page and try again.',
    );
  });

  it('400 (missing field) displays the safe malformed-request message', () => {
    const failure = failureFor(BACKEND.missingField.status, BACKEND.missingField.body);
    expect(failure.kind).toBe('invalid_form');
    expect(failure.message).toBe('Please check the login form and try again.');
  });

  it('400 (malformed JSON) displays the same safe message', () => {
    const failure = failureFor(BACKEND.malformedJson.status, BACKEND.malformedJson.body);
    expect(failure.kind).toBe('invalid_form');
    expect(failure.message).toBe('Please check the login form and try again.');
  });
});

describe('no raw backend content reaches the message', () => {
  // These are the exact strings the backend sends. None may be rendered.
  const RAW_FRAGMENTS = [
    'forbidden_origin',
    'unsupported_media_type',
    'email and password required',
    'FST_ERR_CTP_INVALID_JSON_BODY',
    'Body is not valid JSON',
    'content-type',
    'Bad Request',
    'invalid credentials',
    'statusCode',
  ];

  it.each(Object.entries(BACKEND))('%s renders none of the raw body', (_label, response) => {
    const failure = failureFor(response.status, response.body);
    const rendered = JSON.stringify(failure);
    for (const fragment of RAW_FRAGMENTS) {
      expect(rendered).not.toContain(fragment);
    }
  });

  it('the whole response body is absent from the failure object', () => {
    const failure = failureFor(BACKEND.malformedJson.status, BACKEND.malformedJson.body);
    expect(Object.keys(failure).sort()).toEqual([
      'isCredentialProblem', 'kind', 'message', 'retryAfterSeconds', 'retryAutomatically',
    ]);
  });

  it('never exposes origin configuration, APP_BASE_URL, or a request header', () => {
    for (const response of Object.values(BACKEND)) {
      const rendered = JSON.stringify(failureFor(response.status, response.body));
      for (const leak of [
        'http://', 'https://', 'localhost', '5173', '3000', 'APP_BASE_URL',
        'Origin', 'origin:', 'Sec-Fetch', 'Referer', 'Host:', '/api',
      ]) {
        expect(rendered).not.toContain(leak);
      }
    }
  });

  it('never renders a raw thrown Error or a stack trace', () => {
    const failure = describeLoginFailure(
      new Error('TypeError: boom\n    at login (/Users/deployuser/app/x.js:1:1)'),
    );
    expect(failure.message).toBe('Sign-in failed. Please try again.');
    expect(failure.message).not.toContain('/Users/');
    expect(failure.message).not.toContain('at login');
  });
});

describe('403 and 415 are never a password verdict', () => {
  it.each([
    ['403', BACKEND.forbiddenOrigin],
    ['415', BACKEND.unsupportedMedia],
    ['400', BACKEND.missingField],
  ])('%s does not claim the credentials were wrong', (_label, response) => {
    const failure = failureFor(response.status, response.body);
    expect(failure.isCredentialProblem).toBe(false);
    expect(failure.message.toLowerCase()).not.toContain('password');
    expect(failure.message.toLowerCase()).not.toContain('incorrect');
  });

  it('only a 401 is treated as a credential problem', () => {
    const failure = failureFor(BACKEND.invalidCredentials.status, BACKEND.invalidCredentials.body);
    expect(failure.kind).toBe('invalid_credentials');
    expect(failure.isCredentialProblem).toBe(true);
  });

  it('every failure leaves the user signed out', () => {
    for (const response of Object.values(BACKEND)) {
      expect(isStillSignedOut(failureFor(response.status, response.body))).toBe(true);
    }
  });
});

describe('no automatic retry', () => {
  it.each(Object.entries(BACKEND))('%s is never marked for automatic retry', (_label, response) => {
    expect(failureFor(response.status, response.body).retryAutomatically).toBe(false);
  });

  it('a 429 carries the backend retry delay but still does not self-retry', () => {
    const failure = failureFor(429, { statusCode: 429 }, new Headers({ 'retry-after': '300' }));
    expect(failure.kind).toBe('rate_limited');
    expect(failure.retryAfterSeconds).toBe(300);
    expect(failure.retryAutomatically).toBe(false);
    expect(failure.message).toBe('Too many sign-in attempts. Please wait 300 seconds and try again.');
  });

  it('a 429 with no Retry-After still produces a safe message', () => {
    const failure = failureFor(429, {}, new Headers());
    expect(failure.retryAfterSeconds).toBeNull();
    expect(failure.message).toBe('Too many sign-in attempts. Please wait and try again.');
  });

  it('the API client itself makes exactly one login attempt', async () => {
    stubFetchSequence([BACKEND.forbiddenOrigin, { status: 200, json: { id: 1, email: EMAIL } }]);
    await expect(api.post('/auth/login', { email: EMAIL, password: PASSWORD }))
      .rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});

describe('transport failures', () => {
  it('a network failure maps to the network message', () => {
    const failure = describeLoginFailure(apiErrorFromThrown(new TypeError('Failed to fetch')));
    expect(failure.kind).toBe('network');
    expect(failure.isCredentialProblem).toBe(false);
  });

  it('an aborted request is reported as cancelled, not as a failed password', () => {
    const failure = describeLoginFailure(
      apiErrorFromThrown(new DOMException('aborted', 'AbortError')),
    );
    expect(failure.kind).toBe('cancelled');
    expect(failure.isCredentialProblem).toBe(false);
  });

  it('a 500 maps to the server message, not a credential verdict', () => {
    const failure = failureFor(500, { statusCode: 500, message: 'internal detail' });
    expect(failure.kind).toBe('server_error');
    expect(failure.isCredentialProblem).toBe(false);
    expect(failure.message).not.toContain('internal detail');
  });
});

describe('credentials never escape the request body', () => {
  it('the login request sends Content-Type: application/json', async () => {
    stubFetch({ json: { id: 1, email: EMAIL } });
    await api.post('/auth/login', { email: EMAIL, password: PASSWORD });
    expect(lastCall().headers['content-type']).toBe('application/json');
  });

  it('the login request posts credentials in the body, never in the URL', async () => {
    stubFetch({ json: { id: 1, email: EMAIL } });
    await api.post('/auth/login', { email: EMAIL, password: PASSWORD });
    expect(lastCall().url).toBe('/api/auth/login');
    expect(lastCall().url).not.toContain(EMAIL);
    expect(lastCall().url).not.toContain(PASSWORD);
    expect(lastCall().body).toContain(PASSWORD);
  });

  it('the client never sets Origin, Sec-Fetch-Site, Host, or Referer', async () => {
    stubFetch({ json: { id: 1, email: EMAIL } });
    await api.post('/auth/login', { email: EMAIL, password: PASSWORD });
    const sent = Object.keys(lastCall().headers);
    for (const forbidden of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'host', 'referer']) {
      expect(sent).not.toContain(forbidden);
    }
    // Only the two the client is allowed to control.
    expect(sent.sort()).toEqual(['accept', 'content-type']);
  });

  it.each(Object.entries(BACKEND))(
    '%s puts no email or password in the failure, and logs nothing',
    async (_label, response) => {
      const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      stubFetch({ status: response.status, json: response.body });

      const thrown = await api
        .post('/auth/login', { email: EMAIL, password: PASSWORD })
        .then(() => null)
        .catch((e: unknown) => e);
      const failure = describeLoginFailure(thrown);

      const rendered = JSON.stringify(failure);
      expect(rendered).not.toContain(EMAIL);
      expect(rendered).not.toContain(PASSWORD);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );

  it('nothing is written to browser storage during a failed login', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    stubFetch({ status: 403, json: BACKEND.forbiddenOrigin.body });
    await api.post('/auth/login', { email: EMAIL, password: PASSWORD }).catch(() => undefined);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
