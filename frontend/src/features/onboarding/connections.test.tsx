import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import {
  createRetainingQueryClient, renderWithProviders, type RenderWithProvidersResult,
} from '@/test/render';
import { callCountFor, calls, PENDING, stubFetchRoutes, type RouteStub } from '@/test/server';
import { financialBaseRoutes } from '@/test/financialFixtures';

// Agency provider connection controls.
//
// The load-bearing assertions here are about what must NOT survive: a Shopify
// client secret, a Klaviyo private key or a Recharge admin token must not be in
// either TanStack cache, in browser storage, in an error, or in a console call —
// on success or on failure.
//
// SYNTHETIC EVERYTHING, and deliberately not shaped like a real key.

const SHOP_DOMAIN = 'synthetic-shop.myshopify.com';
const REQUESTED_DOMAIN = 'synthetic-requested.myshopify.com';
const CLIENT_ID = 'synthetic-client-id';
const CLIENT_SECRET = 'synthetic-client-secret';
const KLAVIYO_KEY = 'synthetic-klaviyo-key';
const RECHARGE_TOKEN = 'synthetic-recharge-token';
const ALL_SECRETS = [CLIENT_ID, CLIENT_SECRET, KLAVIYO_KEY, RECHARGE_TOKEN];

const EMAIL = 'synthetic.agent@example.invalid';
const USER = { id: 4242, email: EMAIL };
const ACCOUNT_ID = 11;

const ME = 'GET /api/auth/me';
const LOGOUT = 'POST /api/auth/logout';
const ACCOUNTS = 'GET /api/accounts';
const STATUS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding/status`;
const LINKS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding-links`;
const SHOPIFY_ROUTE = `POST /api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`;
const KLAVIYO_ROUTE = `POST /api/accounts/${ACCOUNT_ID}/connections/klaviyo`;
const RECHARGE_ROUTE = `POST /api/accounts/${ACCOUNT_ID}/connections/recharge`;
const skipRoute = (p: string) => `POST /api/accounts/${ACCOUNT_ID}/connections/${p}/skip`;

const SIGNED_IN: RouteStub = { status: 200, json: USER };
const ACCOUNT = {
  id: ACCOUNT_ID, name: 'Synthetic Acme', store_timezone: 'America/Los_Angeles',
  onboarding_complete: false, created_at: '2026-01-15T09:30:00.000Z',
};

const UI_STATES = {
  onboardingInProgress: true, onboardingComplete: false, limitedAnalyticsAvailable: false,
  shopifyNotConnected: true, rcmSetupIncomplete: false, rcmReady: false, syncStillRunning: false,
};

type ProviderRow = {
  provider: string; state: string; connectionStatus: string | null;
  requestedDomain: string | null; shopDomain: string | null; lastSyncAt: string | null;
};
type ProgressRow = {
  provider: string; state: string; counts: Record<string, number>; lastSyncAt: string | null;
  jobId: string | null; jobState: string | null; attemptsMade: number | null;
  failure: unknown; recentFailures: unknown[];
};

function providerRow(provider: string, state: string, extra: Partial<ProviderRow> = {}): ProviderRow {
  return {
    provider, state, connectionStatus: state === 'connected' ? 'connected' : null,
    requestedDomain: null, shopDomain: null, lastSyncAt: null, ...extra,
  };
}
function progressRow(provider: string, state: string, extra: Partial<ProgressRow> = {}): ProgressRow {
  return {
    provider, state, counts: {}, lastSyncAt: null, jobId: null, jobState: null,
    attemptsMade: null, failure: null, recentFailures: [], ...extra,
  };
}

function statusPayload(
  providers: ProviderRow[] = [
    providerRow('shopify', 'undecided'),
    providerRow('klaviyo', 'undecided'),
    providerRow('recharge', 'undecided'),
  ],
  progress: ProgressRow[] = [
    progressRow('shopify', 'not_started'),
    progressRow('klaviyo', 'not_started'),
    progressRow('recharge', 'not_started'),
  ],
) {
  return {
    onboardingComplete: false,
    onboardingBlockers: [],
    rcmReadiness: { ready: false, blockers: [] },
    providers, progress, uiStates: UI_STATES,
  };
}

const SHOPIFY_OK = {
  ok: true, shop: { name: 'Synthetic Shop' }, shopDomain: SHOP_DOMAIN,
  currency: { outcome: 'applied', currency: 'USD', detected: 'USD' },
  timezoneApplied: true, queued: true,
};
const KLAVIYO_OK = { ok: true, account: { id: 'SYNTH1' }, queued: true };
const RECHARGE_OK = { ok: true, store: { name: 'Synthetic Recharge' }, queued: true };

function baseRoutes(overrides: Record<string, RouteStub> = {}): Record<string, RouteStub> {
  return {
    [ME]: SIGNED_IN,
    [ACCOUNTS]: { json: [ACCOUNT] },
    [STATUS_ROUTE]: { json: statusPayload() },
    [LINKS_ROUTE]: { json: [] },
    // The financial-inputs section renders on this page too. All three of its
    // GETs answer in their "nothing configured" state: this suite is about
    // provider credentials, not money.
    ...financialBaseRoutes(ACCOUNT_ID),
    ...overrides,
  };
}

async function openWorkspace(
  overrides: Record<string, RouteStub> = {},
  queryClient?: QueryClient,
): Promise<RenderWithProvidersResult> {
  stubFetchRoutes(baseRoutes(overrides));
  const result = renderWithProviders(<AppRoutes />, {
    route: `/accounts/${ACCOUNT_ID}`,
    ...(queryClient ? { queryClient } : {}),
  });
  await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });
  await screen.findByRole('heading', { name: 'Shopify', level: 3 });
  return result;
}

/** Both caches, serialized — keys, data, mutation data AND mutation variables. */
function dumpCaches(queryClient: QueryClient): string {
  const queries = queryClient.getQueryCache().getAll().map((q) => ({
    key: q.queryKey, data: q.state.data, error: String(q.state.error ?? ''),
  }));
  const mutations = queryClient.getMutationCache().getAll().map((m) => ({
    data: m.state.data,
    // THE FIELD THIS WHOLE DESIGN EXISTS FOR: a useMutation would keep the
    // submitted credential here.
    variables: m.state.variables,
    error: String(m.state.error ?? ''),
  }));
  return JSON.stringify({ queries, mutations });
}

function expectNoSecretAnywhere(queryClient: QueryClient) {
  const dump = dumpCaches(queryClient);
  for (const secret of ALL_SECRETS) expect(dump).not.toContain(secret);
  expect(JSON.stringify(localStorage)).toBe('{}');
  expect(JSON.stringify(sessionStorage)).toBe('{}');
  expect(document.cookie).toBe('');
  for (const secret of ALL_SECRETS) expect(document.body.innerHTML).not.toContain(secret);
}

async function openShopifyForm(user: RenderWithProvidersResult['user'], label = 'Connect Shopify') {
  await user.click(await screen.findByRole('button', { name: label }));
  return screen.findByLabelText('Permanent store domain');
}

async function fillShopify(user: RenderWithProvidersResult['user'], domain = SHOP_DOMAIN) {
  await user.clear(screen.getByLabelText('Permanent store domain'));
  await user.type(screen.getByLabelText('Permanent store domain'), domain);
  await user.type(screen.getByLabelText('Client ID'), CLIENT_ID);
  await user.type(screen.getByLabelText('Client secret'), CLIENT_SECRET);
}

// ===========================================================================
// Actions derive from backend state
// ===========================================================================
describe('provider actions come from the backend state', () => {
  it('undecided offers Connect and Mark as not used', async () => {
    await openWorkspace();
    const card = screen.getByRole('heading', { name: 'Klaviyo', level: 3 }).closest('li')!;
    expect(within(card).getByRole('button', { name: 'Connect Klaviyo' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Mark as not used' })).toBeInTheDocument();
  });

  it('skipped offers Connect but not a second Skip', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'undecided'),
        providerRow('klaviyo', 'skipped'),
        providerRow('recharge', 'undecided'),
      ]) },
    });
    const card = screen.getByRole('heading', { name: 'Klaviyo', level: 3 }).closest('li')!;
    expect(within(card).getByRole('button', { name: 'Connect Klaviyo' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Mark as not used' })).toBeNull();
  });

  it('connected offers Update credentials, and neither Skip nor Disconnect', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'connected', { shopDomain: SHOP_DOMAIN }),
        providerRow('klaviyo', 'undecided'),
        providerRow('recharge', 'undecided'),
      ]) },
    });
    const card = screen.getByRole('heading', { name: 'Shopify', level: 3 }).closest('li')!;
    expect(within(card).getByRole('button', { name: 'Update Shopify credentials' }))
      .toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Mark as not used' })).toBeNull();
    expect(within(card).queryByRole('button', { name: /disconnect/i })).toBeNull();
    expect(within(card).queryByRole('button', { name: /^delete/i })).toBeNull();
  });

  it('requested Shopify shows the client’s domain and offers to complete it', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'requested', { requestedDomain: REQUESTED_DOMAIN }),
        providerRow('klaviyo', 'undecided'),
        providerRow('recharge', 'undecided'),
      ]) },
    });
    const card = screen.getByRole('heading', { name: 'Shopify', level: 3 }).closest('li')!;
    expect(within(card).getByText(REQUESTED_DOMAIN)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Complete Shopify connection' }))
      .toBeInTheDocument();
  });

  it('offers no Delete action anywhere', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'connected', { shopDomain: SHOP_DOMAIN }),
        providerRow('klaviyo', 'skipped'),
        providerRow('recharge', 'undecided'),
      ]) },
    });
    expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });
});

// ===========================================================================
// The forms
// ===========================================================================
describe('the credential forms', () => {
  it('prefills the requested Shopify domain and no credential', async () => {
    const { user } = await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'requested', { requestedDomain: REQUESTED_DOMAIN }),
        providerRow('klaviyo', 'undecided'),
        providerRow('recharge', 'undecided'),
      ]) },
    });
    await openShopifyForm(user, 'Complete Shopify connection');

    expect(screen.getByLabelText('Permanent store domain')).toHaveValue(REQUESTED_DOMAIN);
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
  });

  it('prefills the connected domain when updating, and still no credential', async () => {
    const { user } = await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'connected', { shopDomain: SHOP_DOMAIN }),
        providerRow('klaviyo', 'undecided'),
        providerRow('recharge', 'undecided'),
      ]) },
    });
    await openShopifyForm(user, 'Update Shopify credentials');
    expect(screen.getByLabelText('Permanent store domain')).toHaveValue(SHOP_DOMAIN);
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    expect(screen.getByText(/replaces the stored ones/)).toBeInTheDocument();
  });

  it('hides every secret by default', async () => {
    const { user } = await openWorkspace();
    await openShopifyForm(user);
    expect(screen.getByLabelText('Client ID')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Client secret')).toHaveAttribute('type', 'password');
    // The domain is not a secret and stays readable.
    expect(screen.getByLabelText('Permanent store domain')).toHaveAttribute('type', 'text');
  });

  it('reveals and hides on click, without submitting', async () => {
    const { user } = await openWorkspace({ [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK } });
    await openShopifyForm(user);

    await user.click(screen.getByRole('button', { name: 'Show Client secret' }));
    expect(screen.getByLabelText('Client secret')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide Client secret' }));
    expect(screen.getByLabelText('Client secret')).toHaveAttribute('type', 'password');

    // type="button" is what stops the reveal being a submit.
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`))
      .toBe(0);
  });

  it('reveals from the keyboard too', async () => {
    const { user } = await openWorkspace({ [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK } });
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await screen.findByLabelText('Private API key');

    screen.getByRole('button', { name: 'Show Private API key' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Private API key')).toHaveAttribute('type', 'text');
    await user.keyboard(' ');
    expect(screen.getByLabelText('Private API key')).toHaveAttribute('type', 'password');
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/klaviyo`)).toBe(0);
  });

  it('does not submit on open', async () => {
    const { user } = await openWorkspace({ [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK } });
    await openShopifyForm(user);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('requires every Shopify field before sending anything', async () => {
    const { user } = await openWorkspace({ [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK } });
    await openShopifyForm(user);
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    expect(await screen.findByText('Enter the store domain, client ID and client secret.'))
      .toBeInTheDocument();
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`))
      .toBe(0);
  });

  it.each([
    ['Klaviyo', 'Connect Klaviyo', 'Private API key', 'Enter a Klaviyo private API key.',
      `/api/accounts/${ACCOUNT_ID}/connections/klaviyo`],
    ['Recharge', 'Connect Recharge', 'Admin API token', 'Enter a Recharge Admin API token.',
      `/api/accounts/${ACCOUNT_ID}/connections/recharge`],
  ])('requires the %s credential before sending', async (_p, button, _field, message, path) => {
    const { user } = await openWorkspace({
      [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK },
      [RECHARGE_ROUTE]: { status: 202, json: RECHARGE_OK },
    });
    await user.click(screen.getByRole('button', { name: button }));
    await user.click(await screen.findByRole('button', { name: button }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(callCountFor('POST', path)).toBe(0);
  });

  it('sends exactly the three Shopify fields, trimmed', async () => {
    const { user } = await openWorkspace({ [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK } });
    await openShopifyForm(user);
    await user.type(screen.getByLabelText('Permanent store domain'), `  ${SHOP_DOMAIN}  `);
    await user.type(screen.getByLabelText('Client ID'), CLIENT_ID);
    await user.type(screen.getByLabelText('Client secret'), CLIENT_SECRET);
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    await waitFor(() => {
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`))
        .toBe(1);
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body ?? '{}')).toEqual({
      shopDomain: SHOP_DOMAIN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    });
  });

  it('blocks a duplicate submission while one is in flight', async () => {
    const { user } = await openWorkspace({ [SHOPIFY_ROUTE]: PENDING });
    await openShopifyForm(user);
    await fillShopify(user);
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    const busy = await screen.findByRole('button', { name: 'Connecting…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    await user.click(busy);
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`))
      .toBe(1);
  });
});

// ===========================================================================
// Credentials never escape
// ===========================================================================
describe('submitted credentials do not survive', () => {
  it('are gone from the form and both caches after success', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({
      [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK },
    }, queryClient);
    await openShopifyForm(user);
    await fillShopify(user);
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    // The form closes on success, so the fields are gone with it.
    await waitFor(() => {
      expect(screen.queryByLabelText('Client secret')).toBeNull();
    });
    expectNoSecretAnywhere(queryClient);
  });

  it('are gone after a FAILED submission, while the domain stays', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({
      [SHOPIFY_ROUTE]: { status: 502, json: { ok: false, code: 'verification_failed', message: 'x' } },
    }, queryClient);
    await openShopifyForm(user);
    await fillShopify(user);
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    await screen.findByText(/We could not verify these Shopify credentials/);
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    // The domain is not a secret, and retyping it after every failed attempt
    // would be the thing that makes someone paste credentials into a notes app.
    expect(screen.getByLabelText('Permanent store domain')).toHaveValue(SHOP_DOMAIN);
    expectNoSecretAnywhere(queryClient);
  });

  it('the mutation cache holds no credential variables at all', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({
      [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK },
    }, queryClient);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    await waitFor(() => {
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/klaviyo`)).toBe(1);
    });
    // Not merely "no credential in there" — no connection mutation exists at
    // all, because credential submission is a controlled local action.
    const variables = queryClient.getMutationCache().getAll().map((m) => m.state.variables);
    expect(JSON.stringify(variables)).not.toContain(KLAVIYO_KEY);
    expectNoSecretAnywhere(queryClient);
  });

  it('are cleared when the form is cancelled', async () => {
    const { user } = await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Connect Recharge' }));
    await user.type(await screen.findByLabelText('Admin API token'), RECHARGE_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByLabelText('Admin API token')).toBeNull());
    // Reopening must not restore it.
    await user.click(screen.getByRole('button', { name: 'Connect Recharge' }));
    expect(await screen.findByLabelText('Admin API token')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(RECHARGE_TOKEN);
  });

  it('are cleared when the workspace unmounts', async () => {
    const { user } = await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);

    await user.click(screen.getByRole('link', { name: 'Back to all accounts' }));
    await screen.findByRole('heading', { name: 'Accounts', level: 1 });
    expect(document.body.innerHTML).not.toContain(KLAVIYO_KEY);
  });

  it('are cleared by signing out, and Back does not bring them back', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({ [LOGOUT]: { json: { ok: true } } }, queryClient);
    await user.click(screen.getByRole('button', { name: 'Connect Recharge' }));
    await user.type(await screen.findByLabelText('Admin API token'), RECHARGE_TOKEN);
    expect(screen.getByLabelText('Admin API token')).toHaveValue(RECHARGE_TOKEN);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Email address');

    expect(document.body.innerHTML).not.toContain(RECHARGE_TOKEN);
    expectNoSecretAnywhere(queryClient);
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.accounts.all() }))
      .toHaveLength(0);
  });

  it('never reach an error message or the console', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { user } = await openWorkspace({
      [KLAVIYO_ROUTE]: {
        status: 502,
        json: {
          ok: false, code: 'verification_failed',
          // The backend really does interpolate the provider exception here.
          message: `Klaviyo verification failed: 401 for key ${KLAVIYO_KEY}`,
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    expect(await screen.findByText('We could not verify this Klaviyo API key.')).toBeInTheDocument();
    // The backend's own sentence — which quoted the key — is nowhere on screen.
    expect(document.body.innerHTML).not.toContain(KLAVIYO_KEY);
    expect(screen.getByRole('main')).not.toHaveTextContent('Klaviyo verification failed:');

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = call.map((a) => String(a)).join(' ');
        for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
      }
    }
  });

  it('never reach the URL or history state', async () => {
    const { user } = await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    expect(window.location.href).not.toContain(KLAVIYO_KEY);
    expect(JSON.stringify(window.history.state ?? {})).not.toContain(KLAVIYO_KEY);
  });
});

// ===========================================================================
// Success presentation and invalidation
// ===========================================================================
describe('after a successful connection', () => {
  it('refetches the onboarding status', async () => {
    const { user } = await openWorkspace({ [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK } });
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
  });

  it('Shopify ALSO refetches the accounts list, because it rewrites the timezone', async () => {
    // Asserted as a REFETCH rather than an `isInvalidated` flag: the list query
    // is active (the workspace resolves its account from it), so invalidation
    // immediately refetches and clears the flag again.
    const { user } = await openWorkspace({ [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK } });
    const before = callCountFor('GET', '/api/accounts');
    await openShopifyForm(user);
    await fillShopify(user);
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    await waitFor(() => {
      expect(callCountFor('GET', '/api/accounts')).toBe(before + 1);
    });
  });

  it('Klaviyo does NOT refetch the accounts list — it changes nothing there', async () => {
    const { user } = await openWorkspace({ [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK } });
    const before = callCountFor('GET', '/api/accounts');
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
    expect(callCountFor('GET', '/api/accounts')).toBe(before);
  });

  it('never invalidates the onboarding-link queries', async () => {
    const { user } = await openWorkspace({ [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK } });
    const before = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(before);
  });

  it('reconnecting uses the same endpoint as connecting', async () => {
    const { user } = await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload([
        providerRow('shopify', 'connected', { shopDomain: SHOP_DOMAIN }),
        providerRow('klaviyo', 'undecided'), providerRow('recharge', 'undecided'),
      ]) },
      [SHOPIFY_ROUTE]: { status: 202, json: SHOPIFY_OK },
    });
    await openShopifyForm(user, 'Update Shopify credentials');
    await fillShopify(user);
    await user.click(screen.getByRole('button', { name: 'Verify and update' }));

    await waitFor(() => {
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`))
        .toBe(1);
    });
    // No second "reconnect" route exists, and none was invented.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url))
      .toEqual([`/api/accounts/${ACCOUNT_ID}/connections/shopify/credentials`]);
  });
});

// ===========================================================================
// Skipping
// ===========================================================================
describe('marking a platform as not used', () => {
  it('requires confirmation and explains what it does not do', async () => {
    const { user } = await openWorkspace();
    const card = screen.getByRole('heading', { name: 'Recharge', level: 3 }).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Mark as not used' }));

    const group = await screen.findByRole('group', {
      name: 'Confirm marking Recharge as not used',
    });
    expect(within(group).getByText(/does not create a connection/)).toBeInTheDocument();
    expect(within(group).getByText(/does not delete anything/)).toBeInTheDocument();
    expect(within(group).getByText(/connect Recharge later/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('sends nothing when cancelled', async () => {
    const { user } = await openWorkspace();
    const card = screen.getByRole('heading', { name: 'Klaviyo', level: 3 }).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Mark as not used' }));
    await user.click(await within(card).findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: /Confirm marking/ })).toBeNull();
    });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('sends exactly one bodyless account-scoped request on confirm', async () => {
    const { user } = await openWorkspace({
      [skipRoute('klaviyo')]: { json: { provider: 'klaviyo', state: 'skipped', providers: [] } },
    });
    const card = screen.getByRole('heading', { name: 'Klaviyo', level: 3 }).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Mark as not used' }));
    await user.click(await within(card).findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/connections/klaviyo/skip`)).toBe(1);
    });
    const skip = calls.find((c) => c.url.endsWith('/skip'))!;
    expect(skip.body).toBeNull();
    expect(skip.headers['content-type']).toBeUndefined();
  });

  it('refetches status and leaves the card visible as skipped, with Connect available', async () => {
    const { user } = await openWorkspace({
      [STATUS_ROUTE]: (attempt) => ({
        json: attempt === 0
          ? statusPayload()
          : statusPayload([
            providerRow('shopify', 'undecided'),
            providerRow('klaviyo', 'skipped'),
            providerRow('recharge', 'undecided'),
          ]),
      }),
      [skipRoute('klaviyo')]: { json: { provider: 'klaviyo', state: 'skipped', providers: [] } },
    });
    const card = screen.getByRole('heading', { name: 'Klaviyo', level: 3 }).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Mark as not used' }));
    await user.click(await within(card).findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
    const after = await screen.findByRole('heading', { name: 'Klaviyo', level: 3 });
    const updated = after.closest('li')!;
    expect(within(updated).getByText('Not used')).toBeInTheDocument();
    // The confirmation must close itself once the server has answered, or the
    // card reads "Not used" with a live "Confirm" still underneath it.
    await waitFor(() => {
      expect(within(updated).queryByRole('button', { name: 'Confirm' })).toBeNull();
    });
    expect(within(updated).getByRole('button', { name: 'Connect Klaviyo' })).toBeInTheDocument();
    expect(within(updated).queryByRole('button', { name: 'Mark as not used' })).toBeNull();
  });

  it('does not paint the card skipped before the server agrees', async () => {
    const { user } = await openWorkspace({ [skipRoute('recharge')]: PENDING });
    const card = screen.getByRole('heading', { name: 'Recharge', level: 3 }).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Mark as not used' }));
    await user.click(await within(card).findByRole('button', { name: 'Confirm' }));

    await screen.findByRole('button', { name: 'Saving…' });
    expect(within(card).getByText('Not set up')).toBeInTheDocument();
    expect(within(card).queryByText('Not used')).toBeNull();
  });

  it('shows a safe message when the choice cannot be saved', async () => {
    const { user } = await openWorkspace({
      [skipRoute('klaviyo')]: { status: 400, json: { error: 'bad_provider' } },
    });
    const card = screen.getByRole('heading', { name: 'Klaviyo', level: 3 }).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Mark as not used' }));
    await user.click(await within(card).findByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('That choice could not be saved. Nothing was changed.'))
      .toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveTextContent('bad_provider');
  });
});

// ===========================================================================
// Polling
// ===========================================================================
describe('sync status polling', () => {
  it('does not poll while every provider is in a terminal state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openWorkspace({
        [STATUS_ROUTE]: { json: statusPayload(undefined, [
          progressRow('shopify', 'completed'),
          progressRow('klaviyo', 'connected'),
          progressRow('recharge', 'failed'),
        ]) },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['waiting', 'syncing', 'retrying', 'sync_delayed'])(
    'polls while a provider is %s', async (state) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await openWorkspace({
          [STATUS_ROUTE]: { json: statusPayload(undefined, [
            progressRow('shopify', state),
            progressRow('klaviyo', 'not_started'),
            progressRow('recharge', 'not_started'),
          ]) },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(11_000);
        });
        await waitFor(() => {
          expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`))
            .toBeGreaterThan(1);
        });
      } finally {
        vi.useRealTimers();
      }
    });

  it('stops as soon as the sync reaches a terminal state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openWorkspace({
        [STATUS_ROUTE]: (attempt) => ({
          json: statusPayload(undefined, [
            progressRow('shopify', attempt === 0 ? 'syncing' : 'completed'),
            progressRow('klaviyo', 'not_started'),
            progressRow('recharge', 'not_started'),
          ]),
        }),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await waitFor(() => {
        expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
      });

      // The second response is terminal, so the interval must be gone.
      const settled = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when the workspace unmounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user } = await openWorkspace({
        [STATUS_ROUTE]: { json: statusPayload(undefined, [
          progressRow('shopify', 'syncing'),
          progressRow('klaviyo', 'not_started'),
          progressRow('recharge', 'not_started'),
        ]) },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await user.click(screen.getByRole('link', { name: 'Back to all accounts' }));
      await screen.findByRole('heading', { name: 'Accounts', level: 1 });

      const afterLeaving = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`))
        .toBe(afterLeaving);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces that it is polling, without a percentage or a progress bar', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: { json: statusPayload(undefined, [
        progressRow('shopify', 'syncing', { counts: { orders: 120 } }),
        progressRow('klaviyo', 'not_started'),
        progressRow('recharge', 'not_started'),
      ]) },
    });
    expect(await screen.findByText(/checking every few seconds/)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('%');
    expect(main.querySelector('progress')).toBeNull();
    expect(main.querySelector('[role="progressbar"]')).toBeNull();
    // Real counts, though.
    expect(main).toHaveTextContent('120 orders');
  });

  it('keeps the manual refresh available', async () => {
    const { user } = await openWorkspace();
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
  });
});

// ===========================================================================
// Session and scope
// ===========================================================================
describe('session handling and scope', () => {
  it('a 401 from a connect takes the existing sign-out path', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({
      [KLAVIYO_ROUTE]: { status: 401, json: { error: 'unauthorized' } },
    }, queryClient);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Platforms' })).toBeNull();
    expectNoSecretAnywhere(queryClient);
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
  });

  it.each([
    ['a 502 provider failure', 502, { ok: false, code: 'verification_failed', message: 'x' }],
    ['a 500', 500, { error: 'boom' }],
    ['a 400', 400, { ok: false, code: 'missing_credentials', message: 'x' }],
  ])('%s does NOT log the agency out', async (_label, status, json) => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({
      [RECHARGE_ROUTE]: { status, json },
    }, queryClient);
    await user.click(screen.getByRole('button', { name: 'Connect Recharge' }));
    await user.type(await screen.findByLabelText('Admin API token'), RECHARGE_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect Recharge' }));

    await screen.findByText('Could not connect Recharge');
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
  });

  it('a network failure does not log the agency out, and the form stays open', async () => {
    const { user } = await openWorkspace({
      [KLAVIYO_ROUTE]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));

    expect(await screen.findByText(
      'Could not reach the server. Check your connection and try again.',
    )).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    // Reopenable: the field is still there, emptied.
    expect(screen.getByLabelText('Private API key')).toHaveValue('');
  });

  /**
   * The PROVIDER form carries credentials and nothing else.
   *
   * This previously forbade currency and cost controls anywhere on the page,
   * which was true when none existed. They exist now, in their own section, so
   * the claim is narrowed to the provider form itself — where a cost or currency
   * field would mean a credential submission also writing financial data, and an
   * env-credential or sync-mode control would mean one brand's stored .env
   * credential reachable from another brand's page.
   */
  it('builds no currency, cost or ad-spend control inside the provider form', async () => {
    const { user } = await openWorkspace();
    await openShopifyForm(user);
    const platforms = screen.getByRole('region', { name: 'Platforms' });
    for (const label of [/currency/i, /cogs/i, /gross margin/i, /operating cost/i, /ocas/i,
      /ad spend/i, /advertising/i]) {
      expect(within(platforms).queryByLabelText(label)).toBeNull();
    }
    // And no environment-credential or sync-mode control.
    expect(screen.queryByLabelText(/environment/i)).toBeNull();
    expect(screen.queryByLabelText(/use env/i)).toBeNull();
    expect(screen.queryByLabelText(/mode/i)).toBeNull();
    expect(screen.getByRole('main')).not.toHaveTextContent('useEnvCredentials');
  });

  it('never requests a client onboarding route, and completes nothing', async () => {
    const { user } = await openWorkspace({ [KLAVIYO_ROUTE]: { status: 202, json: KLAVIYO_OK } });
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await user.type(await screen.findByLabelText('Private API key'), KLAVIYO_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Klaviyo' }));
    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
    // Narrowed to the client prefix: the agency completion route added in 5B-2G
    // also contains '/onboarding/complete', so a substring match would no longer
    // distinguish the two. Both guarantees are kept explicitly — no client route,
    // and connecting a platform never completes setup as a side effect.
    for (const call of calls) {
      expect(call.url.startsWith('/api/onboarding/')).toBe(false);
    }
    expect(calls.some((c) => c.url.endsWith('/onboarding/complete'))).toBe(false);
  });
});
