/**
 * Identity graph at seed scale (§4.4 acceptance: unmatched < 5%).
 * Non-destructive to the *shape* of the data — it only rewrites
 * shopify_customer_id (regenerable via `npm run seed`).
 *
 * Run: `npx tsx scripts/verify-identity-scale.ts`
 */
import { pool, query } from '../server/src/db/pool.js';
import { linkRechargeIdentities, getRechargeIdentityStats } from '../server/src/identity/graph.js';

async function main() {
  const acc = await query<{ account_id: number; n: string }>(
    `SELECT account_id, count(*) n FROM subscriptions GROUP BY account_id ORDER BY account_id LIMIT 1`,
  );
  if (acc.rows.length === 0) {
    console.log('No subscriptions — run `npm run seed` first.');
    await pool.end();
    return;
  }
  const accountId = acc.rows[0].account_id;
  const total = Number(acc.rows[0].n);
  console.log(`Account ${accountId}: ${total} subscriptions`);

  const before = await getRechargeIdentityStats(accountId);
  console.log(`As seeded: ${before.matched}/${before.total} linked (${(before.unmatchedRate * 100).toFixed(1)}% unmatched)`);

  // Simulate a real Recharge sync where NO subscription carried a Shopify
  // customer id directly — forcing 100% of linking onto the email fallback.
  await query(`UPDATE subscriptions SET shopify_customer_id = NULL WHERE account_id = $1`, [accountId]);
  const cleared = await getRechargeIdentityStats(accountId);
  console.log(`After clearing all direct links: ${(cleared.unmatchedRate * 100).toFixed(1)}% unmatched`);

  const stats = await linkRechargeIdentities(accountId);
  console.log(`After email-fallback link: matchedEmail=${stats.matchedEmail}, ` +
    `${stats.matched}/${stats.total} linked, ${(stats.unmatchedRate * 100).toFixed(2)}% unmatched ` +
    (stats.overThreshold ? '⚠ >5%' : '✓ under 5% threshold'));

  await pool.end();
  process.exit(stats.overThreshold ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
