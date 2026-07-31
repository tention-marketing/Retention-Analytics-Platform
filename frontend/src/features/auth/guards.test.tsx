import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import { createRetainingQueryClient, renderWithProviders } from '@/test/render';
import {
  callCountFor, stubFetchNeverResolves, stubFetchRoutes, type RouteStub,
} from '@/test/server';

const EMAIL = 'synthetic.agent@example.invalid';
const USER = { id: 4242, email: EMAIL };
const ME = 'GET /api/auth/me';
const LOGOUT = 'POST /api/auth/logout';

const SIGNED_IN = { status: 200, json: USER } satisfies RouteStub;
const SIGNED_OUT = { status: 401, json: { error: 'unauthorized' } } satisfies RouteStub;

function renderAt(route: string, routes: Record<string, RouteStub>) {
  stubFetchRoutes(routes);
  return renderWithProviders(<AppRoutes />, { route });
}

describe('protected routes require a resolved, authenticated session', () => {
  it('renders the shell for an authenticated user', async () => {
    renderAt('/', { [ME]: SIGNED_IN });
    expect(await screen.findByRole('heading', { name: 'Agency home' })).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it('redirects a confirmed-unauthenticated user to /login', async () => {
    renderAt('/', { [ME]: SIGNED_OUT });
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agency home' })).not.toBeInTheDocument();
  });

  it('never renders protected content while /auth/me is unresolved', async () => {
    stubFetchNeverResolves();
    renderWithProviders(<AppRoutes />, { route: '/' });

    // The resolving state is shown, and no protected markup exists in the tree
    // at all — the shell mounts only after auth resolves, so there is nothing
    // to flash.
    expect(await screen.findByRole('status')).toHaveTextContent('Checking your sign-in status');
    expect(screen.queryByRole('heading', { name: 'Agency home' })).not.toBeInTheDocument();
    expect(screen.queryByText(EMAIL)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });

  it('keeps an unknown protected route inside the authenticated shell', async () => {
    renderAt('/definitely-not-a-route', { [ME]: SIGNED_IN });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    // Still inside the shell: identity and sign-out remain present.
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('sends an unauthenticated visitor on an unknown route to /login, not to a 404', async () => {
    renderAt('/definitely-not-a-route', { [ME]: SIGNED_OUT });
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument();
  });
});

describe('an unavailable auth service is never a logout', () => {
  const NETWORK_FAILURE: RouteStub = () => {
    throw new TypeError('Failed to fetch');
  };

  it.each([
    ['a network failure', NETWORK_FAILURE],
    ['a 500', { status: 500, json: {} } as RouteStub],
    ['a 502', { status: 502, text: '<html>Bad Gateway</html>' } as RouteStub],
  ])('%s shows a retryable service error instead of the login page', async (_label, stub) => {
    renderAt('/', { [ME]: stub });

    expect(await screen.findByRole('alert', {}, { timeout: 5000 }))
      .toHaveTextContent('Cannot reach the sign-in service');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // Crucially: NOT redirected to the login form.
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agency home' })).not.toBeInTheDocument();
  });

  it('does not leak the raw backend body into the service error', async () => {
    renderAt('/', { [ME]: { status: 502, text: '<html>nginx internal</html>' } });
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(alert).not.toHaveTextContent('nginx');
    expect(alert).not.toHaveTextContent('html');
  });

  it('recovers when the service comes back, with no redirect loop', async () => {
    // Fails the first three attempts (initial + two retries), then succeeds.
    const { user } = renderAt('/', {
      [ME]: (attempt) => (attempt < 3 ? { status: 500, json: {} } : SIGNED_IN),
    });

    await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Agency home' }, { timeout: 5000 }))
      .toBeInTheDocument();
    // Recovered straight into the shell — never bounced through /login.
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});

describe('/login is closed to an authenticated user', () => {
  it('redirects an authenticated visitor away from /login', async () => {
    renderAt('/login', { [ME]: SIGNED_IN });
    expect(await screen.findByRole('heading', { name: 'Agency home' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });

  it('shows the form to a confirmed-unauthenticated visitor', async () => {
    renderAt('/login', { [ME]: SIGNED_OUT });
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
  });

  it('shows the service error on /login when auth cannot be resolved', async () => {
    renderAt('/login', { [ME]: { status: 500, json: {} } });
    expect(await screen.findByRole('alert', {}, { timeout: 5000 }))
      .toHaveTextContent('Cannot reach the sign-in service');
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});

describe('session expiry', () => {
  it('clears the complete query cache and redirects when a live session 401s', async () => {
    const queryClient = createRetainingQueryClient();
    // Authenticated first, then signed out on the next resolution.
    stubFetchRoutes({ [ME]: (attempt) => (attempt === 0 ? SIGNED_IN : SIGNED_OUT) });
    renderWithProviders(<AppRoutes />, { route: '/', queryClient });

    await screen.findByRole('heading', { name: 'Agency home' });

    // Unrelated cached data that must not survive the expiry.
    queryClient.setQueryData(['accounts', 'list'], [{ id: 5, name: 'A Client' }]);
    expect(queryClient.getQueryData(['accounts', 'list'])).toBeDefined();

    // Force the next resolution, as a window-focus refetch would.
    await queryClient.refetchQueries({ queryKey: queryKeys.auth.me() });

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(queryClient.getQueryData(['accounts', 'list'])).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
    expect(screen.queryByText(EMAIL)).not.toBeInTheDocument();
  });

  it('does not trigger the expiry flow on a service failure', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({ [ME]: (attempt) => (attempt === 0 ? SIGNED_IN : { status: 500, json: {} }) });
    renderWithProviders(<AppRoutes />, { route: '/', queryClient });
    await screen.findByRole('heading', { name: 'Agency home' });

    queryClient.setQueryData(['accounts', 'list'], [{ id: 5 }]);
    await queryClient.refetchQueries({ queryKey: queryKeys.auth.me() });

    await screen.findByRole('alert', {}, { timeout: 5000 });
    // Not a logout: cached data survives and no login form is shown.
    expect(queryClient.getQueryData(['accounts', 'list'])).toBeDefined();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});

describe('logout', () => {
  it('clears the complete cache and returns to /login on success', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: (attempt) => (attempt === 0 ? SIGNED_IN : SIGNED_OUT),
      [LOGOUT]: { status: 200, json: { ok: true } },
    });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/', queryClient });
    await screen.findByRole('heading', { name: 'Agency home' });

    queryClient.setQueryData(['accounts', 'list'], [{ id: 5, name: 'A Client' }]);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(queryClient.getQueryData(['accounts', 'list'])).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
    expect(screen.queryByText(EMAIL)).not.toBeInTheDocument();
    expect(callCountFor('POST', '/api/auth/logout')).toBe(1);
  });

  it('treats a 401 from logout as a completed sign-out', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: (attempt) => (attempt === 0 ? SIGNED_IN : SIGNED_OUT),
      [LOGOUT]: { status: 401, json: { error: 'unauthorized' } },
    });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/', queryClient });
    await screen.findByRole('heading', { name: 'Agency home' });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
  });

  it('does NOT falsely clear the session when logout fails', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({ [ME]: SIGNED_IN, [LOGOUT]: { status: 500, json: {} } });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/', queryClient });
    await screen.findByRole('heading', { name: 'Agency home' });

    queryClient.setQueryData(['accounts', 'list'], [{ id: 5, name: 'A Client' }]);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out');
    // Still signed in, still on the shell, cache intact — the server session
    // may well still be live.
    expect(screen.getByRole('heading', { name: 'Agency home' })).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(queryClient.getQueryData(['accounts', 'list'])).toBeDefined();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
  });

  it('offers a retry after a failed logout, and never shows the raw body', async () => {
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [LOGOUT]: (attempt) => (attempt === 0
        ? { status: 502, text: '<html>nginx internal</html>' }
        : { status: 200, json: { ok: true } }),
    });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/' });
    await screen.findByRole('heading', { name: 'Agency home' });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('nginx');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
  });

  it('does not auto-retry a failed logout', async () => {
    stubFetchRoutes({ [ME]: SIGNED_IN, [LOGOUT]: { status: 500, json: {} } });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/' });
    await screen.findByRole('heading', { name: 'Agency home' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('alert');
    expect(callCountFor('POST', '/api/auth/logout')).toBe(1);
  });
});

describe('return paths', () => {
  it('remembers a safe internal path and returns to it after signing in', async () => {
    // /auth/me follows the real server: 401 until the login succeeds, 200 after.
    let signedIn = false;
    stubFetchRoutes({
      [ME]: () => (signedIn ? SIGNED_IN : SIGNED_OUT),
      'POST /api/auth/login': () => {
        signedIn = true;
        return { status: 200, json: USER };
      },
    });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/some/deep/page' });

    await screen.findByLabelText('Email address');
    await user.type(screen.getByLabelText('Email address'), EMAIL);
    await user.type(screen.getByLabelText('Password'), 'synthetic-password-value-1234');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // /some/deep/page is protected and unknown, so it renders the shell 404 —
    // which proves the return path was honoured rather than dropped to '/'.
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    'javascript:alert(1)',
  ])('ignores the hostile return path %s injected through router state', async (hostile) => {
    stubFetchRoutes({ [ME]: SIGNED_IN });
    // An authenticated visitor arrives at /login carrying a crafted `from`.
    // It must be discarded and the visitor landed on '/', never off-origin.
    renderWithProviders(<AppRoutes />, { route: '/login', routeState: { from: hostile } });

    expect(await screen.findByRole('heading', { name: 'Agency home' })).toBeInTheDocument();
    expect(window.location.href).not.toContain('evil.example');
    expect(document.body.innerHTML).not.toContain('evil.example');
  });

  it('honours a safe return path carried in router state', async () => {
    stubFetchRoutes({ [ME]: SIGNED_IN });
    renderWithProviders(<AppRoutes />, {
      route: '/login', routeState: { from: '/some/deep/page' },
    });
    // The safe path is protected and unknown, so the shell 404 proves it was used.
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
