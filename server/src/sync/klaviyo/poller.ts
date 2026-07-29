import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import { getKlaviyoConnection, markSynced } from '../../db/connections.js';
import { fetchAllPages, fetchReport, type KlaviyoConnection } from './client.js';
import {
  V1_CHANNELS, REPORT_STATISTICS,
  transformCampaign, transformFlow, rollUpReport, withRecipients, toStatsRow,
  pickConversionMetric,
  type CampaignRow, type CampaignStatsRow, type KlaviyoChannel, type RolledStats,
} from './transform.js';
import { upsertCampaigns, upsertCampaignStats } from './persist.js';
import { measureKlaviyoIdentityMatch, type KlaviyoIdentityStats } from '../../identity/graph.js';
import { logSyncError } from '../errors.js';

/**
 * Klaviyo light poller (§4.2) — every 6h.
 *
 * Imports campaign + flow LISTS with send timestamps, plus per-campaign AGGREGATE
 * stats. Nothing event-level: no /api/events call exists in this phase, per §0.1
 * (deferred to V2) and the campaign_stats schema note.
 *
 * REQUEST BUDGET is the governing design constraint. The two values-report
 * endpoints allow 1/s burst, 2/min steady and a hard 225 requests/DAY. So this
 * makes exactly ONE grouped report call per object type — group_by campaign_id
 * (+ the mandatory campaign_message_id) and flow_id (+ flow_message_id) — and
 * rolls the message-level rows up in memory. A per-campaign call would blow the
 * daily ceiling at ~56 campaigns and is never done.
 *
 * Steady-state per poll: 1 metrics call (skipped when the metric id is pinned)
 * + 1 campaign list walk + 1 flow list walk + 2 report calls. Four polls a day
 * stays comfortably inside every limit.
 */

const CAMPAIGN_FIELDS = 'name,status,archived,send_time,scheduled_at,created_at,updated_at';
const FLOW_FIELDS = 'name,status,archived,created,updated,trigger_type';

export interface KlaviyoSyncResult {
  campaigns: number;
  flows: number;
  stats: number;
  conversionMetricId: string;
  timeframe: string;
  campaignReportPages: number;
  flowReportPages: number;
  /** Campaigns with no stats row — expected for sends older than the 1y window. */
  campaignsWithoutStats: number;
  identity: KlaviyoIdentityStats | null;
  /**
   * The rolled-up report figures, keyed by campaign/flow id, exactly as they were
   * written to campaign_stats. Exposed so live reconciliation can show
   * `conversions` next to `conversion_uniques` — campaign_stats has ONE
   * conversions column (§3) and which of the two matches the Klaviyo dashboard is
   * decided from evidence — without spending a second report request.
   */
  rolledStats: Map<string, RolledStats>;
}

/**
 * Resolve the conversion metric the reports are scoped to. Pinned value wins;
 * otherwise discover it and refuse to guess when ambiguous (Decision 5).
 */
async function resolveConversionMetricId(conn: KlaviyoConnection): Promise<string> {
  if (config.klaviyoConversionMetricId) return config.klaviyoConversionMetricId;
  const { items } = await fetchAllPages<any>(conn, '/api/metrics', {
    'fields[metric]': 'name,integration',
  });
  return pickConversionMetric(items);
}

function reportBody(
  type: 'campaign-values-report' | 'flow-values-report',
  conversionMetricId: string,
  groupBy: string[],
): unknown {
  return {
    data: {
      type,
      attributes: {
        // Reporting API caps the window at 1 year, so stats cover 12 months.
        timeframe: { key: config.klaviyoReportTimeframe },
        conversion_metric_id: conversionMetricId,
        statistics: [...REPORT_STATISTICS],
        group_by: groupBy,
      },
    },
  };
}

/**
 * Whether to run the (expensive) profile scan on this tick.
 *
 * The poll fires at 00/06/12/18 UTC; running the scan only on the 00 tick gives
 * "at most once daily" with no extra state to persist. `force` is used at connect
 * time and by the verification scripts.
 */
function shouldRunIdentity(force: boolean, hourUtc: number): boolean {
  return force || hourUtc < 6;
}

export interface KlaviyoSyncOptions {
  /** Force the identity scan regardless of the once-daily gate. */
  forceIdentity?: boolean;
  /** Injectable for tests; defaults to the current UTC hour. */
  hourUtc?: number;
}

export async function syncKlaviyo(
  accountId: number,
  conn: KlaviyoConnection,
  jobType: string,
  opts: KlaviyoSyncOptions = {},
): Promise<KlaviyoSyncResult> {
  try {
    const conversionMetricId = await resolveConversionMetricId(conn);

    // --- Lists -------------------------------------------------------------
    // The campaigns endpoint REQUIRES a channel filter, so one walk per channel.
    // V1_CHANNELS is ['email'] — SMS is one array entry away, no migration.
    const campaignRows: CampaignRow[] = [];
    for (const channel of V1_CHANNELS) {
      const { items } = await fetchAllPages<any>(conn, '/api/campaigns', {
        filter: `equals(messages.channel,'${channel}')`,
        'fields[campaign]': CAMPAIGN_FIELDS,
        'page[size]': '100',
        sort: '-created_at',
      });
      for (const c of items) {
        const row = transformCampaign(c, channel as KlaviyoChannel);
        if (row) campaignRows.push(row);
      }
    }

    const { items: flowItems } = await fetchAllPages<any>(conn, '/api/flows', {
      'fields[flow]': FLOW_FIELDS,
      'page[size]': '50', // flows cap at 50/page, unlike campaigns/profiles at 100
    });
    const flowRows: CampaignRow[] = [];
    for (const f of flowItems) {
      const row = transformFlow(f);
      if (row) flowRows.push(row);
    }

    // --- Aggregates: exactly two grouped report calls ----------------------
    const campaignReport = await fetchReport(
      conn,
      '/api/campaign-values-reports',
      reportBody('campaign-values-report', conversionMetricId, ['campaign_id', 'campaign_message_id']),
    );
    const flowReport = await fetchReport(
      conn,
      '/api/flow-values-reports',
      reportBody('flow-values-report', conversionMetricId, ['flow_id', 'flow_message_id']),
    );

    const campaignStats = rollUpReport(campaignReport.results, 'campaign_id');
    const flowStats = rollUpReport(flowReport.results, 'flow_id');

    // --- Merge + persist ---------------------------------------------------
    const statsById = new Map<string, RolledStats>([...campaignStats, ...flowStats]);
    const allRows = [...campaignRows, ...flowRows].map((r) => withRecipients(r, statsById.get(r.id)));
    const statsRows: CampaignStatsRow[] = [];
    for (const r of allRows) {
      const s = statsById.get(r.id);
      if (s) statsRows.push(toStatsRow(r.id, s));
    }

    await withTransaction(async (client) => {
      await upsertCampaigns(client, accountId, allRows);
      await upsertCampaignStats(client, accountId, statsRows);
    });

    // --- Identity seam (measure only, at most once daily) ------------------
    const hourUtc = opts.hourUtc ?? new Date().getUTCHours();
    const identity = shouldRunIdentity(opts.forceIdentity ?? false, hourUtc)
      ? await measureKlaviyoIdentityMatch(accountId, conn)
      : null;

    await markSynced(accountId, 'klaviyo');

    return {
      campaigns: campaignRows.length,
      flows: flowRows.length,
      stats: statsRows.length,
      conversionMetricId,
      timeframe: config.klaviyoReportTimeframe,
      campaignReportPages: campaignReport.pagesFetched,
      flowReportPages: flowReport.pagesFetched,
      campaignsWithoutStats: allRows.filter((r) => !statsById.has(r.id)).length,
      identity,
      rolledStats: statsById,
    };
  } catch (err) {
    // logSyncError stores the message; client.ts has already redacted anything
    // key-shaped out of it before it gets here.
    await logSyncError(accountId, jobType, err);
    throw err;
  }
}

/** 6-hourly poll entry point (§4.2). */
export async function runKlaviyoPoll(
  accountId: number,
  opts: KlaviyoSyncOptions = {},
): Promise<KlaviyoSyncResult> {
  const conn = await getKlaviyoConnection(accountId);
  if (!conn) throw new Error(`no klaviyo connection for account ${accountId}`);
  return syncKlaviyo(accountId, conn, 'klaviyo.poll', opts);
}

/** First sync at connect time — forces the identity measurement. */
export async function runKlaviyoBackfill(
  accountId: number,
  connArg?: KlaviyoConnection,
): Promise<KlaviyoSyncResult> {
  const conn = connArg ?? (await getKlaviyoConnection(accountId));
  if (!conn) throw new Error(`no klaviyo connection for account ${accountId}`);
  return syncKlaviyo(accountId, conn, 'klaviyo.backfill', { forceIdentity: true });
}
