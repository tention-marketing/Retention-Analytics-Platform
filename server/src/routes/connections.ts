import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { requireAuth } from './auth.js';
import { upsertShopifyAppConnection, upsertRechargeConnection } from '../db/connections.js';
import { verifyShopifyConnection } from '../sync/shopify/client.js';
import { verifyRechargeConnection } from '../sync/recharge/client.js';
import { enqueueBackfill, enqueueRechargeBackfill } from '../queue/queues.js';
import { runShopifyBackfill } from '../sync/shopify/backfill.js';
import { runRechargeBackfill } from '../sync/recharge/backfill.js';
import { getRechargeIdentityStats } from '../identity/graph.js';

// Store a Shopify connection and kick off sync. This is the plumbing behind
// onboarding step 1 (§5); the wizard UI itself is Phase 5.
//
// Auth is the custom app's client_credentials grant: the client_id/secret live
// in env (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET), the Admin API access token
// is minted + refreshed on demand by sync/shopify/token.ts. The request only
// needs the account and (optionally) an explicit shop domain.
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/connections/shopify', async (req, reply) => {
    const { accountId, shopDomain: shopDomainArg, mode } = (req.body ?? {}) as {
      accountId?: unknown; shopDomain?: unknown; mode?: unknown;
    };
    if (typeof accountId !== 'number') {
      return reply.code(400).send({ error: 'accountId (number) required' });
    }
    const shopDomain =
      (typeof shopDomainArg === 'string' && shopDomainArg.trim()) || config.shopifyShopDomain;
    if (!shopDomain) {
      return reply.code(400).send({ error: 'shopDomain required (body or SHOPIFY_SHOP_DOMAIN)' });
    }
    if (!config.shopifyClientId || !config.shopifyClientSecret) {
      return reply.code(400).send({
        error: 'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set in the environment',
      });
    }

    const acct = await query('SELECT id FROM accounts WHERE id = $1', [accountId]);
    if (acct.rowCount === 0) return reply.code(404).send({ error: 'account not found' });

    // Confirm the credentials work (token exchange + a read) before persisting.
    let shop;
    try {
      shop = await verifyShopifyConnection({
        shopDomain,
        app: { clientId: config.shopifyClientId, clientSecret: config.shopifyClientSecret },
      });
    } catch (err) {
      return reply.code(502).send({
        connected: false,
        error: `Shopify verification failed: ${(err as Error).message}`,
      });
    }

    await upsertShopifyAppConnection(
      accountId,
      shopDomain,
      config.shopifyClientId,
      config.shopifyClientSecret,
    );

    // mode=sync runs the backfill inline (handy for pilot verification without a
    // worker process); default enqueues it for the worker to pick up.
    if (mode === 'sync') {
      const result = await runShopifyBackfill(accountId);
      return reply.code(200).send({ connected: true, shop, backfill: result });
    }
    try {
      await enqueueBackfill(accountId);
      return reply.code(202).send({ connected: true, shop, queued: true });
    } catch (err) {
      return reply.code(200).send({
        connected: true, shop, queued: false, note: 'stored; enqueue failed (is Redis up?)',
      });
    }
  });

  // Onboarding step 3 (§5): connect Recharge. The token comes from the request
  // body or falls back to RECHARGE_API_TOKEN in env.
  app.post('/connections/recharge', async (req, reply) => {
    const { accountId, token: tokenArg, mode } = (req.body ?? {}) as {
      accountId?: unknown; token?: unknown; mode?: unknown;
    };
    if (typeof accountId !== 'number') {
      return reply.code(400).send({ error: 'accountId (number) required' });
    }
    const token = (typeof tokenArg === 'string' && tokenArg.trim()) || config.rechargeApiToken;
    if (!token) {
      return reply.code(400).send({ error: 'token required (body or RECHARGE_API_TOKEN)' });
    }

    const acct = await query('SELECT id FROM accounts WHERE id = $1', [accountId]);
    if (acct.rowCount === 0) return reply.code(404).send({ error: 'account not found' });

    let store;
    try {
      store = await verifyRechargeConnection({ token });
    } catch (err) {
      return reply.code(502).send({ connected: false, error: `Recharge verification failed: ${(err as Error).message}` });
    }

    await upsertRechargeConnection(accountId, token);

    if (mode === 'sync') {
      const result = await runRechargeBackfill(accountId);
      return reply.code(200).send({ connected: true, store, backfill: result });
    }
    try {
      await enqueueRechargeBackfill(accountId);
      return reply.code(202).send({ connected: true, store, queued: true });
    } catch (err) {
      return reply.code(200).send({
        connected: true, store, queued: false, note: 'stored; enqueue failed (is Redis up?)',
      });
    }
  });

  // Surface the identity-graph unmatched rate (§4.4: flag when >5%).
  app.get('/connections/recharge/identity-status', async (req, reply) => {
    const accountId = Number((req.query as { accountId?: string }).accountId);
    if (!Number.isFinite(accountId)) {
      return reply.code(400).send({ error: 'accountId query param required' });
    }
    return getRechargeIdentityStats(accountId);
  });
}
