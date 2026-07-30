import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import {
  requireOnboardingLink, rejectClientAccountId, issueOnboardingSession,
  clearOnboardingSession, GENERIC_LINK_ERROR,
} from '../onboarding/session.js';
import { resolveToken, linkLiveness, markFirstUsed, markLinkCompleted } from '../onboarding/links.js';
import { connectKlaviyo, connectRecharge } from '../onboarding/connect.js';
import {
  getProviderStatuses, isProvider, setSkipped, setShopifyRequested,
} from '../onboarding/choices.js';
import { normalizeShopDomain, findDomainConflict, domainConflictMessage } from '../onboarding/domain.js';
import {
  canCompleteOnboarding, getRcmReadiness, markOnboardingComplete, isOnboardingComplete,
  deriveUiStates,
} from '../onboarding/state.js';
import { getCapabilities } from '../onboarding/capabilities.js';
import { getClientProgress, isSyncRunning } from '../onboarding/progress.js';
import { getSkuCoverage, getAccountCosts } from '../onboarding/costs.js';
import { getCoverageWindow, listAdSpend, SUGGESTED_CHANNELS } from '../onboarding/adspend.js';
import { setManualCurrency, getCurrencyState } from '../onboarding/currency.js';
import {
  handleCogsWrite, handleOcasWrite, handleAdSpendWrite, handleZeroConfirm,
} from './agencyOnboarding.js';

// CLIENT-FACING onboarding routes (auth level L: scoped onboarding-link session).
//
// SECURITY INVARIANTS FOR THIS ENTIRE FILE:
//   1. account_id comes ONLY from req.onboarding, set by requireOnboardingLink
//      after re-reading the link row. It is never read from a body, query, or
//      path — a request carrying one is REJECTED, not silently ignored.
//   2. Credentials are always explicit. Nothing here consults config.* provider
//      credentials, so a blank field can never bind another brand's data
//      (D10/E10).
//   3. No response exposes account_id, credentials, queue identifiers, raw sync
//      errors, or another workspace's details (D9).
//   4. Expiry and revocation are re-checked on EVERY request, so revoking a link
//      ends an already-open session.

/** account_id, always from the session. Never a parameter. */
function acct(req: FastifyRequest): number {
  // requireOnboardingLink guarantees this; the throw is a coding-error tripwire.
  if (!req.onboarding) throw new Error('onboarding principal missing');
  return req.onboarding.accountId;
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  // Correction 2: no referer leakage of anything in the onboarding URL.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // -------------------------------------------------------------------------
  // Token exchange — the ONLY unauthenticated route here
  // -------------------------------------------------------------------------
  //
  // The token arrives in a POST BODY, never a path or query string (Correction
  // 2), so it cannot appear in access logs, proxy logs, browser history, or a
  // referer header. Fastify does not log bodies, and nothing below logs the
  // token or the cookie.
  //
  // Every failure — malformed, never existed, expired, revoked — returns the same
  // generic response with no workspace name, no account id, and no hint about
  // which reason applied (G).
  app.post(
    '/onboarding/session',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      // Defence in depth: refuse a token supplied via the query string so it can
      // never reach a request log even by client error.
      const q = req.query as Record<string, unknown>;
      if (q && (q.token !== undefined || q.t !== undefined)) {
        return reply.code(400).send({
          error: 'token_must_be_in_body',
          message: 'Send the setup token in the request body, not the URL.',
        });
      }

      const token = (req.body as { token?: unknown } | undefined)?.token;
      const resolved = await resolveToken(token);
      if (!resolved.ok) return reply.code(401).send(GENERIC_LINK_ERROR);
      if (!linkLiveness(resolved.link).ok) return reply.code(401).send(GENERIC_LINK_ERROR);

      await markFirstUsed(resolved.link.id);
      issueOnboardingSession(reply, resolved.link);

      const { rows } = await query<{ name: string }>(
        'SELECT name FROM accounts WHERE id = $1',
        [resolved.link.account_id],
      );
      // Workspace name is revealed ONLY after the token validates.
      return reply.send({
        workspaceName: rows[0]?.name ?? null,
        expiresAt: resolved.link.expires_at,
        manageMode: resolved.link.completed_at !== null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Everything below requires the scoped session
  // -------------------------------------------------------------------------
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireOnboardingLink);
    scoped.addHook('preHandler', rejectClientAccountId);

    scoped.post('/onboarding/logout', async (req, reply) => {
      // Clears ONLY the onboarding cookie. An agency session in another tab is
      // untouched (Correction 5).
      clearOnboardingSession(reply);
      return reply.send({ ok: true });
    });

    scoped.get('/onboarding/me', async (req, reply) => {
      const accountId = acct(req);
      const [account, completion, readiness, capabilities, progress, complete, currency] =
        await Promise.all([
          query<{ name: string; store_timezone: string }>(
            'SELECT name, store_timezone FROM accounts WHERE id = $1', [accountId],
          ),
          canCompleteOnboarding(accountId, { linkId: req.onboarding!.linkId, accountId }),
          getRcmReadiness(accountId),
          getCapabilities(accountId),
          getClientProgress(accountId),
          isOnboardingComplete(accountId),
          getCurrencyState(accountId),
        ]);

      // NOTE: no account_id, no credentials, no queue ids in this payload.
      return reply.send({
        workspaceName: account.rows[0]?.name ?? null,
        storeTimezone: account.rows[0]?.store_timezone ?? null,
        currency: currency?.currency ?? null,
        currencySource: currency?.currency_source ?? null,
        onboardingComplete: complete,
        onboardingBlockers: completion.blockers,
        rcmReady: readiness.ready,
        rcmBlockers: readiness.blockers,
        providers: completion.providers.map((p) => ({
          provider: p.provider,
          state: p.state,
          requestedDomain: p.requestedDomain,
          shopDomain: p.shopDomain,
        })),
        capabilities,
        progress,
        uiStates: deriveUiStates({
          onboardingComplete: complete,
          shopifyConnected: readiness.details.shopifyConnected,
          rcmReady: readiness.ready,
          syncRunning: isSyncRunning(progress),
        }),
      });
    });

    scoped.get('/onboarding/progress', async (req, reply) => {
      return reply.send(await getClientProgress(acct(req)));
    });

    // ---------------------------------------------------------------------
    // Connections
    // ---------------------------------------------------------------------

    // D10: the client's OWN key is required. No env fallback exists on this path,
    // so a blank field fails safely instead of binding the agency's dev-store
    // credentials to this account.
    scoped.post('/onboarding/connections/klaviyo', async (req, reply) => {
      const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
      const result = await connectKlaviyo(
        acct(req),
        { apiKey: typeof apiKey === 'string' ? apiKey : '' },
      );
      if (!result.ok) {
        return reply.code(result.code === 'verification_failed' ? 502 : 400)
          .send({ connected: false, code: result.code, message: result.message });
      }
      return reply.code(result.queued ? 202 : 200).send({
        connected: true,
        queued: result.queued,
        providers: await getProviderStatuses(acct(req)),
      });
    });

    scoped.post('/onboarding/connections/recharge', async (req, reply) => {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      const result = await connectRecharge(
        acct(req),
        { token: typeof token === 'string' ? token : '' },
      );
      if (!result.ok) {
        return reply.code(result.code === 'verification_failed' ? 502 : 400)
          .send({ connected: false, code: result.code, message: result.message });
      }
      return reply.code(result.queued ? 202 : 200).send({
        connected: true,
        queued: result.queued,
        providers: await getProviderStatuses(acct(req)),
      });
    });

    /**
     * D11: agency-assisted Shopify. The client confirms the permanent
     * myshopify.com domain and nothing else — Shopify app secrets are never
     * shown to or accepted from a client, and this is honestly presented as
     * "awaiting agency setup" rather than a one-click install that does not exist.
     */
    scoped.post('/onboarding/connections/shopify/request', async (req, reply) => {
      const accountId = acct(req);
      const domain = normalizeShopDomain((req.body as { shopDomain?: unknown } | undefined)?.shopDomain);
      if (!domain.ok) {
        return reply.code(400).send({ code: domain.error, message: domain.message });
      }
      // Correction 3: reject a domain already connected to, or actively requested
      // by, another account. The unique indexes are the guarantee under races;
      // this is the clean message.
      if (await findDomainConflict(accountId, domain.domain)) {
        return reply.code(409).send({ code: 'domain_conflict', message: domainConflictMessage() });
      }
      try {
        await setShopifyRequested(accountId, domain.domain);
      } catch {
        // Unique-index violation from a concurrent request for the same domain.
        return reply.code(409).send({ code: 'domain_conflict', message: domainConflictMessage() });
      }
      return reply.send({
        state: 'requested',
        shopDomain: domain.domain,
        message: 'Thanks — your account manager will finish connecting this store.',
        providers: await getProviderStatuses(accountId),
      });
    });

    scoped.post('/onboarding/connections/:provider/skip', async (req, reply) => {
      const accountId = acct(req);
      const provider = (req.params as { provider?: string }).provider;
      if (!isProvider(provider)) {
        return reply.code(400).send({ error: 'bad_provider' });
      }
      // A skip records intent in onboarding_provider_choices ONLY — no
      // credential-less connections row, so sync workers never see it (D1/D20).
      await setSkipped(accountId, provider);
      return reply.send({
        provider, state: 'skipped',
        providers: await getProviderStatuses(accountId),
      });
    });

    // ---------------------------------------------------------------------
    // Currency (E4: only asked when a money input needs it)
    // ---------------------------------------------------------------------

    scoped.put('/onboarding/currency', async (req, reply) => {
      const result = await setManualCurrency(
        acct(req), (req.body as { currency?: unknown })?.currency,
      );
      if (!result.ok) return reply.code(400).send(result);
      return reply.send(result);
    });

    // ---------------------------------------------------------------------
    // Costs and ad spend — same handlers as the agency routes, so validation
    // has exactly one implementation.
    // ---------------------------------------------------------------------

    scoped.get('/onboarding/skus', async (req, reply) => {
      // Scoped to this account by getSkuCoverage's WHERE account_id — a client
      // cannot reach another account's SKUs.
      return reply.send(await getSkuCoverage(acct(req)));
    });

    scoped.get('/onboarding/costs', async (req, reply) => {
      const accountId = acct(req);
      return reply.send({
        costs: await getAccountCosts(accountId),
        coverage: await getSkuCoverage(accountId),
      });
    });

    scoped.put('/onboarding/cogs', async (req, reply) => handleCogsWrite(acct(req), req, reply));
    scoped.put('/onboarding/ocas', async (req, reply) => handleOcasWrite(acct(req), req, reply));

    scoped.get('/onboarding/ad-spend', async (req, reply) => {
      const accountId = acct(req);
      return reply.send({
        rows: await listAdSpend(accountId),
        coverage: await getCoverageWindow(accountId),
        suggestedChannels: SUGGESTED_CHANNELS,
      });
    });

    scoped.put('/onboarding/ad-spend', async (req, reply) => handleAdSpendWrite(acct(req), req, reply));
    scoped.post('/onboarding/ad-spend/zero', async (req, reply) => handleZeroConfirm(acct(req), req, reply));

    // ---------------------------------------------------------------------
    // Completion
    // ---------------------------------------------------------------------

    scoped.post('/onboarding/complete', async (req, reply) => {
      const accountId = acct(req);
      const completion = await canCompleteOnboarding(accountId, {
        linkId: req.onboarding!.linkId,
        accountId,
      });
      if (!completion.complete) {
        // Machine-readable 409 (D12). A disabled button is never the control.
        return reply.code(409).send({
          completed: false,
          onboardingBlockers: completion.blockers,
        });
      }
      await markOnboardingComplete(accountId);
      await markLinkCompleted(req.onboarding!.linkId);

      const readiness = await getRcmReadiness(accountId);
      return reply.send({
        completed: true,
        rcmReady: readiness.ready,
        rcmBlockers: readiness.blockers,
        capabilities: await getCapabilities(accountId),
      });
    });
  });
}
