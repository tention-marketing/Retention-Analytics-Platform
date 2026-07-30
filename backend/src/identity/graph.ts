import { query } from '../db/pool.js';
import { config } from '../config.js';
import { fetchAllPages, type KlaviyoConnection } from '../sync/klaviyo/client.js';

/**
 * Identity graph (§4.4) — Shopify customer ↔ Recharge subscription
 *                       + Shopify customer ↔ Klaviyo profile (by email).
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
 * KLAVIYO (Phase 4) is the same idea in MEASURE-ONLY form — see
 * measureKlaviyoIdentityMatch below for why nothing is persisted.
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

// ---------------------------------------------------------------------------
// Klaviyo profile ↔ email (§4.4, Phase 4)
// ---------------------------------------------------------------------------

export interface KlaviyoIdentityStats {
  provider: 'klaviyo';
  profilesScanned: number; // distinct usable emails seen
  profilesWithoutEmail: number; // profiles skipped for having no email
  matched: number; // scanned emails that exist in customers
  unmatched: number;
  unmatchedRate: number; // 0..1
  overThreshold: boolean; // unmatchedRate > 0.05
  /** True when the page budget stopped the scan early — NOT a full-list rate. */
  partial: boolean;
  pagesFetched: number;
  pageBudget: number;
}

/**
 * Measure how many Klaviyo profiles can be tied to a Shopify customer by email.
 *
 * MEASURE-ONLY, and deliberately so: §4.4's requirement for Klaviyo is to "log
 * unmatched rate; surface it in the UI if >5%", and CLAUDE.md §3 (which says
 * "migrate exactly this") defines no Klaviyo profile table. So this computes and
 * returns the rate without persisting profiles — no schema change, and nothing
 * stored that no V1 dashboard reads.
 *
 * Matching uses the SAME normalisation as the Recharge email fallback —
 * lower(btrim(email)) on both sides (§8 trap 3).
 *
 * COST: profiles page at 100/request, so a full scan of a large list is
 * expensive. It therefore runs at connect time or at most once a day (see
 * poller.ts), bounded by `pageBudget`. A scan that exhausts its budget is flagged
 * `partial: true` — a partial scan must never be presented as the real rate.
 */
export async function measureKlaviyoIdentityMatch(
  accountId: number,
  conn: KlaviyoConnection,
  pageBudget: number = config.klaviyoProfilePageBudget,
): Promise<KlaviyoIdentityStats> {
  const page = await fetchAllPages<any>(
    conn,
    '/api/profiles',
    { 'fields[profile]': 'email', 'page[size]': '100' },
    pageBudget,
  );

  const keys = new Set<string>();
  let profilesWithoutEmail = 0;
  for (const p of page.items) {
    const email = p?.attributes?.email;
    const key = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!key) {
      profilesWithoutEmail += 1;
      continue;
    }
    keys.add(key);
  }

  const emailKeys = [...keys];
  const { rows } = await query<{ matched: number }>(
    `SELECT count(*)::int AS matched
       FROM unnest($2::text[]) AS e(email_key)
      WHERE EXISTS (
        SELECT 1 FROM customers c
         WHERE c.account_id = $1
           AND c.email IS NOT NULL
           AND lower(btrim(c.email)) = e.email_key
      )`,
    [accountId, emailKeys],
  );

  const profilesScanned = emailKeys.length;
  const matched = rows[0]?.matched ?? 0;
  const unmatched = profilesScanned - matched;
  const unmatchedRate = profilesScanned > 0 ? unmatched / profilesScanned : 0;
  const overThreshold = unmatchedRate > THRESHOLD;

  const pct = (unmatchedRate * 100).toFixed(1);
  const suffix = page.truncated
    ? ` [PARTIAL: page budget ${pageBudget} exhausted, rate covers scanned profiles only]`
    : '';
  if (overThreshold) {
    console.warn(
      `[identity] account ${accountId}: klaviyo ${unmatched}/${profilesScanned} profiles UNMATCHED (${pct}%) — exceeds 5% threshold; surface in UI${suffix}`,
    );
  } else {
    console.log(
      `[identity] account ${accountId}: klaviyo unmatched ${unmatched}/${profilesScanned} (${pct}%)${suffix}`,
    );
  }

  return {
    provider: 'klaviyo',
    profilesScanned,
    profilesWithoutEmail,
    matched,
    unmatched,
    unmatchedRate,
    overThreshold,
    partial: page.truncated,
    pagesFetched: page.pagesFetched,
    pageBudget,
  };
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
