import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';
import type { WebhookJob } from '../sync/shopify/webhookWorker.js';

// Shared Redis connection. maxRetriesPerRequest:null is required by BullMQ.
// Lazy connect so importing this module (e.g. in tests) doesn't force a socket.
export const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export const QUEUE_NAMES = {
  shopifyBackfill: 'shopify:backfill',
  shopifyWebhook: 'shopify:webhook',
  shopifyInventory: 'shopify:inventory',
  shopifyReconcile: 'shopify:reconcile',
  rechargeBackfill: 'recharge:backfill',
  rechargePoll: 'recharge:poll',
  klaviyoPoll: 'klaviyo:poll',
} as const;

const defaultJobOpts = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

// Queues are created lazily so a process that only needs one doesn't open all.
let _backfill: Queue | undefined;
let _webhook: Queue<WebhookJob> | undefined;
let _inventory: Queue | undefined;
let _reconcile: Queue | undefined;
let _rechargeBackfill: Queue | undefined;
let _rechargePoll: Queue | undefined;
let _klaviyoPoll: Queue | undefined;

export function backfillQueue(): Queue {
  return (_backfill ??= new Queue(QUEUE_NAMES.shopifyBackfill, { connection: redis, defaultJobOptions: defaultJobOpts }));
}
export function rechargeBackfillQueue(): Queue {
  return (_rechargeBackfill ??= new Queue(QUEUE_NAMES.rechargeBackfill, { connection: redis, defaultJobOptions: defaultJobOpts }));
}
export function rechargePollQueue(): Queue {
  return (_rechargePoll ??= new Queue(QUEUE_NAMES.rechargePoll, { connection: redis, defaultJobOptions: defaultJobOpts }));
}
export function klaviyoPollQueue(): Queue {
  return (_klaviyoPoll ??= new Queue(QUEUE_NAMES.klaviyoPoll, { connection: redis, defaultJobOptions: defaultJobOpts }));
}
export function webhookQueue(): Queue<WebhookJob> {
  return (_webhook ??= new Queue<WebhookJob>(QUEUE_NAMES.shopifyWebhook, { connection: redis, defaultJobOptions: defaultJobOpts }));
}
export function inventoryQueue(): Queue {
  return (_inventory ??= new Queue(QUEUE_NAMES.shopifyInventory, { connection: redis, defaultJobOptions: defaultJobOpts }));
}
export function reconcileQueue(): Queue {
  return (_reconcile ??= new Queue(QUEUE_NAMES.shopifyReconcile, { connection: redis, defaultJobOptions: defaultJobOpts }));
}

export async function enqueueBackfill(accountId: number): Promise<void> {
  await backfillQueue().add('backfill', { accountId }, { jobId: `backfill:${accountId}` });
}

export async function enqueueRechargeBackfill(accountId: number): Promise<void> {
  await rechargeBackfillQueue().add('backfill', { accountId }, { jobId: `recharge-backfill:${accountId}` });
}

export async function enqueueKlaviyoBackfill(accountId: number): Promise<void> {
  await klaviyoPollQueue().add('backfill', { accountId, forceIdentity: true }, { jobId: `klaviyo-backfill:${accountId}` });
}

export async function enqueueWebhook(job: WebhookJob): Promise<void> {
  await webhookQueue().add(job.topic, job);
}
