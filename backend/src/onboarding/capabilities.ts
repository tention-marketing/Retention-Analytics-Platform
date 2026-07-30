import { getProviderStatuses, type Provider } from './choices.js';

// Capabilities, derived from `connections` on every read (D1 / D13).
//
// Nothing is stored: connecting a platform weeks later changes the answer with no
// migration, no backfill of a capability table, and no risk of a stale flag
// claiming an analytic is available when its integration was disconnected.
//
// Phase 7 consumes this to decide what to render. Unavailable sections stay
// hidden or show a neutral connection prompt — never a broken or failed state.

export const PROVIDER_CAPABILITIES: Record<Provider, string[]> = {
  shopify: [
    'commerce_analytics',
    'customer_analytics',
    'orders',
    'products',
    'inventory',
    'cohorts',
    'repurchase_behavior',
    'commerce_retention_analytics',
    'rcm_revenue_foundation',
  ],
  klaviyo: [
    'campaign_analytics',
    'flow_analytics',
    'opens',
    'clicks',
    'conversions',
    'attributed_revenue_context',
  ],
  recharge: [
    'subscription_analytics',
    'cancellation_analytics',
    'charge_analytics',
    'subscriber_behavior',
    'churn_analytics',
  ],
};

export interface CapabilitiesResult {
  connected: Provider[];
  skipped: Provider[];
  requested: Provider[];
  undecided: Provider[];
  /** Flat list of everything the connected platforms enable. */
  available: string[];
  /** Capabilities that a not-connected platform would enable, and which one. */
  unavailable: { capability: string; requiresProvider: Provider }[];
  /** True only when all three are connected. */
  fullExperience: boolean;
}

export async function getCapabilities(accountId: number): Promise<CapabilitiesResult> {
  const statuses = await getProviderStatuses(accountId);

  const connected = statuses.filter((s) => s.state === 'connected').map((s) => s.provider);
  const skipped = statuses.filter((s) => s.state === 'skipped').map((s) => s.provider);
  const requested = statuses.filter((s) => s.state === 'requested').map((s) => s.provider);
  const undecided = statuses.filter((s) => s.state === 'undecided').map((s) => s.provider);

  const available: string[] = [];
  const unavailable: { capability: string; requiresProvider: Provider }[] = [];
  for (const [provider, caps] of Object.entries(PROVIDER_CAPABILITIES) as [Provider, string[]][]) {
    if (connected.includes(provider)) available.push(...caps);
    else unavailable.push(...caps.map((capability) => ({ capability, requiresProvider: provider })));
  }

  return {
    connected, skipped, requested, undecided,
    available, unavailable,
    fullExperience: connected.length === 3,
  };
}
