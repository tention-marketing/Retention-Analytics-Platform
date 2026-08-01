import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import {
  createRetainingQueryClient, renderWithProviders, type RenderWithProvidersResult,
} from '@/test/render';
import { callCountFor, calls, PENDING, stubFetchRoutes, type RouteStub } from '@/test/server';

// The agency onboarding control centre.
//
// Driven through the real router and guards, because most of what matters here
// is an interaction between them: a one-time credential that must not survive a
// logout, a 401 that must take the existing sign-out path, a DELETE that must
// carry an account id.
//
// SYNTHETIC EVERYTHING. The token is assembled at runtime — documentPolicy
// refuses any 43-character base64url literal in source, including in tests,
// precisely so a real token from a debugging session cannot be pasted into one.

const SYNTHETIC_TOKEN = 'synthetic-test-token'.padEnd(43, 'z');
const SETUP_URL = `https://app.example.invalid/onboarding#token=${SYNTHETIC_TOKEN}`;

const EMAIL = 'synthetic.agent@example.invalid';
const USER = { id: 4242, email: EMAIL };
const ACCOUNT_ID = 11;

const ME = 'GET /api/auth/me';
const LOGOUT = 'POST /api/auth/logout';
const ACCOUNTS = 'GET /api/accounts';
const STATUS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding/status`;
const LINKS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding-links`;
const CREATE_ROUTE = `POST /api/accounts/${ACCOUNT_ID}/onboarding-links`;
const revokeRoute = (linkId: number) =>
  `DELETE /api/accounts/${ACCOUNT_ID}/onboarding-links/${linkId}`;

const SIGNED_IN: RouteStub = { status: 200, json: USER };
const ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Synthetic Acme',
  store_timezone: 'America/Los_Angeles',
  onboarding_complete: false,
  created_at: '2026-01-15T09:30:00.000Z',
};

const UI_STATES = {
  onboardingInProgress: true, onboardingComplete: false, limitedAnalyticsAvailable: false,
  shopifyNotConnected: true, rcmSetupIncomplete: false, rcmReady: false, syncStillRunning: false,
};

const STATUS = {
  onboardingComplete: false,
  onboardingBlockers: [
    { code: 'no_platform_connected', message: 'Connect at least one platform to finish setup.', step: 'connect' },
  ],
  rcmReadiness: {
    ready: false,
    blockers: [{ code: 'shopify_not_connected', message: 'Connect Shopify to turn on RCM analytics.', step: 'connect' }],
  },
  providers: [
    { provider: 'shopify', state: 'undecided', connectionStatus: null, requestedDomain: null, shopDomain: null, lastSyncAt: null },
    { provider: 'klaviyo', state: 'connected', connectionStatus: 'connected', requestedDomain: null, shopDomain: null, lastSyncAt: '2026-07-30T08:00:00.000Z' },
    { provider: 'recharge', state: 'skipped', connectionStatus: null, requestedDomain: null, shopDomain: null, lastSyncAt: null },
  ],
  progress: [
    { provider: 'shopify', state: 'not_started', counts: {}, lastSyncAt: null, jobId: null, jobState: null, attemptsMade: null, failure: null, recentFailures: [] },
    { provider: 'klaviyo', state: 'completed', counts: { campaigns: 12, campaign_stats: 12 }, lastSyncAt: '2026-07-30T08:00:00.000Z', jobId: 'bull:klaviyo:11', jobState: 'completed', attemptsMade: 0, failure: null, recentFailures: [] },
    { provider: 'recharge', state: 'skipped', counts: {}, lastSyncAt: null, jobId: null, jobState: null, attemptsMade: null, failure: null, recentFailures: [] },
  ],
  uiStates: UI_STATES,
};

const ACTIVE_LINK = {
  id: 501,
  status: 'active',
  expires_at: '2026-08-15T02:30:19.855Z',
  revoked_at: null,
  first_used_at: null,
  completed_at: null,
  created_at: '2026-08-01T02:30:19.854Z',
};
const EXPIRED_LINK = {
  ...ACTIVE_LINK, id: 500, status: 'expired', expires_at: '2026-07-01T00:00:00.000Z',
  created_at: '2026-06-17T00:00:00.000Z',
};
const REVOKED_LINK = {
  ...ACTIVE_LINK, id: 499, status: 'revoked', revoked_at: '2026-07-20T00:00:00.000Z',
  first_used_at: '2026-07-18T09:00:00.000Z', completed_at: '2026-07-19T15:00:00.000Z',
};

const CREATED_RESPONSE = {
  id: 502,
  expiresAt: '2026-08-15T02:30:19.852Z',
  token: SYNTHETIC_TOKEN,
  url: SETUP_URL,
  note: 'The token is shown once and cannot be retrieved again. Reissue if lost.',
};

function baseRoutes(overrides: Record<string, RouteStub> = {}): Record<string, RouteStub> {
  return {
    [ME]: SIGNED_IN,
    [ACCOUNTS]: { json: [ACCOUNT] },
    [STATUS_ROUTE]: { json: STATUS },
    [LINKS_ROUTE]: { json: [] },
    ...overrides,
  };
}

function renderWorkspace(
  overrides: Record<string, RouteStub> = {},
  queryClient?: QueryClient,
): RenderWithProvidersResult {
  stubFetchRoutes(baseRoutes(overrides));
  return renderWithProviders(<AppRoutes />, {
    route: `/accounts/${ACCOUNT_ID}`,
    ...(queryClient ? { queryClient } : {}),
  });
}

/** Waits until the workspace has resolved its account. */
async function openWorkspace(
  overrides: Record<string, RouteStub> = {},
  queryClient?: QueryClient,
) {
  const result = renderWorkspace(overrides, queryClient);
  await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });
  return result;
}

// --- clipboard -------------------------------------------------------------
//
// MUST BE APPLIED AFTER RENDER. `userEvent.setup()` — called inside
// renderWithProviders — installs its own `navigator.clipboard` stub, so a
// clipboard stubbed before rendering is silently replaced and every assertion
// about it measures userEvent's copy instead of ours.
function stubClipboard(writeText: () => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: spy }, configurable: true, writable: true,
  });
  return spy;
}

/** The state in a non-secure context or an embedded webview: no API at all. */
function removeClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined, configurable: true, writable: true,
  });
}
afterEach(() => {
  // jsdom has no clipboard by default; leaving a stub behind would leak into
  // the next case.
  Reflect.deleteProperty(navigator, 'clipboard');
});

/** Everything the two TanStack caches are holding, as one searchable string. */
function dumpCaches(queryClient: QueryClient): string {
  const queries = queryClient.getQueryCache().getAll().map((q) => ({
    key: q.queryKey, data: q.state.data, error: String(q.state.error ?? ''),
  }));
  const mutations = queryClient.getMutationCache().getAll().map((m) => ({
    data: m.state.data, variables: m.state.variables, error: String(m.state.error ?? ''),
  }));
  return JSON.stringify({ queries, mutations });
}

async function createLink(user: RenderWithProvidersResult['user']) {
  await user.click(await screen.findByRole('button', { name: 'Create setup link' }));
  await screen.findByRole('heading', { name: 'Copy this setup link now' });
}

// ===========================================================================
// Setup overview
// ===========================================================================
describe('the setup overview', () => {
  it('loads the account status', async () => {
    await openWorkspace();
    expect(await screen.findByRole('heading', { name: 'Setup overview', level: 2 }))
      .toBeInTheDocument();
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(1);
  });

  it('shows a loading state before the status arrives', async () => {
    await openWorkspace({ [STATUS_ROUTE]: PENDING });
    expect(await screen.findByText('Loading setup status…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Client setup' })).not.toBeInTheDocument();
  });

  it('keeps the client-setup and analytics blockers in separate groups', async () => {
    await openWorkspace();
    const setup = await screen.findByRole('list', { name: 'Client setup blockers' });
    const analytics = screen.getByRole('list', { name: 'Analytics readiness blockers' });

    expect(within(setup).getByText('Connect at least one platform to finish setup.'))
      .toBeInTheDocument();
    expect(within(analytics).getByText('Connect Shopify to turn on RCM analytics.'))
      .toBeInTheDocument();
    // Neither list may contain the other's blocker.
    expect(within(setup).queryByText('Connect Shopify to turn on RCM analytics.')).toBeNull();
    expect(within(analytics).queryByText('Connect at least one platform to finish setup.')).toBeNull();
  });

  it('labels the two gates in plain words', async () => {
    await openWorkspace();
    expect(await screen.findByRole('heading', { name: 'Client setup', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analytics readiness', level: 3 })).toBeInTheDocument();
  });

  it('can be complete for setup while analytics are still not ready', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: {
        json: {
          ...STATUS,
          onboardingComplete: true,
          onboardingBlockers: [],
          uiStates: { ...UI_STATES, onboardingComplete: true, limitedAnalyticsAvailable: true },
        },
      },
    });
    await screen.findByRole('heading', { name: 'Client setup', level: 3 });
    expect(screen.getByText('Setup complete')).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toBeInTheDocument();
  });

  it('shows no percentage and no progress bar', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Client setup', level: 3 });
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('%');
    expect(main.querySelector('progress')).toBeNull();
    expect(main.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('renders allowlisted blocker detail as text, never as an object dump', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: {
        json: {
          ...STATUS,
          onboardingBlockers: [{
            code: 'provider_undecided',
            message: 'Tell us about every platform.',
            step: 'connect',
            detail: { providers: ['shopify', 'klaviyo'], internalQueueKey: 'bull:backfill:11' },
          }],
        },
      },
    });
    expect(await screen.findByText('Platforms: shopify, klaviyo')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('internalQueueKey');
    expect(main).not.toHaveTextContent('bull:backfill');
    expect(main).not.toHaveTextContent('[object Object]');
  });

  it('shows a retryable error instead of an empty overview when the service fails', async () => {
    const { user } = await openWorkspace({
      [STATUS_ROUTE]: (attempt) =>
        attempt === 0 ? { status: 500, json: { error: 'boom' } } : { json: STATUS },
    });

    expect(await screen.findByText('Could not load setup status')).toBeInTheDocument();
    // A failure must never read as "this brand has no blockers".
    expect(screen.queryByRole('heading', { name: 'Client setup' })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Client setup', level: 3 })).toBeInTheDocument();
  });

  it('refreshes only the status on demand', async () => {
    const { user } = await openWorkspace();
    await screen.findByRole('heading', { name: 'Client setup', level: 3 });
    const linksBefore = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`);

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(linksBefore);
  });

  it('does not poll in the background', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Client setup', level: 3 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(1);
  });

  it('never calls the onboarding-complete endpoint', async () => {
    const { user } = await openWorkspace();
    await screen.findByRole('heading', { name: 'Client setup', level: 3 });
    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2));

    expect(calls.some((c) => c.url.includes('/onboarding/complete'))).toBe(false);
  });
});

// ===========================================================================
// Providers
// ===========================================================================
describe('the platform section', () => {
  it('shows all three providers', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Shopify', level: 3 });
    expect(screen.getByRole('heading', { name: 'Klaviyo', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recharge', level: 3 })).toBeInTheDocument();
  });

  it('offers no action the backend cannot carry out', async () => {
    // Replaces 5B-2D's blanket "no actions at all". Connect and skip now exist;
    // these three must never appear, because there is no endpoint behind any of
    // them and a control that cannot act is worse than an absent one. Retry is
    // included because there is no provider retry endpoint to invent.
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Shopify', level: 3 });

    for (const action of [/disconnect/i, /^delete/i, /remove .*(platform|connection)/i, /retry sync/i]) {
      expect(screen.queryByRole('button', { name: action })).toBeNull();
    }
  });

  it('translates provider and sync states without adding an adjective', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Klaviyo', level: 3 });
    const main = screen.getByRole('main');

    expect(main).toHaveTextContent('Connected');
    expect(main).toHaveTextContent('Not used');
    expect(main).toHaveTextContent('Not set up');
    // The backend says `connected`; it does not say healthy, and `completed`
    // for one provider is not "setup complete".
    expect(main).not.toHaveTextContent('Healthy');
    expect(main).not.toHaveTextContent('All good');
  });

  it('shows real imported counts and no percentage', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Klaviyo', level: 3 });
    expect(screen.getByText(/12 campaigns/)).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveTextContent('%');
  });

  it('renders only the safe public failure message', async () => {
    await openWorkspace({
      [STATUS_ROUTE]: {
        json: {
          ...STATUS,
          progress: [
            {
              provider: 'klaviyo', state: 'failed', counts: {}, lastSyncAt: null,
              message: 'We hit a problem importing your data.',
              failure: {
                code: 'provider_auth_failed', category: 'auth', provider: 'klaviyo',
                stage: 'klaviyo.backfill', retryable: false,
                publicMessage: 'Authentication with Klaviyo failed. The stored credentials need to be re-entered.',
                occurredAt: '2026-08-01T00:00:00.000Z',
              },
              recentFailures: [],
            },
          ],
          providers: [STATUS.providers[1]],
        },
      },
    });

    expect(await screen.findByText(/Authentication with Klaviyo failed/)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('klaviyo.backfill');
    expect(main).not.toHaveTextContent('provider_auth_failed');
  });

  it('never shows a queue identifier', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Klaviyo', level: 3 });
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('bull:');
    expect(main).not.toHaveTextContent('jobId');
    expect(main).not.toHaveTextContent('attemptsMade');
  });

  it('builds no credential, cost, currency or ad-spend form anywhere on the page', async () => {
    await openWorkspace();
    await screen.findByRole('heading', { name: 'Shopify', level: 3 });

    // The whole workspace: the only inputs that may exist belong to the
    // one-time link panel, and it is not open.
    expect(screen.getByRole('main').querySelectorAll('input, textarea, select')).toHaveLength(0);
    for (const label of [
      /api key/i, /api token/i, /access token/i, /client secret/i, /shop domain/i,
      /currency/i, /cogs/i, /gross margin/i, /operating cost/i, /ocas/i, /ad spend/i,
      /advertising/i,
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });
});

// ===========================================================================
// The link list
// ===========================================================================
describe('the setup link list', () => {
  it('shows an empty state that does not claim the client was contacted', async () => {
    await openWorkspace();
    expect(await screen.findByText('No setup link yet')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('sent');
    expect(main).not.toHaveTextContent('emailed');
    expect(main).not.toHaveTextContent('invited');
  });

  it('lists links newest first, in the order the backend returned', async () => {
    await openWorkspace({ [LINKS_ROUTE]: { json: [ACTIVE_LINK, EXPIRED_LINK, REVOKED_LINK] } });
    const rows = within(await screen.findByRole('list', { name: 'Setup links' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Expired')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Revoked')).toBeInTheDocument();
  });

  it('shows first-opened and setup-finished only when the backend supplied them', async () => {
    await openWorkspace({ [LINKS_ROUTE]: { json: [ACTIVE_LINK, REVOKED_LINK] } });
    const rows = within(await screen.findByRole('list', { name: 'Setup links' })).getAllByRole('listitem');

    expect(within(rows[0]!).queryByText('First opened')).toBeNull();
    expect(within(rows[0]!).queryByText('Setup finished')).toBeNull();
    expect(within(rows[1]!).getByText('First opened')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Setup finished')).toBeInTheDocument();
  });

  it('shows status and completion as separate facts', async () => {
    // A client can finish setup while the link is still live. Collapsing the two
    // would hide that the credential is still usable.
    const completedButActive = { ...ACTIVE_LINK, completed_at: '2026-08-03T10:00:00.000Z' };
    await openWorkspace({ [LINKS_ROUTE]: { json: [completedButActive] } });
    const row = within(await screen.findByRole('list', { name: 'Setup links' })).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('Setup finished')).toBeInTheDocument();
  });

  it('shows no token, hash, URL or internal id', async () => {
    await openWorkspace({ [LINKS_ROUTE]: { json: [ACTIVE_LINK, EXPIRED_LINK, REVOKED_LINK] } });
    await screen.findByRole('list', { name: 'Setup links' });
    const html = screen.getByRole('main').innerHTML;

    expect(html).not.toContain('#token=');
    expect(html).not.toContain(SYNTHETIC_TOKEN);
    expect(html).not.toContain('token_hash');
    expect(html).not.toContain('/onboarding#');
    expect(html).not.toContain('created_by');
  });

  it('offers Revoke only on an active link', async () => {
    await openWorkspace({ [LINKS_ROUTE]: { json: [ACTIVE_LINK, EXPIRED_LINK, REVOKED_LINK] } });
    await screen.findByRole('list', { name: 'Setup links' });
    expect(screen.getAllByRole('button', { name: 'Revoke link' })).toHaveLength(1);
  });

  it('offers no Delete action — revocation is not deletion', async () => {
    await openWorkspace({ [LINKS_ROUTE]: { json: [ACTIVE_LINK] } });
    await screen.findByRole('list', { name: 'Setup links' });
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('shows a retryable error rather than an empty list when the service fails', async () => {
    const { user } = await openWorkspace({
      [LINKS_ROUTE]: (attempt) =>
        attempt === 0 ? { status: 500, json: { error: 'boom' } } : { json: [ACTIVE_LINK] },
    });

    expect(await screen.findByText('Could not load setup links')).toBeInTheDocument();
    expect(screen.queryByText('No setup link yet')).toBeNull();

    const alert = screen.getAllByRole('alert').find((a) => a.textContent?.includes('setup links'))!;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Setup links' })).toBeInTheDocument();
  });
});

// ===========================================================================
// Creating a link
// ===========================================================================
describe('creating a setup link', () => {
  const createRoutes = { [CREATE_ROUTE]: { status: 201, json: CREATED_RESPONSE } };

  it('does not create anything on page load', async () => {
    await openWorkspace(createRoutes);
    await screen.findByText('No setup link yet');
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(0);
  });

  it('sends exactly one POST with the fixed 14-day contract', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(1);
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/onboarding-links'));
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ ttlDays: 14 });
  });

  it('does not retry a failed creation', async () => {
    const { user } = await openWorkspace({ [CREATE_ROUTE]: { status: 500, json: { error: 'boom' } } });
    await user.click(await screen.findByRole('button', { name: 'Create setup link' }));

    expect(await screen.findByText('Could not create the setup link')).toBeInTheDocument();
    // A replay would be a second live credential for the same brand.
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(1);
  });

  it('blocks a duplicate submission while the first is in flight', async () => {
    const { user } = await openWorkspace({ [CREATE_ROUTE]: PENDING });
    const button = await screen.findByRole('button', { name: 'Create setup link' });
    await user.click(button);

    const busy = await screen.findByRole('button', { name: 'Creating…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    await user.click(busy);
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(1);
  });

  it('requires the open panel to be dismissed before another can be created', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    // The control is gone while an unread secret is on screen, so a second link
    // cannot silently replace the first.
    expect(screen.queryByRole('button', { name: 'Create setup link' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Dismiss securely' }));
    expect(await screen.findByRole('button', { name: 'Create setup link' })).toBeInTheDocument();
    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(1);
  });

  it('refreshes the link list and the status afterwards', async () => {
    const { user } = await openWorkspace({
      ...createRoutes,
      [LINKS_ROUTE]: (attempt) => ({ json: attempt === 0 ? [] : [ACTIVE_LINK] }),
    });
    await createLink(user);

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(2);
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
  });

  it('does not revoke any existing link', async () => {
    const { user } = await openWorkspace({
      ...createRoutes,
      [LINKS_ROUTE]: { json: [ACTIVE_LINK] },
    });
    await createLink(user);
    expect(calls.some((c) => c.method.toUpperCase() === 'DELETE')).toBe(false);
    // Nor does the copy claim it replaced anything.
    expect(screen.getByRole('main')).not.toHaveTextContent('replaces');
  });

  it.each([
    ['a 500', { status: 500, json: { error: 'boom' } }, 'The server could not complete this request. Try again in a moment.'],
    ['a 400', { status: 400, json: { error: 'bad_ttl', message: 'ttlDays must be 1-90.' } }, 'That request was not valid, so no setup link was created.'],
    ['a 404', { status: 404, json: { error: 'account_not_found' } }, 'This account is no longer available. Return to all accounts.'],
    ['a malformed 201', { status: 201, json: { id: 1 } }, 'The server returned something unexpected. Nothing was changed.'],
  ])('shows a fixed safe message for %s', async (_label, stub, expected) => {
    const { user } = await openWorkspace({ [CREATE_ROUTE]: stub as RouteStub });
    await user.click(await screen.findByRole('button', { name: 'Create setup link' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('renders no backend wording from a failure', async () => {
    const { user } = await openWorkspace({
      [CREATE_ROUTE]: {
        status: 500,
        json: { message: 'insert into onboarding_links failed at /Users/deploy/src/db/pool.ts:14:9' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Create setup link' }));
    await screen.findByText('Could not create the setup link');

    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('onboarding_links');
    expect(main).not.toHaveTextContent('/Users/deploy');
    expect(main).not.toHaveTextContent('pool.ts');
  });
});

// ===========================================================================
// The one-time secret
// ===========================================================================
describe('the one-time setup URL', () => {
  const createRoutes = { [CREATE_ROUTE]: { status: 201, json: CREATED_RESPONSE } };

  it('is displayed once, with a warning and an expiry', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    expect(screen.getByDisplayValue(SETUP_URL)).toBeInTheDocument();
    expect(screen.getByText(/cannot be retrieved again/)).toBeInTheDocument();
    expect(screen.getByText(/stops working on/)).toBeInTheDocument();
  });

  it('never shows the raw token as a separate value', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    const field = screen.getByLabelText('One-time setup link') as HTMLInputElement;
    expect(field.value).toBe(SETUP_URL);
    // The token exists only inside the URL, never on its own.
    const withoutUrl = screen.getByRole('main').innerHTML.split(SETUP_URL).join('');
    expect(withoutUrl).not.toContain(SYNTHETIC_TOKEN);
  });

  it('leaves NOTHING in either TanStack cache', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace(createRoutes, queryClient);
    await createLink(user);

    const dump = dumpCaches(queryClient);
    expect(dump).not.toContain('#token=');
    expect(dump).not.toContain(SYNTHETIC_TOKEN);
    expect(dump).not.toContain(SETUP_URL);
    expect(dump).not.toContain('/onboarding#');
    // And the mutation cache holds no creation entry at all: creation is a
    // controlled local action, not a useMutation.
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('leaves nothing in any browser storage', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    expect(document.cookie).toBe('');
  });

  it('never reaches the URL bar or history state', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    expect(window.location.href).not.toContain('token');
    expect(JSON.stringify(window.history.state ?? {})).not.toContain(SYNTHETIC_TOKEN);
  });

  it('is never logged', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = call.map((a) => String(a)).join(' ');
        expect(text).not.toContain(SYNTHETIC_TOKEN);
        expect(text).not.toContain('#token=');
      }
    }
  });

  it('is cleared from the DOM when dismissed', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    await user.click(screen.getByRole('button', { name: 'Dismiss securely' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('One-time setup link')).toBeNull();
    });
    expect(screen.getByRole('main').innerHTML).not.toContain(SYNTHETIC_TOKEN);
  });

  it('is cleared when the workspace unmounts', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);

    await user.click(screen.getByRole('link', { name: 'Back to all accounts' }));
    await screen.findByRole('heading', { name: 'Accounts', level: 1 });
    expect(document.body.innerHTML).not.toContain(SYNTHETIC_TOKEN);

    // Returning to the workspace does not bring it back.
    await user.click(await screen.findByRole('link', { name: /Synthetic Acme/ }));
    await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });
    expect(screen.queryByLabelText('One-time setup link')).toBeNull();
  });

  it('cannot be recovered by reloading the page', async () => {
    const queryClient = createRetainingQueryClient();
    const { user, unmount } = await openWorkspace(
      { ...createRoutes, [LINKS_ROUTE]: { json: [ACTIVE_LINK] } },
      queryClient,
    );
    await createLink(user);
    unmount();

    // A refresh is a fresh tree. Even reusing the same cache, there is nothing
    // to restore, and the list row that remains carries no URL.
    stubFetchRoutes(baseRoutes({ ...createRoutes, [LINKS_ROUTE]: { json: [ACTIVE_LINK] } }));
    renderWithProviders(<AppRoutes />, { route: `/accounts/${ACCOUNT_ID}`, queryClient });
    await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });
    await screen.findByRole('list', { name: 'Setup links' });

    expect(screen.queryByLabelText('One-time setup link')).toBeNull();
    expect(document.body.innerHTML).not.toContain(SYNTHETIC_TOKEN);
    expect(dumpCaches(queryClient)).not.toContain(SYNTHETIC_TOKEN);
  });
});

// ===========================================================================
// Copy to clipboard
// ===========================================================================
describe('copying the setup link', () => {
  const createRoutes = { [CREATE_ROUTE]: { status: 201, json: CREATED_RESPONSE } };

  it('writes the exact URL only after the user presses the button', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    const writeText = stubClipboard(() => Promise.resolve());

    // Nothing is copied automatically: the panel has been open, unread, since
    // creation and the clipboard has not been touched.
    expect(writeText).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(SETUP_URL);
  });

  it('announces success accessibly', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    stubClipboard(() => Promise.resolve());
    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    const live = screen.getAllByRole('status').find((el) => el.textContent?.includes('copied'))!;
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Setup link copied to your clipboard.');
  });

  it('fails safely and leaves the link selectable when the write is rejected', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    stubClipboard(() => Promise.reject(new DOMException('Write permission denied.')));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(screen.getByText(/Select the link above and copy it manually/)).toBeInTheDocument();
    // The manual path must survive the failure.
    const field = screen.getByLabelText('One-time setup link') as HTMLInputElement;
    expect(field).toHaveValue(SETUP_URL);
    expect(field.readOnly).toBe(true);
    expect(field).not.toBeDisabled();
  });

  it('fails safely when the clipboard API is absent entirely', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    removeClipboard();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(screen.getByLabelText('One-time setup link')).toHaveValue(SETUP_URL);
  });

  it('does not leak the rejection reason', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    stubClipboard(() => Promise.reject(new DOMException('NotAllowedError: /Users/x/thing')));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await screen.findByRole('button', { name: 'Copy failed' });

    expect(screen.getByRole('main')).not.toHaveTextContent('NotAllowedError');
    expect(screen.getByRole('main')).not.toHaveTextContent('/Users/x');
  });

  it('does not create another link', async () => {
    const { user } = await openWorkspace(createRoutes);
    await createLink(user);
    stubClipboard(() => Promise.resolve());
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await screen.findByRole('button', { name: 'Copied' });

    expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(1);
  });
});

// ===========================================================================
// Revocation
// ===========================================================================
describe('revoking a setup link', () => {
  async function openWithActiveLink(overrides: Record<string, RouteStub> = {}) {
    const result = await openWorkspace({ [LINKS_ROUTE]: { json: [ACTIVE_LINK] }, ...overrides });
    await screen.findByRole('list', { name: 'Setup links' });
    return result;
  }

  it('requires a confirmation step', async () => {
    const { user } = await openWithActiveLink();
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));

    expect(await screen.findByRole('group', { name: 'Confirm revoking this setup link' }))
      .toBeInTheDocument();
    expect(screen.getByText(/signed out and cannot continue/)).toBeInTheDocument();
    // Nothing has been sent yet.
    expect(calls.some((c) => c.method.toUpperCase() === 'DELETE')).toBe(false);
  });

  it('sends no request when the confirmation is cancelled', async () => {
    const { user } = await openWithActiveLink();
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Confirm revoking this setup link' })).toBeNull();
    });
    expect(calls.some((c) => c.method.toUpperCase() === 'DELETE')).toBe(false);
  });

  it('sends exactly one account-scoped DELETE on confirmation', async () => {
    const { user } = await openWithActiveLink({
      [revokeRoute(ACTIVE_LINK.id)]: { json: { revoked: true, id: ACTIVE_LINK.id } },
    });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));

    await waitFor(() => {
      expect(callCountFor('DELETE', `/api/accounts/${ACCOUNT_ID}/onboarding-links/${ACTIVE_LINK.id}`))
        .toBe(1);
    });
    const del = calls.find((c) => c.method.toUpperCase() === 'DELETE')!;
    expect(del.url).toBe(`/api/accounts/${ACCOUNT_ID}/onboarding-links/${ACTIVE_LINK.id}`);
    // Bodyless, and no JSON content-type: Fastify rejects the alternative
    // before the handler runs.
    expect(del.body).toBeNull();
    expect(del.headers['content-type']).toBeUndefined();
  });

  it('never calls the removed unscoped route', async () => {
    const { user } = await openWithActiveLink({
      [revokeRoute(ACTIVE_LINK.id)]: { json: { revoked: true, id: ACTIVE_LINK.id } },
    });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(calls.some((c) => c.method.toUpperCase() === 'DELETE')).toBe(true));

    expect(calls.every((c) => !/^\/api\/onboarding-links\//.test(c.url))).toBe(true);
  });

  it('refreshes both the links and the status, and keeps the row listed', async () => {
    const revokedRow = { ...ACTIVE_LINK, status: 'revoked', revoked_at: '2026-08-04T00:00:00.000Z' };
    const { user } = await openWithActiveLink({
      [LINKS_ROUTE]: (attempt) => ({ json: attempt === 0 ? [ACTIVE_LINK] : [revokedRow] }),
      [revokeRoute(ACTIVE_LINK.id)]: { json: { revoked: true, id: ACTIVE_LINK.id } },
    });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));

    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(2);
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
    });
    // Revocation is not deletion: the row stays.
    expect(within(screen.getByRole('list', { name: 'Setup links' })).getAllByRole('listitem'))
      .toHaveLength(1);
  });

  it('closes the confirmation once the link is no longer active', async () => {
    // Leaving it open would show "Revoked" above a live "Confirm revoke"
    // button, which reads as though the revocation had not taken.
    const revokedRow = { ...ACTIVE_LINK, status: 'revoked', revoked_at: '2026-08-04T00:00:00.000Z' };
    const { user } = await openWithActiveLink({
      [LINKS_ROUTE]: (attempt) => ({ json: attempt === 0 ? [ACTIVE_LINK] : [revokedRow] }),
      [revokeRoute(ACTIVE_LINK.id)]: { json: { revoked: true, id: ACTIVE_LINK.id } },
    });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));

    await screen.findByText('Revoked');
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Confirm revoking this setup link' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Confirm revoke' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke link' })).toBeNull();
  });

  it('does not optimistically mark the row revoked before the server agrees', async () => {
    const { user } = await openWithActiveLink({ [revokeRoute(ACTIVE_LINK.id)]: PENDING });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));

    await screen.findByRole('button', { name: 'Revoking…' });
    // Claiming a live credential was killed when it has not been is the one lie
    // this screen must never tell.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Revoked')).toBeNull();
  });

  it('uses one generic message for a foreign or nonexistent link', async () => {
    const { user } = await openWithActiveLink({
      [revokeRoute(ACTIVE_LINK.id)]: { status: 404, json: { error: 'link_not_found' } },
    });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));

    expect(await screen.findByText(
      'That setup link is no longer available. Refresh the list and try again.',
    )).toBeInTheDocument();
    // The wording must not reveal whether the link exists under another account.
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('another account');
    expect(main).not.toHaveTextContent('does not exist');
    expect(main).not.toHaveTextContent(String(ACTIVE_LINK.id));
  });

  it.each([
    ['a 400', { status: 400, json: { error: 'bad_link_id' } }, 'That request was not valid, so nothing was revoked.'],
    ['a 500', { status: 500, json: { error: 'boom' } }, 'The server could not complete this request. Try again in a moment.'],
  ])('shows a fixed safe message for %s', async (_label, stub, expected) => {
    const { user } = await openWithActiveLink({ [revokeRoute(ACTIVE_LINK.id)]: stub as RouteStub });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('survives a network failure without signing the user out', async () => {
    const { user } = await openWithActiveLink({
      [revokeRoute(ACTIVE_LINK.id)]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm revoke' }));

    expect(await screen.findByText(
      'Could not reach the server. Check your connection and try again.',
    )).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).toBeNull();
  });
});

// ===========================================================================
// Session expiry
// ===========================================================================
describe('an expired session on the workspace', () => {
  it('takes the existing sign-out path and clears the whole cache', async () => {
    const queryClient = createRetainingQueryClient();
    await openWorkspace({
      [STATUS_ROUTE]: (attempt) =>
        attempt === 0 ? { json: STATUS } : { status: 401, json: { error: 'unauthorized' } },
    }, queryClient);
    await screen.findByRole('heading', { name: 'Client setup', level: 3 });

    await queryClient.refetchQueries({
      queryKey: queryKeys.accounts.onboardingStatus(ACCOUNT_ID),
    });

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Setup overview' })).toBeNull();
    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.accounts.onboardingStatus(ACCOUNT_ID)))
        .toBeUndefined();
      expect(queryClient.getQueryData(queryKeys.accounts.onboardingLinks(ACCOUNT_ID)))
        .toBeUndefined();
      expect(queryClient.getQueryData(queryKeys.accounts.list())).toBeUndefined();
    });
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
  });

  it('takes a 401 from the links query down the same path', async () => {
    const queryClient = createRetainingQueryClient();
    await openWorkspace({
      [LINKS_ROUTE]: (attempt) =>
        attempt === 0 ? { json: [ACTIVE_LINK] } : { status: 401, json: { error: 'unauthorized' } },
    }, queryClient);
    await screen.findByRole('list', { name: 'Setup links' });

    await queryClient.refetchQueries({ queryKey: queryKeys.accounts.onboardingLinks(ACCOUNT_ID) });
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
  });

  it('removes a visible one-time URL on sign-out, and Back does not bring it back', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openWorkspace({
      [CREATE_ROUTE]: { status: 201, json: CREATED_RESPONSE },
      [LOGOUT]: { json: { ok: true } },
    }, queryClient);
    await createLink(user);
    expect(screen.getByDisplayValue(SETUP_URL)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Email address');

    // Gone from the document, and never in a cache to be restored from.
    expect(document.body.innerHTML).not.toContain(SYNTHETIC_TOKEN);
    expect(document.body.innerHTML).not.toContain('#token=');
    expect(dumpCaches(queryClient)).not.toContain(SYNTHETIC_TOKEN);
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.accounts.all() }))
      .toHaveLength(0);
  });

  it('does not sign the user out on a 500', async () => {
    const queryClient = createRetainingQueryClient();
    await openWorkspace({ [STATUS_ROUTE]: { status: 500, json: { error: 'boom' } } }, queryClient);

    expect(await screen.findByText('Could not load setup status')).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
  });

  it('does not sign the user out on a network failure', async () => {
    const queryClient = createRetainingQueryClient();
    await openWorkspace({
      [STATUS_ROUTE]: () => {
        throw new TypeError('Failed to fetch');
      },
    }, queryClient);

    expect(await screen.findByText('Could not load setup status')).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
  });

  it('keeps the link controls usable when only the status query fails', async () => {
    // Revoking a live credential is the one thing here that might be urgent; a
    // bad status endpoint must not take it down.
    await openWorkspace({
      [STATUS_ROUTE]: { status: 500, json: { error: 'boom' } },
      [LINKS_ROUTE]: { json: [ACTIVE_LINK] },
    });
    await screen.findByText('Could not load setup status');
    expect(await screen.findByRole('list', { name: 'Setup links' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke link' })).toBeEnabled();
  });
});
