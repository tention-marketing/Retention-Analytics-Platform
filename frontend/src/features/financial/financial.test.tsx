import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { AppRoutes } from '@/routes/router';
import { queryKeys } from '@/api/queryKeys';
import {
  createRetainingQueryClient, renderWithProviders, type RenderWithProvidersResult,
} from '@/test/render';
import { callCountFor, calls, PENDING, stubFetchRoutes, type RouteStub } from '@/test/server';
import {
  AD_SPEND_EMPTY, COSTS_EMPTY, CURRENCY_MANUAL_USD, CURRENCY_MISMATCH, CURRENCY_SHOPIFY_USD,
  CURRENCY_UNKNOWN, adSpendCoverage, costsState, coverage, financialRouteKeys, sku,
} from '@/test/financialFixtures';

// The agency financial-input controls.
//
// Driven through the real router, guards and query client, because much of what
// matters is an interaction between them: a 401 that must take the existing
// sign-out path, a write that must refresh RCM readiness, a section that must keep
// working when a sibling section's endpoint is down.
//
// EVERY FIXTURE IS SYNTHETIC. No real brand's SKUs, costs or spend appear.

const EMAIL = 'synthetic.agent@example.invalid';
const USER = { id: 4242, email: EMAIL };
const ACCOUNT_ID = 11;
const OTHER_ACCOUNT_ID = 12;

const ME = 'GET /api/auth/me';
const ACCOUNTS = 'GET /api/accounts';
const STATUS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding/status`;
const LINKS_ROUTE = `GET /api/accounts/${ACCOUNT_ID}/onboarding-links`;
const R = financialRouteKeys(ACCOUNT_ID);

const ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Synthetic Acme',
  store_timezone: 'America/Los_Angeles',
  onboarding_complete: false,
  created_at: '2026-01-15T09:30:00.000Z',
};

function statusPayload(shopifyConnected = true) {
  return {
    onboardingComplete: false,
    onboardingBlockers: [],
    rcmReadiness: { ready: false, blockers: [] },
    providers: [
      {
        provider: 'shopify',
        state: shopifyConnected ? 'connected' : 'undecided',
        connectionStatus: shopifyConnected ? 'connected' : null,
        requestedDomain: null,
        shopDomain: shopifyConnected ? 'synthetic.myshopify.com' : null,
        lastSyncAt: null,
      },
      { provider: 'klaviyo', state: 'skipped', connectionStatus: null, requestedDomain: null, shopDomain: null, lastSyncAt: null },
      { provider: 'recharge', state: 'skipped', connectionStatus: null, requestedDomain: null, shopDomain: null, lastSyncAt: null },
    ],
    progress: [
      { provider: 'shopify', state: shopifyConnected ? 'completed' : 'not_started', counts: {}, lastSyncAt: null, failure: null },
      { provider: 'klaviyo', state: 'skipped', counts: {}, lastSyncAt: null, failure: null },
      { provider: 'recharge', state: 'skipped', counts: {}, lastSyncAt: null, failure: null },
    ],
    uiStates: {
      onboardingInProgress: true,
      onboardingComplete: false,
      limitedAnalyticsAvailable: false,
      shopifyNotConnected: !shopifyConnected,
      rcmSetupIncomplete: shopifyConnected,
      rcmReady: false,
      syncStillRunning: false,
    },
  };
}

function baseRoutes(overrides: Record<string, RouteStub> = {}): Record<string, RouteStub> {
  return {
    [ME]: { status: 200, json: USER },
    [ACCOUNTS]: { json: [ACCOUNT] },
    [STATUS_ROUTE]: { json: statusPayload() },
    [LINKS_ROUTE]: { json: [] },
    [R.currency]: { json: CURRENCY_MANUAL_USD },
    [R.costs]: { json: COSTS_EMPTY },
    [R.adSpend]: { json: AD_SPEND_EMPTY },
    ...overrides,
  };
}

/**
 * The per-resource loading messages.
 *
 * openWorkspace waits for each of these to clear, because the section heading
 * renders long before its query settles — without the wait, every assertion below
 * would run against a "Loading…" placeholder and fail for a reason that has
 * nothing to do with what it is testing. A route deliberately left PENDING is
 * skipped, since its message is the point of that case.
 */
const LOADING_MESSAGES: [string, string][] = [
  [R.currency, 'Loading currency…'],
  [R.costs, 'Loading cost of goods…'],
  [R.adSpend, 'Loading advertising spend…'],
];

async function openWorkspace(
  overrides: Record<string, RouteStub> = {},
  queryClient?: QueryClient,
): Promise<RenderWithProvidersResult> {
  stubFetchRoutes(baseRoutes(overrides));
  const result = renderWithProviders(<AppRoutes />, {
    route: `/accounts/${ACCOUNT_ID}`,
    ...(queryClient ? { queryClient } : {}),
  });
  await screen.findByRole('region', { name: 'Financial inputs' });

  for (const [route, message] of LOADING_MESSAGES) {
    if (overrides[route] === PENDING) continue;
    // Settled means loaded OR failed — an error state is a legitimate resting
    // place for several cases here.
    await waitFor(() => {
      expect(screen.queryByText(message)).toBeNull();
    });
  }
  return result;
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

/** The OCAS zero-confirmation checkbox, as its label actually reads. */
const ZERO_OCAS_LABEL = /the true monthly operating cost allocation for this brand is zero/;

const CURRENCY = 'Currency';
const COGS = 'Cost of goods';
const OCAS = 'Monthly operating costs';
const AD_SPEND = 'Advertising spend';

// ===========================================================================
// Layout
// ===========================================================================
describe('the financial inputs section', () => {
  it('renders all four subsections under one heading', async () => {
    await openWorkspace();
    const financial = section('Financial inputs');
    for (const title of [CURRENCY, COGS, OCAS, AD_SPEND]) {
      expect(within(financial).getByRole('heading', { name: title })).toBeInTheDocument();
    }
  });

  it('preserves the account details and onboarding controls above it', async () => {
    await openWorkspace();
    expect(screen.getByRole('heading', { name: 'Synthetic Acme' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Setup links' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Platforms' })).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it('issues exactly one request per financial resource', async () => {
    await openWorkspace();
    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/currency`)).toBe(1);
    });
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(1);
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(1);
    // The costs response carries OCAS too, so there is no second fetch for it —
    // and no separate /skus call, because coverage arrives with the costs.
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/skus`)).toBe(0);
  });

  it('never requests a client onboarding route, completion, or a dashboard', async () => {
    await openWorkspace();
    for (const call of calls) {
      expect(call.url).not.toMatch(/\/onboarding\/(currency|cogs|ocas|ad-spend)/);
      expect(call.url).not.toContain('/onboarding/complete');
      expect(call.url).not.toMatch(/\/(rcm|metrics|snapshot|churn|cohort|repurchase)\b/);
    }
  });

  it('explains the Shopify requirement neutrally when it is not connected', async () => {
    await openWorkspace({ [STATUS_ROUTE]: { json: statusPayload(false) } });
    expect(await screen.findByText(/Shopify is required before RCM can be calculated/))
      .toBeInTheDocument();
    // Not presented as a provider fault, and nothing is disabled by it: the
    // currency form is still usable.
    expect(within(section(CURRENCY)).getByRole('button', { name: 'Save currency' }))
      .toBeEnabled();
  });

  it('does not claim Shopify is missing before the status has resolved', async () => {
    await openWorkspace({ [STATUS_ROUTE]: PENDING });
    expect(screen.queryByText(/Shopify is required before RCM/)).toBeNull();
  });

  it('loads each subsection independently, so one failure does not hide the others',
    async () => {
      await openWorkspace({ [R.adSpend]: { status: 500, json: { error: 'boom' } } });
      // Ad spend failed…
      expect(await within(section(AD_SPEND)).findByText(
        'The server could not complete this request. Try again in a moment.',
      )).toBeInTheDocument();
      // …and currency and cost of goods are still there and usable.
      expect(within(section(CURRENCY)).getByText('USD')).toBeInTheDocument();
      expect(within(section(COGS)).getByRole('radio', { name: /Per-product costs/ }))
        .toBeInTheDocument();
      expect(within(section(OCAS)).getByLabelText(/Monthly operating cost allocation/))
        .toBeInTheDocument();
    });

  it('does not describe a financial failure as a provider-connection problem', async () => {
    await openWorkspace({ [R.costs]: { status: 500, json: {} } });
    const cogs = section(COGS);
    await within(cogs).findByText('The server could not complete this request. Try again in a moment.');
    for (const word of ['Shopify', 'Klaviyo', 'Recharge', 'credential', 'disconnect']) {
      expect(cogs).not.toHaveTextContent(word);
    }
  });

  it('shows a pending state per subsection', async () => {
    await openWorkspace({ [R.adSpend]: PENDING });
    expect(within(section(AD_SPEND)).getByText('Loading advertising spend…'))
      .toBeInTheDocument();
    expect(within(section(CURRENCY)).getByText('USD')).toBeInTheDocument();
  });

  it('offers a retry for a retryable load failure', async () => {
    const { user } = await openWorkspace({
      [R.adSpend]: (attempt) => (attempt === 0 ? { status: 503, json: {} } : { json: AD_SPEND_EMPTY }),
    });
    const adSpend = section(AD_SPEND);
    await within(adSpend).findByText('The server could not complete this request. Try again in a moment.');
    await user.click(within(adSpend).getByRole('button', { name: 'Try again' }));
    expect(await within(section(AD_SPEND)).findByText(/No advertising spend is required/))
      .toBeInTheDocument();
  });

  it('builds no delete, disconnect, RCM or ad-platform control', async () => {
    await openWorkspace({
      [R.adSpend]: {
        json: {
          ...AD_SPEND_EMPTY,
          rows: [{ month: '2026-07-01', channel: 'Meta', spend: '500.00', source: 'manual' }],
          coverage: adSpendCoverage({
            firstOrderMonth: '2026-07-01', windowStart: '2026-07-01',
            requiredMonths: ['2026-07-01'], coveredMonths: ['2026-07-01'],
          }),
        },
      },
    });
    const financial = section('Financial inputs');
    for (const name of [/^delete$/i, /disconnect/i, /remove row/i, /calculate rcm/i,
      /connect meta/i, /connect google/i, /import csv/i, /^upload$/i]) {
      expect(within(financial).queryByRole('button', { name })).toBeNull();
    }
    // The rows table exists, and offers correction rather than deletion.
    expect(within(financial).getByText(/save the same channel and month again/i))
      .toBeInTheDocument();
  });
});

// ===========================================================================
// Currency
// ===========================================================================
describe('the currency control', () => {
  it('shows the three-letter code and its source when set manually', async () => {
    await openWorkspace();
    const currency = section(CURRENCY);
    // The code is rendered in its own element beside the "Currency" label.
    expect(within(currency).getByText('Currency', { selector: 'span' }).nextElementSibling).toHaveTextContent('USD');
    expect(within(currency).getByText('Source: manually selected by your team.'))
      .toBeInTheDocument();
  });

  it('explains that money needs a currency, but a percentage does not', async () => {
    await openWorkspace({ [R.currency]: { json: CURRENCY_UNKNOWN } });
    const currency = section(CURRENCY);
    expect(within(currency).getByText(/A currency is required before any amount/))
      .toBeInTheDocument();
    expect(within(currency).getByText(/Gross margin is a percentage, so it can be entered now/))
      .toBeInTheDocument();
  });

  it('normalizes a typed code to uppercase and sends exactly one field', async () => {
    const { user } = await openWorkspace({
      [R.currency]: { json: CURRENCY_UNKNOWN },
      [R.setCurrency]: { json: { ok: true, currency: 'GBP' } },
    });
    const currency = section(CURRENCY);
    const field = within(currency).getByLabelText('Currency code');
    await user.type(field, 'gbp');
    // Uppercased as typed, so what is on screen is what will be stored.
    expect(field).toHaveValue('GBP');
    await user.click(within(currency).getByRole('button', { name: 'Save currency' }));

    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/currency`)).toBe(1);
    });
    const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/currency'))!;
    expect(JSON.parse(call.body!)).toEqual({ currency: 'GBP' });
  });

  it('refuses a code that is not exactly three letters, without a request', async () => {
    const { user } = await openWorkspace({ [R.currency]: { json: CURRENCY_UNKNOWN } });
    const currency = section(CURRENCY);
    await user.type(within(currency).getByLabelText('Currency code'), 'US');
    await user.click(within(currency).getByRole('button', { name: 'Save currency' }));
    expect(await within(currency).findByText('Enter exactly three letters, for example USD.'))
      .toBeInTheDocument();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/currency`)).toBe(0);
  });

  it('does not claim the code was checked against an official register', async () => {
    await openWorkspace({ [R.currency]: { json: CURRENCY_UNKNOWN } });
    const currency = section(CURRENCY);
    // The backend validates the FORMAT only, so the UI must not imply more.
    expect(currency).not.toHaveTextContent(/ISO 4217/i);
    expect(currency).not.toHaveTextContent(/valid currency/i);
    expect(currency).not.toHaveTextContent(/verified/i);
  });

  it('renders a Shopify currency read-only, with no edit control', async () => {
    await openWorkspace({ [R.currency]: { json: CURRENCY_SHOPIFY_USD } });
    const currency = section(CURRENCY);
    expect(within(currency).getByText('Currency', { selector: 'span' }).nextElementSibling).toHaveTextContent('USD');
    expect(within(currency).getByText('Source: the connected Shopify store.'))
      .toBeInTheDocument();
    expect(within(currency).queryByLabelText('Currency code')).toBeNull();
    expect(within(currency).queryByRole('button', { name: 'Save currency' })).toBeNull();
    expect(within(currency).getByText(/not editable here/)).toBeInTheDocument();
  });

  it('surfaces the fixed message if the server refuses a manual change', async () => {
    const { user } = await openWorkspace({
      [R.currency]: { json: CURRENCY_MANUAL_USD },
      [R.setCurrency]: {
        status: 400,
        json: { ok: false, error: 'shopify_authoritative', message: 'raw backend prose' },
      },
    });
    const currency = section(CURRENCY);
    await user.click(within(currency).getByRole('button', { name: 'Save currency' }));
    expect(await within(currency).findByText(
      'This currency comes from the connected Shopify store and cannot be changed here.',
    )).toBeInTheDocument();
    expect(currency).not.toHaveTextContent('raw backend prose');
  });

  describe('a mismatch', () => {
    const MISMATCH_ROUTES = { [R.currency]: { json: CURRENCY_MISMATCH } };

    it('shows both codes and states that nothing was converted', async () => {
      await openWorkspace(MISMATCH_ROUTES);
      const currency = section(CURRENCY);
      expect(within(currency).getByText(/Currency mismatch/)).toBeInTheDocument();
      // Both codes are shown, each under its own label, so the agency can see
      // exactly which is which.
      expect(within(currency).getByText(/Amounts on file are recorded in/)
        .nextElementSibling).toHaveTextContent('CAD');
      expect(within(currency).getByText(/Shopify reports/)
        .nextElementSibling).toHaveTextContent('USD');
      expect(within(currency).getByText(/No amount has been converted and nothing has been deleted/))
        .toBeInTheDocument();
      expect(within(currency).getByText(/RCM analytics are unavailable/)).toBeInTheDocument();
    });

    it('blocks resolution until the acknowledgement is ticked', async () => {
      const { user } = await openWorkspace(MISMATCH_ROUTES);
      const currency = section(CURRENCY);
      const button = within(currency).getByRole('button', { name: 'Resolve mismatch' });
      expect(button).toBeDisabled();

      await user.click(within(currency).getByLabelText(
        /I have reviewed and re-entered all affected money values in USD/,
      ));
      expect(button).toBeEnabled();
    });

    it('sends nothing while the acknowledgement is unticked', async () => {
      const { user } = await openWorkspace(MISMATCH_ROUTES);
      const currency = section(CURRENCY);
      await user.click(within(currency).getByRole('button', { name: 'Resolve mismatch' }));
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/currency/resolve-mismatch`)).toBe(0);
    });

    it('sends exactly one bodyless request, and refetches every financial resource',
      async () => {
        const { user } = await openWorkspace({
          ...MISMATCH_ROUTES,
          [R.resolveMismatch]: { json: { ok: true, currency: 'USD' } },
        });
        const currency = section(CURRENCY);
        await user.click(within(currency).getByLabelText(/I have reviewed and re-entered/));
        await user.click(within(currency).getByRole('button', { name: 'Resolve mismatch' }));

        await waitFor(() => {
          expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/currency/resolve-mismatch`))
            .toBe(1);
        });
        const call = calls.find((c) => c.url.endsWith('/resolve-mismatch'))!;
        expect(call.body).toBeNull();

        // Every money value's LABEL has changed meaning, so all three resources are
        // re-read — plus the RCM readiness that the mismatch was blocking.
        await waitFor(() => {
          expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/currency`)).toBe(2);
        });
        expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(2);
        expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(2);
        expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
      });

    it('converts no stored amount — the values after resolution are the values before',
      async () => {
        const withMoney = {
          costs: costsState({ cogsMethod: 'per_sku', ocasMonthly: '1500.25' }),
          coverage: coverage({ required: [sku('SYN-A', 1000, 333.33)] }),
        };
        const { user } = await openWorkspace({
          ...MISMATCH_ROUTES,
          [R.costs]: { json: withMoney },
          [R.adSpend]: {
            json: {
              ...AD_SPEND_EMPTY,
              rows: [{ month: '2026-07-01', channel: 'Meta', spend: '777.77', source: 'manual' }],
              coverage: adSpendCoverage({
                firstOrderMonth: '2026-07-01', windowStart: '2026-07-01',
                requiredMonths: ['2026-07-01'], coveredMonths: ['2026-07-01'],
              }),
            },
          },
          [R.resolveMismatch]: { json: { ok: true, currency: 'USD' } },
        });

        expect(await within(section(OCAS)).findByText('1500.25 CAD')).toBeInTheDocument();
        expect(within(section(AD_SPEND)).getByText('777.77 CAD')).toBeInTheDocument();

        const currency = section(CURRENCY);
        await user.click(within(currency).getByLabelText(/I have reviewed and re-entered/));
        await user.click(within(currency).getByRole('button', { name: 'Resolve mismatch' }));

        await waitFor(() => {
          expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/currency/resolve-mismatch`))
            .toBe(1);
        });
        // The DIGITS are identical. Only the code beside them changes, and only
        // because the account currency did.
        expect(within(section(OCAS)).getByText(/^1500\.25 /)).toBeInTheDocument();
        expect(within(section(AD_SPEND)).getByText(/^777\.77 /)).toBeInTheDocument();
        // And no request anywhere tried to rewrite a money value.
        expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
      });

    it('does not resolve as a side effect of saving another form', async () => {
      const { user } = await openWorkspace({
        ...MISMATCH_ROUTES,
        [R.saveOcas]: { json: { ocasMonthly: 100, confirmedZero: false } },
      });
      const ocas = section(OCAS);
      await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), '100');
      await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));
      await waitFor(() => {
        expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(1);
      });
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/currency/resolve-mismatch`)).toBe(0);
    });

    it('maps a 409 no_mismatch to a fixed sentence', async () => {
      const { user } = await openWorkspace({
        ...MISMATCH_ROUTES,
        [R.resolveMismatch]: {
          status: 409,
          json: { ok: false, error: 'no_mismatch', message: 'raw backend prose' },
        },
      });
      const currency = section(CURRENCY);
      await user.click(within(currency).getByLabelText(/I have reviewed and re-entered/));
      await user.click(within(currency).getByRole('button', { name: 'Resolve mismatch' }));
      expect(await within(currency).findByText(/There is no currency mismatch on this account/))
        .toBeInTheDocument();
      expect(currency).not.toHaveTextContent('raw backend prose');
    });
  });
});

// ===========================================================================
// COGS
// ===========================================================================
describe('the cost-of-goods control', () => {
  const FIVE_SKUS = coverage({
    required: [sku('SYN-A', 5000), sku('SYN-B', 3000)],
    all: [sku('SYN-A', 5000), sku('SYN-B', 3000), sku('SYN-C', 1000), sku('SYN-D', 600),
      sku('SYN-E', 400)],
  });

  it('offers exactly two methods and renders only one form', async () => {
    await openWorkspace({ [R.costs]: { json: { costs: costsState(), coverage: FIVE_SKUS } } });
    const cogs = section(COGS);
    expect(within(cogs).getAllByRole('radio')).toHaveLength(2);
    expect(within(cogs).getByRole('radio', { name: /Per-product costs/ })).toBeChecked();
    // Only the selected method's FIELD exists, so both can never be submitted. The
    // radio shares that label text, hence the role filter.
    expect(within(cogs).queryByRole('textbox', { name: 'Blended gross margin' })).toBeNull();
  });

  it('confirms a method switch and describes the retained values accurately', async () => {
    const { user } = await openWorkspace({
      [R.costs]: {
        json: { costs: costsState({ cogsMethod: 'per_sku' }), coverage: FIVE_SKUS },
      },
    });
    const cogs = section(COGS);
    await user.click(within(cogs).getByRole('radio', { name: /Blended gross margin/ }));

    expect(await within(cogs).findByText(/Switch to blended gross margin\?/)).toBeInTheDocument();
    // The promise that matters, and it is literally true: the backend keeps both
    // sets and switches which is ACTIVE.
    // The <strong> around "kept" splits the text node, so the claim is asserted
    // against the containing element.
    expect(cogs).toHaveTextContent(/Everything you have already entered is kept/);
    expect(cogs).toHaveTextContent(/nothing is deleted/);
    expect(cogs).toHaveTextContent(/never combined/);
    expect(within(cogs).getByText(/Switching back restores the values you entered before/))
      .toBeInTheDocument();
    // And it must not claim the opposite.
    expect(cogs).not.toHaveTextContent(/will be lost/i);
    expect(cogs).not.toHaveTextContent(/will be removed/i);
    expect(cogs).not.toHaveTextContent(/permanently/i);
  });

  it('cancels a method switch without changing anything', async () => {
    const { user } = await openWorkspace({
      [R.costs]: { json: { costs: costsState({ cogsMethod: 'per_sku' }), coverage: FIVE_SKUS } },
    });
    const cogs = section(COGS);
    await user.click(within(cogs).getByRole('radio', { name: /Blended gross margin/ }));
    await user.click(within(cogs).getByRole('button', { name: 'Cancel' }));
    expect(within(cogs).getByRole('radio', { name: /Per-product costs/ })).toBeChecked();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(0);
  });

  it('does not confirm when no method has been chosen yet', async () => {
    const { user } = await openWorkspace({
      [R.costs]: { json: { costs: costsState(), coverage: FIVE_SKUS } },
    });
    const cogs = section(COGS);
    await user.click(within(cogs).getByRole('radio', { name: /Blended gross margin/ }));
    expect(within(cogs).queryByText(/Switch to/)).toBeNull();
    expect(within(cogs).getByRole('textbox', { name: 'Blended gross margin' }))
      .toBeInTheDocument();
  });

  it('marks the stored method as active and describes the other as retained',
    async () => {
      const { user } = await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'blended', blendedMarginPct: '62.55' }),
            coverage: FIVE_SKUS,
          },
        },
      });
      const cogs = section(COGS);
      expect(within(cogs).getByRole('radio', { name: /Blended gross margin.*Active/ }))
        .toBeChecked();
      expect(within(cogs).getByRole('textbox', { name: 'Blended gross margin' }))
        .toHaveValue('62.55');

      await user.click(within(cogs).getByRole('radio', { name: /Per-product costs/ }));
      await user.click(within(cogs).getByRole('button', { name: 'Switch method' }));
      expect(await within(cogs).findByText(
        /Blended gross margin is the active method, so these costs are retained but not used/,
      )).toBeInTheDocument();
    });

  describe('blended gross margin', () => {
    const BLENDED = {
      [R.costs]: { json: { costs: costsState({ cogsMethod: 'blended' }), coverage: FIVE_SKUS } },
    };

    it('is available with no currency, because it is a percentage', async () => {
      await openWorkspace({ ...BLENDED, [R.currency]: { json: CURRENCY_UNKNOWN } });
      const cogs = section(COGS);
      const field = within(cogs).getByRole('textbox', { name: 'Blended gross margin' });
      expect(field).toBeEnabled();
      expect(within(cogs).getByRole('button', { name: 'Save gross margin' })).toBeEnabled();
      expect(within(cogs).getByText(/no currency is needed/i)).toBeInTheDocument();
    });

    it('is shown as a percentage and never with a currency code', async () => {
      await openWorkspace(BLENDED);
      const cogs = section(COGS);
      expect(within(cogs).getByText('%')).toBeInTheDocument();
      // The FIELD's label, not the radio's — neither carries a currency code,
      // because a margin is a percentage.
      const field = within(cogs).getByRole('textbox', { name: 'Blended gross margin' });
      const label = cogs.querySelector(`label[for="${field.id}"]`);
      expect(label).not.toBeNull();
      expect(label!.textContent).not.toContain('USD');
    });

    it.each([
      ['0', 'Gross margin must be greater than 0 and less than 100.'],
      ['100', 'Gross margin must be greater than 0 and less than 100.'],
      ['62.555', 'Enter a percentage with at most two decimal places.'],
    ])('refuses %s without a request', async (value, message) => {
      const { user } = await openWorkspace(BLENDED);
      const cogs = section(COGS);
      await user.type(within(cogs).getByRole('textbox', { name: 'Blended gross margin' }), value);
      await user.click(within(cogs).getByRole('button', { name: 'Save gross margin' }));
      expect(await within(cogs).findByText(message)).toBeInTheDocument();
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(0);
    });

    it('refuses a blank value without treating it as zero', async () => {
      const { user } = await openWorkspace(BLENDED);
      const cogs = section(COGS);
      await user.click(within(cogs).getByRole('button', { name: 'Save gross margin' }));
      expect(await within(cogs).findByText('Enter a gross margin percentage.')).toBeInTheDocument();
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(0);
    });

    it('saves a valid margin and refetches costs and RCM readiness', async () => {
      const { user } = await openWorkspace({
        ...BLENDED,
        [R.saveCosts]: { json: { method: 'blended', blendedMarginPct: 62.5 } },
      });
      const cogs = section(COGS);
      await user.type(within(cogs).getByRole('textbox', { name: 'Blended gross margin' }), '62.5');
      await user.click(within(cogs).getByRole('button', { name: 'Save gross margin' }));

      await waitFor(() => {
        expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(1);
      });
      const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/costs'))!;
      expect(JSON.parse(call.body!)).toEqual({ method: 'blended', blendedMarginPct: 62.5 });
      await waitFor(() => {
        expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(2);
      });
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
      expect(await within(section(COGS)).findByText('Gross margin saved.')).toBeInTheDocument();
    });
  });

  describe('per-SKU costs', () => {
    const PER_SKU = {
      [R.costs]: { json: { costs: costsState({ cogsMethod: 'per_sku' }), coverage: FIVE_SKUS } },
    };

    it('lists the required set in the backend order', async () => {
      await openWorkspace(PER_SKU);
      const cogs = section(COGS);
      const labels = within(cogs).getAllByText(/^SYN-[A-E]$/).map((el) => el.textContent);
      // Highest revenue first, exactly as returned — never re-sorted here.
      expect(labels).toEqual(['SYN-A', 'SYN-B']);
    });

    it('prefills a saved cost as its stored decimal string', async () => {
      await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({ required: [sku('SYN-A', 1000, 400.00)] }),
          },
        },
      });
      const cogs = section(COGS);
      // "400.00", not "400" — no float round trip anywhere.
      expect(within(cogs).getByLabelText('SYN-A')).toHaveValue('400.00');
      expect(within(cogs).getByText('Saved: 400.00 USD')).toBeInTheDocument();
    });

    it('requires a currency before an amount can be submitted', async () => {
      await openWorkspace({ ...PER_SKU, [R.currency]: { json: CURRENCY_UNKNOWN } });
      const cogs = section(COGS);
      expect(within(cogs).getByText(/Set the account currency above before entering product costs/))
        .toBeInTheDocument();
      expect(within(cogs).getByLabelText('SYN-A')).toBeDisabled();
      expect(within(cogs).getByRole('button', { name: 'Save product costs' })).toBeDisabled();
    });

    it('saves only the rows that were filled in', async () => {
      const { user } = await openWorkspace({
        ...PER_SKU,
        [R.saveCosts]: { json: { method: 'per_sku', written: 1, coverage: FIVE_SKUS } },
      });
      const cogs = section(COGS);
      await user.type(within(cogs).getByLabelText('SYN-A'), '2000');
      await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));

      await waitFor(() => {
        expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(1);
      });
      const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/costs'))!;
      // SYN-B was left blank and is simply absent — NOT sent as zero.
      expect(JSON.parse(call.body!)).toEqual({
        method: 'per_sku',
        skus: [{ sku: 'SYN-A', cogs: '2000.00' }],
      });
    });

    it('treats a blank row as unanswered rather than zero', async () => {
      const { user } = await openWorkspace(PER_SKU);
      const cogs = section(COGS);
      await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));
      expect(await within(cogs).findByText('Enter a cost for at least one product before saving.'))
        .toBeInTheDocument();
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(0);
    });

    it('requires an explicit confirmation for a zero cost, per row', async () => {
      const { user } = await openWorkspace(PER_SKU);
      const cogs = section(COGS);
      await user.type(within(cogs).getByLabelText('SYN-A'), '0');

      // The checkbox appears only because the amount is exactly zero, and is not
      // pre-ticked.
      const confirm = await within(cogs).findByLabelText(
        /Confirm the true cost of SYN-A really is zero/,
      );
      expect(confirm).not.toBeChecked();

      await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));
      expect(await within(cogs).findByText(
        'Confirm that the true cost of SYN-A is zero, or enter a cost.',
      )).toBeInTheDocument();
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(0);
    });

    it('sends zeroConfirmed once the row is confirmed', async () => {
      const { user } = await openWorkspace({
        ...PER_SKU,
        [R.saveCosts]: { json: { method: 'per_sku', written: 1, coverage: FIVE_SKUS } },
      });
      const cogs = section(COGS);
      await user.type(within(cogs).getByLabelText('SYN-A'), '0');
      await user.click(await within(cogs).findByLabelText(/Confirm the true cost of SYN-A/));
      await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));

      await waitFor(() => {
        expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(1);
      });
      const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/costs'))!;
      expect(JSON.parse(call.body!)).toEqual({
        method: 'per_sku',
        skus: [{ sku: 'SYN-A', cogs: '0.00', zeroConfirmed: true }],
      });
    });

    it('drops a zero confirmation when the amount moves away from zero', async () => {
      const { user } = await openWorkspace(PER_SKU);
      const cogs = section(COGS);
      const field = within(cogs).getByLabelText('SYN-A');
      await user.type(field, '0');
      await user.click(await within(cogs).findByLabelText(/Confirm the true cost of SYN-A/));
      await user.clear(field);
      await user.type(field, '25');
      // The confirmation was given for 0; it must not ride along with 25.
      expect(within(cogs).queryByLabelText(/Confirm the true cost of SYN-A/)).toBeNull();
    });

    it.each([
      ['-5', 'A cost cannot be negative.'],
      ['1.234', 'Use at most two decimal places.'],
      ['abc', 'Enter a cost as a plain number, with no currency symbol or separators.'],
    ])('refuses %s without a request', async (value, message) => {
      const { user } = await openWorkspace(PER_SKU);
      const cogs = section(COGS);
      await user.type(within(cogs).getByLabelText('SYN-A'), value);
      await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));
      expect(await within(cogs).findByText(message)).toBeInTheDocument();
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(0);
    });

    it('shows the actual coverage percentage from the backend', async () => {
      await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({
              required: [sku('SYN-A', 5000, 2000.00), sku('SYN-B', 3000)],
              all: [sku('SYN-A', 5000, 2000.00), sku('SYN-B', 3000), sku('SYN-C', 2000)],
            }),
          },
        },
      });
      const cogs = section(COGS);
      // 5000 of 10000 = 50%, which the backend computed. Not "1 of 3 rows filled".
      expect(within(cogs).getByText('50.0%')).toBeInTheDocument();
      expect(within(cogs).getByText(/Below the 80% target/)).toBeInTheDocument();
    });

    it('never presents the ratio operands as revenue figures', async () => {
      await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({ required: [sku('SYN-A', 12345, 1.00)] }),
          },
        },
      });
      const cogs = section(COGS);
      // eligibleLineRevenue / costedRevenue are line-item values, not net sales.
      // Showing either as "revenue" would put a number on screen that disagrees
      // with Shopify.
      expect(cogs).not.toHaveTextContent('12345');
      expect(cogs).not.toHaveTextContent(/net revenue/i);
      expect(cogs).not.toHaveTextContent(/net sales/i);
      expect(cogs).not.toHaveTextContent(/total revenue/i);
    });

    it('shows no success state below the target even with every row filled', async () => {
      const twenty = Array.from({ length: 20 }, (_, i) =>
        sku(`SYN-${String(i).padStart(2, '0')}`, 100, 40.00));
      const ten = Array.from({ length: 10 }, (_, i) =>
        sku(`SYN-X${String(i).padStart(2, '0')}`, 100));
      await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({ required: twenty, all: [...twenty, ...ten], cappedBelowTarget: true }),
          },
        },
      });
      const cogs = section(COGS);
      expect(within(cogs).getByText('66.7%')).toBeInTheDocument();
      expect(within(cogs).getByText(/Below the 80% target/)).toBeInTheDocument();
      expect(cogs).not.toHaveTextContent('The 80% target is met.');
      // No required SKU is missing, and that still is not completeness.
      expect(cogs).not.toHaveTextContent(/still.*no cost/);
    });

    it('explains the capped case and opens the additional products', async () => {
      const twenty = Array.from({ length: 20 }, (_, i) =>
        sku(`SYN-${String(i).padStart(2, '0')}`, 100));
      const extra = [sku('SYN-EXTRA-1', 100), sku('SYN-EXTRA-2', 100)];
      const { user } = await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({
              required: twenty, all: [...twenty, ...extra], cappedBelowTarget: true,
            }),
          },
        },
      });
      const cogs = section(COGS);
      expect(within(cogs).getByText(/These 20 products cannot reach the target on their own/))
        .toBeInTheDocument();
      expect(within(cogs).getByText(/come to less than 80% of eligible product value/))
        .toBeInTheDocument();

      // The additional list is collapsed, searchable, and lets costs be entered
      // beyond the initial twenty.
      await user.click(within(cogs).getByRole('button', { name: /Show additional products \(2\)/ }));
      expect(await within(cogs).findByLabelText('SYN-EXTRA-1')).toBeInTheDocument();
      await user.type(within(cogs).getByLabelText('Search products'), 'EXTRA-2');
      expect(within(cogs).queryByLabelText('SYN-EXTRA-1')).toBeNull();
      expect(within(cogs).getByLabelText('SYN-EXTRA-2')).toBeInTheDocument();
    });

    it('submits a cost entered for a SKU beyond the required set', async () => {
      const twenty = Array.from({ length: 20 }, (_, i) =>
        sku(`SYN-${String(i).padStart(2, '0')}`, 100));
      const { user } = await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({
              required: twenty, all: [...twenty, sku('SYN-EXTRA', 100)], cappedBelowTarget: true,
            }),
          },
        },
        [R.saveCosts]: { json: { method: 'per_sku', written: 1, coverage: FIVE_SKUS } },
      });
      const cogs = section(COGS);
      await user.click(within(cogs).getByRole('button', { name: /Show additional products/ }));
      await user.type(await within(cogs).findByLabelText('SYN-EXTRA'), '40');
      await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));

      await waitFor(() => {
        expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs`)).toBe(1);
      });
      const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/costs'))!;
      expect(JSON.parse(call.body!)).toEqual({
        method: 'per_sku', skus: [{ sku: 'SYN-EXTRA', cogs: '40.00' }],
      });
    });

    it('warns about unconfirmed zero costs the backend reported', async () => {
      await openWorkspace({
        [R.costs]: {
          json: {
            costs: costsState({ cogsMethod: 'per_sku' }),
            coverage: coverage({ required: [sku('SYN-A', 1000, 0.00, false)] }),
          },
        },
      });
      expect(await within(section(COGS)).findByText(
        /1 product recorded at zero cost without confirmation/,
      )).toBeInTheDocument();
    });

    it('shows a neutral waiting state and invents no rows when there is no SKU data',
      async () => {
        await openWorkspace({
          [R.costs]: { json: { costs: costsState({ cogsMethod: 'per_sku' }), coverage: coverage({ required: [] }) } },
        });
        const cogs = section(COGS);
        expect(within(cogs).getByText(/Waiting for Shopify product and order data/))
          .toBeInTheDocument();
        expect(within(cogs).getByText(/A blended gross margin can be entered now instead/))
          .toBeInTheDocument();
        // No fabricated rows, and no percentage claiming anything.
        expect(within(cogs).queryByRole('textbox')).toBeNull();
        expect(cogs).not.toHaveTextContent('0.0%');
      });

    it('maps an unknown-SKU refusal to a safe message that names no other account',
      async () => {
        const { user } = await openWorkspace({
          ...PER_SKU,
          [R.saveCosts]: {
            status: 400,
            json: {
              ok: false, error: 'unknown_skus', skus: ['SYN-A'],
              message: "These SKUs are not in this account's order history: SYN-A",
            },
          },
        });
        const cogs = section(COGS);
        await user.type(within(cogs).getByLabelText('SYN-A'), '10');
        await user.click(within(cogs).getByRole('button', { name: 'Save product costs' }));
        expect(await within(cogs).findByText(
          /is not in this brand’s own order history, so nothing was saved/,
        )).toBeInTheDocument();
        expect(cogs).not.toHaveTextContent(/another account/i);
        expect(cogs).not.toHaveTextContent(/account \d/);
      });
  });
});

// ===========================================================================
// OCAS
// ===========================================================================
describe('the operating-cost control', () => {
  it('is labelled clearly and shows the currency code inline', async () => {
    await openWorkspace();
    const ocas = section(OCAS);
    expect(within(ocas).getByLabelText('Monthly operating cost allocation (USD)'))
      .toBeInTheDocument();
  });

  it('prefills the stored amount as its decimal string', async () => {
    await openWorkspace({
      [R.costs]: { json: { costs: costsState({ ocasMonthly: '1500.00' }), coverage: coverage({ required: [] }) } },
    });
    const ocas = section(OCAS);
    expect(within(ocas).getByLabelText(/Monthly operating cost allocation/)).toHaveValue('1500.00');
    expect(within(ocas).getByText('1500.00 USD')).toBeInTheDocument();
  });

  it('shows "not configured" rather than a zero when nothing is stored', async () => {
    await openWorkspace();
    const ocas = section(OCAS);
    expect(within(ocas).getByText('Not configured yet.')).toBeInTheDocument();
    expect(within(ocas).getByLabelText(/Monthly operating cost allocation/)).toHaveValue('');
  });

  it('prefills a stored confirmed zero, including its confirmation', async () => {
    await openWorkspace({
      [R.costs]: {
        json: {
          costs: costsState({ ocasMonthly: '0.00', ocasZeroConfirmed: true }),
          coverage: coverage({ required: [] }),
        },
      },
    });
    const ocas = section(OCAS);
    expect(within(ocas).getByText(/zero, explicitly confirmed/)).toBeInTheDocument();
    expect(within(ocas).getByLabelText(/the true monthly operating cost allocation for this brand is zero/))
      .toBeChecked();
  });

  it('requires a currency before an amount can be submitted', async () => {
    await openWorkspace({ [R.currency]: { json: CURRENCY_UNKNOWN } });
    const ocas = section(OCAS);
    expect(within(ocas).getByText(/Set the account currency above/)).toBeInTheDocument();
    expect(within(ocas).getByLabelText(/Monthly operating cost allocation/)).toBeDisabled();
  });

  it('refuses a blank field and says plainly that it is not zero', async () => {
    const { user } = await openWorkspace();
    const ocas = section(OCAS);
    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));
    expect(await within(ocas).findByText(
      'Enter a monthly operating cost. An empty field is not the same as zero.',
    )).toBeInTheDocument();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(0);
  });

  it('shows the zero confirmation only for an amount of exactly zero', async () => {
    const { user } = await openWorkspace();
    const ocas = section(OCAS);
    const field = within(ocas).getByLabelText(/Monthly operating cost allocation/);
    const zeroLabel = /the true monthly operating cost allocation for this brand is zero/;

    expect(within(ocas).queryByLabelText(zeroLabel)).toBeNull();
    await user.type(field, '100');
    expect(within(ocas).queryByLabelText(zeroLabel)).toBeNull();
    await user.clear(field);
    await user.type(field, '0');
    expect(await within(ocas).findByLabelText(zeroLabel)).not.toBeChecked();
  });

  it('requires the confirmation before a zero is sent', async () => {
    const { user } = await openWorkspace();
    const ocas = section(OCAS);
    await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), '0');
    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));
    expect(await within(ocas).findByText(
      'To record zero, confirm that the true monthly operating cost allocation really is zero.',
    )).toBeInTheDocument();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(0);
  });

  it('sends confirmedZero once the confirmation is ticked', async () => {
    const { user } = await openWorkspace({
      [R.saveOcas]: { json: { ocasMonthly: 0, confirmedZero: true } },
    });
    const ocas = section(OCAS);
    await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), '0');
    await user.click(await within(ocas).findByLabelText(ZERO_OCAS_LABEL));
    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));

    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(1);
    });
    const call = calls.find((c) => c.url.endsWith('/costs/ocas'))!;
    expect(JSON.parse(call.body!)).toEqual({ ocasMonthly: '0.00', confirmedZero: true });
  });

  it('clears a ticked confirmation when the amount changes away from zero', async () => {
    const { user } = await openWorkspace({
      [R.saveOcas]: { json: { ocasMonthly: 4500, confirmedZero: false } },
    });
    const ocas = section(OCAS);
    const field = within(ocas).getByLabelText(/Monthly operating cost allocation/);
    await user.type(field, '0');
    await user.click(await within(ocas).findByLabelText(ZERO_OCAS_LABEL));
    await user.clear(field);
    await user.type(field, '4500');
    expect(within(ocas).queryByLabelText(ZERO_OCAS_LABEL)).toBeNull();

    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));
    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(1);
    });
    const call = calls.find((c) => c.url.endsWith('/costs/ocas'))!;
    // A confirmation given for 0 must not survive onto 4500.
    expect(JSON.parse(call.body!)).toEqual({ ocasMonthly: '4500.00' });
  });

  it.each([
    ['-1', 'An operating cost cannot be negative.'],
    ['1.234', 'Use at most two decimal places.'],
    ['lots', 'Enter a operating cost as a plain number, with no currency symbol or separators.'],
  ])('refuses %s without a request', async (value, message) => {
    const { user } = await openWorkspace();
    const ocas = section(OCAS);
    await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), value);
    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));
    expect(await within(ocas).findByText(message)).toBeInTheDocument();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(0);
  });

  it('blocks a duplicate submission while one is in flight', async () => {
    // The route never answers, so the first write STAYS in flight — which is the
    // only state in which a duplicate is possible. Clicking three times against a
    // settled form is three legitimate saves, not a double-submit, so testing it
    // that way would assert nothing.
    const { user } = await openWorkspace({ [R.saveOcas]: PENDING });
    const ocas = section(OCAS);
    await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), '100');
    const button = within(ocas).getByRole('button', { name: 'Save operating cost' });
    await user.click(button);
    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(1);
    });

    // The button reports itself busy, and further clicks send nothing.
    expect(within(ocas).getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
    await user.click(within(ocas).getByRole('button', { name: 'Saving…' }));
    await user.click(within(ocas).getByRole('button', { name: 'Saving…' }));
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(1);
  });

  it('refetches the costs resource and RCM readiness after a save', async () => {
    const { user } = await openWorkspace({
      [R.saveOcas]: { json: { ocasMonthly: 100, confirmedZero: false } },
    });
    const ocas = section(OCAS);
    await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), '100');
    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));

    await waitFor(() => {
      expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`))
        .toBeGreaterThanOrEqual(2);
    });
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/costs/ocas`)).toBe(1);
    // "At least twice" because two components observe the costs query; how many
    // refetches TanStack coalesces that into is its business, not this contract's.
    expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/costs`)).toBeGreaterThanOrEqual(2);
  });

  it('builds no annual, category or accounting-integration control', async () => {
    await openWorkspace();
    const ocas = section(OCAS);
    expect(ocas).not.toHaveTextContent(/annual/i);
    expect(ocas).not.toHaveTextContent(/quickbooks|xero|netsuite/i);
    expect(within(ocas).queryByRole('button', { name: /add category/i })).toBeNull();
  });
});

// ===========================================================================
// Ad spend
// ===========================================================================
describe('the advertising-spend control', () => {
  const THREE_MONTHS = adSpendCoverage({
    firstOrderMonth: '2026-05-01',
    windowStart: '2026-05-01',
    currentMonth: '2026-08-01',
    requiredMonths: ['2026-05-01', '2026-06-01', '2026-08-01'],
  });

  const WITH_WINDOW = { [R.adSpend]: { json: { ...AD_SPEND_EMPTY, coverage: THREE_MONTHS } } };

  it('shows the window, the required months and what is missing', async () => {
    await openWorkspace(WITH_WINDOW);
    const adSpend = section(AD_SPEND);
    // "May 2026" is both the first-order month and a zero-confirmation checkbox
    // label, so it legitimately appears more than once.
    expect(within(adSpend).getAllByText('May 2026').length).toBeGreaterThan(0);
    expect(within(adSpend).getByText(/May 2026 – August 2026/)).toBeInTheDocument();
    expect(within(adSpend).getByText(/3 months required/)).toBeInTheDocument();
    expect(within(adSpend).getByText('May 2026, Jun 2026, Aug 2026')).toBeInTheDocument();
    expect(within(adSpend).getByText(/only months with at least one first-time customer/))
      .toBeInTheDocument();
  });

  it('formats months without drifting to the previous one', async () => {
    await openWorkspace({
      [R.adSpend]: {
        json: {
          ...AD_SPEND_EMPTY,
          rows: [{ month: '2026-03-01', channel: 'Meta', spend: '100.00', source: 'manual' }],
          coverage: adSpendCoverage({
            firstOrderMonth: '2026-03-01', windowStart: '2026-03-01', currentMonth: '2026-08-01',
            requiredMonths: ['2026-03-01'], coveredMonths: ['2026-03-01'],
          }),
        },
      },
    });
    const adSpend = section(AD_SPEND);
    // 2026-03-01 parsed as a Date would render as February in Los Angeles, which is
    // this suite's configured account timezone.
    expect(within(adSpend).getByText('March 2026')).toBeInTheDocument();
    expect(adSpend).not.toHaveTextContent('February 2026');
    expect(adSpend).not.toHaveTextContent('Feb 2026');
  });

  it('shows a distinct state when no month is required', async () => {
    await openWorkspace();
    const adSpend = section(AD_SPEND);
    expect(within(adSpend).getByText(/No advertising spend is required for this brand yet/))
      .toBeInTheDocument();
    expect(within(adSpend).getByText(/There is no eligible order history yet/))
      .toBeInTheDocument();
    // And no zero-confirmation form, because there is nothing to confirm.
    expect(within(adSpend).queryByText('Confirm zero-spend months')).toBeNull();
  });

  it('explains the young-brand case rather than asking for months before trading',
    async () => {
      await openWorkspace({
        [R.adSpend]: {
          json: {
            ...AD_SPEND_EMPTY,
            coverage: adSpendCoverage({
              firstOrderMonth: '2026-07-01', windowStart: '2026-07-01', currentMonth: '2026-08-01',
              requiredMonths: ['2026-07-01', '2026-08-01'],
            }),
          },
        },
      });
      const adSpend = section(AD_SPEND);
      expect(within(adSpend).getByText(/July 2026 – August 2026/)).toBeInTheDocument();
      expect(within(adSpend).getByText(/2 months required/)).toBeInTheDocument();
      expect(adSpend).not.toHaveTextContent('Jun 2026');
    });

  it('saves a positive single-month range with no accountId in the body', async () => {
    const { user } = await openWorkspace({
      ...WITH_WINDOW,
      [R.saveAdSpend]: { json: { monthsWritten: 1, rowsWritten: 1, zeroConfirmationsCleared: 0 } },
    });
    const adSpend = section(AD_SPEND);
    await user.type(within(adSpend).getByLabelText('Channel'), 'Meta');
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '1000');
    await user.type(within(adSpend).getByLabelText('From month'), '2026-05');
    await user.type(within(adSpend).getByLabelText('To month'), '2026-05');
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));

    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(1);
    });
    const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/ad-spend'))!;
    expect(JSON.parse(call.body!)).toEqual({
      rows: [{
        channel: 'Meta', amount: '1000.00', startMonth: '2026-05-01', endMonth: '2026-05-01',
      }],
    });
    expect(call.body).not.toMatch(/account_?[iI]d/);
  });

  it('saves a multi-month range and says the amount applies to every month', async () => {
    const { user } = await openWorkspace({
      ...WITH_WINDOW,
      [R.saveAdSpend]: { json: { monthsWritten: 2, rowsWritten: 2, zeroConfirmationsCleared: 0 } },
    });
    const adSpend = section(AD_SPEND);
    expect(within(adSpend).getByText(/the same monthly amount to every month it covers/))
      .toBeInTheDocument();

    await user.type(within(adSpend).getByLabelText('Channel'), 'Google');
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '500.50');
    await user.type(within(adSpend).getByLabelText('From month'), '2026-05');
    await user.type(within(adSpend).getByLabelText('To month'), '2026-06');
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));

    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(1);
    });
    const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/ad-spend'))!;
    expect(JSON.parse(call.body!).rows[0]).toEqual({
      channel: 'Google', amount: '500.50', startMonth: '2026-05-01', endMonth: '2026-06-01',
    });
  });

  it('offers suggested channels while still accepting free text', async () => {
    const { user } = await openWorkspace({
      ...WITH_WINDOW,
      [R.saveAdSpend]: { json: { monthsWritten: 1, rowsWritten: 1, zeroConfirmationsCleared: 0 } },
    });
    const adSpend = section(AD_SPEND);
    const field = within(adSpend).getByLabelText('Channel');
    // A datalist, not a closed select: the brand's real channel mix is not this
    // platform's to define.
    expect(field.getAttribute('list')).toBeTruthy();
    expect(within(adSpend).getByText(/any name up to 64 characters is accepted/))
      .toBeInTheDocument();

    await user.type(field, 'Synthetic Podcast Sponsorship');
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '10');
    await user.type(within(adSpend).getByLabelText('From month'), '2026-05');
    await user.type(within(adSpend).getByLabelText('To month'), '2026-05');
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));
    await waitFor(() => {
      expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(1);
    });
    const call = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/ad-spend'))!;
    expect(JSON.parse(call.body!).rows[0].channel).toBe('Synthetic Podcast Sponsorship');
  });

  it('refuses a zero amount and points at the dedicated flow', async () => {
    const { user } = await openWorkspace(WITH_WINDOW);
    const adSpend = section(AD_SPEND);
    await user.type(within(adSpend).getByLabelText('Channel'), 'Meta');
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '0');
    await user.type(within(adSpend).getByLabelText('From month'), '2026-05');
    await user.type(within(adSpend).getByLabelText('To month'), '2026-05');
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));

    expect(await within(adSpend).findByText(
      /A zero-spend month cannot be entered as an amount/,
    )).toBeInTheDocument();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(0);
  });

  it.each([
    ['a future month', { start: '2026-08', end: '2026-09' }, 'Spend cannot be recorded for a future month.'],
    ['a reversed range', { start: '2026-06', end: '2026-05' }, 'The start month cannot be after the end month.'],
  ])('refuses %s without a request', async (_label, range, message) => {
    const { user } = await openWorkspace(WITH_WINDOW);
    const adSpend = section(AD_SPEND);
    await user.type(within(adSpend).getByLabelText('Channel'), 'Meta');
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '10');
    await user.type(within(adSpend).getByLabelText('From month'), range.start);
    await user.type(within(adSpend).getByLabelText('To month'), range.end);
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));
    expect(await within(adSpend).findByText(message)).toBeInTheDocument();
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(0);
  });

  it('refuses a blank channel and an over-long one', async () => {
    const { user } = await openWorkspace(WITH_WINDOW);
    const adSpend = section(AD_SPEND);
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '10');
    await user.type(within(adSpend).getByLabelText('From month'), '2026-05');
    await user.type(within(adSpend).getByLabelText('To month'), '2026-05');
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));
    expect(await within(adSpend).findByText('Enter a channel name.')).toBeInTheDocument();

    // The field itself caps the length, so an over-long value cannot be typed.
    expect(within(adSpend).getByLabelText('Channel')).toHaveAttribute('maxlength', '64');
    expect(callCountFor('PUT', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(0);
  });

  it('maps the backend overlap refusal to a fixed sentence', async () => {
    const { user } = await openWorkspace({
      ...WITH_WINDOW,
      [R.saveAdSpend]: {
        status: 400,
        json: { ok: false, error: 'overlapping_rows', message: 'Meta: 2026-05 appears twice.' },
      },
    });
    const adSpend = section(AD_SPEND);
    await user.type(within(adSpend).getByLabelText('Channel'), 'Meta');
    await user.type(within(adSpend).getByLabelText('Monthly amount (USD)'), '10');
    await user.type(within(adSpend).getByLabelText('From month'), '2026-05');
    await user.type(within(adSpend).getByLabelText('To month'), '2026-05');
    await user.click(within(adSpend).getByRole('button', { name: 'Save spend' }));

    expect(await within(adSpend).findByText(
      /Each channel can have one amount per month/,
    )).toBeInTheDocument();
    expect(adSpend).not.toHaveTextContent('Meta: 2026-05 appears twice.');
  });

  it('lists existing rows with their currency code and read-only source', async () => {
    await openWorkspace({
      [R.adSpend]: {
        json: {
          ...AD_SPEND_EMPTY,
          rows: [
            { month: '2026-06-01', channel: 'Meta', spend: '1000.00', source: 'manual' },
            { month: '2026-05-01', channel: 'Google', spend: '250.50', source: 'manual' },
          ],
          coverage: THREE_MONTHS,
        },
      },
    });
    const table = within(section(AD_SPEND)).getByRole('table');
    expect(within(table).getByText('Jun 2026')).toBeInTheDocument();
    // "1000.00 USD", not "1000" — the stored string, shown as stored.
    expect(within(table).getByText('1000.00 USD')).toBeInTheDocument();
    expect(within(table).getByText('250.50 USD')).toBeInTheDocument();
    expect(within(table).getAllByText('manual')).toHaveLength(2);
    // Source is read-only: no control to change it.
    expect(within(table).queryByRole('combobox')).toBeNull();
  });

  it('offers no delete action for a spend row', async () => {
    await openWorkspace({
      [R.adSpend]: {
        json: {
          ...AD_SPEND_EMPTY,
          rows: [{ month: '2026-06-01', channel: 'Meta', spend: '1000.00', source: 'manual' }],
          coverage: THREE_MONTHS,
        },
      },
    });
    const adSpend = section(AD_SPEND);
    // No general delete endpoint exists, so a delete button would be one that
    // cannot work.
    expect(within(adSpend).queryByRole('button', { name: /delete|remove/i })).toBeNull();
    expect(within(adSpend).getByText(/Individual rows cannot be deleted/)).toBeInTheDocument();
  });

  it('states that saving spend clears a zero confirmation', async () => {
    await openWorkspace(WITH_WINDOW);
    expect(within(section(AD_SPEND)).getByText(/removes that zero confirmation/))
      .toBeInTheDocument();
  });

  it('builds no ad-platform, aggregator, CSV or daily-spend control', async () => {
    await openWorkspace(WITH_WINDOW);
    const adSpend = section(AD_SPEND);
    expect(adSpend).not.toHaveTextContent(/connect meta|connect google|connect tiktok/i);
    expect(adSpend).not.toHaveTextContent(/aggregator|funnel\.io|supermetrics/i);
    expect(adSpend).not.toHaveTextContent(/csv|import|upload/i);
    expect(adSpend).not.toHaveTextContent(/daily spend|attribution/i);
    expect(within(adSpend).queryByRole('button', { name: /connect/i })).toBeNull();
  });

  describe('the explicit zero-spend flow', () => {
    it('requires both a month selection and the confirmation', async () => {
      const { user } = await openWorkspace(WITH_WINDOW);
      const adSpend = section(AD_SPEND);
      await user.click(within(adSpend).getByRole('button', { name: 'Confirm zero spend' }));
      expect(await within(adSpend).findByText('Select at least one month.')).toBeInTheDocument();
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/ad-spend/zero`)).toBe(0);

      await user.click(within(adSpend).getByLabelText('May 2026'));
      await user.click(within(adSpend).getByRole('button', { name: 'Confirm zero spend' }));
      expect(await within(adSpend).findByText(
        'Confirm that the true advertising spend for these months was zero.',
      )).toBeInTheDocument();
      expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/ad-spend/zero`)).toBe(0);
    });

    it('sends confirmedZero and omits replace on the first request', async () => {
      const { user } = await openWorkspace({
        ...WITH_WINDOW,
        [R.zeroAdSpend]: { json: { ok: true, monthsConfirmed: 1, spendRowsRemoved: 0 } },
      });
      const adSpend = section(AD_SPEND);
      await user.click(within(adSpend).getByLabelText('May 2026'));
      await user.click(within(adSpend).getByLabelText(/The true advertising spend for these months was zero/));
      await user.click(within(adSpend).getByRole('button', { name: 'Confirm zero spend' }));

      await waitFor(() => {
        expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/ad-spend/zero`)).toBe(1);
      });
      const call = calls.find((c) => c.url.endsWith('/ad-spend/zero'))!;
      expect(JSON.parse(call.body!)).toEqual({
        months: ['2026-05-01'], confirmedZero: true,
      });
      expect(call.body).not.toContain('replace');
    });

    describe('when a month already has spend', () => {
      const CONFLICT_ROUTES = {
        ...WITH_WINDOW,
        [R.zeroAdSpend]: (attempt: number) => (attempt === 0
          ? {
            status: 409,
            json: {
              ok: false, error: 'requires_replace', months: ['2026-05-01'],
              message: 'Spend is already recorded for 2026-05. Confirm that you want to replace it.',
            },
          }
          : { json: { ok: true, monthsConfirmed: 1, spendRowsRemoved: 2 } }),
      };

      async function reachConflict() {
        const result = await openWorkspace(CONFLICT_ROUTES);
        const adSpend = section(AD_SPEND);
        await result.user.click(within(adSpend).getByLabelText('May 2026'));
        await result.user.click(
          within(adSpend).getByLabelText(/The true advertising spend for these months was zero/),
        );
        await result.user.click(within(adSpend).getByRole('button', { name: 'Confirm zero spend' }));
        await within(section(AD_SPEND)).findByText(/These months already have spend recorded/);
        return result;
      }

      it('names the months and states what replacement deletes', async () => {
        await reachConflict();
        const adSpend = section(AD_SPEND);
        expect(within(adSpend).getAllByText('May 2026').length).toBeGreaterThan(0);
        expect(within(adSpend).getByText(/deletes every advertising spend row recorded against/))
          .toBeInTheDocument();
        // And never renders the backend's own sentence.
        expect(adSpend).not.toHaveTextContent('Spend is already recorded for 2026-05.');
      });

      it('does not retry automatically', async () => {
        await reachConflict();
        // Exactly one request so far: the conflict is a question, not a step.
        expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/ad-spend/zero`)).toBe(1);
      });

      it('sends nothing when the replacement is cancelled', async () => {
        const { user } = await reachConflict();
        await user.click(within(section(AD_SPEND)).getByRole('button', { name: 'Cancel' }));
        expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/ad-spend/zero`)).toBe(1);
        expect(screen.queryByText(/These months already have spend recorded/)).toBeNull();
      });

      it('sends exactly one second request with replace:true when confirmed', async () => {
        const { user } = await reachConflict();
        await user.click(within(section(AD_SPEND)).getByRole('button', {
          name: 'Delete that spend and confirm zero',
        }));

        await waitFor(() => {
          expect(callCountFor('POST', `/api/accounts/${ACCOUNT_ID}/ad-spend/zero`)).toBe(2);
        });
        const second = calls.filter((c) => c.url.endsWith('/ad-spend/zero'))[1]!;
        expect(JSON.parse(second.body!)).toEqual({
          months: ['2026-05-01'], confirmedZero: true, replace: true,
        });
      });

      it('refetches coverage after a successful replacement', async () => {
        const { user } = await reachConflict();
        await user.click(within(section(AD_SPEND)).getByRole('button', {
          name: 'Delete that spend and confirm zero',
        }));
        await waitFor(() => {
          expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/ad-spend`)).toBe(2);
        });
        expect(callCountFor('GET', `/api/accounts/${ACCOUNT_ID}/onboarding/status`)).toBe(2);
      });

      it('drops the conflict when the month selection changes', async () => {
        const { user } = await reachConflict();
        await user.click(within(section(AD_SPEND)).getByLabelText('Jun 2026'));
        // The confirmation was for a different set of months.
        expect(screen.queryByText(/These months already have spend recorded/)).toBeNull();
      });
    });
  });

  describe('a contradictory month', () => {
    const CONTRADICTORY = {
      [R.adSpend]: {
        json: {
          ...AD_SPEND_EMPTY,
          rows: [{ month: '2026-05-01', channel: 'Meta', spend: '100.00', source: 'manual' }],
          coverage: adSpendCoverage({
            firstOrderMonth: '2026-05-01', windowStart: '2026-05-01', currentMonth: '2026-08-01',
            requiredMonths: ['2026-05-01'], coveredMonths: ['2026-05-01'],
            zeroConfirmedMonths: ['2026-05-01'], contradictoryMonths: ['2026-05-01'],
            missingMonths: [],
          }),
        },
      },
    };

    it('raises it as a data-integrity warning', async () => {
      await openWorkspace(CONTRADICTORY);
      const adSpend = section(AD_SPEND);
      expect(within(adSpend).getByText('Conflicting records need review')).toBeInTheDocument();
      expect(within(adSpend).getByText(/both recorded spend and a zero confirmation/))
        .toBeInTheDocument();
    });

    it('never reports coverage as complete while it stands', async () => {
      await openWorkspace(CONTRADICTORY);
      const adSpend = section(AD_SPEND);
      expect(within(adSpend).getByText(/Coverage is not complete while that is true/))
        .toBeInTheDocument();
      expect(adSpend).not.toHaveTextContent('Every required month is answered.');
    });

    it('offers both safe resolution paths rather than picking one', async () => {
      await openWorkspace(CONTRADICTORY);
      const adSpend = section(AD_SPEND);
      expect(within(adSpend).getByRole('button', { name: 'Save spend' })).toBeInTheDocument();
      expect(within(adSpend).getByRole('button', { name: 'Confirm zero spend' }))
        .toBeInTheDocument();
      expect(within(adSpend).getByText(/Resolve each month by either/)).toBeInTheDocument();
    });
  });
});

// ===========================================================================
// Session handling
// ===========================================================================
describe('session handling', () => {
  it('signs the agency out on a confirmed 401 from a financial read', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes(baseRoutes({ [R.costs]: { status: 401, json: { error: 'unauthorized' } } }));
    renderWithProviders(<AppRoutes />, { route: `/accounts/${ACCOUNT_ID}`, queryClient });

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    // The whole cache is cleared, so browser Back cannot resurrect the data.
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
    expect(queryClient.getQueryData(queryKeys.accounts.costs(ACCOUNT_ID))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.accounts.currency(ACCOUNT_ID))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.accounts.adSpend(ACCOUNT_ID))).toBeUndefined();
    // The forms are gone, not merely hidden behind an error.
    expect(screen.queryByRole('region', { name: 'Financial inputs' })).toBeNull();
    expect(screen.queryByText(EMAIL)).toBeNull();
  });

  it('signs the agency out on a 401 from a financial write', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes(baseRoutes({
      [R.saveOcas]: { status: 401, json: { error: 'unauthorized' } },
    }));
    const { user } = renderWithProviders(<AppRoutes />, {
      route: `/accounts/${ACCOUNT_ID}`, queryClient,
    });
    await screen.findByRole('region', { name: 'Financial inputs' });
    // The section heading renders before its query settles, so the field has to be
    // awaited rather than assumed.
    await within(section(OCAS)).findByLabelText(/Monthly operating cost allocation/);
    const ocas = section(OCAS);
    await user.type(within(ocas).getByLabelText(/Monthly operating cost allocation/), '100');
    await user.click(within(ocas).getByRole('button', { name: 'Save operating cost' }));

    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
  });

  it('does not sign the agency out on a network failure', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes(baseRoutes({ [R.adSpend]: { status: 503, json: {} } }));
    renderWithProviders(<AppRoutes />, { route: `/accounts/${ACCOUNT_ID}`, queryClient });

    await within(await screen.findByRole('region', { name: AD_SPEND })).findByText(
      'The server could not complete this request. Try again in a moment.',
    );
    // Still signed in, and the other sections still work.
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
    expect(screen.queryByLabelText('Email address')).toBeNull();
  });

  it('does not sign the agency out on a 409 conflict', async () => {
    const queryClient = createRetainingQueryClient();
    stubFetchRoutes(baseRoutes({
      [R.adSpend]: {
        json: {
          ...AD_SPEND_EMPTY,
          coverage: adSpendCoverage({
            firstOrderMonth: '2026-05-01', windowStart: '2026-05-01', currentMonth: '2026-08-01',
            requiredMonths: ['2026-05-01'],
          }),
        },
      },
      [R.zeroAdSpend]: {
        status: 409,
        json: { ok: false, error: 'requires_replace', months: ['2026-05-01'], message: 'x' },
      },
    }));
    const { user } = renderWithProviders(<AppRoutes />, {
      route: `/accounts/${ACCOUNT_ID}`, queryClient,
    });
    await screen.findByRole('region', { name: 'Financial inputs' });
    await within(section(AD_SPEND)).findByLabelText('May 2026');
    const adSpend = section(AD_SPEND);
    await user.click(within(adSpend).getByLabelText('May 2026'));
    await user.click(within(adSpend).getByLabelText(/The true advertising spend/));
    await user.click(within(adSpend).getByRole('button', { name: 'Confirm zero spend' }));

    await within(section(AD_SPEND)).findByText(/These months already have spend recorded/);
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.auth.me())).toEqual(USER);
  });

  it('does not resurrect financial data through browser Back after signing out',
    async () => {
      const queryClient = createRetainingQueryClient();
      stubFetchRoutes(baseRoutes({
        'POST /api/auth/logout': { status: 204 },
        [R.costs]: {
          json: { costs: costsState({ ocasMonthly: '9999.99' }), coverage: coverage({ required: [] }) },
        },
      }));
      const { user } = renderWithProviders(<AppRoutes />, {
        route: `/accounts/${ACCOUNT_ID}`, queryClient,
      });
      await screen.findByRole('region', { name: 'Financial inputs' });
      expect(await within(section(OCAS)).findByText('9999.99 USD')).toBeInTheDocument();
      await within(section(OCAS)).findByLabelText(/Monthly operating cost allocation/);

      // Unsaved input in a financial form must not survive either.
      await user.type(within(section(OCAS)).getByLabelText(/Monthly operating cost/), '1');
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      await screen.findByLabelText('Email address');

      window.history.back();
      await waitFor(() => {
        expect(screen.queryByText('9999.99 USD')).toBeNull();
      });
      expect(queryClient.getQueryData(queryKeys.accounts.costs(ACCOUNT_ID))).toBeUndefined();
    });
});

// ===========================================================================
// Account scoping
// ===========================================================================
describe('account scoping', () => {
  it('reads every financial resource under the account in the URL', async () => {
    await openWorkspace();
    for (const path of ['currency', 'costs', 'ad-spend']) {
      expect(calls.some((c) => c.url === `/api/accounts/${ACCOUNT_ID}/${path}`)).toBe(true);
      expect(calls.some((c) => c.url.includes(`/accounts/${OTHER_ACCOUNT_ID}/`))).toBe(false);
    }
  });

  it('caches each resource under its own account-scoped key', async () => {
    const { queryClient } = await openWorkspace();
    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.accounts.currency(ACCOUNT_ID))).toBeDefined();
    });
    // Nested under the account, so `accounts.all()` reaches them and another
    // account's data can never be served here.
    expect(queryKeys.accounts.currency(ACCOUNT_ID))
      .toEqual(['accounts', 'detail', ACCOUNT_ID, 'currency']);
    expect(queryClient.getQueryData(queryKeys.accounts.currency(OTHER_ACCOUNT_ID)))
      .toBeUndefined();
  });
});
