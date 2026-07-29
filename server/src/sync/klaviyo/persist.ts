import type { PoolClient } from 'pg';
import { bulkUpsert } from '../../db/upserts.js';
import type { CampaignRow, CampaignStatsRow } from './transform.js';

type Queryable = Pick<PoolClient, 'query'>;

const CAMPAIGN_COLS = ['account_id', 'id', 'name', 'channel', 'kind', 'sent_at', 'recipients'];
const STATS_COLS = ['account_id', 'campaign_id', 'opens', 'clicks',
  'conversions', 'conversion_uniques', 'revenue'];

/**
 * Upsert campaigns and flows into the single `campaigns` table, distinguished by
 * `kind` (the table's CHECK allows 'campaign'|'flow' only).
 *
 * Idempotent per §2: ON CONFLICT (account_id, id) DO UPDATE. Update-not-ignore is
 * deliberate — a campaign's name can be edited and its recipient count keeps
 * accruing while a send is in flight, so a re-poll must refresh in place.
 *
 * Rows are de-duplicated on the conflict key first: Postgres rejects touching the
 * same row twice inside one ON CONFLICT statement, and a campaign id could in
 * principle repeat across channel queries.
 */
export async function upsertCampaigns(
  db: Queryable,
  accountId: number,
  rows: CampaignRow[],
): Promise<number> {
  const seen = new Set<string>();
  const values: unknown[][] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    values.push([accountId, r.id, r.name, r.channel, r.kind, r.sent_at, r.recipients]);
  }
  return bulkUpsert(db, 'campaigns', CAMPAIGN_COLS, ['account_id', 'id'], values);
}

/**
 * Upsert per-campaign aggregate stats. AGGREGATES ONLY (§0.1 / schema note):
 * five numbers per campaign, no event-level rows anywhere.
 *
 * `conversions` (total orders) and `conversion_uniques` (distinct customers, the
 * dashboard's "Placed order recipients") are both stored — see migration 003.
 */
export async function upsertCampaignStats(
  db: Queryable,
  accountId: number,
  rows: CampaignStatsRow[],
): Promise<number> {
  const seen = new Set<string>();
  const values: unknown[][] = [];
  for (const r of rows) {
    if (seen.has(r.campaign_id)) continue;
    seen.add(r.campaign_id);
    values.push([accountId, r.campaign_id, r.opens, r.clicks,
      r.conversions, r.conversion_uniques, r.revenue]);
  }
  return bulkUpsert(db, 'campaign_stats', STATS_COLS, ['account_id', 'campaign_id'], values);
}
