import { withTransaction } from '../../db/pool.js';
import { getRechargeConnection, markSynced } from '../../db/connections.js';
import { fetchAllPages, type RechargeConnection } from './client.js';
import {
  transformCustomer, transformSubscription,
  subscriptionLifecycleEvents, chargeEvents, orderEvents,
  type CustomerIdentity, type SubscriptionRow, type SubscriptionEventRow,
} from './transform.js';
import { upsertSubscriptions, upsertSubscriptionEvents } from './persist.js';
import { linkRechargeIdentities, type IdentityMatchStats } from '../../identity/graph.js';
import { logSyncError } from '../errors.js';

export interface RechargeBackfillResult {
  subscriptions: number;
  events: number;
  identity: IdentityMatchStats;
}

/**
 * Build the map of Recharge customer id -> identity (email + Shopify customer
 * id). Subscriptions carry only a customer_id, so this map is how we attach the
 * direct identity link before falling back to email matching (§4.4).
 */
async function buildCustomerIdentityMap(
  conn: RechargeConnection,
  filters: Record<string, string> = {},
): Promise<Map<string, CustomerIdentity>> {
  const customers = await fetchAllPages(conn, 'customers', 'customers', filters);
  const map = new Map<string, CustomerIdentity>();
  for (const c of customers) {
    const t = transformCustomer(c);
    if (t) map.set(t.id, t.identity);
  }
  return map;
}

/** Shared work for both backfill (no filter) and poll (updated_at_min filter). */
export async function syncRecharge(
  accountId: number,
  conn: RechargeConnection,
  filters: Record<string, string>,
  jobType: string,
): Promise<RechargeBackfillResult> {
  try {
    // Customers first (identity map), then subscriptions resolved against it.
    // On a poll the map is scoped to the same window; a subscription whose
    // customer wasn't in-window still falls back to email linking afterward.
    const identityMap = await buildCustomerIdentityMap(conn, filters);

    const rawSubs = await fetchAllPages(conn, 'subscriptions', 'subscriptions', filters);
    const subs: SubscriptionRow[] = [];
    for (const s of rawSubs) {
      const row = transformSubscription(s, s.customer_id != null ? identityMap.get(String(s.customer_id)) : undefined);
      if (row) subs.push(row);
    }

    // Events: created/cancelled from subscriptions; charge/billing_reminder from
    // charges; delivered from orders (where a shipped/processed date exists).
    const events: SubscriptionEventRow[] = [];
    for (const s of subs) events.push(...subscriptionLifecycleEvents(s));

    const charges = await fetchAllPages(conn, 'charges', 'charges', filters);
    for (const ch of charges) events.push(...chargeEvents(ch));

    const orders = await fetchAllPages(conn, 'orders', 'orders', filters);
    for (const o of orders) events.push(...orderEvents(o));

    await withTransaction(async (client) => {
      await upsertSubscriptions(client, accountId, subs);
      await upsertSubscriptionEvents(client, accountId, events);
    });

    // Email-fallback linking + unmatched-rate measurement runs over the full
    // account (not just this window) so late-arriving Shopify customers get linked.
    const identity = await linkRechargeIdentities(accountId);

    await markSynced(accountId, 'recharge');
    return { subscriptions: subs.length, events: events.length, identity };
  } catch (err) {
    await logSyncError(accountId, jobType, err);
    throw err;
  }
}

/** Full history backfill. */
export async function runRechargeBackfill(
  accountId: number,
  connArg?: RechargeConnection,
): Promise<RechargeBackfillResult> {
  const conn = connArg ?? (await getRechargeConnection(accountId));
  if (!conn) throw new Error(`no recharge connection for account ${accountId}`);
  return syncRecharge(accountId, conn, {}, 'recharge.backfill');
}
