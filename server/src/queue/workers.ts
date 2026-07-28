import { Worker } from 'bullmq';
import { redis, QUEUE_NAMES, inventoryQueue, reconcileQueue, rechargePollQueue } from './queues.js';
import { runShopifyBackfill } from '../sync/shopify/backfill.js';
import { runShopifyReconcile } from '../sync/shopify/reconcile.js';
import { getShopifyConnection } from '../db/connections.js';
import { snapshotInventory } from '../sync/shopify/inventory.js';
import { processShopifyWebhook, type WebhookJob } from '../sync/shopify/webhookWorker.js';
import { runRechargeBackfill } from '../sync/recharge/backfill.js';
import { runRechargePoll } from '../sync/recharge/poller.js';
import { logSyncError } from '../sync/errors.js';
import { query } from '../db/pool.js';

// Daily inventory snapshot + nightly 48h reconcile as repeatable jobs, fanned
// out to one child job per connected Shopify account.
async function scheduleRepeatables(): Promise<void> {
  await inventoryQueue().add(
    'inventory-tick', {},
    { repeat: { pattern: '0 6 * * *' }, jobId: 'inventory-daily' }, // 06:00 daily
  );
  await reconcileQueue().add(
    'reconcile-tick', {},
    { repeat: { pattern: '0 3 * * *' }, jobId: 'reconcile-nightly' }, // 03:00 nightly
  );
  await rechargePollQueue().add(
    'recharge-poll-tick', {},
    { repeat: { pattern: '0 4 * * *' }, jobId: 'recharge-poll-daily' }, // 04:00 daily
  );
}

async function connectedAccountIds(provider: 'shopify' | 'recharge'): Promise<number[]> {
  const { rows } = await query<{ account_id: number }>(
    `SELECT account_id FROM connections WHERE provider = $1 AND status = 'connected'`,
    [provider],
  );
  return rows.map((r) => r.account_id);
}
const connectedShopifyAccountIds = () => connectedAccountIds('shopify');

export function startWorkers(): Worker[] {
  const workers: Worker[] = [];

  workers.push(
    new Worker(
      QUEUE_NAMES.shopifyBackfill,
      async (job) => runShopifyBackfill(job.data.accountId),
      { connection: redis, concurrency: 1 }, // one bulk op per shop at a time
    ),
  );

  workers.push(
    new Worker<WebhookJob>(
      QUEUE_NAMES.shopifyWebhook,
      async (job) => processShopifyWebhook(job.data),
      { connection: redis, concurrency: 10 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.shopifyInventory,
      async () => {
        for (const accountId of await connectedShopifyAccountIds()) {
          const conn = await getShopifyConnection(accountId);
          if (!conn) continue;
          await snapshotInventory(accountId, conn).catch((e) => logSyncError(accountId, 'shopify.inventory', e));
        }
      },
      { connection: redis, concurrency: 1 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.shopifyReconcile,
      async () => {
        for (const accountId of await connectedShopifyAccountIds()) {
          await runShopifyReconcile(accountId).catch((e) => logSyncError(accountId, 'shopify.reconcile', e));
        }
      },
      { connection: redis, concurrency: 1 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.rechargeBackfill,
      async (job) => runRechargeBackfill(job.data.accountId),
      { connection: redis, concurrency: 1 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.rechargePoll,
      async () => {
        for (const accountId of await connectedAccountIds('recharge')) {
          await runRechargePoll(accountId).catch((e) => logSyncError(accountId, 'recharge.poll', e));
        }
      },
      { connection: redis, concurrency: 1 },
    ),
  );

  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(`[worker] ${job?.queueName} job ${job?.id} failed:`, err.message);
    });
  }
  return workers;
}

// Entry point: `npm run worker`
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await scheduleRepeatables();
    const workers = startWorkers();
    console.log(`Workers started: ${workers.map((w) => w.name).join(', ')}`);
    const shutdown = async () => {
      await Promise.all(workers.map((w) => w.close()));
      await redis.quit();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}
