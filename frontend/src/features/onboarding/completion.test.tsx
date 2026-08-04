import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import {
  createRetainingQueryClient, renderWithProviders, type RenderWithProvidersResult,
} from '@/test/render';
import { callCountFor, calls, PENDING, stubFetchRoutes, type RouteStub } from '@/test/server';
import { financialBaseRoutes } from '@/test/financialFixtures';

// Marking an account's setup complete.
//
// Driven through the real router, the real auth guard and the real query client,
// because most of what matters is an interaction between them: a write that must
// refetch two resources and not a third, a 409 that must not read as a crash, and
// a 401 that must take the one existing sign-out path.
//
// THE FIXTURES ARE THE CONTRACT. Every status payload below is the shape
// backend/src/routes/agencyOnboarding.ts actually returns — including the queue
// fields the parser drops — so a backend change that altered the wire would fail
// these tests rather than being absorbed by a convenient mock.

const EMAIL = 'synthetic.agent@example.invalid';
const USER = { id: 4242, email: EMAIL };
const ACCOUNT_ID = 11;
const OTHER_ACCOUNT_ID = 12;

const ME = 'GET /api/auth/me';
const LOGOUT = 'POST /api/auth/logout';
const ACCOUNTS = 'GET /api/accounts';
const STATUS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding/status`;
const LINKS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding-links`;
const COMPLETE_ROUTE = `POST /api/accounts/${ACCOUNT_ID}/onboarding/complete`;
const COMPLETE_PATH = `/api/accounts/${ACCOUNT_ID}/onboarding/complete`;

const SIGNED_IN: RouteStub = { status: 200, json: USER };

function account(id: number, name: string, complete: boolean) {
  return {
    id,
    name,
    store_timezone: 'America/Los_Angeles',
    onboarding_complete: complete,
    created_at: '2026-01-15T09:30:00.000Z',
  };
}

const ACCOUNT_INCOMPLETE = account(ACCOUNT_ID, 'Synthetic Acme', false);
const ACCOUNT_COMPLETE = account(ACCOUNT_ID, 'Synthetic Acme', true);

// --- provider fixtures -----------------------------------------------------
//
// The three distinct answered states, one per platform, in every payload: a
// connected Klaviyo, a requested Shopify and a skipped Recharge. That is the
// Klaviyo-only shape the backend's D13 sequence completes on, and it is also the
// arrangement in which a bug that collapsed the states into "connected" would be
// most visible.
const PROVIDER_SHOPIFY_REQUESTED = {
  provider: 'shopify', state: 'requested', connectionStatus: null,
  requestedDomain: 'synthetic-brand.myshopify.com', shopDomain: null, lastSyncAt: null,
};
const PROVIDER_SHOPIFY_UNDECIDED = {
  provider: 'shopify', state: 'undecided', connectionStatus: null,
  requestedDomain: null, shopDomain: null, lastSyncAt: null,
};
const PROVIDER_KLAVIYO_CONNECTED = {
  provider: 'klaviyo', state: 'connected', connectionStatus: 'connected',
  requestedDomain: null, shopDomain: null, lastSyncAt: '2026-07-30T08:00:00.000Z',
};
const PROVIDER_RECHARGE_SKIPPED = {
  provider: 'recharge', state: 'skipped', connectionStatus: null,
  requestedDomain: null, shopDomain: null, lastSyncAt: null,
};

const PROGRESS = [
  { provider: 'shopify', state: 'requested', counts: {}, lastSyncAt: null, jobId: null, jobState: null, attemptsMade: null, failure: null, recentFailures: [] },
  { provider: 'klaviyo', state: 'completed', counts: { campaigns: 12, campaign_stats: 12 }, lastSyncAt: '2026-07-30T08:00:00.000Z', jobId: 'bull:klaviyo:11', jobState: 'completed', attemptsMade: 0, failure: null, recentFailures: [] },
  { provider: 'recharge', state: 'skipped', counts: {}, lastSyncAt: null, jobId: null, jobState: null, attemptsMade: null, failure: null, recentFailures: [] },
];

const SHOPIFY_RCM_BLOCKER: BlockerFixture = {
  code: 'shopify_not_connected',
  message: 'Connect Shopify to turn on RCM analytics.',
  step: 'connect',
};
interface BlockerFixture {
  code: string;
  message: string;
  step: string;
  detail?: { providers: string[] };
}

const UNDECIDED_BLOCKER: BlockerFixture = {
  code: 'provider_undecided',
  message: 'Tell us about every platform: connect it, or mark that you do not use it — shopify',
  step: 'connect',
  detail: { providers: ['shopify'] },
};

function uiStates(complete: boolean) {
  return {
    onboardingInProgress: !complete,
    onboardingComplete: complete,
    // Setup finished without Shopify — the combination the copy must survive.
    limitedAnalyticsAvailable: complete,
    shopifyNotConnected: true,
    rcmSetupIncomplete: false,
    rcmReady: false,
    syncStillRunning: false,
  };
}

/** Answered everywhere, one platform connected: the completable state. */
function statusReady(complete = false) {
  return {
    onboardingComplete: complete,
    onboardingBlockers: [],
    rcmReadiness: { ready: false, blockers: [SHOPIFY_RCM_BLOCKER] },
    providers: [
      PROVIDER_SHOPIFY_REQUESTED, PROVIDER_KLAVIYO_CONNECTED, PROVIDER_RECHARGE_SKIPPED,
    ],
    progress: PROGRESS,
    uiStates: uiStates(complete),
  };
}

/** Shopify never answered: the gate refuses, and so must the button. */
function statusBlocked(blockers: BlockerFixture[] = [UNDECIDED_BLOCKER]) {
  return {
    onboardingComplete: false,
    onboardingBlockers: blockers,
    rcmReadiness: { ready: false, blockers: [SHOPIFY_RCM_BLOCKER] },
    providers: [
      PROVIDER_SHOPIFY_UNDECIDED, PROVIDER_KLAVIYO_CONNECTED, PROVIDER_RECHARGE_SKIPPED,
    ],
    progress: PROGRESS,
    uiStates: uiStates(false),
  };
}

const COMPLETION_OK = {
  completed: true,
  rcmReady: false,
  rcmBlockers: [SHOPIFY_RCM_BLOCKER],
};

/** The real 409: no `code`, no `message`, just the recomputed blockers. */
const COMPLETION_CONFLICT = {
  status: 409,
  json: { completed: false, onboardingBlockers: [UNDECIDED_BLOCKER] },
} satisfies RouteStub;

const CONFLICT_SENTENCE =
  'Setup changed before it could be completed. Review the latest setup status and try again.';

function baseRoutes(overrides: Record<string, RouteStub> = {}): Record<string, RouteStub> {
  return {
    [ME]: SIGNED_IN,
    [ACCOUNTS]: { json: [ACCOUNT_INCOMPLETE] },
    [STATUS_ROUTE]: { json: statusReady() },
    [LINKS_ROUTE]: { json: [] },
    ...financialBaseRoutes(ACCOUNT_ID),
    ...overrides,
  };
}

function renderWorkspace(
  overrides: Record<string, RouteStub> = {},
  queryClient?: QueryClient,
  accountId: number = ACCOUNT_ID,
): RenderWithProvidersResult {
  stubFetchRoutes(baseRoutes(overrides));
  return renderWithProviders(<AppRoutes />, {
    route: `/accounts/${accountId}`,
    ...(queryClient ? { queryClient } : {}),
  });
}

/** Render and wait for the completion panel to exist. */
async function openPanel(
  overrides: Record<string, RouteStub> = {},
  queryClient?: QueryClient,
) {
  const result = renderWorkspace(overrides, queryClient);
  await screen.findByRole('region', { name: 'Finish setup' });
  return result;
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Finish setup' });
}

function completeButton(): HTMLElement {
  return within(panel()).getByRole('button', { name: 'Mark setup complete' });
}

/**
 * The "Client setup" gate's own badge.
 *
 * Scoped rather than matched by text, because "Setup in progress" legitimately
 * appears twice on this page — on this badge, and in the workspace's Details
 * card, which reads the accounts-list row. A bare getByText would be ambiguous,
 * and resolving that ambiguity by deleting one of them would delete a real part
 * of the page.
 */
function clientSetupGate(): HTMLElement {
  return screen.getByRole('heading', { name: 'Client setup', level: 3 }).closest('section')!;
}

function gateBadge(): string {
  return within(clientSetupGate()).getByText(/^Setup (complete|in progress)$/).textContent ?? '';
}

/** Everything both caches hold, as one searchable string. */
function dumpCaches(queryClient: QueryClient): string {
  const queries = queryClient.getQueryCache().getAll().map((q) => ({
    key: q.queryKey, data: q.state.data, error: String(q.state.error ?? ''),
  }));
  const mutations = queryClient.getMutationCache().getAll().map((m) => ({
    data: m.state.data, variables: m.state.variables, error: String(m.state.error ?? ''),
  }));
  return JSON.stringify({ queries, mutations });
}

/** Every recorded request to the completion endpoint. */
function completionCalls() {
  return calls.filter((c) => c.url === COMPLETE_PATH);
}

/** The single completion request, or a failure that says so. */
function theCompletionCall() {
  const recorded = completionCalls();
  if (recorded.length !== 1) {
    throw new Error(`expected exactly one completion request, saw ${recorded.length}`);
  }
  return recorded[0]!;
}

// ===========================================================================
// 1-3. The three states
// ===========================================================================
describe('the panel reports the state the server reports', () => {
  it('offers a disabled action while a blocker is outstanding', async () => {
    await openPanel({ [STATUS_ROUTE]: { json: statusBlocked() } });

    expect(within(panel()).getByText(/Setup is not ready to be marked complete/))
      .toBeInTheDocument();
    expect(completeButton()).toBeDisabled();
    // The gate above still says the same thing, in its own words.
    expect(gateBadge()).toBe('Setup in progress');
  });

  it('points at the blocker list rather than repeating it', async () => {
    await openPanel({ [STATUS_ROUTE]: { json: statusBlocked() } });

    expect(within(panel()).getByText(/One item above is still outstanding/))
      .toBeInTheDocument();
    // The blocker's own sentence appears once on the page — in SetupOverview.
    expect(screen.getAllByText(UNDECIDED_BLOCKER.message)).toHaveLength(1);
    expect(within(panel()).queryByText(UNDECIDED_BLOCKER.message)).toBeNull();
  });

  it('counts multiple blockers without listing them', async () => {
    await openPanel({
      [STATUS_ROUTE]: {
        json: statusBlocked([
          UNDECIDED_BLOCKER,
          { code: 'no_platform_connected', message: 'Connect at least one platform to finish setup.', step: 'connect' },
        ]),
      },
    });
    expect(within(panel()).getByText(/2 items above are still outstanding/)).toBeInTheDocument();
  });

  it('clicking a blocked action sends no request', async () => {
    const { user } = await openPanel({ [STATUS_ROUTE]: { json: statusBlocked() } });

    await user.click(completeButton());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(callCountFor('POST', COMPLETE_PATH)).toBe(0);
    expect(completionCalls()).toHaveLength(0);
  });

  it('enables the action once every platform is answered', async () => {
    await openPanel();

    expect(completeButton()).toBeEnabled();
    expect(within(panel()).getByText(/Every platform has been answered/)).toBeInTheDocument();
  });

  it('shows a completed statement and no action once complete', async () => {
    await openPanel({
      [ACCOUNTS]: { json: [ACCOUNT_COMPLETE] },
      [STATUS_ROUTE]: { json: statusReady(true) },
    });

    expect(within(panel()).getByText('Setup is complete for this brand.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Mark setup complete' })).toBeNull();
    // Nowhere on the page, not merely outside this panel.
    expect(screen.queryByRole('button', { name: 'Mark setup complete' })).toBeNull();
  });
});

// ===========================================================================
// 4-6. The successful write
// ===========================================================================
describe('a successful completion', () => {
  /** Incomplete until the write lands, complete afterwards — as the server is. */
  function sequencedRoutes() {
    let completed = false;
    return {
      [COMPLETE_ROUTE]: (() => {
        completed = true;
        return { status: 200, json: COMPLETION_OK };
      }) as RouteStub,
      [STATUS_ROUTE]: (() => ({ json: statusReady(completed) })) as RouteStub,
      [ACCOUNTS]: (() => ({
        json: [completed ? ACCOUNT_COMPLETE : ACCOUNT_INCOMPLETE],
      })) as RouteStub,
    };
  }

  it('sends exactly one bodyless POST to the account-scoped agency route', async () => {
    const { user } = await openPanel(sequencedRoutes());
    await user.click(completeButton());

    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));
    const call = theCompletionCall();
    expect(call.method.toUpperCase()).toBe('POST');
    expect(call.url).toBe(COMPLETE_PATH);
    expect(call.body).toBeNull();
    expect(call.credentials).toBe('include');
  });

  it('refetches the onboarding status and the account list', async () => {
    const { user } = await openPanel(sequencedRoutes());
    const statusBefore = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`);
    const accountsBefore = callCountFor('GET', '/api/accounts');

    await user.click(completeButton());

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`))
        .toBeGreaterThan(statusBefore);
    });
    await waitFor(() => {
      expect(callCountFor('GET', '/api/accounts')).toBeGreaterThan(accountsBefore);
    });
  });

  it('shows the completed state from the refetched status, not from the response', async () => {
    const { user } = await openPanel(sequencedRoutes());
    await user.click(completeButton());

    expect(await within(panel()).findByText('Setup is complete for this brand.'))
      .toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Mark setup complete' })).toBeNull();
    // The two gates and the workspace detail moved with it, all from the refetch.
    expect(screen.getAllByText('Setup complete').length).toBeGreaterThan(0);
  });

  it('does not refetch the setup links', async () => {
    const { user } = await openPanel(sequencedRoutes());
    const linksBefore = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`);

    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The agency completion path provably does not touch link rows — verified in
    // verify-onboarding group K, check 12. Refetching them would be a request
    // answering a question nobody asked.
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding-links`)).toBe(linksBefore);
  });

  it('does not refetch any financial resource', async () => {
    const { user } = await openPanel(sequencedRoutes());
    const before = {
      currency: callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/currency`),
      costs: callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/costs`),
      adSpend: callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/ad-spend`),
    };

    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Completion writes none of them, so none of them is stale.
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/currency`)).toBe(before.currency);
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(before.costs);
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(before.adSpend);
  });

  it('never writes completion into the cache by hand', async () => {
    const queryClient = createRetainingQueryClient();
    // The status route keeps answering `false`, as a server that had not applied
    // the write would. Nothing may show complete on the strength of the response.
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 200, json: COMPLETION_OK },
    }, queryClient);

    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const cached = queryClient.getQueryData(queryKeys.accounts.onboardingStatus(ACCOUNT_ID)) as
      { onboardingComplete: boolean } | undefined;
    expect(cached?.onboardingComplete).toBe(false);
    expect(within(panel()).queryByText('Setup is complete for this brand.')).toBeNull();
  });
});

// ===========================================================================
// 7-8. The 409
// ===========================================================================
describe('a 409 is a refusal, not a fault', () => {
  it('shows the fixed conflict sentence rather than a generic error', async () => {
    const { user } = await openPanel({ [COMPLETE_ROUTE]: COMPLETION_CONFLICT });
    await user.click(completeButton());

    expect(await within(panel()).findByText(CONFLICT_SENTENCE)).toBeInTheDocument();
    expect(within(panel()).getByText('Could not mark setup complete')).toBeInTheDocument();
    // Not the catch-all, and not called internal or unexpected.
    expect(within(panel()).queryByText(/returned something unexpected/)).toBeNull();
    expect(panel().textContent).not.toMatch(/unexpected|internal/i);
  });

  it('refetches the status so the current blockers become visible', async () => {
    let refused = false;
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: (() => {
        refused = true;
        return COMPLETION_CONFLICT;
      }) as RouteStub,
      [STATUS_ROUTE]: (() => ({ json: refused ? statusBlocked() : statusReady() })) as RouteStub,
    });
    const statusBefore = callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`);

    await user.click(completeButton());

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`))
        .toBeGreaterThan(statusBefore);
    });
    // The refreshed blockers arrive through SetupOverview, in the backend's words.
    expect(await screen.findByText(UNDECIDED_BLOCKER.message)).toBeInTheDocument();
    expect(completeButton()).toBeDisabled();
  });

  it('does not refetch the account list, because nothing was written', async () => {
    const { user } = await openPanel({ [COMPLETE_ROUTE]: COMPLETION_CONFLICT });
    const accountsBefore = callCountFor('GET', '/api/accounts');

    await user.click(completeButton());
    await within(panel()).findByText(CONFLICT_SENTENCE);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(callCountFor('GET', '/api/accounts')).toBe(accountsBefore);
  });

  it('claims no success and renders no raw response', async () => {
    const { user } = await openPanel({ [COMPLETE_ROUTE]: COMPLETION_CONFLICT });
    await user.click(completeButton());
    await within(panel()).findByText(CONFLICT_SENTENCE);

    expect(within(panel()).queryByText('Setup is complete for this brand.')).toBeNull();
    expect(gateBadge()).toBe('Setup in progress');
    // No JSON, no machine code, no field name from the body. ("completed" is not
    // asserted against: our own fixed sentence contains "could be completed",
    // and banning the word would be banning the copy the spec asked for.)
    expect(panel().textContent).not.toContain('provider_undecided');
    expect(panel().textContent).not.toContain('onboardingBlockers');
    expect(panel().textContent).not.toContain('completed:');
    expect(panel().textContent).not.toContain('{');
    expect(panel().textContent).not.toContain('[object');
  });

  it('offers no retry button for a refusal that retrying cannot fix', async () => {
    const { user } = await openPanel({ [COMPLETE_ROUTE]: COMPLETION_CONFLICT });
    await user.click(completeButton());
    await within(panel()).findByText(CONFLICT_SENTENCE);

    expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

// ===========================================================================
// 9-11. Session and transport failures
// ===========================================================================
describe('a 401 takes the one existing sign-out path', () => {
  it('redirects to /login and leaves no protected data on screen', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 401, json: { error: 'unauthorized' } },
    }, queryClient);

    await user.click(completeButton());

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Synthetic Acme' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Finish setup' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(EMAIL);
    expect(document.body.innerHTML).not.toContain('Setup in progress');
  });

  it('leaves no error panel behind the redirect', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 401, json: { error: 'unauthorized' } },
    });
    await user.click(completeButton());
    await screen.findByLabelText('Email address');

    expect(screen.queryByText('Could not mark setup complete')).toBeNull();
    expect(screen.queryByText(/session has expired/)).toBeNull();
  });

  it('clears the cache, so Back cannot restore the completion state', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 401, json: { error: 'unauthorized' } },
    }, queryClient);

    await user.click(completeButton());
    await screen.findByLabelText('Email address');

    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.accounts.all() }))
      .toHaveLength(0);
    const dump = dumpCaches(queryClient);
    expect(dump).not.toContain('Synthetic Acme');
    expect(dump).not.toContain('onboardingComplete');
    expect(dump).not.toContain(EMAIL);
  });

  it('clears it on an ordinary sign-out too, after a completion', async () => {
    const queryClient = createRetainingQueryClient();
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 200, json: COMPLETION_OK },
      [LOGOUT]: { json: { ok: true } },
    }, queryClient);

    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Email address');

    expect(dumpCaches(queryClient)).not.toContain('Synthetic Acme');
    expect(document.body.innerHTML).not.toContain(EMAIL);
  });
});

describe('transport and server failures keep the session', () => {
  it('a network failure shows a retryable sentence and stays signed in', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: (() => {
        throw new TypeError('Failed to fetch');
      }) as RouteStub,
    });

    await user.click(completeButton());

    expect(await within(panel()).findByText(/Could not reach the server/)).toBeInTheDocument();
    // Still signed in, still on the workspace, still incomplete.
    expect(screen.getByRole('heading', { name: 'Synthetic Acme', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(within(panel()).queryByText('Setup is complete for this brand.')).toBeNull();
  });

  it('a 500 shows the fixed server sentence and stays signed in', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 500, json: { error: 'boom', message: 'internal detail' } },
    });

    await user.click(completeButton());

    expect(await within(panel()).findByText(/The server could not complete this request/))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Synthetic Acme', level: 1 })).toBeInTheDocument();
    // The 5xx body is never adopted as the message.
    expect(panel().textContent).not.toContain('internal detail');
    expect(panel().textContent).not.toContain('boom');
    // And the display is still honestly incomplete.
    expect(gateBadge()).toBe('Setup in progress');
    expect(completeButton()).toBeEnabled();
  });

  it('does not refetch the account list on a transport failure', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: (() => {
        throw new TypeError('Failed to fetch');
      }) as RouteStub,
    });
    const accountsBefore = callCountFor('GET', '/api/accounts');

    await user.click(completeButton());
    await within(panel()).findByText(/Could not reach the server/);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(callCountFor('GET', '/api/accounts')).toBe(accountsBefore);
  });

  it('never retries a failed completion automatically', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 500, json: {} },
    });

    await user.click(completeButton());
    await within(panel()).findByText(/The server could not complete this request/);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(callCountFor('POST', COMPLETE_PATH)).toBe(1);
  });
});

// ===========================================================================
// 12-13. Duplicate submission
// ===========================================================================
describe('a completion cannot be submitted twice', () => {
  it('three clicks in ONE tick produce one request', async () => {
    await openPanel({ [COMPLETE_ROUTE]: { status: 200, json: COMPLETION_OK } });
    const button = completeButton();

    // Native .click() rather than userEvent: userEvent awaits between clicks, so
    // its clicks are sequential submissions and each is legitimate. Dispatching
    // three in a single tick is the actual race — `isPending` has not been
    // committed yet when the second and third handlers run, which is why the hook
    // guards on a ref instead.
    button.click();
    button.click();
    button.click();

    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(callCountFor('POST', COMPLETE_PATH)).toBe(1);
  });

  it('a second completion after the first has settled is not offered', async () => {
    let completed = false;
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: (() => {
        completed = true;
        return { status: 200, json: COMPLETION_OK };
      }) as RouteStub,
      [STATUS_ROUTE]: (() => ({ json: statusReady(completed) })) as RouteStub,
      [ACCOUNTS]: (() => ({
        json: [completed ? ACCOUNT_COMPLETE : ACCOUNT_INCOMPLETE],
      })) as RouteStub,
    });

    await user.click(completeButton());
    await within(panel()).findByText('Setup is complete for this brand.');

    // The control is gone, so there is nothing to submit a second time.
    expect(screen.queryByRole('button', { name: 'Mark setup complete' })).toBeNull();
    expect(callCountFor('POST', COMPLETE_PATH)).toBe(1);
  });

  it('shows a busy label while pending and ignores a further submission', async () => {
    // PENDING keeps the request in flight for the whole case, which is the only
    // way to observe the busy state without racing it.
    const { user } = await openPanel({ [COMPLETE_ROUTE]: PENDING });

    await user.click(completeButton());

    const busy = await within(panel()).findByRole('button', { name: 'Marking complete…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
    // The idle label is gone, so there is nothing left to click twice.
    expect(within(panel()).queryByRole('button', { name: 'Mark setup complete' })).toBeNull();

    await user.click(busy);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(callCountFor('POST', COMPLETE_PATH)).toBe(1);
  });
});

// ===========================================================================
// 14-16, 20. Onboarding completion is not RCM readiness
// ===========================================================================
describe('completion is never presented as analytics readiness', () => {
  it('a Klaviyo-only completion says complete and not ready, together', async () => {
    await openPanel({
      [ACCOUNTS]: { json: [ACCOUNT_COMPLETE] },
      [STATUS_ROUTE]: { json: statusReady(true) },
    });

    expect(within(panel()).getByText('Setup is complete for this brand.')).toBeInTheDocument();
    // The analytics gate, unchanged and honest, in the same viewport.
    const readiness = screen.getByRole('heading', { name: 'Analytics readiness', level: 3 })
      .closest('section')!;
    expect(within(readiness).getByText('Not ready')).toBeInTheDocument();
    expect(within(readiness).getByText(SHOPIFY_RCM_BLOCKER.message)).toBeInTheDocument();
    expect(gateBadge()).toBe('Setup complete');
  });

  it('states outright that readiness is tracked separately', async () => {
    await openPanel({
      [ACCOUNTS]: { json: [ACCOUNT_COMPLETE] },
      [STATUS_ROUTE]: { json: statusReady(true) },
    });

    expect(within(panel()).getByText(/Analytics readiness is tracked separately/))
      .toBeInTheDocument();
    expect(within(panel()).getByText(/may still require Shopify or financial inputs/))
      .toBeInTheDocument();
  });

  it('makes no readiness claim anywhere in the panel', async () => {
    await openPanel({
      [ACCOUNTS]: { json: [ACCOUNT_COMPLETE] },
      [STATUS_ROUTE]: { json: statusReady(true) },
    });

    const text = panel().textContent ?? '';
    expect(text).not.toMatch(/RCM is ready|analytics are ready|analytics ready/i);
    expect(text).not.toMatch(/all (platforms|integrations) (are )?connected/i);
    expect(text).not.toMatch(/the client (has )?(completed|finished)/i);
    expect(text).not.toMatch(/import(s)? (are |have )?(finished|complete)/i);
  });

  it('keeps the limited-analytics explanation accurate after completion', async () => {
    await openPanel({
      [ACCOUNTS]: { json: [ACCOUNT_COMPLETE] },
      [STATUS_ROUTE]: { json: statusReady(true) },
    });

    expect(screen.getByText(/Client setup is finished without Shopify/)).toBeInTheDocument();
  });

  it('presents financial inputs as optional, before and after completion', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 200, json: COMPLETION_OK },
    });
    const financial = screen.getByRole('region', { name: 'Financial inputs' });

    expect(within(financial).getByText(/limited onboarding can be completed without them/))
      .toBeInTheDocument();
    // No required marker anywhere in the financial section.
    expect(financial.querySelector('[required]')).toBeNull();
    expect(financial.querySelector('[aria-required="true"]')).toBeNull();
    // And the panel invents no financial PREREQUISITE. It names these inputs on
    // purpose — to say they are not needed — so the assertion is on the claim
    // rather than on the words: the sentence that mentions them must be the one
    // ruling them out.
    expect(within(panel()).getByText(/cost figures are not required/))
      .toBeInTheDocument();
    expect(panel().textContent).not.toMatch(/enter .* before .* complete/i);
    expect(panel().textContent).not.toMatch(/RCM|readiness|analytics/i);

    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));
    expect(within(financial).queryByText(/required to complete/i)).toBeNull();
  });

  it('keeps the three provider states distinct through a completion', async () => {
    let completed = false;
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: (() => {
        completed = true;
        return { status: 200, json: COMPLETION_OK };
      }) as RouteStub,
      [STATUS_ROUTE]: (() => ({ json: statusReady(completed) })) as RouteStub,
    });

    const platforms = screen.getByRole('region', { name: 'Platforms' });
    expect(within(platforms).getByText('Connected')).toBeInTheDocument();
    expect(within(platforms).getByText('Setup requested')).toBeInTheDocument();
    expect(within(platforms).getByText('Not used')).toBeInTheDocument();

    await user.click(completeButton());
    await within(panel()).findByText('Setup is complete for this brand.');

    // Completion converted nothing: still one of each.
    expect(within(platforms).getAllByText('Connected')).toHaveLength(1);
    expect(within(platforms).getByText('Setup requested')).toBeInTheDocument();
    expect(within(platforms).getByText('Not used')).toBeInTheDocument();
  });
});

// ===========================================================================
// 17-19. Request discipline and account scoping
// ===========================================================================
describe('the request is account-scoped and carries nothing else', () => {
  it('never calls a client onboarding route', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 200, json: COMPLETION_OK },
    });
    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));

    // The client wizard's own prefix, matched at the segment boundary so the
    // agency path /api/accounts/:id/onboarding/... cannot satisfy it.
    for (const call of calls) {
      expect(call.url.startsWith('/api/onboarding/')).toBe(false);
      expect(call.url).not.toBe('/api/onboarding/complete');
    }
  });

  it('carries no account identifier and no credential-shaped field', async () => {
    const { user } = await openPanel({
      [COMPLETE_ROUTE]: { status: 200, json: COMPLETION_OK },
    });
    await user.click(completeButton());
    await waitFor(() => expect(callCountFor('POST', COMPLETE_PATH)).toBe(1));

    const call = theCompletionCall();
    expect(call.body).toBeNull();
    // A bodyless request also means no Content-Type to smuggle anything under.
    expect(call.headers['content-type']).toBeUndefined();

    // And no write anywhere in this flow names an account in its body.
    for (const recorded of calls) {
      if (recorded.body === null) continue;
      const parsed = JSON.parse(recorded.body) as Record<string, unknown>;
      for (const forbidden of ['accountId', 'account_id', 'account']) {
        expect(Object.prototype.hasOwnProperty.call(parsed, forbidden)).toBe(false);
      }
      for (const forbidden of ['apiKey', 'token', 'clientSecret', 'clientId', 'password', 'secret']) {
        expect(Object.prototype.hasOwnProperty.call(parsed, forbidden)).toBe(false);
      }
    }
  });

  it('sends the id from the path it was rendered for', async () => {
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: { json: [ACCOUNT_INCOMPLETE, account(OTHER_ACCOUNT_ID, 'Synthetic Beta', false)] },
      [`GET /api/accounts/${OTHER_ACCOUNT_ID}/onboarding/status`]: { json: statusReady() },
      [`GET /api/accounts/${OTHER_ACCOUNT_ID}/onboarding-links`]: { json: [] },
      [`POST /api/accounts/${OTHER_ACCOUNT_ID}/onboarding/complete`]: {
        status: 200, json: COMPLETION_OK,
      },
      ...financialBaseRoutes(OTHER_ACCOUNT_ID),
    });
    const { user } = renderWithProviders(<AppRoutes />, {
      route: `/accounts/${OTHER_ACCOUNT_ID}`,
    });
    await screen.findByRole('region', { name: 'Finish setup' });

    await user.click(completeButton());
    await waitFor(() => {
      expect(callCountFor('POST', `/api/accounts/${OTHER_ACCOUNT_ID}/onboarding/complete`)).toBe(1);
    });
    // Never the other account, whose id is also in the directory the page read.
    expect(callCountFor('POST', COMPLETE_PATH)).toBe(0);
  });

  it('does not show one account\'s completion state on another account', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes({
      [ME]: SIGNED_IN,
      [ACCOUNTS]: { json: [ACCOUNT_COMPLETE, account(OTHER_ACCOUNT_ID, 'Synthetic Beta', false)] },
      [STATUS_ROUTE]: { json: statusReady(true) },
      [LINKS_ROUTE]: { json: [] },
      [`GET /api/accounts/${OTHER_ACCOUNT_ID}/onboarding/status`]: { json: statusBlocked() },
      [`GET /api/accounts/${OTHER_ACCOUNT_ID}/onboarding-links`]: { json: [] },
      ...financialBaseRoutes(ACCOUNT_ID),
      ...financialBaseRoutes(OTHER_ACCOUNT_ID),
    });
    const { user } = renderWithProviders(<AppRoutes />, {
      route: `/accounts/${ACCOUNT_ID}`, queryClient,
    });
    await screen.findByRole('region', { name: 'Finish setup' });
    expect(within(panel()).getByText('Setup is complete for this brand.')).toBeInTheDocument();

    // Navigate to the other brand through the directory, as a user would.
    await user.click(screen.getByRole('link', { name: 'Back to all accounts' }));
    await user.click(await screen.findByRole('link', { name: /Synthetic Beta/ }));
    await screen.findByRole('heading', { name: 'Synthetic Beta', level: 1 });

    expect(within(panel()).queryByText('Setup is complete for this brand.')).toBeNull();
    expect(completeButton()).toBeDisabled();
  });
});

// ===========================================================================
// The rest of the control centre is unaffected
// ===========================================================================
describe('nothing else on the page changed', () => {
  it('still renders the two gates, the links section and the platforms', async () => {
    await openPanel();

    expect(screen.getByRole('heading', { name: 'Client setup', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analytics readiness', level: 3 }))
      .toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Setup links' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Platforms' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Financial inputs' })).toBeInTheDocument();
  });

  it('renders no completion control while the status is still loading', async () => {
    stubFetchRoutes(baseRoutes({ [STATUS_ROUTE]: { pending: true } }));
    renderWithProviders(<AppRoutes />, { route: `/accounts/${ACCOUNT_ID}` });
    await screen.findByRole('heading', { name: 'Synthetic Acme', level: 1 });

    expect(screen.queryByRole('region', { name: 'Finish setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark setup complete' })).toBeNull();
  });

  it('renders no completion control when the status request failed', async () => {
    await screen.findByRole; // keeps the import used in every case
    stubFetchRoutes(baseRoutes({ [STATUS_ROUTE]: { status: 500, json: {} } }));
    renderWithProviders(<AppRoutes />, { route: `/accounts/${ACCOUNT_ID}` });
    await screen.findByText('Could not load setup status');

    // A button whose enabled state would be a guess is not offered at all.
    expect(screen.queryByRole('region', { name: 'Finish setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark setup complete' })).toBeNull();
  });

  it('issues no completion request merely by opening the workspace', async () => {
    await openPanel();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(callCountFor('POST', COMPLETE_PATH)).toBe(0);
  });
});
