import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import {
  requireOnboardingLink, rejectClientAccountId, issueOnboardingSession,
  clearOnboardingSession, GENERIC_LINK_ERROR,
} from '../onboarding/session.js';
import { resolveToken, linkLiveness, markFirstUsed, markLinkCompleted } from '../onboarding/links.js';
import { connectKlaviyo, connectRecharge } from '../onboarding/connect.js';
import {
  getProviderStatuses, isProvider, setSkipped, setShopifyRequested, isConnected,
  type Provider,
} from '../onboarding/choices.js';
import { normalizeShopDomain, findDomainConflict, domainConflictMessage } from '../onboarding/domain.js';
import {
  canCompleteOnboarding, getRcmReadiness, markOnboardingComplete, deriveUiStates,
} from '../onboarding/state.js';
import { getCapabilities } from '../onboarding/capabilities.js';
import { getClientProgress, isSyncRunning } from '../onboarding/progress.js';
import { getSkuCoverage, getAccountCosts } from '../onboarding/costs.js';
import { getCoverageWindow, listAdSpend, SUGGESTED_CHANNELS } from '../onboarding/adspend.js';
import { setManualCurrency, getCurrencyState } from '../onboarding/currency.js';
import {
  handleCogsWrite, handleOcasWrite, handleAdSpendWrite, handleZeroConfirm,
} from './agencyOnboarding.js';
import { enforceManageMode, deriveManageMode } from '../onboarding/manageMode.js';

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
//   5. Every authenticated route below declares a `clientAction`, and
//      enforceManageMode refuses one that does not. Manage-mode permissions are
//      never a hand-written boolean in a handler — see onboarding/manageMode.ts.

/** account_id, always from the session. Never a parameter. */
function acct(req: FastifyRequest): number {
  // requireOnboardingLink guarantees this; the throw is a coding-error tripwire.
  if (!req.onboarding) throw new Error('onboarding principal missing');
  return req.onboarding.accountId;
}

/** The client principal. Same tripwire as acct(). */
function principal(req: FastifyRequest) {
  if (!req.onboarding) throw new Error('onboarding principal missing');
  return req.onboarding;
}

/**
 * The three lifecycle facts, in the one shape both `/onboarding/session` and
 * `/onboarding/me` return (§5.4 / 5C-1).
 *
 * Built in one function so the two responses cannot drift, and so a browser
 * restoring state from `/onboarding/me` alone sees exactly what the exchange
 * would have told it. `completedByThisLink` is reported separately from
 * `manageMode` on purpose: only the former may be used to claim that this link
 * completed anything.
 */
function lifecycleFields(facts: {
  onboardingComplete: boolean;
  completedByThisLink: boolean;
  expiresAt: Date;
}) {
  return {
    onboardingComplete: facts.onboardingComplete,
    completedByThisLink: facts.completedByThisLink,
    manageMode: deriveManageMode(facts),
    expiresAt: facts.expiresAt,
  };
}

/** Client-facing provider names. The client already knows which one it asked about. */
const PROVIDER_LABELS: Record<Provider, string> = {
  shopify: 'Shopify',
  klaviyo: 'Klaviyo',
  recharge: 'Recharge',
};

/**
 * THE manage-mode connected-provider refusal, shared by every route that would
 * otherwise change a provider that is already connected (§5.4.4: in manage mode a
 * connected provider may not be re-connected, marked requested, or marked
 * skipped).
 *
 * ONE query, ONE message, three call sites — not because repetition is ugly, but
 * because the manage-mode test and the connectedness test have to stay bound
 * together. Either one alone is a different, wrong rule: connectedness alone
 * would break first-time credential rotation, and manage mode alone would freeze
 * providers the client is still allowed to connect.
 *
 * Returns null when the action is permitted, so callers read as a guard clause:
 *   - before Gate 1 — always null. Reconnecting to rotate a credential is
 *     unchanged first-time setup behaviour and is NOT touched here.
 *   - in manage mode — null unless the provider is genuinely connected. An
 *     unconnected `requested` or `skipped` provider stays fully editable.
 *
 * Call this BEFORE reading the request body, so a refusal never depends on — or
 * acknowledges — a submitted credential, and never runs verification against a
 * provider API. The response carries a stable code and a fixed sentence: no
 * account id, no link id, no credential, no connection row, no allowlist detail.
 */
async function refuseIfAlreadyConnected(
  req: FastifyRequest,
  provider: Provider,
): Promise<{ code: 'provider_already_connected'; message: string } | null> {
  const session = principal(req);
  if (!session.manageMode) return null;
  if (!(await isConnected(session.accountId, provider))) return null;
  return {
    code: 'provider_already_connected',
    message:
      `${PROVIDER_LABELS[provider]} is already connected. ` +
      'Ask your account manager to change it.',
  };
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

      const { rows } = await query<{ name: string; onboarding_complete: boolean }>(
        'SELECT name, onboarding_complete FROM accounts WHERE id = $1',
        [resolved.link.account_id],
      );
      // Workspace name is revealed ONLY after the token validates.
      //
      // manageMode here is the SAME derivation the per-request guard uses, read
      // from the same two columns — so a freshly exchanged session and an
      // already-open one cannot disagree, and re-exchanging a token on a
      // completed account cannot hand back unrestricted setup access.
      return reply.send({
        workspaceName: rows[0]?.name ?? null,
        ...lifecycleFields({
          onboardingComplete: rows[0]?.onboarding_complete === true,
          completedByThisLink: resolved.link.completed_at !== null,
          expiresAt: resolved.link.expires_at,
        }),
      });
    },
  );

  // -------------------------------------------------------------------------
  // Everything below requires the scoped session
  // -------------------------------------------------------------------------
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireOnboardingLink);
    scoped.addHook('preHandler', rejectClientAccountId);
    // Third, so it runs with a resolved principal and a rejected account
    // identifier already handled. Registered as a plugin-wide hook rather than
    // per handler: a route cannot forget to apply it, and a route that forgets
    // to DECLARE its action is refused by it.
    scoped.addHook('preHandler', enforceManageMode);

    scoped.post(
      '/onboarding/logout',
      { config: { clientAction: 'session.logout' } },
      async (req, reply) => {
        // Clears ONLY the onboarding cookie. An agency session in another tab is
        // untouched (Correction 5).
        clearOnboardingSession(reply);
        return reply.send({ ok: true });
      },
    );

    scoped.get(
      '/onboarding/me',
      { config: { clientAction: 'status.read' } },
      async (req, reply) => {
        const accountId = acct(req);
        const session = principal(req);
        const [account, completion, readiness, capabilities, progress, currency] =
          await Promise.all([
            query<{ name: string; store_timezone: string }>(
              'SELECT name, store_timezone FROM accounts WHERE id = $1', [accountId],
            ),
            canCompleteOnboarding(accountId, { linkId: session.linkId, accountId }),
            getRcmReadiness(accountId),
            getCapabilities(accountId),
            getClientProgress(accountId),
            getCurrencyState(accountId),
          ]);

        // The lifecycle facts come from the PRINCIPAL, not from a second
        // isOnboardingComplete() read. One read per request means the mode this
        // response reports is provably the mode the guard just enforced.
        const lifecycle = lifecycleFields(session);

        // NOTE: no account_id, no link id, no credentials, no queue ids here.
        return reply.send({
          workspaceName: account.rows[0]?.name ?? null,
          storeTimezone: account.rows[0]?.store_timezone ?? null,
          currency: currency?.currency ?? null,
          currencySource: currency?.currency_source ?? null,
          ...lifecycle,
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
            onboardingComplete: lifecycle.onboardingComplete,
            shopifyConnected: readiness.details.shopifyConnected,
            rcmReady: readiness.ready,
            syncRunning: isSyncRunning(progress),
          }),
        });
      },
    );

    scoped.get(
      '/onboarding/progress',
      { config: { clientAction: 'progress.read' } },
      async (req, reply) => {
        return reply.send(await getClientProgress(acct(req)));
      },
    );

    // ---------------------------------------------------------------------
    // Connections
    // ---------------------------------------------------------------------

    // D10: the client's OWN key is required. No env fallback exists on this path,
    // so a blank field fails safely instead of binding the agency's dev-store
    // credentials to this account.
    scoped.post(
      '/onboarding/connections/klaviyo',
      { config: { clientAction: 'connections.klaviyo.connect' } },
      async (req, reply) => {
        const accountId = acct(req);
        const refusal = await refuseIfAlreadyConnected(req, 'klaviyo');
        if (refusal) return reply.code(409).send(refusal);
        const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
        const result = await connectKlaviyo(
          accountId,
          { apiKey: typeof apiKey === 'string' ? apiKey : '' },
        );
        if (!result.ok) {
          return reply.code(result.code === 'verification_failed' ? 502 : 400)
            .send({ connected: false, code: result.code, message: result.message });
        }
        return reply.code(result.queued ? 202 : 200).send({
          connected: true,
          queued: result.queued,
          providers: await getProviderStatuses(accountId),
        });
      },
    );

    scoped.post(
      '/onboarding/connections/recharge',
      { config: { clientAction: 'connections.recharge.connect' } },
      async (req, reply) => {
        const accountId = acct(req);
        const refusal = await refuseIfAlreadyConnected(req, 'recharge');
        if (refusal) return reply.code(409).send(refusal);
        const token = (req.body as { token?: unknown } | undefined)?.token;
        const result = await connectRecharge(
          accountId,
          { token: typeof token === 'string' ? token : '' },
        );
        if (!result.ok) {
          return reply.code(result.code === 'verification_failed' ? 502 : 400)
            .send({ connected: false, code: result.code, message: result.message });
        }
        return reply.code(result.queued ? 202 : 200).send({
          connected: true,
          queued: result.queued,
          providers: await getProviderStatuses(accountId),
        });
      },
    );

    /**
     * D11: agency-assisted Shopify. The client confirms the permanent
     * myshopify.com domain and nothing else — Shopify app secrets are never
     * shown to or accepted from a client, and this is honestly presented as
     * "awaiting agency setup" rather than a one-click install that does not exist.
     */
    scoped.post(
      '/onboarding/connections/shopify/request',
      { config: { clientAction: 'connections.shopify.request' } },
      async (req, reply) => {
        const accountId = acct(req);
        // FIRST, before the body is read at all: a connected Shopify store cannot
        // be re-requested from a manage-mode link. Refusing here means no domain
        // is parsed, no conflict lookup runs, and setShopifyRequested is never
        // reached — so the refusal provably writes no provider-choice row and
        // cannot disturb the existing requested_domain.
        const refusal = await refuseIfAlreadyConnected(req, 'shopify');
        if (refusal) return reply.code(409).send(refusal);

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
      },
    );

    scoped.post(
      '/onboarding/connections/:provider/skip',
      { config: { clientAction: 'connections.choice.skip' } },
      async (req, reply) => {
        const accountId = acct(req);
        const provider = (req.params as { provider?: string }).provider;
        if (!isProvider(provider)) {
          return reply.code(400).send({ error: 'bad_provider' });
        }
        // §5.4.4: marking a CONNECTED provider skipped is denied in manage mode.
        // The refusal returns before setSkipped, so the connections row is never
        // read for writing, never altered and never deleted — the provider stays
        // connected, and disconnect remains an agency operation outside Phase 5C.
        // An unconnected `requested` provider is untouched by this and may still
        // become `skipped`.
        const refusal = await refuseIfAlreadyConnected(req, provider);
        if (refusal) return reply.code(409).send(refusal);

        // A skip records intent in onboarding_provider_choices ONLY — no
        // credential-less connections row, so sync workers never see it (D1/D20).
        await setSkipped(accountId, provider);
        return reply.send({
          provider, state: 'skipped',
          providers: await getProviderStatuses(accountId),
        });
      },
    );

    // ---------------------------------------------------------------------
    // Currency (E4: only asked when a money input needs it)
    // ---------------------------------------------------------------------

    scoped.put(
      '/onboarding/currency',
      { config: { clientAction: 'currency.update' } },
      async (req, reply) => {
        // setManualCurrency is the guard for §5.4.7: it refuses to overwrite a
        // Shopify-authoritative currency and preserves both sides of a mismatch,
        // so manage mode grants the MANUAL update only — mismatch resolution
        // stays agency-only without a second rule here.
        const result = await setManualCurrency(
          acct(req), (req.body as { currency?: unknown })?.currency,
        );
        if (!result.ok) return reply.code(400).send(result);
        return reply.send(result);
      },
    );

    // ---------------------------------------------------------------------
    // Costs and ad spend — same handlers as the agency routes, so validation
    // has exactly one implementation.
    // ---------------------------------------------------------------------

    scoped.get(
      '/onboarding/skus',
      { config: { clientAction: 'costs.read' } },
      async (req, reply) => {
        // Scoped to this account by getSkuCoverage's WHERE account_id — a client
        // cannot reach another account's SKUs.
        return reply.send(await getSkuCoverage(acct(req)));
      },
    );

    scoped.get(
      '/onboarding/costs',
      { config: { clientAction: 'costs.read' } },
      async (req, reply) => {
        const accountId = acct(req);
        return reply.send({
          costs: await getAccountCosts(accountId),
          coverage: await getSkuCoverage(accountId),
        });
      },
    );

    scoped.put(
      '/onboarding/cogs',
      { config: { clientAction: 'cogs.update' } },
      async (req, reply) => handleCogsWrite(acct(req), req, reply),
    );

    scoped.put(
      '/onboarding/ocas',
      { config: { clientAction: 'ocas.update' } },
      async (req, reply) => handleOcasWrite(acct(req), req, reply),
    );

    scoped.get(
      '/onboarding/ad-spend',
      { config: { clientAction: 'ad_spend.read' } },
      async (req, reply) => {
        const accountId = acct(req);
        return reply.send({
          rows: await listAdSpend(accountId),
          coverage: await getCoverageWindow(accountId),
          suggestedChannels: SUGGESTED_CHANNELS,
        });
      },
    );

    scoped.put(
      '/onboarding/ad-spend',
      { config: { clientAction: 'ad_spend.update' } },
      async (req, reply) => handleAdSpendWrite(acct(req), req, reply),
    );

    scoped.post(
      '/onboarding/ad-spend/zero',
      { config: { clientAction: 'ad_spend.zero_confirm' } },
      async (req, reply) => handleZeroConfirm(acct(req), req, reply),
    );

    // ---------------------------------------------------------------------
    // Completion
    // ---------------------------------------------------------------------

    scoped.post(
      '/onboarding/complete',
      { config: { clientAction: 'completion.submit' } },
      async (req, reply) => {
        const accountId = acct(req);
        const session = principal(req);
        const completion = await canCompleteOnboarding(accountId, {
          linkId: session.linkId,
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
        // Stamps completed_at only when it is still null (§5.4.1), so repeating
        // this call is idempotent and never moves the first-completion timestamp.
        // Permitted in manage mode by design: it changes the AUDIT fact, not the
        // permission mode, which was already true on the way in.
        await markLinkCompleted(session.linkId);

        const readiness = await getRcmReadiness(accountId);
        return reply.send({
          completed: true,
          rcmReady: readiness.ready,
          rcmBlockers: readiness.blockers,
          capabilities: await getCapabilities(accountId),
        });
      },
    );
  });
}
