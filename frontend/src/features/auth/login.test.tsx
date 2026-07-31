import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import { renderWithProviders } from '@/test/render';
import { callCountFor, calls, stubFetchRoutes } from '@/test/server';

// Synthetic credentials only. No real agency address or password appears here.
const EMAIL = 'synthetic.agent@example.invalid';
const PASSWORD = 'synthetic-password-value-1234';
const USER = { id: 4242, email: EMAIL };

const ME = 'GET /api/auth/me';
const LOGIN = 'POST /api/auth/login';

/**
 * Start signed out on /login.
 *
 * The /auth/me stub models the real server rather than a fixed answer: once the
 * login route has replied 200, the session cookie exists and /auth/me starts
 * saying so. Pinning it to 401 forever would make every post-login assertion
 * fight a backend that no browser would ever see.
 */
function arrange(loginResponse: Parameters<typeof stubFetchRoutes>[0][string]) {
  let signedIn = false;
  stubFetchRoutes({
    [ME]: () => (signedIn ? { status: 200, json: USER } : { status: 401, json: { error: 'unauthorized' } }),
    [LOGIN]: (attempt) => {
      const response = typeof loginResponse === 'function' ? loginResponse(attempt) : loginResponse;
      if (response.status === 200) signedIn = true;
      return response;
    },
  });
  return renderWithProviders(<AppRoutes />, { route: '/login' });
}

async function fillAndSubmit(
  user: ReturnType<typeof renderWithProviders>['user'],
  password = PASSWORD,
) {
  await user.type(await screen.findByLabelText('Email address'), EMAIL);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('the login form', () => {
  it('renders accessible, correctly-typed fields', async () => {
    arrange({ status: 401, json: {} });
    const email = await screen.findByLabelText('Email address');
    const password = screen.getByLabelText('Password');

    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('type', 'submit');
  });

  it('offers no registration, password-reset, social or remember-me control', async () => {
    arrange({ status: 401, json: {} });
    await screen.findByLabelText('Email address');
    for (const forbidden of [/register/i, /sign up/i, /forgot/i, /reset/i, /remember/i, /google/i]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('requires both fields without imposing a password length rule', async () => {
    const { user } = arrange({ status: 401, json: {} });
    await screen.findByLabelText('Email address');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    // Nothing was sent.
    expect(callCountFor('POST', '/api/auth/login')).toBe(0);
  });

  it('accepts a short password rather than second-guessing the backend', async () => {
    const { user } = arrange({ status: 200, json: USER });
    await fillAndSubmit(user, 'x');
    // The backend decides. A local minimum could reject a valid password and
    // would recreate the credential oracle the backend deliberately removed.
    await waitFor(() => expect(callCountFor('POST', '/api/auth/login')).toBe(1));
  });

  it('associates a validation error with its field', async () => {
    const { user } = arrange({ status: 401, json: {} });
    await user.type(await screen.findByLabelText('Email address'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const email = await screen.findByLabelText('Email address');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    const describedBy = email.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Enter a valid email address.');
  });
});

describe('successful login', () => {
  it('signs in, seeds the auth cache, and lands on the shell', async () => {
    const { user, queryClient } = arrange({ status: 200, json: USER });
    await fillAndSubmit(user);

    expect(await screen.findByRole('heading', { name: 'Agency home' })).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it('goes straight from the form to the shell with no loading state between', async () => {
    const { user } = arrange({ status: 200, json: USER });
    await fillAndSubmit(user);
    // The login response is written into the auth cache directly, so the shell
    // renders from it rather than waiting on a second /auth/me round trip.
    await screen.findByRole('heading', { name: 'Agency home' });
    expect(screen.queryByText('Checking your sign-in status…')).not.toBeInTheDocument();
  });

  it('sends the credentials as a JSON body with the session cookie', async () => {
    const { user } = arrange({ status: 200, json: USER });
    await fillAndSubmit(user);
    await screen.findByRole('heading', { name: 'Agency home' });

    const loginCall = calls.find((c) => c.url === '/api/auth/login')!;
    expect(loginCall.credentials).toBe('include');
    expect(loginCall.headers['content-type']).toBe('application/json');
    expect(JSON.parse(loginCall.body!)).toEqual({ email: EMAIL, password: PASSWORD });
  });
});

describe('failure messages come from the approved mapper', () => {
  it.each([
    [401, { error: 'invalid credentials' }, 'Email or password is incorrect.'],
    [400, { error: 'email and password required' }, 'Please check the login form and try again.'],
    [
      403,
      { error: 'forbidden_origin' },
      'This login request was blocked. Open the application from its official address and try again.',
    ],
    [
      415,
      { error: 'unsupported_media_type' },
      'The login request could not be sent correctly. Refresh the page and try again.',
    ],
  ])('a %i shows its safe message and keeps the user on /login', async (status, body, expected) => {
    const { user } = arrange({ status, json: body });
    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agency home' })).not.toBeInTheDocument();
  });

  it('shows a safe retry hint for a 429', async () => {
    const { user } = arrange({
      status: 429,
      json: { statusCode: 429, error: 'Too Many Requests' },
      headers: { 'retry-after': '120' },
    });
    await fillAndSubmit(user);
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Too many sign-in attempts. Please wait 120 seconds and try again.');
  });

  it('an unknown email and a wrong password are indistinguishable', async () => {
    const { user, unmount } = arrange({ status: 401, json: { error: 'invalid credentials' } });
    await fillAndSubmit(user);
    const first = (await screen.findByRole('alert')).textContent;
    unmount();

    const second = arrange({ status: 401, json: { error: 'invalid credentials' } });
    await fillAndSubmit(second.user, 'a-completely-different-password');
    expect((await screen.findByRole('alert')).textContent).toBe(first);
  });

  it('a network failure is not reported as invalid credentials', async () => {
    const { user } = arrange({ status: 0, json: {} });
    stubFetchRoutes({
      [ME]: { status: 401, json: {} },
      [LOGIN]: { status: 503, json: {} },
    });
    await fillAndSubmit(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in is unavailable right now. Please try again shortly.');
    expect(alert).not.toHaveTextContent('incorrect');
    expect(alert).not.toHaveTextContent('password');
  });

  it('never renders the raw backend body', async () => {
    const { user } = arrange({
      status: 400,
      json: {
        statusCode: 400,
        code: 'FST_ERR_CTP_INVALID_JSON_BODY',
        error: 'Bad Request',
        message: "Body is not valid JSON but content-type is set to 'application/json'",
      },
    });
    await fillAndSubmit(user);
    const alert = await screen.findByRole('alert');
    for (const raw of ['FST_ERR', 'Body is not valid JSON', 'Bad Request', 'statusCode']) {
      expect(alert).not.toHaveTextContent(raw);
    }
  });

  it('puts focus on the cleared password field after a credential failure', async () => {
    const { user } = arrange({ status: 401, json: { error: 'invalid credentials' } });
    await fillAndSubmit(user);
    await screen.findByRole('alert');
    // The alert announces itself as a live region; focus goes where the next
    // action is, which for a wrong password is the field to retype.
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus());
  });

  it('puts focus on the message when there is no field to correct', async () => {
    const { user } = arrange({ status: 403, json: { error: 'forbidden_origin' } });
    await fillAndSubmit(user);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
  });

  it('clears the password but keeps the email after a credential failure', async () => {
    const { user } = arrange({ status: 401, json: { error: 'invalid credentials' } });
    await fillAndSubmit(user);
    await screen.findByRole('alert');

    expect(screen.getByLabelText('Email address')).toHaveValue(EMAIL);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('keeps the password after a rate-limit, where retrying the same input is right', async () => {
    const { user } = arrange({
      status: 429, json: {}, headers: { 'retry-after': '30' },
    });
    await fillAndSubmit(user);
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Password')).toHaveValue(PASSWORD);
  });
});

describe('submission discipline', () => {
  it('makes exactly one request per submission and never auto-retries', async () => {
    const { user } = arrange({ status: 500, json: {} });
    await fillAndSubmit(user);
    await screen.findByRole('alert');
    expect(callCountFor('POST', '/api/auth/login')).toBe(1);
  });

  it('prevents a duplicate submission while one is in flight', async () => {
    let resolveLogin: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { resolveLogin = resolve; });
    stubFetchRoutes({
      [ME]: { status: 401, json: {} },
      [LOGIN]: { status: 200, json: USER },
    });
    // Wrap fetch so the login call parks until released.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/auth/login') await gate;
      return realFetch(input, init);
    }));

    const { user } = renderWithProviders(<AppRoutes />, { route: '/login' });
    await user.type(await screen.findByLabelText('Email address'), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);

    const submit = screen.getByRole('button', { name: /Sign in|Signing in/ });
    await user.click(submit);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Signing in…' }));
    await user.click(screen.getByRole('button', { name: 'Signing in…' }));

    resolveLogin!();
    await screen.findByRole('heading', { name: 'Agency home' });
    expect(callCountFor('POST', '/api/auth/login')).toBe(1);
  });
});

describe('credential discipline', () => {
  it('keeps the password out of query keys, URLs, storage, and logs', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const { user, queryClient } = arrange({ status: 401, json: { error: 'invalid credentials' } });
    await fillAndSubmit(user);
    await screen.findByRole('alert');

    const keys = JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.queryKey));
    expect(keys).not.toContain(PASSWORD);
    expect(keys).not.toContain(EMAIL);

    for (const call of calls) expect(call.url).not.toContain(PASSWORD);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('never reads or writes document.cookie', async () => {
    const getter = vi.spyOn(document, 'cookie', 'get');
    const setter = vi.spyOn(document, 'cookie', 'set');
    const { user } = arrange({ status: 200, json: USER });
    await fillAndSubmit(user);
    await screen.findByRole('heading', { name: 'Agency home' });
    expect(getter).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
  });
});
