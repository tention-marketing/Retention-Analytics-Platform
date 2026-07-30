import { query } from '../db/pool.js';

// Shopify shop-domain normalization and uniqueness (D11 / D16 / Correction 3).
//
// The PERMANENT *.myshopify.com domain is the only acceptable form, because
// db/connections.ts:getAccountIdByShopDomain() routes incoming webhooks by
// matching it. A vanity domain would never match a webhook's shop header, so
// accepting one would silently break webhook delivery.

const MYSHOPIFY_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export type DomainError =
  | 'empty'
  | 'not_myshopify'
  | 'too_long';

export type NormalizedDomain =
  | { ok: true; domain: string }
  | { ok: false; error: DomainError; message: string };

/**
 * Normalize before ANY comparison or write: trim, lowercase, strip scheme,
 * userinfo, port, path, query and fragment. Without this, `MyStore.myshopify.com`
 * and `https://mystore.myshopify.com/` would both bypass a uniqueness check on
 * the raw string.
 */
export function normalizeShopDomain(input: unknown): NormalizedDomain {
  if (typeof input !== 'string') {
    return { ok: false, error: 'empty', message: 'Shopify store domain is required.' };
  }
  let s = input.trim().toLowerCase();
  if (!s) return { ok: false, error: 'empty', message: 'Shopify store domain is required.' };
  if (s.length > 255) {
    return { ok: false, error: 'too_long', message: 'Shopify store domain is too long.' };
  }

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^/@]*@/, '');                 // userinfo
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split(':')[0];                           // port

  if (!MYSHOPIFY_RE.test(s)) {
    return {
      ok: false,
      error: 'not_myshopify',
      message:
        'Enter the permanent Shopify domain, which ends in .myshopify.com ' +
        '(a custom domain cannot be used here).',
    };
  }
  return { ok: true, domain: s };
}

export type DomainConflict =
  | { kind: 'connected_elsewhere'; accountId: number }
  | { kind: 'requested_elsewhere'; accountId: number };

/**
 * Is this domain free for `accountId` to claim? Checks BOTH already-connected
 * domains and domains under an active agency-assist request, since either would
 * make webhook routing ambiguous. Same-account claims are always allowed, which
 * is what makes re-requesting idempotent.
 *
 * This is a pre-flight check for a clean error message. The unique indexes added
 * in 004 are the actual guarantee under concurrency.
 */
export async function findDomainConflict(
  accountId: number,
  domain: string,
): Promise<DomainConflict | null> {
  const connected = await query<{ account_id: number }>(
    `SELECT account_id FROM connections
      WHERE provider = 'shopify' AND lower(shop_domain) = $1 AND account_id <> $2`,
    [domain, accountId],
  );
  if (connected.rows[0]) {
    return { kind: 'connected_elsewhere', accountId: connected.rows[0].account_id };
  }

  const requested = await query<{ account_id: number }>(
    `SELECT account_id FROM onboarding_provider_choices
      WHERE provider = 'shopify' AND choice = 'requested'
        AND lower(requested_domain) = $1 AND account_id <> $2`,
    [domain, accountId],
  );
  if (requested.rows[0]) {
    return { kind: 'requested_elsewhere', accountId: requested.rows[0].account_id };
  }
  return null;
}

/** Client-safe message: never names the other account. */
export function domainConflictMessage(): string {
  return 'This Shopify store is already being set up. Contact your account manager.';
}
