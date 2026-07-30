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
  | 'requested'   // shopify only: client confirmed a domain, agency setup pending
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
