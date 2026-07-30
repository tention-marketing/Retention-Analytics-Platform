/**
 * Shopify → DB transforms. Two input shapes converge on the same row types:
 *   - GraphQL Bulk Operation JSONL (backfill/reconcile)
 *   - REST webhook payloads (orders/*, refunds/create, customers/update)
 *
 * MONEY DEFINITION (single source of truth — tune here at pilot sign-off):
 *   total_net = current subtotal, i.e. line sales AFTER discounts AND refunds/
 *   returns, EXCLUDING tax and shipping. Shopify's `currentSubtotalPrice`
 *   already reflects edits/returns, so it maps directly.
 *   refunded_amount = total amount refunded on the order.
 * This mirrors Shopify's "Net sales" (gross − discounts − returns) closely
 * enough to hit the §7 "12m net sales within 0.5%" bar; verify against the
 * pilot admin and adjust this one function if the store's reporting differs.
 */

export interface CustomerRow {
  id: number;
  email: string | null;
  created_at: string | null;
}

export interface OrderRow {
  id: number;
  customer_id: number | null;
  created_at: string;
  total_net: number;
  refunded_amount: number;
  cancelled: boolean;
  test: boolean;
}

export interface LineItemRow {
  order_id: number;
  product_id: number;
  product_title: string | null;
  sku: string | null;
  quantity: number;
  price: number;
}

export interface ProductRow {
  id: number;
  title: string | null;
}

// gid://shopify/Order/12345  ->  12345
export function gidToId(gid: string | null | undefined): number | null {
  if (!gid) return null;
  const tail = String(gid).split('/').pop();
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

function money(x: unknown): number {
  const n = typeof x === 'string' ? parseFloat(x) : typeof x === 'number' ? x : 0;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function amountFromSet(set: any): number {
  return money(set?.shopMoney?.amount ?? set?.amount);
}

// ---------------------------------------------------------------------------
// GraphQL Bulk JSONL
// ---------------------------------------------------------------------------
// Bulk results flatten connections: each connection edge becomes its own JSONL
// line carrying `__parentId`. Non-connection nested objects (order.customer,
// lineItem.product) stay inline on their parent's line. We split by gid type.

export interface ParsedBulkOrders {
  orders: OrderRow[];
  lineItems: LineItemRow[];
}

export function parseBulkOrderLines(objects: any[]): ParsedBulkOrders {
  const orders: OrderRow[] = [];
  const lineItems: LineItemRow[] = [];
  for (const obj of objects) {
    const id = gidToId(obj?.id);
    if (id == null) continue;
    const gid = String(obj.id);
    if (gid.includes('/Order/')) {
      orders.push({
        id,
        customer_id: gidToId(obj.customer?.id),
        created_at: obj.createdAt,
        total_net: amountFromSet(obj.currentSubtotalPriceSet),
        refunded_amount: amountFromSet(obj.totalRefundedSet),
        cancelled: obj.cancelledAt != null,
        test: obj.test === true,
      });
    } else if (gid.includes('/LineItem/')) {
      const orderId = gidToId(obj.__parentId);
      const productId = gidToId(obj.product?.id);
      if (orderId == null || productId == null) continue; // custom line items w/o product are skipped
      lineItems.push({
        order_id: orderId,
        product_id: productId,
        product_title: obj.product?.title ?? obj.title ?? null,
        sku: obj.sku ?? null,
        quantity: Number(obj.quantity ?? 0),
        price: amountFromSet(obj.discountedUnitPriceSet ?? obj.originalUnitPriceSet),
      });
    }
  }
  // A single order can list the same product on multiple lines; the line_items
  // PK is (account_id, order_id, product_id), so collapse duplicates by summing
  // quantity and keeping the last price.
  const byKey = new Map<string, LineItemRow>();
  for (const li of lineItems) {
    const key = `${li.order_id}:${li.product_id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += li.quantity;
      existing.price = li.price;
    } else {
      byKey.set(key, { ...li });
    }
  }
  return { orders, lineItems: [...byKey.values()] };
}

export function parseBulkCustomerLines(objects: any[]): CustomerRow[] {
  const out: CustomerRow[] = [];
  for (const obj of objects) {
    const gid = String(obj?.id ?? '');
    if (!gid.includes('/Customer/')) continue;
    const id = gidToId(gid);
    if (id == null) continue;
    out.push({ id, email: obj.email ?? null, created_at: obj.createdAt ?? null });
  }
  return out;
}

export function parseBulkProductLines(objects: any[]): ProductRow[] {
  const out: ProductRow[] = [];
  for (const obj of objects) {
    const gid = String(obj?.id ?? '');
    if (!gid.includes('/Product/')) continue;
    const id = gidToId(gid);
    if (id == null) continue;
    out.push({ id, title: obj.title ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST webhook payloads
// ---------------------------------------------------------------------------

export interface WebhookOrderResult {
  order: OrderRow;
  lineItems: LineItemRow[];
  customer: CustomerRow | null;
}

export function transformWebhookOrder(p: any): WebhookOrderResult {
  const id = Number(p.id);
  const customerId = p.customer?.id != null ? Number(p.customer.id) : null;
  // REST current_subtotal_price already reflects refunds/edits (net of discounts).
  const totalNet = money(p.current_subtotal_price ?? p.subtotal_price);
  const refunded = sumRestRefunds(p.refunds);

  const rawItems: LineItemRow[] = Array.isArray(p.line_items)
    ? p.line_items
        .filter((li: any) => li.product_id != null)
        .map((li: any) => ({
          order_id: id,
          product_id: Number(li.product_id),
          product_title: li.title ?? null,
          sku: li.sku ?? null,
          quantity: Number(li.quantity ?? 0),
          price: money(li.price),
        }))
    : [];
  const byKey = new Map<string, LineItemRow>();
  for (const li of rawItems) {
    const key = `${li.order_id}:${li.product_id}`;
    const ex = byKey.get(key);
    if (ex) {
      ex.quantity += li.quantity;
      ex.price = li.price;
    } else byKey.set(key, li);
  }

  const customer: CustomerRow | null =
    customerId != null
      ? {
          id: customerId,
          email: p.customer?.email ?? p.email ?? null,
          created_at: p.customer?.created_at ?? null,
        }
      : null;

  return {
    order: {
      id,
      customer_id: customerId,
      created_at: p.created_at,
      total_net: totalNet,
      refunded_amount: refunded,
      cancelled: p.cancelled_at != null,
      test: p.test === true,
    },
    lineItems: [...byKey.values()],
    customer,
  };
}

// Sum refunded subtotal (product refunds) across a REST refunds[] array.
export function sumRestRefunds(refunds: any): number {
  if (!Array.isArray(refunds)) return 0;
  let total = 0;
  for (const r of refunds) {
    if (Array.isArray(r.refund_line_items)) {
      for (const rli of r.refund_line_items) {
        total += money(rli.subtotal ?? rli.subtotal_set?.shop_money?.amount);
      }
    }
  }
  return Math.round(total * 100) / 100;
}

export function transformWebhookCustomer(p: any): CustomerRow | null {
  const id = p.id != null ? Number(p.id) : null;
  if (id == null || !Number.isFinite(id)) return null;
  return { id, email: p.email ?? null, created_at: p.created_at ?? null };
}
