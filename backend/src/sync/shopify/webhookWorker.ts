import { pool, withTransaction } from '../../db/pool.js';
import {
  transformWebhookOrder, transformWebhookCustomer, sumRestRefunds,
} from './transform.js';
import { upsertCustomers, upsertOrdersWithLineItems } from './persist.js';
import { recomputeOrderSequence } from './sequence.js';
import { logSyncError } from '../errors.js';

export interface WebhookJob {
  accountId: number;
  topic: string; // orders/create | orders/updated | refunds/create | customers/update
  payload: any;
}

/**
 * Apply one verified Shopify webhook. orders/* is authoritative for money
 * (current_subtotal_price already nets discounts + refunds); refunds/create is
 * a fast interim adjustment that a trailing orders/updated will overwrite.
 */
export async function processShopifyWebhook(job: WebhookJob): Promise<void> {
  const { accountId, topic, payload } = job;
  try {
    switch (topic) {
      case 'orders/create':
      case 'orders/updated': {
        const { order, lineItems, customer } = transformWebhookOrder(payload);
        await withTransaction(async (client) => {
          if (customer) await upsertCustomers(client, accountId, [customer]);
          await upsertOrdersWithLineItems(client, accountId, [order], lineItems);
          await recomputeOrderSequence(client, accountId, order.customer_id);
        });
        break;
      }
      case 'refunds/create': {
        const orderId = Number(payload.order_id);
        if (!Number.isFinite(orderId)) break;
        const delta = sumRestRefunds([payload]);
        await pool.query(
          `UPDATE orders
              SET refunded_amount = refunded_amount + $3,
                  total_net = total_net - $3
            WHERE account_id = $1 AND id = $2`,
          [accountId, orderId, delta],
        );
        break;
      }
      case 'customers/update': {
        const customer = transformWebhookCustomer(payload);
        if (customer) await upsertCustomers(pool, accountId, [customer]);
        break;
      }
      default:
        // Unhandled topic — ignore quietly (we only subscribe to the four above).
        break;
    }
  } catch (err) {
    await logSyncError(accountId, `shopify.webhook.${topic}`, err, payload);
    throw err;
  }
}
