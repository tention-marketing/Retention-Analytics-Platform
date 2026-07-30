import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from './auth.js';
import { getKlaviyoConnection } from '../db/connections.js';
import { getRechargeIdentityStats, measureKlaviyoIdentityMatch } from '../identity/graph.js';
import {
  connectShopify, connectKlaviyo, connectRecharge, type ConnectMode,
} from '../onboarding/connect.js';

// AGENCY-OPERATED connection routes (auth level P: requireAuth).
//
// Phase 5A turned these into thin delegates over onboarding/connect.ts. The
// verification clients, AES encryption, connection upserts and queue helpers they
// used inline now live in that one shared service, so the client-facing wizard and
// these routes cannot drift apart. Behaviour is otherwise unchanged.
//
// E10 — THE ONE DELIBERATE BEHAVIOUR CHANGE: falling back to provider credentials
// in .env now requires the caller to opt in explicitly with
// `useEnvCredentials: true`. Previously a blank field silently used the env value.
// That implicit fallback is exactly the cross-tenant hazard trap 8 describes, and
// leaving it implicit here — while forbidding it on the client path — is how the
// client path would regress later. Verification scripts and local development set
// the flag, or call the services directly with explicit credentials.
//
// A scoped onboarding-link session carries no session.userId, so requireAuth
// rejects it from every route in this file with no extra code.
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  function readAccountId(body: unknown): number | null {
    const { accountId } = (body ?? {}) as { accountId?: unknown };
    return typeof accountId === 'number' && Number.isInteger(accountId) ? accountId : null;
  }

  function readMode(body: unknown): ConnectMode {
    return (body as { mode?: unknown })?.mode === 'sync' ? 'sync' : 'queue';
  }

  /** Map a shared-service failure onto the status codes these routes always used. */
  function statusFor(code: string): number {
    if (code === 'verification_failed') return 502;
    if (code === 'account_not_found') return 404;
    if (code === 'domain_conflict') return 409;
    return 400;
  }

  app.post('/connections/shopify', async (req, reply) => {
    const accountId = readAccountId(req.body);
    if (accountId === null) {
      return reply.code(400).send({ error: 'accountId (number) required' });
    }
    const body = (req.body ?? {}) as {
      shopDomain?: unknown; clientId?: unknown; clientSecret?: unknown; useEnvCredentials?: unknown;
    };
    const useEnv = body.useEnvCredentials === true;

    const shopDomain = typeof body.shopDomain === 'string' && body.shopDomain.trim()
      ? body.shopDomain.trim()
      : useEnv ? config.shopifyShopDomain : '';
    const clientId = typeof body.clientId === 'string' && body.clientId.trim()
      ? body.clientId.trim()
      : useEnv ? config.shopifyClientId : '';
    const clientSecret = typeof body.clientSecret === 'string' && body.clientSecret.trim()
      ? body.clientSecret.trim()
      : useEnv ? config.shopifyClientSecret : '';

    if (!clientId || !clientSecret) {
      return reply.code(400).send({
        error:
          'clientId and clientSecret required (send them explicitly, or set ' +
          'useEnvCredentials: true to use SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)',
      });
    }

    const result = await connectShopify(
      accountId, { shopDomain, clientId, clientSecret }, { mode: readMode(req.body) },
    );
    if (!result.ok) {
      return reply.code(statusFor(result.code)).send({ connected: false, error: result.message });
    }
    return reply.code(result.queued ? 202 : 200).send({
      connected: true,
      shop: result.shop,
      queued: result.queued,
      ...(result.backfill ? { backfill: result.backfill } : {}),
      ...(result.queueNote ? { note: result.queueNote } : {}),
      currency: result.currency,
      timezoneApplied: result.timezoneApplied,
    });
  });

  app.post('/connections/recharge', async (req, reply) => {
    const accountId = readAccountId(req.body);
    if (accountId === null) {
      return reply.code(400).send({ error: 'accountId (number) required' });
    }
    const body = (req.body ?? {}) as { token?: unknown; useEnvCredentials?: unknown };
    const token = typeof body.token === 'string' && body.token.trim()
      ? body.token.trim()
      : body.useEnvCredentials === true ? config.rechargeApiToken : '';
    if (!token) {
      return reply.code(400).send({
        error:
          'token required (send it explicitly, or set useEnvCredentials: true to use RECHARGE_API_TOKEN)',
      });
    }

    const result = await connectRecharge(accountId, { token }, { mode: readMode(req.body) });
    if (!result.ok) {
      return reply.code(statusFor(result.code)).send({ connected: false, error: result.message });
    }
    return reply.code(result.queued ? 202 : 200).send({
      connected: true,
      store: result.store,
      queued: result.queued,
      ...(result.backfill ? { backfill: result.backfill } : {}),
      ...(result.queueNote ? { note: result.queueNote } : {}),
    });
  });

  // Surface the identity-graph unmatched rate (§4.4: flag when >5%).
  app.get('/connections/recharge/identity-status', async (req, reply) => {
    const accountId = Number((req.query as { accountId?: string }).accountId);
    if (!Number.isFinite(accountId)) {
      return reply.code(400).send({ error: 'accountId query param required' });
    }
    return getRechargeIdentityStats(accountId);
  });

  app.post('/connections/klaviyo', async (req, reply) => {
    const accountId = readAccountId(req.body);
    if (accountId === null) {
      return reply.code(400).send({ error: 'accountId (number) required' });
    }
    const body = (req.body ?? {}) as { apiKey?: unknown; useEnvCredentials?: unknown };
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim()
      ? body.apiKey.trim()
      : body.useEnvCredentials === true ? config.klaviyoApiKey : '';
    if (!apiKey) {
      return reply.code(400).send({
        error:
          'apiKey required (send it explicitly, or set useEnvCredentials: true to use KLAVIYO_API_KEY)',
      });
    }

    const result = await connectKlaviyo(accountId, { apiKey }, { mode: readMode(req.body) });
    if (!result.ok) {
      // The Klaviyo client redacts anything key-shaped before this point.
      return reply.code(statusFor(result.code)).send({ connected: false, error: result.message });
    }
    return reply.code(result.queued ? 202 : 200).send({
      connected: true,
      account: result.account,
      queued: result.queued,
      ...(result.backfill ? { backfill: result.backfill } : {}),
      ...(result.queueNote ? { note: result.queueNote } : {}),
    });
  });

  // Klaviyo profile↔email match rate (§4.4). Nothing is persisted for Klaviyo, so
  // this is an on-demand bounded scan: `partial: true` means the page budget ran
  // out and the rate covers only the profiles scanned.
  app.get('/connections/klaviyo/identity-status', async (req, reply) => {
    const q = req.query as { accountId?: string; pageBudget?: string };
    const accountId = Number(q.accountId);
    if (!Number.isFinite(accountId)) {
      return reply.code(400).send({ error: 'accountId query param required' });
    }
    const conn = await getKlaviyoConnection(accountId);
    if (!conn) return reply.code(404).send({ error: 'no klaviyo connection for account' });

    const budget = Number(q.pageBudget);
    return measureKlaviyoIdentityMatch(
      accountId,
      conn,
      Number.isFinite(budget) && budget > 0 ? budget : undefined,
    );
  });
}
