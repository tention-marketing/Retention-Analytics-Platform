/**
 * Klaviyo API → DB transforms (§4.2). Pure functions, no I/O.
 *
 * Every field read is defensive: a missing value becomes null (or 0 for a
 * statistic), never an invented number.
 *
 * AGGREGATES ONLY. There is deliberately no event-level mapper in this file —
 * per-open/per-click storage is cut from V1 (§0.1) and deferred to V2, and the
 * campaign_stats schema comment says the same. Nothing here reads /api/events.
 */

/**
 * Channels imported in V1: email only.
 *
 * `campaigns.channel` is a free TEXT column, so adding 'sms' later is a one-line
 * change to this array plus one extra paginated list call — NO migration, and no
 * change to the transforms below, which take the channel as a parameter. (SMS
 * markers as a *feature* stay cut per §0.1; this is only about not painting the
 * schema into a corner.)
 */
export const V1_CHANNELS = ['email'] as const;
export type KlaviyoChannel = (typeof V1_CHANNELS)[number] | 'sms' | 'mobile_push';

/**
 * Statistics requested from both values-report endpoints.
 *
 * `opens_unique`/`clicks_unique` rather than `opens`/`clicks`: Klaviyo's own
 * dashboard headline open/click figures are unique-based, and campaign_stats has
 * one column for each — so storing uniques is what makes the ≤1% reconciliation
 * criterion meaningful rather than guaranteed to fail.
 *
 * `conversions` and `conversion_uniques` are BOTH requested because they cost
 * nothing extra on the same call and the dashboard's "Placed Order" figure can
 * correspond to either depending on how the account reports; the live
 * reconciliation prints both so the right one is chosen from evidence.
 */
export const REPORT_STATISTICS = [
  'recipients',
  'opens_unique',
  'clicks_unique',
  'conversions',
  'conversion_uniques',
  'conversion_value',
] as const;

export interface CampaignRow {
  id: string;
  name: string | null;
  channel: string;
  kind: 'campaign' | 'flow';
  sent_at: string | null;
  recipients: number | null;
}

export interface CampaignStatsRow {
  campaign_id: string;
  opens: number;
  clicks: number;
  /** Total attributed orders for the conversion metric. */
  conversions: number;
  /**
   * Distinct converting customers — what the Klaviyo Overview displays as
   * "Placed order recipients" (confirmed against the dashboard 2026-07-29). Kept
   * alongside `conversions` because orders and customers are different questions;
   * see migration 003.
   */
  conversion_uniques: number;
  revenue: number;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toInt(v: unknown): number {
  return toIntOrNull(v) ?? 0;
}

function toFloat(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** revenue is NUMERIC(12,2). Applied ONCE to a finished sum — see rollUpReport. */
function toMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Campaign → row. `channel` comes from the caller because the list endpoint
 * REQUIRES a channel filter, so we always know which channel we asked for.
 *
 * sent_at ← send_time, falling back to scheduled_at. Klaviyo documents send_time
 * as "when the campaign will be / was sent", so a Scheduled (not yet sent)
 * campaign carries a FUTURE timestamp here. That is stored verbatim rather than
 * nulled — inventing a null would lose real information, and any "sent in period
 * X" query over a past range excludes future dates naturally.
 */
export function transformCampaign(c: any, channel: KlaviyoChannel): CampaignRow | null {
  const id = c?.id != null ? String(c.id) : null;
  if (!id) return null;
  const a = c.attributes ?? {};
  return {
    id,
    name: str(a.name),
    channel,
    kind: 'campaign',
    sent_at: str(a.send_time) ?? str(a.scheduled_at),
    recipients: null, // filled from the values-report roll-up
  };
}

/**
 * Flow → row, stored in the same table under kind='flow'.
 *
 * sent_at is NULL by design: flows are always-on and the Klaviyo flow object
 * exposes only `created`/`updated` — there is no send timestamp to map (verified
 * against revision 2026-07-15). Mapping `created` into sent_at would fabricate a
 * send event, so it stays null.
 */
export function transformFlow(f: any): CampaignRow | null {
  const id = f?.id != null ? String(f.id) : null;
  if (!id) return null;
  const a = f.attributes ?? {};
  return {
    id,
    name: str(a.name),
    channel: 'email', // flow email values are what §4.2 asks for in V1
    kind: 'flow',
    sent_at: null,
    recipients: null,
  };
}

export interface RolledStats {
  recipients: number;
  opens: number; // sum of per-message opens_unique
  clicks: number; // sum of per-message clicks_unique
  conversions: number;
  conversionUniques: number;
  revenue: number;
  /** How many message-level rows folded into this object; useful for debugging. */
  messageRows: number;
}

/**
 * Roll message-level report rows up to the campaign/flow level.
 *
 * Klaviyo FORCES message-level grouping on both report endpoints —
 * `campaign_id` + `campaign_message_id` are mandatory group_by values, as are
 * `flow_id` + `flow_message_id` — so a flow with five emails returns five rows
 * and an A/B-tested campaign returns one row per variation. campaign_stats holds
 * one row per campaign/flow (PK account_id, campaign_id), so the rows are summed
 * here by their parent id.
 *
 * CAVEAT, stated plainly because it affects reconciliation: summing per-message
 * UNIQUE opens is not a true parent-level unique count. A profile that opened two
 * emails in the same flow counts twice. For single-message campaigns (the normal
 * case) parent == message and the sum is exact; for multi-message flows the
 * stored figure is an upper bound on true flow-level uniques.
 */
export function rollUpReport(
  results: Array<{ groupings: Record<string, string>; statistics: Record<string, number> }>,
  idKey: 'campaign_id' | 'flow_id',
): Map<string, RolledStats> {
  const out = new Map<string, RolledStats>();
  for (const row of results ?? []) {
    const id = row?.groupings?.[idKey];
    if (!id) continue;
    const s = row.statistics ?? {};
    const acc = out.get(id) ?? {
      recipients: 0, opens: 0, clicks: 0,
      conversions: 0, conversionUniques: 0, revenue: 0, messageRows: 0,
    };
    acc.recipients += toInt(s.recipients);
    acc.opens += toInt(s.opens_unique);
    acc.clicks += toInt(s.clicks_unique);
    acc.conversions += toInt(s.conversions);
    acc.conversionUniques += toInt(s.conversion_uniques);
    // Accumulate the RAW float and round once below. Rounding each message row
    // before summing double-rounds: 100.005 + 99.995 would store 200.01, not
    // 200.00, and the error grows with the number of messages.
    acc.revenue += toFloat(s.conversion_value);
    acc.messageRows += 1;
    out.set(id, acc);
  }
  for (const [id, acc] of out) out.set(id, { ...acc, revenue: toMoney(acc.revenue) });
  return out;
}

/** Attach report recipients to a campaign/flow row (mutating a copy). */
export function withRecipients(row: CampaignRow, stats: RolledStats | undefined): CampaignRow {
  return { ...row, recipients: stats ? stats.recipients : null };
}

/** Build the campaign_stats row for an id that has report data. */
export function toStatsRow(campaignId: string, stats: RolledStats): CampaignStatsRow {
  return {
    campaign_id: campaignId,
    opens: stats.opens,
    clicks: stats.clicks,
    conversions: stats.conversions,
    conversion_uniques: stats.conversionUniques,
    revenue: stats.revenue,
  };
}

export class AmbiguousConversionMetricError extends Error {}

/**
 * Pick the conversion metric the reports must be scoped to.
 *
 * Both values-report endpoints require a `conversion_metric_id`, and the wrong
 * one silently corrupts `conversions` and `revenue` — so this REFUSES to guess
 * (approved Decision 5). Preference order:
 *   1. a Shopify-integration metric named "Placed Order" (the normal case)
 *   2. any metric named "Placed Order", if exactly one exists
 * Zero or multiple candidates at both steps → throw, telling the operator to set
 * KLAVIYO_CONVERSION_METRIC_ID explicitly.
 */
export function pickConversionMetric(metrics: any[]): string {
  const named = (metrics ?? []).filter(
    (m) => str(m?.attributes?.name)?.trim().toLowerCase() === 'placed order',
  );
  const shopify = named.filter(
    (m) => str(m?.attributes?.integration?.name)?.trim().toLowerCase() === 'shopify',
  );

  const pick = (list: any[]) => (list.length === 1 ? String(list[0].id) : null);
  const chosen = pick(shopify) ?? pick(named);
  if (chosen) return chosen;

  const describe = (m: any) =>
    `${m?.id} (${m?.attributes?.name} / ${m?.attributes?.integration?.name ?? 'no integration'})`;
  throw new AmbiguousConversionMetricError(
    named.length === 0
      ? 'No Klaviyo metric named "Placed Order" found. Set KLAVIYO_CONVERSION_METRIC_ID explicitly.'
      : `Ambiguous "Placed Order" metric — ${named.length} candidates: ` +
        `${named.map(describe).join('; ')}. Set KLAVIYO_CONVERSION_METRIC_ID explicitly.`,
  );
}
