import { query } from '../../db/pool.js';
import { getRechargeConnection } from '../../db/connections.js';
import { syncRecharge, type RechargeBackfillResult } from './backfill.js';

// Re-pull anything updated since a little before the last successful sync (a
// safety overlap so nothing slips through the boundary). Falls back to a full
// backfill window if we've never synced.
const OVERLAP_HOURS = 48;

function windowStart(lastSyncAt: Date | null): string {
  const base = lastSyncAt ? lastSyncAt.getTime() : Date.now() - 3650 * 24 * 3600_000;
  return new Date(base - OVERLAP_HOURS * 3600_000).toISOString();
}

/**
 * Daily poll (§4.3): re-pull subscriptions/charges/orders updated since the last
 * sync, re-upsert, and re-run identity linking. Recharge's `updated_at_min`
 * filter applies to the first page only (client.ts follows the cursor after).
 */
export async function runRechargePoll(accountId: number): Promise<RechargeBackfillResult> {
  const conn = await getRechargeConnection(accountId);
  if (!conn) throw new Error(`no recharge connection for account ${accountId}`);

  const { rows } = await query<{ last_sync_at: Date | null }>(
    `SELECT last_sync_at FROM connections WHERE account_id = $1 AND provider = 'recharge'`,
    [accountId],
  );
  const since = windowStart(rows[0]?.last_sync_at ?? null);

  return syncRecharge(accountId, conn, { updated_at_min: since }, 'recharge.poll');
}
