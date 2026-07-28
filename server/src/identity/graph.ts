import { query } from '../db/pool.js';

/**
 * Identity graph (§4.4) — Shopify customer ↔ Recharge subscription.
 *
 * A subscription's Shopify customer id is resolved in two passes:
 *   1. DIRECT — Recharge's own external_customer_id.ecommerce, written at
 *      transform time (persist.ts). Preferred; no ambiguity.
 *   2. EMAIL FALLBACK — for still-unlinked subscriptions, case-insensitive,
 *      trimmed email match against the customers table (§8 trap 3). When a
 *      Shopify email is shared by multiple customer records we pick the lowest
 *      id deterministically (DISTINCT ON) so re-runs are stable.
 *
 * The unmatched rate is measured every run and surfaced (returned + logged;
 * >5% is flagged) — the churn annotations live or die on this linkage.
 *
 * Klaviyo profile ↔ email is the same idea and slots in at Phase 4; not built
 * here.
 */

export interface IdentityMatchStats {
  provider: 'recharge';
  total: number;
  matchedDirect: number; // linked by Recharge external id
  matchedEmail: number; // newly linked by email fallback this run
  matched: number; // total linked after this run
  unmatched: number;
  unmatchedRate: number; // 0..1
  overThreshold: boolean; // unmatchedRate > 0.05
}

const THRESHOLD = 0.05;

async function countSubs(accountId: number): Promise<{ total: number; matched: number }> {
  const { rows } = await query<{ total: string; matched: string }>(
    `SELECT count(*)::int AS total,
            count(shopify_customer_id)::int AS matched
       FROM subscriptions WHERE account_id = $1`,
    [accountId],
  );
  return { total: Number(rows[0].total), matched: Number(rows[0].matched) };
}

/**
 * Run the email-fallback pass and return match stats. Idempotent: only fills
 * NULL shopify_customer_ids, so the direct links from Recharge are untouched.
 */
export async function linkRechargeIdentities(accountId: number): Promise<IdentityMatchStats> {
  const before = await countSubs(accountId);
  const matchedDirect = before.matched;

  const linked = await query(
    `UPDATE subscriptions s
        SET shopify_customer_id = m.id
       FROM (
         SELECT DISTINCT ON (lower(btrim(email))) lower(btrim(email)) AS email_key, id
           FROM customers
          WHERE account_id = $1 AND email IS NOT NULL AND btrim(email) <> ''
          ORDER BY lower(btrim(email)), id
       ) m
      WHERE s.account_id = $1
        AND s.shopify_customer_id IS NULL
        AND s.email IS NOT NULL
        AND lower(btrim(s.email)) = m.email_key`,
    [accountId],
  );
  const matchedEmail = linked.rowCount ?? 0;

  const total = before.total;
  const matched = matchedDirect + matchedEmail;
  const unmatched = total - matched;
  const unmatchedRate = total > 0 ? unmatched / total : 0;
  const overThreshold = unmatchedRate > THRESHOLD;

  const stats: IdentityMatchStats = {
    provider: 'recharge',
    total, matchedDirect, matchedEmail, matched, unmatched, unmatchedRate, overThreshold,
  };

  const pct = (unmatchedRate * 100).toFixed(1);
  if (overThreshold) {
    console.warn(
      `[identity] account ${accountId}: ${unmatched}/${total} subscriptions UNMATCHED (${pct}%) — exceeds 5% threshold; surface in UI`,
    );
  } else {
    console.log(`[identity] account ${accountId}: unmatched ${unmatched}/${total} (${pct}%)`);
  }
  return stats;
}

/** Read-only stats for surfacing (route/UI). Does not mutate linkages. */
export async function getRechargeIdentityStats(accountId: number): Promise<IdentityMatchStats> {
  const { total, matched } = await countSubs(accountId);
  const unmatched = total - matched;
  const unmatchedRate = total > 0 ? unmatched / total : 0;
  return {
    provider: 'recharge',
    total,
    matchedDirect: matched, // read-only view can't distinguish direct vs email after the fact
    matchedEmail: 0,
    matched,
    unmatched,
    unmatchedRate,
    overThreshold: unmatchedRate > THRESHOLD,
  };
}
