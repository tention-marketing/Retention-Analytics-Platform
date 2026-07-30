import { query } from '../db/pool.js';
import {
  backfillQueue, klaviyoPollQueue, rechargeBackfillQueue,
  backfillJobId, rechargeBackfillJobId, klaviyoBackfillJobId,
} from '../queue/queues.js';
import { getProviderStatuses, type Provider } from './choices.js';

// Sync progress, DERIVED (D6).
//
// No sync_runs table: BullMQ job state + imported row counts + last_sync_at +
// sync_errors + connection status already answer every question the client and
// agency need. Adding a table would introduce a second, differently-timed record
// of the same facts.
//
// Real counts only — never an invented percentage. A Shopify Bulk Operation has
// no reliable total to divide by, and a fabricated progress bar would be a lie
// about data completeness in a product whose premise is honest completeness.

export type ClientSyncState =
  | 'not_started'
  | 'waiting'
  | 'syncing'
  | 'retrying'
  | 'sync_delayed'
  | 'completed'
  | 'connected'      // connected, previously synced, nothing running
  | 'failed'
  | 'skipped'
  | 'requested';

/** How long a job may sit queued before it is reported as delayed. */
const DELAYED_AFTER_MS = 2 * 60 * 1000;

export interface ProviderProgress {
  provider: Provider;
  state: ClientSyncState;
  /** Imported row counts. Client-safe. */
  counts: Record<string, number>;
  lastSyncAt: Date | null;
  /** Safe, non-technical message when state is 'failed'. */
  message?: string;
}

export interface AgencyProviderDetail extends ProviderProgress {
  /** Agency-only. Never returned on a client route. */
  jobId: string | null;
  jobState: string | null;
  attemptsMade: number | null;
  failedReason: string | null;
  recentErrors: { job_type: string; error: string; created_at: Date }[];
}

const SAFE_FAILURE_MESSAGE =
  'We hit a problem importing your data. Your account manager has been notified.';

interface JobSnapshot {
  id: string | null;
  state: string | null;
  attemptsMade: number | null;
  failedReason: string | null;
  timestamp: number | null;
}

const NO_JOB: JobSnapshot = { id: null, state: null, attemptsMade: null, failedReason: null, timestamp: null };

/**
 * Read one backfill job's state. Never throws: when Redis is unavailable the
 * caller still gets row counts and connection status, so progress degrades
 * rather than erroring out.
 */
async function readJob(
  queueFactory: () => { getJob: (id: string) => Promise<unknown> },
  jobId: string,
): Promise<JobSnapshot> {
  try {
    const job = (await queueFactory().getJob(jobId)) as
      | {
          id?: string; attemptsMade?: number; failedReason?: string; timestamp?: number;
          getState: () => Promise<string>;
        }
      | null
      | undefined;
    if (!job) return NO_JOB;
    return {
      id: job.id ?? jobId,
      state: await job.getState(),
      attemptsMade: job.attemptsMade ?? 0,
      failedReason: job.failedReason ?? null,
      timestamp: job.timestamp ?? null,
    };
  } catch {
    return NO_JOB;
  }
}

function classify(
  job: JobSnapshot,
  connected: boolean,
  lastSyncAt: Date | null,
  hasRows: boolean,
): ClientSyncState {
  if (!connected) return 'not_started';

  switch (job.state) {
    case 'active':
      return (job.attemptsMade ?? 0) > 0 ? 'retrying' : 'syncing';
    case 'waiting':
    case 'delayed':
    case 'prioritized':
    case 'waiting-children': {
      const queuedFor = job.timestamp ? Date.now() - job.timestamp : 0;
      return queuedFor > DELAYED_AFTER_MS ? 'sync_delayed' : 'waiting';
    }
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    default:
      // No job record (completed and pruned, or Redis unreachable). Fall back to
      // observable database facts.
      if (lastSyncAt || hasRows) return 'connected';
      return 'waiting';
  }
}

async function countsFor(accountId: number, provider: Provider): Promise<Record<string, number>> {
  if (provider === 'shopify') {
    const { rows } = await query<{ orders: string; customers: string; products: string; inventory: string }>(
      `SELECT (SELECT count(*) FROM orders           WHERE account_id = $1) AS orders,
              (SELECT count(*) FROM customers        WHERE account_id = $1) AS customers,
              (SELECT count(*) FROM products         WHERE account_id = $1) AS products,
              (SELECT count(*) FROM inventory_levels WHERE account_id = $1) AS inventory`,
      [accountId],
    );
    return {
      orders: Number(rows[0].orders),
      customers: Number(rows[0].customers),
      products: Number(rows[0].products),
      inventory_snapshots: Number(rows[0].inventory),
    };
  }
  if (provider === 'recharge') {
    const { rows } = await query<{ subs: string; events: string }>(
      `SELECT (SELECT count(*) FROM subscriptions       WHERE account_id = $1) AS subs,
              (SELECT count(*) FROM subscription_events WHERE account_id = $1) AS events`,
      [accountId],
    );
    return { subscriptions: Number(rows[0].subs), subscription_events: Number(rows[0].events) };
  }
  const { rows } = await query<{ campaigns: string; stats: string }>(
    `SELECT (SELECT count(*) FROM campaigns      WHERE account_id = $1) AS campaigns,
            (SELECT count(*) FROM campaign_stats WHERE account_id = $1) AS stats`,
    [accountId],
  );
  return { campaigns: Number(rows[0].campaigns), campaign_stats: Number(rows[0].stats) };
}

// Imported from queues.ts rather than re-spelled here: a job id that does not
// match the one the enqueue used makes progress silently report "no job".
const JOB_IDS: Record<Provider, (accountId: number) => string> = {
  shopify: backfillJobId,
  recharge: rechargeBackfillJobId,
  klaviyo: klaviyoBackfillJobId,
};

const QUEUE_FACTORIES: Record<Provider, () => any> = {
  shopify: backfillQueue,
  recharge: rechargeBackfillQueue,
  klaviyo: klaviyoPollQueue,
};

/**
 * CLIENT-FACING progress. Contains no queue identifiers, no raw errors, no
 * database internals — only states, real counts, and a safe message (D9).
 */
export async function getClientProgress(accountId: number): Promise<ProviderProgress[]> {
  const statuses = await getProviderStatuses(accountId);
  const out: ProviderProgress[] = [];

  for (const s of statuses) {
    if (s.state === 'skipped') {
      out.push({ provider: s.provider, state: 'skipped', counts: {}, lastSyncAt: null });
      continue;
    }
    if (s.state === 'requested') {
      out.push({ provider: s.provider, state: 'requested', counts: {}, lastSyncAt: null });
      continue;
    }
    if (s.state === 'undecided') {
      out.push({ provider: s.provider, state: 'not_started', counts: {}, lastSyncAt: null });
      continue;
    }

    const counts = await countsFor(accountId, s.provider);
    const hasRows = Object.values(counts).some((n) => n > 0);
    const job = await readJob(QUEUE_FACTORIES[s.provider], JOB_IDS[s.provider](accountId));
    const state = classify(job, true, s.lastSyncAt, hasRows);
    out.push({
      provider: s.provider,
      state,
      counts,
      lastSyncAt: s.lastSyncAt,
      ...(state === 'failed' ? { message: SAFE_FAILURE_MESSAGE } : {}),
    });
  }
  return out;
}

/** AGENCY-FACING progress: everything above plus technical detail (D6/D8). */
export async function getAgencyProgress(accountId: number): Promise<AgencyProviderDetail[]> {
  const client = await getClientProgress(accountId);
  const out: AgencyProviderDetail[] = [];

  for (const p of client) {
    const jobId = JOB_IDS[p.provider](accountId);
    const job = await readJob(QUEUE_FACTORIES[p.provider], jobId);
    const { rows: errors } = await query<{ job_type: string; error: string; created_at: Date }>(
      `SELECT job_type, error, created_at FROM sync_errors
        WHERE account_id = $1 AND job_type LIKE $2
        ORDER BY created_at DESC LIMIT 5`,
      [accountId, `${p.provider}%`],
    );
    out.push({
      ...p,
      jobId: job.id,
      jobState: job.state,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      recentErrors: errors,
    });
  }
  return out;
}

/** Is any provider mid-sync? Feeds the `syncStillRunning` UI flag. */
export function isSyncRunning(progress: ProviderProgress[]): boolean {
  return progress.some((p) => ['waiting', 'syncing', 'retrying', 'sync_delayed'].includes(p.state));
}
