import { query } from '../db/pool.js';
import { getProviderStatuses, PROVIDERS, type ProviderStatus } from './choices.js';
import { getCurrencyState, hasCurrencyMismatch } from './currency.js';
import { getAccountCosts, getSkuCoverage, validateBlendedMargin, COGS_COVERAGE_TARGET_PCT } from './costs.js';
import { getCoverageWindow, type CoverageWindow } from './adspend.js';
import { linkLiveness, getLinkById } from './links.js';

// The two gates (D12). Deliberately TWO functions, never one mixed blocker list:
// a single list is exactly what makes limited non-Shopify onboarding impossible.
//
// Server-side validation is the only authority. A disabled button in the UI is
// never the control.

export interface Blocker {
  code: string;
  /** Safe to show a client. */
  message: string;
  /** Which wizard step resolves it, when applicable. */
  step?: string;
  /** Extra machine-readable context (e.g. the months or SKUs at fault). */
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Gate 1 — onboarding completion
// ---------------------------------------------------------------------------

export interface OnboardingSessionContext {
  linkId: number;
  /** account_id the scoped session resolved to. */
  accountId: number;
}

export interface OnboardingCompletionState {
  complete: boolean;
  blockers: Blocker[];
  providers: ProviderStatus[];
  connectedCount: number;
}

/**
 * ONBOARDING-COMPLETION BLOCKERS ONLY.
 *
 * Note what is absent: account_costs, sku_costs, ad_spend and accounts.currency
 * are never consulted. Cost data therefore cannot block completion by
 * construction rather than by a conditional — there is no branch to get wrong,
 * which is what makes limited Klaviyo-only / Recharge-only onboarding safe.
 *
 * `session` is supplied on the client path and omitted on the agency path (an
 * authenticated staff member is not acting through a link).
 */
export async function canCompleteOnboarding(
  accountId: number,
  session?: OnboardingSessionContext,
): Promise<OnboardingCompletionState> {
  const blockers: Blocker[] = [];

  const acct = await query<{ id: number }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
  if (acct.rowCount === 0) {
    return {
      complete: false,
      blockers: [{ code: 'account_not_found', message: 'This workspace no longer exists.' }],
      providers: [],
      connectedCount: 0,
    };
  }

  if (session) {
    const link = await getLinkById(session.linkId);
    if (!link) {
      blockers.push({ code: 'session_invalid', message: 'This setup session is no longer valid.' });
    } else if (link.account_id !== accountId || session.accountId !== accountId) {
      blockers.push({
        code: 'link_account_mismatch',
        message: 'This setup session is no longer valid.',
      });
    } else {
      const live = linkLiveness(link);
      if (!live.ok && live.reason === 'revoked') {
        blockers.push({ code: 'session_revoked', message: 'This setup link is no longer valid.' });
      } else if (!live.ok && live.reason === 'expired') {
        blockers.push({ code: 'session_expired', message: 'This setup link has expired.' });
      }
    }
  }

  const providers = await getProviderStatuses(accountId);
  const connected = providers.filter((p) => p.state === 'connected');

  if (connected.length === 0) {
    blockers.push({
      code: 'no_platform_connected',
      message: 'Connect at least one platform to finish setup.',
      step: 'connect',
    });
  }

  const undecided = providers.filter((p) => p.state === 'undecided');
  if (undecided.length > 0) {
    blockers.push({
      code: 'provider_undecided',
      message:
        'Tell us about every platform: connect it, or mark that you do not use it — ' +
        undecided.map((p) => p.provider).join(', '),
      step: 'connect',
      detail: { providers: undecided.map((p) => p.provider) },
    });
  }

  // Defensive: a failed verification never persists a row today (connect.ts
  // returns before the upsert, and every upsert sets status='connected'), so this
  // guards a future path that saves an unverified connection.
  const unverified = await query<{ provider: string; status: string }>(
    `SELECT provider, status FROM connections
      WHERE account_id = $1 AND status <> 'connected'`,
    [accountId],
  );
  if (unverified.rowCount && unverified.rowCount > 0) {
    blockers.push({
      code: 'connection_not_verified',
      message: `We could not verify: ${unverified.rows.map((r) => r.provider).join(', ')}`,
      step: 'connect',
      detail: { providers: unverified.rows },
    });
  }

  return { complete: blockers.length === 0, blockers, providers, connectedCount: connected.length };
}

// ---------------------------------------------------------------------------
// Gate 2 — RCM readiness (DERIVED, never stored)
// ---------------------------------------------------------------------------

export interface RevenueFoundation {
  eligibleOrders: number;
  netRevenue: number;
  newCustomers: number;
  sufficient: boolean;
}

/**
 * E1b: is there enough eligible Shopify commerce data for an RCM figure to mean
 * anything? Covers all four listed cases — no eligible orders, no eligible
 * revenue, only zero-value orders, and no usable customer+revenue foundation for
 * the RCM period.
 */
export async function getRevenueFoundation(accountId: number): Promise<RevenueFoundation> {
  const { rows } = await query<{ orders: string; net: string | null; new_customers: string }>(
    `WITH tz AS (
       SELECT COALESCE(store_timezone, 'UTC') AS name FROM accounts WHERE id = $1
     ), win AS (
       SELECT (date_trunc('month', (now() AT TIME ZONE (SELECT name FROM tz)))
               - interval '11 months')::date AS start_month
     )
     SELECT count(*)                                        AS orders,
            COALESCE(sum(o.total_net), 0)                    AS net,
            count(*) FILTER (WHERE o.is_first_order = true)  AS new_customers
       FROM orders o
      WHERE o.account_id = $1 AND o.cancelled = false AND o.test = false
        AND (o.created_at AT TIME ZONE (SELECT name FROM tz)) >= (SELECT start_month FROM win)`,
    [accountId],
  );
  const eligibleOrders = Number(rows[0]?.orders ?? 0);
  const netRevenue = Number(rows[0]?.net ?? 0);
  const newCustomers = Number(rows[0]?.new_customers ?? 0);
  return {
    eligibleOrders,
    netRevenue,
    newCustomers,
    sufficient: eligibleOrders > 0 && netRevenue > 0 && newCustomers > 0,
  };
}

export interface RcmReadiness {
  ready: boolean;
  blockers: Blocker[];
  details: {
    shopifyConnected: boolean;
    currency: string | null;
    currencySource: string | null;
    shopifyCurrencyDetected: string | null;
    cogsMethod: string | null;
    cogsCoveragePct: number | null;
    cogsCoverageTargetPct: number;
    eligibleLineRevenue: number | null;
    revenue: RevenueFoundation | null;
    adSpend: CoverageWindow | null;
  };
}

/**
 * RCM-READINESS BLOCKERS. Recomputed from live table state on every call.
 *
 * DERIVED, NOT STORED (D1/D12 decision): its inputs live in five tables that
 * change independently — connections, accounts.currency, account_costs,
 * sku_costs, ad_spend. A stored flag would need an invalidation hook on every one
 * of those write paths, and any hook ever missed would produce a confidently
 * wrong RCM tier, which is the exact failure trap #5 forbids. Phase 6 already
 * persists the authoritative per-month record in m_rcm.tier / completeness_pct.
 */
export async function getRcmReadiness(accountId: number): Promise<RcmReadiness> {
  const blockers: Blocker[] = [];
  const providers = await getProviderStatuses(accountId);
  const shopifyConnected = providers.some((p) => p.provider === 'shopify' && p.state === 'connected');

  const currencyState = await getCurrencyState(accountId);

  if (!shopifyConnected) {
    // Everything downstream depends on Shopify commerce data, so this is the only
    // blocker worth reporting — a list of ten consequences would be noise.
    blockers.push({
      code: 'shopify_not_connected',
      message: 'Connect Shopify to turn on RCM analytics.',
      step: 'connect',
    });
    return {
      ready: false,
      blockers,
      details: {
        shopifyConnected: false,
        currency: currencyState?.currency ?? null,
        currencySource: currencyState?.currency_source ?? null,
        shopifyCurrencyDetected: currencyState?.shopify_currency_detected ?? null,
        cogsMethod: null, cogsCoveragePct: null, cogsCoverageTargetPct: COGS_COVERAGE_TARGET_PCT,
        eligibleLineRevenue: null, revenue: null, adSpend: null,
      },
    };
  }

  // --- currency -----------------------------------------------------------
  if (!currencyState?.currency) {
    blockers.push({
      code: 'currency_unknown',
      message: 'We need to know this account\'s currency.',
      step: 'currency',
    });
  } else if (hasCurrencyMismatch(currencyState)) {
    blockers.push({
      code: 'currency_mismatch',
      message:
        `Shopify reports ${currencyState.shopify_currency_detected}, but the cost figures on ` +
        `file are in ${currencyState.currency}. Your account manager needs to resolve this.`,
      step: 'currency',
      detail: {
        storedCurrency: currencyState.currency,
        shopifyCurrency: currencyState.shopify_currency_detected,
        agencyOnlyResolution: true,
      },
    });
  }

  // --- revenue foundation (E1b) ------------------------------------------
  const revenue = await getRevenueFoundation(accountId);
  if (!revenue.sufficient) {
    blockers.push({
      code: 'no_eligible_revenue_data',
      message:
        'Shopify is connected, but there is not enough eligible commerce history yet ' +
        'to calculate RCM.',
      step: 'connect',
      detail: {
        eligibleOrders: revenue.eligibleOrders,
        netRevenue: revenue.netRevenue,
        newCustomers: revenue.newCustomers,
      },
    });
  }

  // --- COGS ---------------------------------------------------------------
  const costs = await getAccountCosts(accountId);
  const coverage = await getSkuCoverage(accountId);

  if (!costs.cogs_method) {
    blockers.push({
      code: 'cogs_method_not_selected',
      message: 'Choose how to record product costs: per SKU, or one blended gross margin.',
      step: 'cogs',
    });
  } else if (costs.cogs_method === 'blended') {
    const v = validateBlendedMargin(
      costs.blended_margin_pct === null ? null : Number(costs.blended_margin_pct),
    );
    if (!v.ok) {
      blockers.push({
        code: 'cogs_blended_missing_or_invalid',
        message: 'Enter a blended gross margin between 0 and 100.',
        step: 'cogs',
      });
    }
  } else {
    // per_sku
    if (coverage.all.length === 0) {
      blockers.push({
        code: 'insufficient_shopify_data_for_skus',
        message:
          'We are still importing your Shopify products, so per-SKU costs are not ready yet.',
        step: 'cogs',
      });
    } else {
      if (coverage.unconfirmedZeroSkus.length > 0) {
        blockers.push({
          code: 'cogs_per_sku_zero_unconfirmed',
          message:
            'Confirm that these product costs are genuinely zero: ' +
            coverage.unconfirmedZeroSkus.join(', '),
          step: 'cogs',
          detail: { skus: coverage.unconfirmedZeroSkus },
        });
      }
      // E2: the binding condition is REVENUE COVERAGE, not "all 20 entered".
      // Entering every displayed SKU must not yield a confident RCM result when
      // those SKUs cover too little revenue.
      if (coverage.coveragePct < COGS_COVERAGE_TARGET_PCT) {
        blockers.push({
          code: 'cogs_per_sku_incomplete',
          message:
            `Product costs currently cover ${coverage.coveragePct.toFixed(1)}% of revenue; ` +
            `${COGS_COVERAGE_TARGET_PCT}% is needed. Add costs for more SKUs, or switch to a ` +
            'blended gross margin.',
          step: 'cogs',
          detail: {
            coveragePct: coverage.coveragePct,
            targetPct: COGS_COVERAGE_TARGET_PCT,
            missingSkus: coverage.missingSkus,
            topSkusCannotReachTarget: coverage.cappedBelowTarget,
          },
        });
      }
    }
  }

  // --- OCAS ---------------------------------------------------------------
  if (costs.ocas_monthly === null) {
    blockers.push({
      code: 'ocas_missing',
      message: 'Enter your monthly operating cost allocation.',
      step: 'ocas',
    });
  } else if (Number(costs.ocas_monthly) === 0 && !costs.ocas_zero_confirmed) {
    blockers.push({
      code: 'ocas_zero_unconfirmed',
      message: 'Confirm that the true monthly operating cost allocation is zero.',
      step: 'ocas',
    });
  }

  // --- ad spend -----------------------------------------------------------
  const adSpend = await getCoverageWindow(accountId);
  if (adSpend.contradictoryMonths.length > 0) {
    blockers.push({
      code: 'contradictory_ad_spend_state',
      message: 'Some months have both recorded spend and a zero confirmation. Please review them.',
      step: 'ad_spend',
      detail: { months: adSpend.contradictoryMonths },
    });
  }
  if (adSpend.missingMonths.length > 0) {
    blockers.push({
      code: 'ad_spend_coverage_incomplete',
      message:
        `Advertising spend is missing for ${adSpend.missingMonths.length} month(s): ` +
        adSpend.missingMonths.map((m) => m.slice(0, 7)).join(', '),
      step: 'ad_spend',
      detail: { months: adSpend.missingMonths, requiredMonths: adSpend.requiredMonths },
    });
  }
  const invalidSpend = await query<{ n: string }>(
    `SELECT count(*) n FROM ad_spend WHERE account_id = $1 AND (spend IS NULL OR spend < 0)`,
    [accountId],
  );
  if (Number(invalidSpend.rows[0].n) > 0) {
    blockers.push({
      code: 'ad_spend_invalid',
      message: 'Some advertising spend values are invalid. Please review them.',
      step: 'ad_spend',
    });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    details: {
      shopifyConnected: true,
      currency: currencyState?.currency ?? null,
      currencySource: currencyState?.currency_source ?? null,
      shopifyCurrencyDetected: currencyState?.shopify_currency_detected ?? null,
      cogsMethod: costs.cogs_method,
      cogsCoveragePct: coverage.coveragePct,
      cogsCoverageTargetPct: COGS_COVERAGE_TARGET_PCT,
      eligibleLineRevenue: coverage.eligibleLineRevenue,
      revenue,
      adSpend,
    },
  };
}

/**
 * Set accounts.onboarding_complete. Only ever writes `true` — D13 requires that
 * completion never reverts, including when a platform is connected later.
 */
export async function markOnboardingComplete(accountId: number): Promise<void> {
  await query(`UPDATE accounts SET onboarding_complete = true WHERE id = $1`, [accountId]);
}

export async function isOnboardingComplete(accountId: number): Promise<boolean> {
  const { rows } = await query<{ onboarding_complete: boolean }>(
    `SELECT onboarding_complete FROM accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0]?.onboarding_complete === true;
}

/** The six UI states from D12, all derived — no status column anywhere. */
export interface UiStateFlags {
  onboardingInProgress: boolean;
  onboardingComplete: boolean;
  limitedAnalyticsAvailable: boolean;
  shopifyNotConnected: boolean;
  rcmSetupIncomplete: boolean;
  rcmReady: boolean;
  syncStillRunning: boolean;
}

export function deriveUiStates(args: {
  onboardingComplete: boolean;
  shopifyConnected: boolean;
  rcmReady: boolean;
  syncRunning: boolean;
}): UiStateFlags {
  return {
    onboardingInProgress: !args.onboardingComplete,
    onboardingComplete: args.onboardingComplete,
    limitedAnalyticsAvailable: args.onboardingComplete && !args.shopifyConnected,
    shopifyNotConnected: !args.shopifyConnected,
    rcmSetupIncomplete: args.shopifyConnected && !args.rcmReady,
    rcmReady: args.rcmReady,
    syncStillRunning: args.syncRunning,
  };
}

export { PROVIDERS };
