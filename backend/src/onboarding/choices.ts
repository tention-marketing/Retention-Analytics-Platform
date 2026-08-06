import { query } from '../db/pool.js';

// Per-provider onboarding intent (D1 / D20).
//
// `connections` holds reality; this table holds intent. A skipped or
// agency-assist-requested platform creates NO connections row, because
// credentials_encrypted is NOT NULL and every worker in queue/workers.ts fans out
// over `connections WHERE status='connected'` — a placeholder row there would be
// picked up by real sync jobs.

export const PROVIDERS = ['shopify', 'klaviyo', 'recharge'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/**
 * Resolved state per provider. `connected` always wins over any stored choice,
 * which is why 'connected' is not a value in the choices table — one source of
 * truth for connectedness.
 */
export type ProviderState =
  | 'connected'
  | 'requested'   // answered: agency setup pending (shopify carries a domain, the others do not)
  | 'skipped'
  | 'undecided';  // no connection and no (or 'pending') choice row

export interface ProviderStatus {
  provider: Provider;
  state: ProviderState;
  /** Present when connected: the stored connections.status. */
  connectionStatus: string | null;
  requestedDomain: string | null;
  shopDomain: string | null;
  lastSyncAt: Date | null;
}

export async function getProviderStatuses(accountId: number): Promise<ProviderStatus[]> {
  const conns = await query<{
    provider: string; status: string; shop_domain: string | null; last_sync_at: Date | null;
  }>(
    `SELECT provider, status, shop_domain, last_sync_at FROM connections WHERE account_id = $1`,
    [accountId],
  );
  const choices = await query<{ provider: string; choice: string; requested_domain: string | null }>(
    `SELECT provider, choice, requested_domain FROM onboarding_provider_choices
      WHERE account_id = $1`,
    [accountId],
  );

  const connByProvider = new Map(conns.rows.map((r) => [r.provider, r]));
  const choiceByProvider = new Map(choices.rows.map((r) => [r.provider, r]));

  return PROVIDERS.map((provider) => {
    const conn = connByProvider.get(provider);
    const choice = choiceByProvider.get(provider);

    let state: ProviderState;
    if (conn && conn.status === 'connected') state = 'connected';
    else if (choice?.choice === 'skipped') state = 'skipped';
    else if (choice?.choice === 'requested') state = 'requested';
    else state = 'undecided';

    return {
      provider,
      state,
      connectionStatus: conn?.status ?? null,
      requestedDomain: choice?.requested_domain ?? null,
      shopDomain: conn?.shop_domain ?? null,
      lastSyncAt: conn?.last_sync_at ?? null,
    };
  });
}

export async function isConnected(accountId: number, provider: Provider): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) n FROM connections
      WHERE account_id = $1 AND provider = $2 AND status = 'connected'`,
    [accountId, provider],
  );
  return Number(rows[0].n) > 0;
}

export async function setSkipped(accountId: number, provider: Provider): Promise<void> {
  await query(
    `INSERT INTO onboarding_provider_choices (account_id, provider, choice, requested_domain)
     VALUES ($1, $2, 'skipped', NULL)
     ON CONFLICT (account_id, provider)
     DO UPDATE SET choice = 'skipped', requested_domain = NULL, updated_at = now()`,
    [accountId, provider],
  );
}

/**
 * The providers a client may request agency setup for WITHOUT a domain (5C-2).
 *
 * Klaviyo and Recharge are the only two, and Shopify is excluded because its
 * request carries a client-confirmed *.myshopify.com domain and is protected by
 * a unique index on that domain — it uses the domain-bearing Shopify route, and
 * the domain-less path below would silently drop the one field that makes it
 * meaningful.
 *
 * THIS CONSTANT IS THE SINGLE SOURCE OF TRUTH, and the type is derived FROM it
 * rather than beside it. Written as `Exclude<Provider, 'shopify'>` the two could
 * drift: a fourth provider added to PROVIDERS would silently widen the type
 * while the runtime allowlist stayed at two, and the compiler would stop
 * flagging a call the guard still rejects. Deriving the type means a future
 * Provider value is NOT automatically requestable — adding one requires an
 * explicit edit here, which is the decision that deserves to be explicit.
 */
export const REQUESTABLE_PROVIDERS = ['klaviyo', 'recharge'] as const;
export type RequestableProvider = (typeof REQUESTABLE_PROVIDERS)[number];

export function isRequestableProvider(v: unknown): v is RequestableProvider {
  return typeof v === 'string' && (REQUESTABLE_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Record an agency-assist request for Klaviyo or Recharge (5C-2).
 *
 * ONE implementation for both, parameterised by provider — the two differ in no
 * respect, and a per-provider copy would be two places for the same rule to
 * drift. It mirrors setSkipped exactly, because a request and a skip are the
 * same kind of fact: an ANSWER recorded in onboarding_provider_choices, with no
 * connections row, no credential, no queue job and no provider call. That is
 * what keeps `requested` from ever being counted as a connection (§5.4.5) while
 * still satisfying the "answered" half of Gate 1.
 *
 * `requested_domain` is written as NULL explicitly, not merely left alone. A
 * stale domain surviving a skipped → requested transition would be a value no
 * client had confirmed, and for these two providers there is no such thing as a
 * domain to confirm. Writing NULL also keeps these rows outside the partial
 * unique index on requested_domain, which is scoped to Shopify.
 *
 * Idempotent: re-requesting refreshes updated_at and nothing else.
 */
export async function setRequested(
  accountId: number,
  provider: RequestableProvider,
): Promise<void> {
  await query(
    `INSERT INTO onboarding_provider_choices (account_id, provider, choice, requested_domain)
     VALUES ($1, $2, 'requested', NULL)
     ON CONFLICT (account_id, provider)
     DO UPDATE SET choice = 'requested', requested_domain = NULL, updated_at = now()`,
    [accountId, provider],
  );
}

/**
 * Record an agency-assist Shopify request. Idempotent for the same account and
 * domain (Correction 3): re-requesting simply refreshes updated_at.
 *
 * The unique index on lower(requested_domain) WHERE choice='requested' means a
 * concurrent request for the same domain from a different account fails here at
 * the database, not merely at the pre-flight check in domain.ts.
 */
export async function setShopifyRequested(accountId: number, domain: string): Promise<void> {
  await query(
    `INSERT INTO onboarding_provider_choices (account_id, provider, choice, requested_domain)
     VALUES ($1, 'shopify', 'requested', $2)
     ON CONFLICT (account_id, provider)
     DO UPDATE SET choice = 'requested', requested_domain = EXCLUDED.requested_domain,
                   updated_at = now()`,
    [accountId, domain],
  );
}

/**
 * Called after a successful connect. Moves the choice row out of any active
 * state so it stops occupying the active-request unique index, while retaining
 * requested_domain for audit. The row is NOT deleted so the history of what the
 * client asked for survives.
 */
export async function supersedeChoiceOnConnect(
  accountId: number,
  provider: Provider,
): Promise<void> {
  await query(
    `INSERT INTO onboarding_provider_choices (account_id, provider, choice)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (account_id, provider)
     DO UPDATE SET choice = 'pending', updated_at = now()`,
    [accountId, provider],
  );
}
