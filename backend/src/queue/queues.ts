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

// HYPHENS, NOT COLONS.
//
// BullMQ 5 rejects a queue name containing ':' (QueueBase throws "Queue name
// cannot contain :"), because it builds its Redis keys as `bull:<name>:<...>` and
// a colon in the name would make those keys ambiguous. The original names were
// colon-separated, so EVERY `new Queue(...)` threw on construction and every
// enqueue*() call failed — silently, because the callers treated the throw as
// "Redis is unavailable" and carried on with `queued: false`. Phases 2-4 never
// noticed: their verification runs backfills inline via `mode: 'sync'`, which
// bypasses the queues entirely.
//
// Renaming is safe: Redis held no `bull:*` keys, so there were no jobs or
// repeatables under the old names to orphan (there could not be — the
// constructor never succeeded).
export const QUEUE_NAMES = {
  shopifyBackfill: 'shopify-backfill',
  shopifyWebhook: 'shopify-webhook',
  shopifyInventory: 'shopify-inventory',
  shopifyReconcile: 'shopify-reconcile',
  rechargeBackfill: 'recharge-backfill',
  rechargePoll: 'recharge-poll',
  klaviyoPoll: 'klaviyo-poll',
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

// Job ids are hyphenated for the same reason as the queue names above: BullMQ
// rejects a custom id containing ':' ("Custom Id cannot contain :"). Exported so
// onboarding/progress.ts looks a job up by exactly the id that created it —
// duplicating the format in two places is how progress silently reports "no job".
export const backfillJobId = (accountId: number) => `backfill-${accountId}`;
export const rechargeBackfillJobId = (accountId: number) => `recharge-backfill-${accountId}`;
export const klaviyoBackfillJobId = (accountId: number) => `klaviyo-backfill-${accountId}`;

export async function enqueueBackfill(accountId: number): Promise<void> {
  await backfillQueue().add('backfill', { accountId }, { jobId: backfillJobId(accountId) });
}

export async function enqueueRechargeBackfill(accountId: number): Promise<void> {
  await rechargeBackfillQueue().add('backfill', { accountId }, { jobId: rechargeBackfillJobId(accountId) });
}

export async function enqueueKlaviyoBackfill(accountId: number): Promise<void> {
  await klaviyoPollQueue().add(
    'backfill', { accountId, forceIdentity: true }, { jobId: klaviyoBackfillJobId(accountId) },
  );
}

export async function enqueueWebhook(job: WebhookJob): Promise<void> {
  await webhookQueue().add(job.topic, job);
}
