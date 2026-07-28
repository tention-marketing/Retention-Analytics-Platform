/**
 * Phase 3 verification (no live Recharge credentials required).
 *
 *  A. Transform unit checks — plan_type, identity resolution, event extraction.
 *  B. End-to-end backfill against a MOCKED Recharge API (real client pagination,
 *     real persist, real identity graph, real DB) into a throwaway account, then
 *     assert subscription counts (total/active/cancelled), events, and the
 *     identity match rate (direct link + email fallback + unmatched surfacing).
 *  C. Read the seeded account's live linkage stats (non-destructive) for context.
 *
 * Run: `npx tsx scripts/verify-recharge.ts`
 */
import { pool, query } from '../server/src/db/pool.js';
import {
  derivePlanType, transformCustomer, transformSubscription,
  subscriptionLifecycleEvents, chargeEvents, orderEvents,
} from '../server/src/sync/recharge/transform.js';
import { runRechargeBackfill } from '../server/src/sync/recharge/backfill.js';
import { getRechargeIdentityStats } from '../server/src/identity/graph.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// ---------------------------------------------------------------------------
// A. Transform unit checks
// ---------------------------------------------------------------------------
function transformChecks() {
  console.log('\nA. Transforms');
  check('plan_type month/1 -> monthly', derivePlanType('month', 1) === 'monthly');
  check('plan_type month/3 -> quarterly', derivePlanType('month', 3) === 'quarterly');
  check('plan_type week/2 -> biweekly', derivePlanType('week', 2) === 'biweekly');
  check('plan_type generic fallback', derivePlanType('month', 2) === 'every_2_month');
  check('plan_type missing -> null', derivePlanType(undefined, undefined) === null);

  const cust = transformCustomer({ id: 900001, email: 'alice@example.com', external_customer_id: { ecommerce: '5001' } });
  check('customer identity ecommerce id', cust?.identity.shopify_customer_id === 5001, cust);

  const custLegacy = transformCustomer({ id: 2, email: 'x@y.com', shopify_customer_id: 42 });
  check('customer legacy shopify_customer_id', custLegacy?.identity.shopify_customer_id === 42);

  const sub = transformSubscription(
    { id: 'sub_A', customer_id: 900001, status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z',
      order_interval_unit: 'month', order_interval_frequency: 1, external_product_id: { ecommerce: '77' } },
    { email: 'alice@example.com', shopify_customer_id: 5001 },
  );
  check('sub id/status/lowercased', sub?.id === 'sub_A' && sub?.status === 'active');
  check('sub identity from map', sub?.shopify_customer_id === 5001 && sub?.email === 'alice@example.com');
  check('sub product_id from ecommerce', sub?.product_id === 77);
  check('sub plan_type', sub?.plan_type === 'monthly');
  check('sub acquisition_channel null (not exposed)', sub?.acquisition_channel === null);

  const cancelled = transformSubscription(
    { id: 'sub_B', customer_id: 900002, status: 'cancelled', created_at: '2026-01-01T00:00:00Z',
      cancelled_at: '2026-02-15T00:00:00Z', cancellation_reason: 'too expensive',
      order_interval_unit: 'month', order_interval_frequency: 3 },
  )!;
  const life = subscriptionLifecycleEvents(cancelled);
  check('lifecycle events created+cancelled', life.length === 2 && life.some((e) => e.event_type === 'cancelled'));
  check('cancel_reason mapped', cancelled.cancel_reason === 'too expensive');

  const chEv = chargeEvents({ status: 'success', processed_at: '2026-02-01T00:00:00Z',
    line_items: [{ subscription_id: 'sub_A' }] });
  check('charge event from SUCCESS', chEv.length === 1 && chEv[0].event_type === 'charge');

  const reminder = chargeEvents({ status: 'QUEUED', scheduled_at: '2026-03-01T00:00:00Z',
    line_items: [{ purchase_item_id: 'sub_A' }] });
  check('billing_reminder from QUEUED (purchase_item_id alias)',
    reminder.length === 1 && reminder[0].event_type === 'billing_reminder' && reminder[0].subscription_id === 'sub_A');

  const del = orderEvents({ shipped_date: '2026-02-03T00:00:00Z', line_items: [{ subscription_id: 'sub_A' }] });
  check('delivered event from shipped order', del.length === 1 && del[0].event_type === 'delivered');
}

// ---------------------------------------------------------------------------
// B. Mocked-API end-to-end backfill
// ---------------------------------------------------------------------------
const FIXTURES = {
  store: { store: { name: 'Fixture Store' } },
  // Two customer pages to exercise cursor pagination.
  customersPage1: {
    customers: [
      { id: 900001, email: 'alice@example.com', external_customer_id: { ecommerce: '5001' } }, // direct link
    ],
    next_cursor: 'CUST_PAGE_2',
  },
  customersPage2: {
    customers: [
      { id: 900002, email: 'bob@example.com', external_customer_id: {} },   // no id -> email fallback
      { id: 900003, email: 'nobody@example.com', external_customer_id: {} }, // no id, no matching customer
    ],
    next_cursor: null,
  },
  subscriptions: {
    subscriptions: [
      { id: 'sub_A', customer_id: 900001, status: 'active', created_at: '2026-01-01T00:00:00Z',
        order_interval_unit: 'month', order_interval_frequency: 1, external_product_id: { ecommerce: '77' } },
      { id: 'sub_B', customer_id: 900002, status: 'cancelled', created_at: '2026-01-01T00:00:00Z',
        cancelled_at: '2026-02-15T00:00:00Z', cancellation_reason: 'too expensive',
        order_interval_unit: 'month', order_interval_frequency: 3, external_product_id: { ecommerce: '77' } },
      { id: 'sub_C', customer_id: 900003, status: 'active', created_at: '2026-01-10T00:00:00Z',
        order_interval_unit: 'month', order_interval_frequency: 1, external_product_id: { ecommerce: '88' } },
    ],
    next_cursor: null,
  },
  charges: {
    charges: [
      { id: 'ch1', status: 'success', processed_at: '2026-01-01T00:00:00Z', line_items: [{ subscription_id: 'sub_A' }] },
      { id: 'ch2', status: 'QUEUED', scheduled_at: '2026-02-01T00:00:00Z', line_items: [{ subscription_id: 'sub_A' }] },
    ],
    next_cursor: null,
  },
  orders: {
    orders: [
      { id: 'ord1', shipped_date: '2026-01-03T00:00:00Z', line_items: [{ subscription_id: 'sub_A' }] },
    ],
    next_cursor: null,
  },
};

function fakeResponse(body: unknown): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installMockFetch() {
  (globalThis as any).fetch = async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    const cursor = u.searchParams.get('cursor');
    if (path === '/store') return fakeResponse(FIXTURES.store);
    if (path === '/customers') return fakeResponse(cursor === 'CUST_PAGE_2' ? FIXTURES.customersPage2 : FIXTURES.customersPage1);
    if (path === '/subscriptions') return fakeResponse(FIXTURES.subscriptions);
    if (path === '/charges') return fakeResponse(FIXTURES.charges);
    if (path === '/orders') return fakeResponse(FIXTURES.orders);
    throw new Error(`unexpected fetch to ${path}`);
  };
}

async function cleanupAccount(accountId: number) {
  await query(`DELETE FROM subscription_events WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM subscriptions WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM connections WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM customers WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
}

async function endToEndChecks() {
  console.log('\nB. Mocked-API backfill (real client + persist + identity + DB)');
  const { rows } = await query<{ id: number }>(
    `INSERT INTO accounts (name) VALUES ('__verify_recharge__') RETURNING id`,
  );
  const accountId = rows[0].id;
  try {
    // Shopify-side customers to link against. Note BOB uppercase + trailing space
    // to prove the email fallback is case-insensitive AND trimmed (§8 trap 3).
    await query(
      `INSERT INTO customers (account_id, id, email) VALUES
        ($1, 5001, 'alice@example.com'),
        ($1, 5002, ' BOB@EXAMPLE.COM '),
        ($1, 5003, 'carol@example.com')`,
      [accountId],
    );

    installMockFetch();
    const result = await runRechargeBackfill(accountId, { token: 'fake-token' });

    check('backfill returned 3 subscriptions', result.subscriptions === 3, result);

    const counts = await query<{ total: string; active: string; cancelled: string; linked: string }>(
      `SELECT count(*) total,
              sum((status='active')::int) active,
              sum((status='cancelled')::int) cancelled,
              count(shopify_customer_id) linked
         FROM subscriptions WHERE account_id = $1`,
      [accountId],
    );
    const c = counts.rows[0];
    check('subscriptions total=3', Number(c.total) === 3, c);
    check('active=2 / cancelled=1', Number(c.active) === 2 && Number(c.cancelled) === 1, c);

    const subA = (await query(`SELECT * FROM subscriptions WHERE account_id=$1 AND id='sub_A'`, [accountId])).rows[0] as any;
    check('sub_A direct-linked to 5001', Number(subA.shopify_customer_id) === 5001, subA.shopify_customer_id);
    check('sub_A product_id=77, plan monthly', Number(subA.product_id) === 77 && subA.plan_type === 'monthly', subA);

    const subB = (await query(`SELECT * FROM subscriptions WHERE account_id=$1 AND id='sub_B'`, [accountId])).rows[0] as any;
    check('sub_B email-fallback linked to 5002 (case/space-insensitive)', Number(subB.shopify_customer_id) === 5002, subB.shopify_customer_id);
    check('sub_B cancelled fields present', subB.status === 'cancelled' && subB.cancel_reason === 'too expensive', subB);

    const subC = (await query(`SELECT * FROM subscriptions WHERE account_id=$1 AND id='sub_C'`, [accountId])).rows[0] as any;
    check('sub_C unmatched (no id, no email match)', subC.shopify_customer_id === null, subC.shopify_customer_id);

    // Identity stats from the backfill.
    const id = result.identity;
    check('identity: matchedDirect=1', id.matchedDirect === 1, id);
    check('identity: matchedEmail=1', id.matchedEmail === 1, id);
    check('identity: unmatched=1', id.unmatched === 1, id);
    check('identity: unmatchedRate ~0.333', Math.abs(id.unmatchedRate - 1 / 3) < 0.001, id.unmatchedRate);
    check('identity: overThreshold flagged (>5%)', id.overThreshold === true, id);

    // Events.
    const ev = await query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*) n FROM subscription_events WHERE account_id=$1 GROUP BY event_type ORDER BY event_type`,
      [accountId],
    );
    const evMap = Object.fromEntries(ev.rows.map((r) => [r.event_type, Number(r.n)]));
    check('events: created x3', evMap.created === 3, evMap);
    check('events: cancelled x1', evMap.cancelled === 1, evMap);
    check('events: charge x1', evMap.charge === 1, evMap);
    check('events: billing_reminder x1', evMap.billing_reminder === 1, evMap);
    check('events: delivered x1', evMap.delivered === 1, evMap);

    // Idempotency: a second run must not duplicate or wipe the email link.
    const second = await runRechargeBackfill(accountId, { token: 'fake-token' });
    check('re-run: still 3 subs (idempotent)', second.subscriptions === 3);
    const subB2 = (await query(`SELECT shopify_customer_id FROM subscriptions WHERE account_id=$1 AND id='sub_B'`, [accountId])).rows[0] as any;
    check('re-run: sub_B email link preserved (COALESCE)', Number(subB2.shopify_customer_id) === 5002, subB2);
    const evCount2 = (await query(`SELECT count(*) n FROM subscription_events WHERE account_id=$1`, [accountId])).rows[0] as any;
    const evCount1 = ev.rows.reduce((a, r) => a + Number(r.n), 0);
    check('re-run: no duplicate events', Number(evCount2.n) === evCount1, { before: evCount1, after: evCount2.n });
  } finally {
    await cleanupAccount(accountId);
  }
}

// ---------------------------------------------------------------------------
// C. Seed account linkage (non-destructive, contextual)
// ---------------------------------------------------------------------------
async function seedContext() {
  console.log('\nC. Seed account linkage (context, read-only)');
  const { rows } = await query<{ account_id: number; n: string }>(
    `SELECT account_id, count(*) n FROM subscriptions GROUP BY account_id ORDER BY account_id`,
  );
  if (rows.length === 0) {
    console.log('  (no subscriptions in DB — run `npm run seed` to exercise this)');
    return;
  }
  for (const r of rows) {
    const stats = await getRechargeIdentityStats(r.account_id);
    console.log(`  account ${r.account_id}: ${stats.matched}/${stats.total} linked, ` +
      `${(stats.unmatchedRate * 100).toFixed(1)}% unmatched` + (stats.overThreshold ? ' ⚠ >5%' : ' ✓ <5%'));
  }
}

async function main() {
  transformChecks();
  await endToEndChecks();
  await seedContext();
  await pool.end();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nverify-recharge crashed:', err);
  await pool.end();
  process.exit(1);
});
