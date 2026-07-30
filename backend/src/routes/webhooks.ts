import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { verifyShopifyHmac } from '../crypto.js';
import { getAccountIdByShopDomain } from '../db/connections.js';
import { enqueueWebhook } from '../queue/queues.js';
import { logSyncError } from '../sync/errors.js';

const SUBSCRIBED_TOPICS = new Set([
  'orders/create', 'orders/updated', 'refunds/create', 'customers/update',
]);

/**
 * Shopify webhook receiver. Verifies HMAC over the RAW body, maps the shop
 * domain to an account, enqueues the job, and returns 200 fast (§4.1).
 * - bad/missing HMAC        -> 401 (do not process)
 * - unknown shop / topic    -> 200 ignored (avoid pointless Shopify retries)
 * - enqueue failure         -> 500 (let Shopify retry so we don't drop events)
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Capture the raw body for this scope so HMAC is computed over exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post('/webhooks/shopify', async (req, reply) => {
    const raw: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
    const hmac = req.headers['x-shopify-hmac-sha256'] as string | undefined;
    const topic = req.headers['x-shopify-topic'] as string | undefined;
    const shopDomain = req.headers['x-shopify-shop-domain'] as string | undefined;

    if (!verifyShopifyHmac(raw, hmac, config.shopifyApiSecret)) {
      return reply.code(401).send({ error: 'invalid hmac' });
    }
    if (!topic || !shopDomain) {
      return reply.code(400).send({ error: 'missing topic or shop domain' });
    }
    if (!SUBSCRIBED_TOPICS.has(topic)) {
      return reply.code(200).send({ ignored: true, reason: 'unsubscribed topic' });
    }

    const accountId = await getAccountIdByShopDomain(shopDomain);
    if (accountId == null) {
      return reply.code(200).send({ ignored: true, reason: 'unknown shop' });
    }

    try {
      await enqueueWebhook({ accountId, topic, payload: req.body });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      await logSyncError(accountId, `shopify.webhook.enqueue.${topic}`, err);
      // 500 => Shopify retries; better than silently losing the event.
      return reply.code(500).send({ error: 'enqueue failed' });
    }
  });
}
