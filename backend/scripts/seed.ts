/**
 * Phase 1 seed: ONE fake brand with ~2 years of history.
 *
 * Acceptance targets (CLAUDE.md §7, Phase 1):
 *   - a login user exists
 *   - seeded orders > 20,000
 *   - subscription cancellations spread across day 0–90 with rebill clustering
 *
 * Re-runnable: wipes the seed brand's rows first, then reinserts.
 * Deterministic: uses a seeded RNG so hand-checks in later phases are stable.
 */
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../src/db/pool.js';

// ---- deterministic RNG (mulberry32) --------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(1337);
const rand = (min: number, max: number) => min + rng() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const pick = <T>(arr: T[]): T => arr[randInt(0, arr.length - 1)];
function weightedPick<T>(entries: Array<[T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [val, w] of entries) {
    if ((r -= w) <= 0) return val;
  }
  return entries[entries.length - 1][0];
}

// ---- date helpers (day math is UTC here; store-tz conversion is Phase 6) --
const DAY_MS = 86_400_000;
const NOW = new Date('2026-07-17T00:00:00Z').getTime();
const HISTORY_START = NOW - 730 * DAY_MS;
const addDays = (t: number, d: number) => new Date(t + d * DAY_MS);
const dayFloor = (t: number) => Math.floor(t / DAY_MS);

// ---- config ---------------------------------------------------------------
const SEED_USER = { email: 'demo@tention.test', password: 'password123' };
const BRAND_NAME = 'Acme Wellness Co.';
const TARGET_ORDERS = 25_000;
const NUM_SUBS = 800;
const CHANNELS = ['meta', 'google', 'tiktok', 'organic', 'email'];
const SUB_CANCEL_REASONS = ['too expensive', 'too much product', 'no longer needed', 'quality', 'switching brand'];

const PRODUCTS = Array.from({ length: 20 }, (_, i) => ({
  id: 100 + i,
  title: `Product ${i + 1}`,
  sku: `SKU-${String(i + 1).padStart(3, '0')}`,
  price: Math.round(rand(18, 120) * 100) / 100,
}));
const SUB_PRODUCTS = PRODUCTS.slice(0, 6); // subscribable products

// ---- generic chunked multi-row insert ------------------------------------
async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.length;
  const maxRowsPerChunk = Math.max(1, Math.floor(60_000 / cols));
  for (let start = 0; start < rows.length; start += maxRowsPerChunk) {
    const chunk = rows.slice(start, start + maxRowsPerChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((row, ri) => {
      const placeholders = row.map((_, ci) => `$${ri * cols + ci + 1}`);
      values.push(...row);
      return `(${placeholders.join(',')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
      values,
    );
  }
}

// ---- cancellation day distribution: spread 0–90, clustered near rebills ---
// Monthly plans rebill at ~30/60/90; churn clusters just after each rebill.
function cancellationDayActive(planType: string): number {
  const center =
    planType === 'quarterly'
      ? weightedPick<number>([[3, 1], [90, 5], [45, 1]]) // signup regret or first quarterly rebill
      : weightedPick<number>([
          [2, 2], // early cancels (day 0–5)
          [30, 5], // after 1st rebill
          [60, 4], // after 2nd rebill
          [90, 4], // after 3rd rebill
          [15, 1], // scattered mid-cycle
          [45, 1],
          [75, 1],
        ]);
  const jitter = randInt(0, 4); // churn lands 0–4 days after the rebill charge
  return Math.min(90, Math.max(0, center + jitter));
}

async function wipeBrand(client: PoolClient, accountId: number): Promise<void> {
  const tables = [
    'line_items', 'orders', 'customers', 'products', 'inventory_levels',
    'campaign_stats', 'campaigns', 'subscription_events', 'subscriptions',
    'ad_spend', 'account_costs', 'sku_costs', 'rcm_config', 'sync_errors',
    'connections',
  ];
  for (const t of tables) {
    await client.query(`DELETE FROM ${t} WHERE account_id = $1`, [accountId]);
  }
}

async function seed(): Promise<void> {
  // Login user (idempotent).
  const hash = await bcrypt.hash(SEED_USER.password, 10);
  await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [SEED_USER.email, hash],
  );

  await withTransaction(async (client) => {
    // Fresh account each run.
    const existing = await client.query<{ id: number }>(
      'SELECT id FROM accounts WHERE name = $1',
      [BRAND_NAME],
    );
    for (const r of existing.rows) await wipeBrand(client, r.id);
    await client.query('DELETE FROM accounts WHERE name = $1', [BRAND_NAME]);

    const acct = await client.query<{ id: number }>(
      `INSERT INTO accounts (name, store_timezone, onboarding_complete)
       VALUES ($1, 'America/Los_Angeles', true) RETURNING id`,
      [BRAND_NAME],
    );
    const accountId = acct.rows[0].id;
    console.log(`Seeding brand "${BRAND_NAME}" as account_id=${accountId}`);

    // Products
    await insertRows(
      client, 'products', ['account_id', 'id', 'title'],
      PRODUCTS.map((p) => [accountId, p.id, p.title]),
    );

    // SKU costs (COGS = 30–50% of price)
    await insertRows(
      client, 'sku_costs', ['account_id', 'sku', 'cogs'],
      PRODUCTS.map((p) => [accountId, p.sku, Math.round(p.price * rand(0.3, 0.5) * 100) / 100]),
    );

    // ---- Customers + orders + line items -----------------------------------
    const customerRows: unknown[][] = [];
    const orderRows: unknown[][] = [];
    const lineItemRows: unknown[][] = [];
    let customerId = 1_000_000;
    let orderId = 5_000_000;
    let totalOrders = 0;
    const customerIds: number[] = [];
    const customerEmails: string[] = [];

    while (totalOrders < TARGET_ORDERS) {
      customerId += 1;
      const email = `customer${customerId}@example.com`;
      customerIds.push(customerId);
      customerEmails.push(email);

      // Orders per customer: skewed toward 1–2, long tail of loyal repeaters.
      const numOrders = weightedPick<number>([
        [1, 42], [2, 24], [3, 14], [4, 8], [5, 5], [6, 3], [7, 2], [8, 2],
      ]);
      const firstOrderOffset = rand(0, 730);
      const firstOrderTime = HISTORY_START + firstOrderOffset * DAY_MS;
      let orderTime = firstOrderTime;

      for (let n = 1; n <= numOrders; n++) {
        if (n > 1) orderTime += rand(20, 120) * DAY_MS;
        if (orderTime > NOW) break;
        orderId += 1;
        totalOrders += 1;

        // 1–3 distinct products per order
        const itemCount = weightedPick<number>([[1, 55], [2, 30], [3, 15]]);
        const chosen = new Set<number>();
        while (chosen.size < itemCount) chosen.add(pick(PRODUCTS).id);
        let gross = 0;
        for (const pid of chosen) {
          const prod = PRODUCTS.find((p) => p.id === pid)!;
          const qty = weightedPick<number>([[1, 70], [2, 22], [3, 8]]);
          gross += prod.price * qty;
          lineItemRows.push([accountId, orderId, prod.id, prod.title, prod.sku, qty, prod.price]);
        }

        const isTest = rng() < 0.005;
        const isCancelled = rng() < 0.02;
        const hasRefund = rng() < 0.05;
        const refund = hasRefund ? Math.round(gross * rand(0.1, 1) * 100) / 100 : 0;
        const totalNet = Math.round((gross - refund) * 100) / 100;

        orderRows.push([
          accountId, orderId, customerId, new Date(orderTime).toISOString(),
          totalNet, refund, n === 1, n, isCancelled, isTest,
        ]);
      }

      // customer row (first_order_at set to the first generated order time)
      customerRows.push([
        accountId, customerId, email,
        new Date(firstOrderTime).toISOString(),
        new Date(firstOrderTime - rand(0, 30) * DAY_MS).toISOString(),
      ]);
    }

    await insertRows(
      client, 'customers',
      ['account_id', 'id', 'email', 'first_order_at', 'created_at'],
      customerRows,
    );
    await insertRows(
      client, 'orders',
      ['account_id', 'id', 'customer_id', 'created_at', 'total_net',
       'refunded_amount', 'is_first_order', 'order_number_for_customer',
       'cancelled', 'test'],
      orderRows,
    );
    await insertRows(
      client, 'line_items',
      ['account_id', 'order_id', 'product_id', 'product_title', 'sku', 'quantity', 'price'],
      lineItemRows,
    );

    // ---- Subscriptions + events -------------------------------------------
    const subRows: unknown[][] = [];
    const eventRows: unknown[][] = [];
    let cancelledCount = 0;
    const dayHistogram = new Array(91).fill(0); // day_active 0..90

    for (let i = 0; i < NUM_SUBS; i++) {
      const subId = `sub_${1000 + i}`;
      const linkIdx = randInt(0, customerIds.length - 1);
      const shopifyCustomerId = customerIds[linkIdx];
      const email = customerEmails[linkIdx];
      const product = pick(SUB_PRODUCTS);
      const planType = weightedPick<string>([['monthly', 70], ['quarterly', 30]]);
      const channel = pick(CHANNELS);
      // start early enough that a 0–90 day window is fully observable
      const startTime = HISTORY_START + rand(0, 620) * DAY_MS;

      const willCancel = rng() < 0.45;
      let cancelledAt: string | null = null;
      let cancelReason: string | null = null;
      let status = 'active';
      let observeUntilDay = 90;

      if (willCancel) {
        const dayActive = cancellationDayActive(planType);
        const cancelTime = startTime + dayActive * DAY_MS;
        if (cancelTime <= NOW) {
          cancelledAt = new Date(cancelTime).toISOString();
          cancelReason = pick(SUB_CANCEL_REASONS);
          status = 'cancelled';
          cancelledCount += 1;
          dayHistogram[dayActive] += 1;
          observeUntilDay = dayActive;
        }
      }

      subRows.push([
        accountId, subId, `rc_${2000 + i}`, shopifyCustomerId, email,
        product.id, planType, status, new Date(startTime).toISOString(),
        cancelledAt, cancelReason, channel,
      ]);

      // events: created + rebill charges (+reminder +delivery) up to observe window
      const push = (type: string, t: number) =>
        eventRows.push([accountId, subId, type, new Date(t).toISOString()]);
      push('created', startTime);
      const cycle = planType === 'quarterly' ? 90 : 30;
      for (let day = 0; day <= observeUntilDay && day <= 90; day += cycle) {
        const chargeTime = startTime + day * DAY_MS;
        if (chargeTime > NOW) break;
        if (day > 0) {
          const reminder = chargeTime - 3 * DAY_MS;
          if (reminder <= NOW) push('billing_reminder', reminder);
        }
        push('charge', chargeTime);
        const delivered = chargeTime + 2 * DAY_MS;
        if (delivered <= NOW && delivered <= startTime + observeUntilDay * DAY_MS + 5 * DAY_MS) {
          push('delivered', delivered);
        }
      }
      if (cancelledAt) push('cancelled', new Date(cancelledAt).getTime());
    }

    await insertRows(
      client, 'subscriptions',
      ['account_id', 'id', 'recharge_customer_id', 'shopify_customer_id', 'email',
       'product_id', 'plan_type', 'status', 'started_at', 'cancelled_at',
       'cancel_reason', 'acquisition_channel'],
      subRows,
    );
    await insertRows(
      client, 'subscription_events',
      ['account_id', 'subscription_id', 'event_type', 'occurred_at'],
      eventRows,
    );

    // ---- Inventory snapshots (latest day per product) ---------------------
    const today = new Date(NOW).toISOString().slice(0, 10);
    await insertRows(
      client, 'inventory_levels',
      ['account_id', 'product_id', 'snapshot_date', 'available'],
      PRODUCTS.map((p) => [accountId, p.id, today, randInt(0, 500)]),
    );

    // ---- Campaigns + flows + stats ----------------------------------------
    const campaignRows: unknown[][] = [];
    const statRows: unknown[][] = [];
    const mkCampaign = (idx: number, kind: 'campaign' | 'flow') => {
      const id = `${kind}_${idx}`;
      const sentAt = new Date(HISTORY_START + rand(0, 730) * DAY_MS).toISOString();
      const recipients = randInt(2000, 40000);
      campaignRows.push([
        accountId, id,
        kind === 'campaign' ? `Campaign ${idx}` : `Flow ${idx}`,
        'email', kind, sentAt, recipients,
      ]);
      const opens = Math.round(recipients * rand(0.25, 0.55));
      const clicks = Math.round(opens * rand(0.05, 0.2));
      const conversions = Math.round(clicks * rand(0.02, 0.12));
      const revenue = Math.round(conversions * rand(40, 120) * 100) / 100;
      statRows.push([accountId, id, opens, clicks, conversions, revenue]);
    };
    for (let i = 1; i <= 12; i++) mkCampaign(i, 'campaign');
    for (let i = 1; i <= 6; i++) mkCampaign(i, 'flow');
    await insertRows(
      client, 'campaigns',
      ['account_id', 'id', 'name', 'channel', 'kind', 'sent_at', 'recipients'],
      campaignRows,
    );
    await insertRows(
      client, 'campaign_stats',
      ['account_id', 'campaign_id', 'opens', 'clicks', 'conversions', 'revenue'],
      statRows,
    );

    // ---- Ad spend (24 months × channels) ----------------------------------
    const spendRows: unknown[][] = [];
    const spendChannels = ['meta', 'google', 'tiktok'];
    const startMonth = new Date(NOW);
    startMonth.setUTCDate(1);
    for (let m = 0; m < 24; m++) {
      const d = new Date(startMonth);
      d.setUTCMonth(d.getUTCMonth() - m);
      const month = d.toISOString().slice(0, 10);
      for (const ch of spendChannels) {
        spendRows.push([accountId, month, ch, Math.round(rand(5000, 40000) * 100) / 100, 'manual']);
      }
    }
    await insertRows(
      client, 'ad_spend',
      ['account_id', 'month', 'channel', 'spend', 'source'],
      spendRows,
    );

    // ---- Costs + RCM placeholder config -----------------------------------
    await client.query(
      `INSERT INTO account_costs (account_id, blended_margin_pct, ocas_monthly)
       VALUES ($1, $2, $3)`,
      [accountId, 62.5, 45000],
    );
    await client.query(
      `INSERT INTO rcm_config (account_id, config) VALUES ($1, $2)`,
      [
        accountId,
        JSON.stringify({
          // Placeholder until Retention Economics values are locked (§0.2).
          _placeholder: true,
          formula: { revenue: 1, cogs: -1, cac: -1, refunds: -1, ocas: -1 },
          tiers: { gold: 0.35, silver: 0.2, bronze: 0.1, below: 0 },
        }),
      ],
    );

    // ---- Summary ----------------------------------------------------------
    console.log('\n=== Seed summary ===');
    console.log(`customers:            ${customerRows.length}`);
    console.log(`orders:               ${orderRows.length}  (target > 20,000)`);
    console.log(`line_items:           ${lineItemRows.length}`);
    console.log(`subscriptions:        ${subRows.length}`);
    console.log(`  cancelled:          ${cancelledCount}`);
    console.log(`subscription_events:  ${eventRows.length}`);
    console.log(`campaigns+flows:      ${campaignRows.length}`);
    console.log(`ad_spend rows:        ${spendRows.length}`);

    // Cancellation histogram bucketed into 10-day bands to show 0–90 spread.
    console.log('\ncancellation day_active distribution (rebill clustering):');
    for (let band = 0; band < 90; band += 10) {
      const count = dayHistogram.slice(band, band + 10).reduce((a, b) => a + b, 0);
      const bar = '#'.repeat(Math.round(count / 2));
      console.log(`  day ${String(band).padStart(2)}–${String(band + 9).padStart(2)}: ${String(count).padStart(3)} ${bar}`);
    }
    const day90 = dayHistogram[90];
    console.log(`  day 90    : ${String(day90).padStart(3)} ${'#'.repeat(Math.round(day90 / 2))}`);

    if (orderRows.length <= 20_000) {
      throw new Error(`Acceptance FAILED: orders=${orderRows.length} must be > 20,000`);
    }
    console.log('\nPhase 1 seed acceptance: orders > 20,000 ✅  login user + cancellations 0–90 seeded ✅');
  });
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
