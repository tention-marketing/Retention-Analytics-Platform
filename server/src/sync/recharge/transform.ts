/**
 * Recharge API → DB transforms.
 *
 * Recharge payloads differ subtly across API versions and objects, so every
 * field read here is defensive: we check the 2021-11 shape first and fall back
 * to older aliases. Nothing invents data — a missing field becomes null.
 *
 * Identity fields (§4.4): a subscription's Shopify customer id comes from the
 * Recharge *customer* record (external_customer_id.ecommerce), which is why the
 * backfill builds a customer map first and passes it in here. The email is used
 * as the case-insensitive fallback link when that id is absent.
 */

export interface SubscriptionRow {
  id: string;
  recharge_customer_id: string | null;
  shopify_customer_id: number | null;
  email: string | null;
  product_id: number | null;
  plan_type: string | null;
  status: string | null;
  started_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  acquisition_channel: string | null;
}

export interface SubscriptionEventRow {
  subscription_id: string;
  event_type: 'created' | 'cancelled' | 'charge' | 'billing_reminder' | 'delivered';
  occurred_at: string;
}

// Recharge customer id -> the identity we can attach to a subscription.
export interface CustomerIdentity {
  email: string | null;
  shopify_customer_id: number | null;
}

function toBigIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// external_*_id is `{ ecommerce: "123" }` in 2021-11; older payloads expose a
// flat `shopify_customer_id` / `shopify_product_id`.
function externalEcommerceId(external: any, legacy: unknown): number | null {
  return toBigIntOrNull(external?.ecommerce ?? legacy);
}

/** Human-readable plan label from Recharge's interval unit + frequency. */
export function derivePlanType(unit: unknown, frequency: unknown): string | null {
  const u = typeof unit === 'string' ? unit.toLowerCase() : null;
  const f = Number(frequency);
  if (!u || !Number.isFinite(f)) return null;
  if (u === 'month') {
    if (f === 1) return 'monthly';
    if (f === 3) return 'quarterly';
    if (f === 6) return 'biannual';
    if (f === 12) return 'annual';
  }
  if (u === 'week') {
    if (f === 1) return 'weekly';
    if (f === 2) return 'biweekly';
  }
  if (u === 'day' && f === 1) return 'daily';
  return `every_${f}_${u}`; // generic, still queryable
}

export function transformCustomer(c: any): { id: string; identity: CustomerIdentity } | null {
  const id = c?.id != null ? String(c.id) : null;
  if (!id) return null;
  const email = typeof c.email === 'string' ? c.email : null;
  return {
    id,
    identity: {
      email,
      shopify_customer_id: externalEcommerceId(c.external_customer_id, c.shopify_customer_id),
    },
  };
}

/**
 * Map a Recharge subscription. `identity` is the resolved customer identity
 * (from the customer map) when available; the subscription's own fields are the
 * fallback.
 */
export function transformSubscription(s: any, identity?: CustomerIdentity): SubscriptionRow | null {
  const id = s?.id != null ? String(s.id) : null;
  if (!id) return null;

  const rechargeCustomerId = s.customer_id != null ? String(s.customer_id) : null;
  const email = identity?.email ?? (typeof s.email === 'string' ? s.email : null);
  const shopifyCustomerId =
    identity?.shopify_customer_id ??
    externalEcommerceId(s.external_customer_id, s.shopify_customer_id);

  // Interval fields describe the delivery cadence; charge_interval mirrors it
  // for most plans. Prefer order_interval_* (the fulfillment cadence).
  const planType = derivePlanType(
    s.order_interval_unit,
    s.order_interval_frequency ?? s.charge_interval_frequency,
  );

  return {
    id,
    recharge_customer_id: rechargeCustomerId,
    shopify_customer_id: shopifyCustomerId,
    email,
    product_id: externalEcommerceId(s.external_product_id, s.shopify_product_id),
    plan_type: planType,
    status: typeof s.status === 'string' ? s.status.toLowerCase() : null,
    started_at: s.created_at ?? null,
    cancelled_at: s.cancelled_at ?? null,
    cancel_reason: s.cancellation_reason ?? s.cancellation_reason_comments ?? null,
    // Recharge does not expose a per-subscription acquisition channel; left null
    // (source-agnostic — a later refinement can derive it from charge UTMs).
    acquisition_channel: null,
  };
}

// created + cancelled markers come straight off the subscription object.
export function subscriptionLifecycleEvents(s: SubscriptionRow): SubscriptionEventRow[] {
  const events: SubscriptionEventRow[] = [];
  if (s.started_at) events.push({ subscription_id: s.id, event_type: 'created', occurred_at: s.started_at });
  if (s.cancelled_at) events.push({ subscription_id: s.id, event_type: 'cancelled', occurred_at: s.cancelled_at });
  return events;
}

// A charge/order line item points back at its subscription; the field name has
// drifted across versions (subscription_id -> purchase_item_id).
function lineItemSubscriptionId(li: any): string | null {
  const v = li?.subscription_id ?? li?.purchase_item_id;
  return v != null ? String(v) : null;
}

/**
 * Charge → events. A processed (SUCCESS) charge yields a `charge` marker per
 * subscription line item; a QUEUED upcoming charge yields a `billing_reminder`
 * marker at its scheduled date (the rebill the customer is about to be hit
 * with — a strong churn signal when a cancellation lands just before it).
 */
export function chargeEvents(charge: any): SubscriptionEventRow[] {
  const status = typeof charge?.status === 'string' ? charge.status.toLowerCase() : '';
  const lineItems: any[] = Array.isArray(charge?.line_items) ? charge.line_items : [];
  const out: SubscriptionEventRow[] = [];

  for (const li of lineItems) {
    const subId = lineItemSubscriptionId(li);
    if (!subId) continue;
    if (status === 'success' || status === 'partially_refunded' || status === 'refunded') {
      const when = charge.processed_at ?? charge.updated_at ?? charge.scheduled_at;
      if (when) out.push({ subscription_id: subId, event_type: 'charge', occurred_at: when });
    } else if (status === 'queued' && charge.scheduled_at) {
      out.push({ subscription_id: subId, event_type: 'billing_reminder', occurred_at: charge.scheduled_at });
    }
  }
  return out;
}

/** Order → `delivered` events, where a shipped/processed date is exposed. */
export function orderEvents(order: any): SubscriptionEventRow[] {
  const when = order?.shipped_date ?? order?.processed_at ?? null;
  if (!when) return [];
  const lineItems: any[] = Array.isArray(order?.line_items) ? order.line_items : [];
  const out: SubscriptionEventRow[] = [];
  for (const li of lineItems) {
    const subId = lineItemSubscriptionId(li);
    if (subId) out.push({ subscription_id: subId, event_type: 'delivered', occurred_at: when });
  }
  return out;
}
