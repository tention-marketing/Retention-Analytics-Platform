import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import {
  createRetainingQueryClient, createTestQueryClient, renderWithProviders,
  type RenderWithProvidersResult,
} from '@/test/render';
import {
  callCountFor, calls, PENDING, stubFetchNeverResolves, stubFetchRoutes, type RouteStub,
} from '@/test/server';

// The account directory, the create form, and the workspace — driven through the
// real router and the real guards, because what is being asserted is mostly
// about how those interact: no protected flash, no fetch of an endpoint that
// does not exist, no logout on a 500.
//
// Every name here is obviously synthetic.

const EMAIL = 'synthetic.agent@example.invalid';
const USER = { id: 4242, email: EMAIL };

const ME = 'GET /api/auth/me';
const ACCOUNTS = 'GET /api/accounts';
const CREATE = 'POST /api/accounts';
const LOGOUT = 'POST /api/auth/logout';

const SIGNED_IN: RouteStub = { status: 200, json: USER };
const SIGNED_OUT: RouteStub = { status: 401, json: { error: 'unauthorized' } };

const ACME = {
  id: 11,
  name: 'Synthetic Acme',
  store_timezone: 'America/Los_Angeles',
  onboarding_complete: false,
  created_at: '2026-01-15T09:30:00.000Z',
};
const BOREALIS = {
  id: 12,
  name: 'Synthetic Borealis',
  store_timezone: 'Europe/London',
  onboarding_complete: true,
  created_at: '2026-02-20T12:00:00.000Z',
};

function renderAt(route: string, routes: Record<string, RouteStub>): RenderWithProvidersResult {
  stubFetchRoutes(routes);
  return renderWithProviders(<AppRoutes />, { route });
}

/** Waits for the directory heading, so later assertions are not racing a fetch. */
async function openDirectory(routes: Record<string, RouteStub>) {
  const result = renderAt('/accounts', { [ME]: SIGNED_IN, ...routes });
  await screen.findByRole('heading', { name: 'Accounts', level: 1 });
  return result;
}

// ===========================================================================
// Access
// ===========================================================================
describe('/accounts is behind the agency session', () => {
  it('opens for an authenticated user', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [ACME] } });
    expect(await screen.findByText('Synthetic Acme')).toBeInTheDocument();
  });

  it('sends an unauthenticated visitor to /login and fetches no accounts', async () => {
    renderAt('/accounts', { [ME]: SIGNED_OUT });
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(callCountFor('GET', '/api/accounts')).toBe(0);
  });

  it('never flashes account data while the session is unresolved', async () => {
    stubFetchNeverResolves();
    renderWithProviders(<AppRoutes />, { route: '/accounts' });

    expect(await screen.findByRole('status')).toHaveTextContent('Checking your sign-in status');
    expect(screen.queryByRole('heading', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New account' })).not.toBeInTheDocument();
    // The list request is not even issued: the protected subtree has not mounted.
    expect(callCountFor('GET', '/api/accounts')).toBe(0);
  });

  it('adds an Accounts link to the authenticated shell', async () => {
    renderAt('/', { [ME]: SIGNED_IN });
    await screen.findByRole('heading', { name: 'Agency home' });
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getByRole('link', { name: 'Accounts' })).toHaveAttribute('href', '/accounts');
  });

  it('marks the Accounts link as the current page when on it', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [] } });
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'aria-current', 'page',
    );
  });
});

// ===========================================================================
// The list
// ===========================================================================
describe('the account directory', () => {
  it('shows a loading state while the list is in flight', async () => {
    stubFetchRoutes({ [ME]: SIGNED_IN, [ACCOUNTS]: PENDING });
    renderWithProviders(<AppRoutes />, { route: '/accounts' });

    await screen.findByRole('heading', { name: 'Accounts', level: 1 });
    expect(await screen.findByText('Loading accounts…')).toBeInTheDocument();
    // Neither of the two answers is claimed while the question is open.
    expect(screen.queryByText('No accounts yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load accounts')).not.toBeInTheDocument();
  });

  it('shows an empty state when the agency genuinely has no accounts', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [] } });
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Synthetic/ })).not.toBeInTheDocument();
  });

  it('lists every account with its real fields', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [ACME, BOREALIS] } });
    expect(await screen.findByText('Synthetic Acme')).toBeInTheDocument();
    expect(screen.getByText('Synthetic Borealis')).toBeInTheDocument();
    expect(screen.getByText(/America\/Los Angeles/)).toBeInTheDocument();
    expect(screen.getByText(/Europe\/London/)).toBeInTheDocument();
  });

  it('links each account to its workspace', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [ACME, BOREALIS] } });
    expect(await screen.findByRole('link', { name: /Synthetic Acme/ }))
      .toHaveAttribute('href', '/accounts/11');
    expect(screen.getByRole('link', { name: /Synthetic Borealis/ }))
      .toHaveAttribute('href', '/accounts/12');
  });

  it('derives the setup label from onboarding_complete and nothing else', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [ACME, BOREALIS] } });
    const incomplete = await screen.findByRole('link', { name: /Synthetic Acme/ });
    const complete = screen.getByRole('link', { name: /Synthetic Borealis/ });
    expect(within(incomplete).getByText('Setup in progress')).toBeInTheDocument();
    expect(within(complete).getByText('Setup complete')).toBeInTheDocument();
  });

  it('invents no progress figure, tier, metric or provider state', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [ACME, BOREALIS] } });
    await screen.findByText('Synthetic Acme');
    const main = screen.getByRole('main');
    for (const invented of ['%', 'Revenue', 'RCM', 'Tier', 'Churn', 'Shopify', 'Klaviyo',
      'Recharge', 'Last sync', 'Owner', 'steps']) {
      expect(main, invented).not.toHaveTextContent(invented);
    }
  });

  it('fetches the list exactly once for the page', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [ACME] } });
    await screen.findByText('Synthetic Acme');
    expect(callCountFor('GET', '/api/accounts')).toBe(1);
  });

  it('shows a retryable error, not an empty directory, when the service fails', async () => {
    const { user } = await openDirectory({
      [ACCOUNTS]: (attempt) =>
        attempt === 0 ? { status: 500, json: { error: 'boom' } } : { json: [ACME] },
    });

    expect(await screen.findByText('Could not load accounts')).toBeInTheDocument();
    // The distinction that matters: a failed request must not read as "no clients".
    expect(screen.queryByText('No accounts yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Synthetic Acme')).toBeInTheDocument();
    expect(screen.queryByText('Could not load accounts')).not.toBeInTheDocument();
  });

  it('renders no backend error text, only the fixed sentence', async () => {
    await openDirectory({
      [ACCOUNTS]: {
        status: 500,
        json: {
          statusCode: 500,
          error: 'Internal Server Error',
          message: 'select * from accounts failed: relation "accounts" does not exist',
        },
      },
    });
    await screen.findByText('Could not load accounts');
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent('The server could not complete this request.');
    expect(main).not.toHaveTextContent('relation');
    expect(main).not.toHaveTextContent('select');
  });

  it('treats a malformed payload as an error rather than rendering it', async () => {
    await openDirectory({ [ACCOUNTS]: { json: [{ id: 'eleven', name: 42 }] } });
    expect(await screen.findByText('Could not load accounts')).toBeInTheDocument();
    expect(screen.getByRole('main'))
      .toHaveTextContent('The server returned an unexpected response.');
    expect(screen.queryByText('No accounts yet')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// Creating an account
// ===========================================================================
describe('creating an account', () => {
  async function openForm(routes: Record<string, RouteStub> = {}) {
    const result = await openDirectory({ [ACCOUNTS]: { json: [] }, ...routes });
    await result.user.click(await screen.findByRole('button', { name: 'New account' }));
    await screen.findByRole('heading', { name: 'New account', level: 2 });
    return result;
  }

  it('requires a name', async () => {
    const { user } = await openForm();
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Europe/London');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Enter a name for this brand.')).toBeInTheDocument();
    expect(callCountFor('POST', '/api/accounts')).toBe(0);
  });

  it('rejects a whitespace-only name', async () => {
    const { user } = await openForm();
    await user.type(screen.getByLabelText('Account name'), '     ');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Europe/London');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Enter a name for this brand.')).toBeInTheDocument();
    expect(callCountFor('POST', '/api/accounts')).toBe(0);
  });

  it('requires a timezone and does not pre-fill one', async () => {
    const { user } = await openForm();
    expect(screen.getByLabelText('Store timezone')).toHaveValue('');

    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Choose the store timezone.')).toBeInTheDocument();
    expect(callCountFor('POST', '/api/accounts')).toBe(0);
  });

  it('offers only valid IANA zones, and no UTC offsets', async () => {
    await openForm();
    const options = within(screen.getByLabelText('Store timezone')).getAllByRole('option');
    const values = options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== '');

    expect(values.length).toBeGreaterThan(20);
    expect(values).toContain('America/Los_Angeles');
    expect(values).toContain('UTC');
    for (const value of values) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: value })).not.toThrow();
      expect(value, `${value} is an offset, not a zone`).not.toMatch(/^[+-]/);
    }
  });

  it('blocks an invalid timezone before any request is made', async () => {
    const { user } = await openForm();
    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');

    // The select cannot offer this, so it is injected the way a tampered DOM or
    // a stale option would produce it — the point being that submission still
    // stops here rather than at the server.
    const select = screen.getByLabelText('Store timezone') as HTMLSelectElement;
    const rogue = document.createElement('option');
    rogue.value = 'Not/A_Timezone';
    rogue.textContent = 'Not/A_Timezone';
    select.appendChild(rogue);
    await user.selectOptions(select, 'Not/A_Timezone');

    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Choose a valid timezone from the list.')).toBeInTheDocument();
    expect(callCountFor('POST', '/api/accounts')).toBe(0);
  });

  it('submits the trimmed name and the backend field name', async () => {
    const { user } = await openForm({
      [CREATE]: { status: 201, json: { id: 31, name: 'Synthetic Nimbus', store_timezone: 'Asia/Tokyo' } },
      [ACCOUNTS]: { json: [] },
    });

    await user.type(screen.getByLabelText('Account name'), '  Synthetic Nimbus  ');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(callCountFor('POST', '/api/accounts')).toBe(1));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/accounts');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      name: 'Synthetic Nimbus',
      store_timezone: 'Asia/Tokyo',
    });
  });

  it('sends exactly one request per submission and does not retry a failure', async () => {
    const { user } = await openForm({ [CREATE]: { status: 500, json: { error: 'boom' } } });

    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Could not create the account')).toBeInTheDocument();
    // Creation is not idempotent: a retry would be a second brand.
    expect(callCountFor('POST', '/api/accounts')).toBe(1);
  });

  it('blocks a duplicate submission while the first is in flight', async () => {
    stubFetchRoutes({ [ME]: SIGNED_IN, [ACCOUNTS]: { json: [] }, [CREATE]: PENDING });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/accounts' });
    await screen.findByRole('heading', { name: 'Accounts', level: 1 });
    await user.click(await screen.findByRole('button', { name: 'New account' }));
    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');

    const submit = screen.getByRole('button', { name: 'Create account' });
    await user.click(submit);

    // The button reports busy and refuses further activation.
    const busy = await screen.findByRole('button', { name: 'Creating…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    await user.click(busy);
    expect(callCountFor('POST', '/api/accounts')).toBe(1);
  });

  it('refreshes the list and lands on the new workspace', async () => {
    const created = {
      id: 31, name: 'Synthetic Nimbus', store_timezone: 'Asia/Tokyo',
      onboarding_complete: false, created_at: '2026-03-01T10:00:00.000Z',
    };
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: (attempt) => ({ json: attempt === 0 ? [] : [created] }),
      [CREATE]: {
        status: 201,
        json: { id: 31, name: created.name, store_timezone: created.store_timezone },
      },
    });
    // Production staleTime, so the workspace remounting the same query does not
    // add a refetch of its own — leaving the count a clean measure of the one
    // the invalidation caused.
    const { user } = renderWithProviders(<AppRoutes />, {
      route: '/accounts',
      queryClient: createTestQueryClient({ staleTime: 30_000 }),
    });
    await screen.findByRole('heading', { name: 'Accounts', level: 1 });
    await user.click(await screen.findByRole('button', { name: 'New account' }));
    await screen.findByRole('heading', { name: 'New account', level: 2 });

    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    // Navigated to the workspace, and the account is already resolvable there —
    // which is only true because the list was refetched before the navigation.
    expect(await screen.findByRole('heading', { name: 'Synthetic Nimbus', level: 1 }))
      .toBeInTheDocument();
    expect(screen.queryByText('Account not found')).not.toBeInTheDocument();
    expect(callCountFor('GET', '/api/accounts')).toBe(2);
  });

  it('creates no onboarding link along the way', async () => {
    const { user } = await openForm({
      [ACCOUNTS]: (attempt) => ({
        json: attempt === 0 ? [] : [{
          id: 31, name: 'Synthetic Nimbus', store_timezone: 'Asia/Tokyo',
          onboarding_complete: false, created_at: '2026-03-01T10:00:00.000Z',
        }],
      }),
      [CREATE]: { status: 201, json: { id: 31, name: 'Synthetic Nimbus', store_timezone: 'Asia/Tokyo' } },
    });

    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Synthetic Nimbus', level: 1 });

    expect(calls.some((c) => c.url.includes('onboarding'))).toBe(false);
  });

  // --- failure presentation ------------------------------------------------
  const FAILURES: [string, RouteStub, string][] = [
    ['a rejected timezone', { status: 400, json: { error: 'invalid_store_timezone' } },
      'That timezone was not recognised. Choose one from the list and try again.'],
    ['a rejected name', { status: 400, json: { error: 'name required' } },
      'That request was not valid. Check the fields and try again.'],
    ['a blocked origin', { status: 403, json: { error: 'forbidden_origin' } },
      'That request was not valid. Check the fields and try again.'],
    ['a server error', { status: 500, json: { message: 'ENOENT /var/app/src/db/pool.ts:14:9' } },
      'The server could not create the account. Try again in a moment.'],
    ['an unexpected 201 payload', { status: 201, json: { ok: true } },
      'Something went wrong. The account was not created.'],
  ];

  it.each(FAILURES)('shows a safe message for %s', async (_label, stub, expected) => {
    const { user } = await openForm({ [CREATE]: stub });
    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('never renders raw backend wording or a stack path', async () => {
    const { user } = await openForm({
      [CREATE]: {
        status: 500,
        json: { message: 'insert into accounts failed at /Users/deploy/src/db/pool.ts:14:9' },
      },
    });
    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findByText('Could not create the account');
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('insert into');
    expect(main).not.toHaveTextContent('/Users/deploy');
    expect(main).not.toHaveTextContent('pool.ts');
  });

  it('reports a network failure without signing the user out', async () => {
    const { user } = await openForm({
      [CREATE]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await user.type(screen.getByLabelText('Account name'), 'Synthetic Nimbus');
    await user.selectOptions(screen.getByLabelText('Store timezone'), 'Asia/Tokyo');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(
      'Could not reach the server. Check your connection and try again.',
    )).toBeInTheDocument();
    // Still signed in, still on the directory.
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// The workspace route
// ===========================================================================
describe('the account workspace', () => {
  it('resolves an account on a direct visit by fetching the list', async () => {
    renderAt('/accounts/11', { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME, BOREALIS] } });

    expect(await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 }))
      .toBeInTheDocument();
    expect(callCountFor('GET', '/api/accounts')).toBe(1);
  });

  it('never requests GET /accounts/:id, which the backend does not have', async () => {
    renderAt('/accounts/11', { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME] } });
    await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });

    expect(callCountFor('GET', '/api/accounts/11')).toBe(0);
    expect(calls.filter((c) => /\/api\/accounts\/\d/.test(c.url))).toEqual([]);
  });

  it('shows only real fields', async () => {
    renderAt('/accounts/12', { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME, BOREALIS] } });
    await screen.findByRole('heading', { name: 'Synthetic Borealis', level: 1 });

    expect(screen.getByText('Europe/London')).toBeInTheDocument();
    expect(screen.getByText('Setup complete')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all accounts' }))
      .toHaveAttribute('href', '/accounts');
  });

  it('says plainly that setup tools are not here yet', async () => {
    renderAt('/accounts/11', { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME] } });
    await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });
    expect(screen.getByText(/Setup tools arrive next/)).toBeInTheDocument();
  });

  it('invents no metrics or provider state', async () => {
    renderAt('/accounts/11', { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME] } });
    await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });
    const main = screen.getByRole('main');
    for (const invented of ['Revenue', 'RCM', 'Tier', 'Churn', 'Last sync', '%']) {
      expect(main, invented).not.toHaveTextContent(invented);
    }
  });

  it('shows a loading state before the list arrives', async () => {
    stubFetchRoutes({ [ME]: SIGNED_IN, [ACCOUNTS]: PENDING });
    renderWithProviders(<AppRoutes />, { route: '/accounts/11' });

    expect(await screen.findByText('Loading this account…')).toBeInTheDocument();
    // "Not found" before the list has arrived would be a guess.
    expect(screen.queryByText('Account not found')).not.toBeInTheDocument();
  });

  it('shows a safe state for an unknown id without crashing', async () => {
    renderAt('/accounts/999', { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME] } });
    expect(await screen.findByRole('heading', { name: 'Account not found' })).toBeInTheDocument();
    // Still inside the shell, with a way back.
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all accounts' })).toBeInTheDocument();
  });

  it.each(['abc', '1.5', '-3', '0', '%20', 'null', 'undefined', '1e5', '11abc'])(
    'shows a safe state for the invalid id %s', async (raw) => {
      renderAt(`/accounts/${raw}`, { [ME]: SIGNED_IN, [ACCOUNTS]: { json: [ACME] } });
      expect(await screen.findByRole('heading', { name: 'Not a valid account address' }))
        .toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to all accounts' })).toBeInTheDocument();
    });

  it('distinguishes a failed list from a missing account', async () => {
    renderAt('/accounts/11', {
      [ME]: SIGNED_IN,
      [ACCOUNTS]: { status: 500, json: { error: 'boom' } },
    });
    expect(await screen.findByText('Could not load this account')).toBeInTheDocument();
    // Asserting "not found" here would be claiming knowledge we do not have.
    expect(screen.queryByText('Account not found')).not.toBeInTheDocument();
  });

  it('recovers from a list failure via retry', async () => {
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: (attempt) =>
        attempt === 0 ? { status: 500, json: { error: 'boom' } } : { json: [ACME] },
    });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/accounts/11' });

    await screen.findByText('Could not load this account');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 }))
      .toBeInTheDocument();
  });
});

// ===========================================================================
// Session expiry
// ===========================================================================
describe('an expired session while browsing accounts', () => {
  it('clears the whole cache and returns to sign-in on a confirmed 401', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: (attempt) =>
        attempt === 0 ? { json: [ACME] } : { status: 401, json: { error: 'unauthorized' } },
    });
    renderWithProviders(<AppRoutes />, { route: '/accounts', queryClient });
    await screen.findByText('Synthetic Acme');

    // Something unrelated in the cache, to prove the clear is total.
    queryClient.setQueryData(['unrelated', 'data'], { secretish: 'value' });
    await queryClient.refetchQueries({ queryKey: queryKeys.accounts.list() });

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Acme')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Accounts' })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.accounts.list())).toBeUndefined();
      expect(queryClient.getQueryData(['unrelated', 'data'])).toBeUndefined();
    });
    // The auth key is re-seeded to the fact just established, so the login page
    // does not immediately refetch and bounce.
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
  });

  it('leaves no stale account data for the browser Back button to paint', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: (attempt) =>
        attempt === 0 ? { json: [ACME] } : { status: 401, json: { error: 'unauthorized' } },
      [LOGOUT]: { json: { ok: true } },
    });
    renderWithProviders(<AppRoutes />, { route: '/accounts', queryClient });
    await screen.findByText('Synthetic Acme');

    await queryClient.refetchQueries({ queryKey: queryKeys.accounts.list() });
    await screen.findByLabelText('Email address');

    // Whatever a history entry restores, there is nothing in memory to show.
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.accounts.all() }))
      .toHaveLength(0);
  });

  it('does not sign the user out on a 500', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: { status: 500, json: { error: 'boom' } },
    });
    renderWithProviders(<AppRoutes />, { route: '/accounts', queryClient });

    await screen.findByText('Could not load accounts');
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
  });

  it('does not sign the user out on a network failure', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderWithProviders(<AppRoutes />, { route: '/accounts', queryClient });

    await screen.findByText('Could not load accounts');
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('returns to sign-in without a redirect loop', async () => {
    stubFetchRoutes({
      [ME]: (attempt) => (attempt === 0 ? SIGNED_IN : SIGNED_OUT),
      [ACCOUNTS]: (attempt) =>
        attempt === 0 ? { json: [ACME] } : { status: 401, json: { error: 'unauthorized' } },
    });
    const { queryClient } = renderWithProviders(<AppRoutes />, { route: '/accounts' });
    await screen.findByText('Synthetic Acme');

    await queryClient.refetchQueries({ queryKey: queryKeys.accounts.list() });
    await screen.findByLabelText('Email address');

    // A loop would show as /auth/me being polled. Give it room to misbehave.
    const before = callCountFor('GET', '/api/auth/me');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(callCountFor('GET', '/api/auth/me')).toBe(before);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
