import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import { requireAuth } from './auth.js';
import { mintOnboardingLink, listLinks, revokeLink, DEFAULT_TTL_DAYS } from '../onboarding/links.js';
import { canCompleteOnboarding, getRcmReadiness, markOnboardingComplete, isOnboardingComplete, deriveUiStates } from '../onboarding/state.js';
import { getCapabilities } from '../onboarding/capabilities.js';
import { getAgencyProgress, isSyncRunning } from '../onboarding/progress.js';
import { getProviderStatuses, isProvider, setSkipped } from '../onboarding/choices.js';
import { connectShopify } from '../onboarding/connect.js';
import { config } from '../config.js';
import {
  getSkuCoverage, getAccountCosts, setCogsMethod, setBlendedMargin, upsertSkuCosts, setOcas,
  validateBlendedMargin, validateSkuCost, validateOcas, type SkuCostInput,
} from '../onboarding/costs.js';
import {
  getCoverageWindow, parseAdSpendRanges, writeAdSpendRanges, confirmZeroMonths, listAdSpend,
  normalizeMonth, SUGGESTED_CHANNELS,
} from '../onboarding/adspend.js';
import { setManualCurrency, resolveCurrencyMismatch, getCurrencyState } from '../onboarding/currency.js';

// AGENCY-FACING onboarding routes (auth level P: requireAuth / session.userId).
//
// E8: any authenticated user is trusted agency staff. No roles, no
// account-manager permissions in V1.
//
// A scoped onboarding-link session has no session.userId, so requireAuth rejects
// it from every route in this plugin with no additional code — the isolation
// falls out of the existing guard (Correction 5).

async function accountIdParam(req: FastifyRequest, reply: FastifyReply): Promise<number | null> {
  const id = Number((req.params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    await reply.code(400).send({ error: 'bad_account_id' });
    return null;
  }
  const { rowCount } = await query('SELECT 1 FROM accounts WHERE id = $1', [id]);
  if (rowCount === 0) {
    await reply.code(404).send({ error: 'account_not_found' });
    return null;
  }
  return id;
}

export async function agencyOnboardingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // -------------------------------------------------------------------------
  // Onboarding links
  // -------------------------------------------------------------------------

  // The raw token is returned HERE AND ONLY HERE. It is never persisted, never
  // logged, and never retrievable again — reissue is the only recovery.
  app.post('/accounts/:id/onboarding-links', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;

    const body = (req.body ?? {}) as { ttlDays?: unknown };
    let ttlDays = DEFAULT_TTL_DAYS;
    if (body.ttlDays !== undefined) {
      const n = Number(body.ttlDays);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return reply.code(400).send({ error: 'bad_ttl', message: 'ttlDays must be 1-90.' });
      }
      ttlDays = n;
    }

    const link = await mintOnboardingLink(accountId, req.session.userId ?? null, ttlDays);
    return reply.code(201).send({
      id: link.id,
      expiresAt: link.expiresAt,
      token: link.token,
      // Correction 2: the token belongs in the URL FRAGMENT, which browsers never
      // send to the server, so it cannot reach access logs, proxy logs, or a
      // referer header. There is deliberately no /onboarding/c/:token route.
      url: `${config.appBaseUrl}/onboarding#token=${link.token}`,
      note: 'The token is shown once and cannot be retrieved again. Reissue if lost.',
    });
  });

  app.get('/accounts/:id/onboarding-links', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send(await listLinks(accountId));
  });

  /**
   * Revoke a link — ACCOUNT-SCOPED.
   *
   * This replaced an unscoped `DELETE /onboarding-links/:linkId`, which let any
   * authenticated caller revoke any link in the system by guessing a small
   * integer. E8 does treat every authenticated user as trusted agency staff, so
   * that was not a privilege escalation — but it made the account in the URL
   * decorative, and "the frontend only ever sends ids it read from this
   * account" is not an access control. The old route is gone rather than kept
   * as a deprecated alias: no consumer existed (the Phase 5B frontend is not
   * built yet), so this is the cheapest moment in the project's life to fix the
   * shape.
   *
   * A link belonging to another account is indistinguishable from one that
   * never existed — both are 404 `link_not_found` — so this route cannot be
   * used to probe which link ids are real.
   */
  app.delete('/accounts/:id/onboarding-links/:linkId', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    const linkId = Number((req.params as { linkId?: string }).linkId);
    if (!Number.isInteger(linkId) || linkId <= 0) {
      return reply.code(400).send({ error: 'bad_link_id' });
    }
    const ok = await revokeLink(accountId, linkId);
    if (!ok) return reply.code(404).send({ error: 'link_not_found' });
    return reply.send({ revoked: true, id: linkId });
  });

  // -------------------------------------------------------------------------
  // Status, readiness, capabilities, progress
  // -------------------------------------------------------------------------

  app.get('/accounts/:id/onboarding/status', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;

    const [completion, readiness, capabilities, progress, complete, links] = await Promise.all([
      canCompleteOnboarding(accountId),
      getRcmReadiness(accountId),
      getCapabilities(accountId),
      getAgencyProgress(accountId),
      isOnboardingComplete(accountId),
      listLinks(accountId),
    ]);

    return reply.send({
      onboardingComplete: complete,
      // TWO separate blocker groups, never merged (D12).
      onboardingBlockers: completion.blockers,
      rcmReadiness: { ready: readiness.ready, blockers: readiness.blockers, details: readiness.details },
      providers: completion.providers,
      capabilities,
      progress,
      links,
      uiStates: deriveUiStates({
        onboardingComplete: complete,
        shopifyConnected: readiness.details.shopifyConnected,
        rcmReady: readiness.ready,
        syncRunning: isSyncRunning(progress),
      }),
    });
  });

  app.get('/accounts/:id/rcm-readiness', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send(await getRcmReadiness(accountId));
  });

  app.get('/accounts/:id/capabilities', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send(await getCapabilities(accountId));
  });

  app.get('/accounts/:id/progress', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send(await getAgencyProgress(accountId));
  });

  app.post('/accounts/:id/onboarding/complete', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;

    // Recomputed server-side; the caller's view of the world is irrelevant.
    const completion = await canCompleteOnboarding(accountId);
    if (!completion.complete) {
      return reply.code(409).send({
        completed: false,
        onboardingBlockers: completion.blockers,
      });
    }
    await markOnboardingComplete(accountId);
    const readiness = await getRcmReadiness(accountId);
    return reply.send({
      completed: true,
      rcmReady: readiness.ready,
      rcmBlockers: readiness.blockers,
    });
  });

  // -------------------------------------------------------------------------
  // Provider connections (agency-operated)
  // -------------------------------------------------------------------------

  /**
   * Agency-operated Shopify connection (D11 Option A).
   *
   * Per-store custom-app credentials. E10: env credentials are used ONLY when the
   * caller explicitly opts in with useEnvCredentials:true — never implicitly, and
   * never on a client-facing route.
   */
  app.post('/accounts/:id/connections/shopify/credentials', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;

    const body = (req.body ?? {}) as {
      shopDomain?: unknown; clientId?: unknown; clientSecret?: unknown;
      useEnvCredentials?: unknown; mode?: unknown;
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

    const result = await connectShopify(
      accountId,
      { shopDomain, clientId, clientSecret },
      { mode: body.mode === 'sync' ? 'sync' : 'queue' },
    );
    if (!result.ok) {
      return reply.code(result.code === 'verification_failed' ? 502 : 400).send(result);
    }
    return reply.code(result.queued ? 202 : 200).send(result);
  });

  // Klaviyo and Recharge are connected through the existing agency routes
  // (POST /connections/klaviyo, POST /connections/recharge), which now delegate to
  // the same shared services. They are deliberately NOT duplicated here.

  app.post('/accounts/:id/connections/:provider/skip', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    const provider = (req.params as { provider?: string }).provider;
    if (!isProvider(provider)) return reply.code(400).send({ error: 'bad_provider' });
    await setSkipped(accountId, provider);
    return reply.send({ provider, state: 'skipped', providers: await getProviderStatuses(accountId) });
  });

  // -------------------------------------------------------------------------
  // Currency
  // -------------------------------------------------------------------------

  app.get('/accounts/:id/currency', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send(await getCurrencyState(accountId));
  });

  app.put('/accounts/:id/currency', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    const result = await setManualCurrency(accountId, (req.body as { currency?: unknown })?.currency);
    if (!result.ok) return reply.code(400).send(result);
    return reply.send(result);
  });

  // E5: mismatch resolution is AGENCY-ONLY. A client is never asked to adjudicate
  // which currency their existing cost figures were entered in.
  app.post('/accounts/:id/currency/resolve-mismatch', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    const result = await resolveCurrencyMismatch(accountId);
    if (!result.ok) return reply.code(409).send(result);
    return reply.send({ ...result, rcmReadiness: await getRcmReadiness(accountId) });
  });

  // -------------------------------------------------------------------------
  // Costs
  // -------------------------------------------------------------------------

  app.get('/accounts/:id/skus', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send(await getSkuCoverage(accountId));
  });

  app.get('/accounts/:id/costs', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send({
      costs: await getAccountCosts(accountId),
      coverage: await getSkuCoverage(accountId),
    });
  });

  app.put('/accounts/:id/costs', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return handleCogsWrite(accountId, req, reply);
  });

  app.put('/accounts/:id/costs/ocas', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return handleOcasWrite(accountId, req, reply);
  });

  // -------------------------------------------------------------------------
  // Ad spend
  // -------------------------------------------------------------------------

  app.get('/accounts/:id/ad-spend', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return reply.send({
      rows: await listAdSpend(accountId),
      coverage: await getCoverageWindow(accountId),
      suggestedChannels: SUGGESTED_CHANNELS,
    });
  });

  app.put('/accounts/:id/ad-spend', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return handleAdSpendWrite(accountId, req, reply);
  });

  app.post('/accounts/:id/ad-spend/zero', async (req, reply) => {
    const accountId = await accountIdParam(req, reply);
    if (accountId === null) return;
    return handleZeroConfirm(accountId, req, reply);
  });
}

// ---------------------------------------------------------------------------
// Shared handlers — used verbatim by the client routes so both surfaces enforce
// identical validation (there is exactly one implementation of each rule).
// ---------------------------------------------------------------------------

export async function handleCogsWrite(
  accountId: number,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (req.body ?? {}) as { method?: unknown; blendedMarginPct?: unknown; skus?: unknown };

  if (body.method === 'blended') {
    const v = validateBlendedMargin(body.blendedMarginPct);
    if (!v.ok) return reply.code(400).send(v);
    await setBlendedMargin(accountId, v.value);
    // E3: per-SKU values are RETAINED, not deleted. cogs_method decides which is
    // active, and the v_active_* views make the inactive set unreadable.
    return reply.send({
      method: 'blended', blendedMarginPct: v.value,
      note: 'Per-SKU costs are retained but inactive while blended margin is selected.',
    });
  }

  if (body.method === 'per_sku') {
    if (!Array.isArray(body.skus)) {
      return reply.code(400).send({ error: 'skus_required', message: 'Provide per-SKU costs.' });
    }
    const parsed: SkuCostInput[] = [];
    for (const row of body.skus) {
      const v = validateSkuCost(row);
      if (!v.ok) return reply.code(400).send(v);
      parsed.push(v.value);
    }
    await setCogsMethod(accountId, 'per_sku');
    const written = await upsertSkuCosts(accountId, parsed);
    if (!written.ok) return reply.code(400).send(written);
    return reply.send({
      method: 'per_sku', written: written.written,
      coverage: await getSkuCoverage(accountId),
      note: 'Blended margin is retained but inactive while per-SKU costs are selected.',
    });
  }

  return reply.code(400).send({
    error: 'bad_method',
    message: "method must be 'per_sku' or 'blended'.",
  });
}

export async function handleOcasWrite(
  accountId: number,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (req.body ?? {}) as { ocasMonthly?: unknown; confirmedZero?: unknown };
  const v = validateOcas(body.ocasMonthly, body.confirmedZero === true);
  if (!v.ok) return reply.code(400).send(v);
  await setOcas(accountId, v.value.ocas, v.value.confirmedZero);
  return reply.send({ ocasMonthly: v.value.ocas, confirmedZero: v.value.confirmedZero });
}

export async function handleAdSpendWrite(
  accountId: number,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (req.body ?? {}) as { rows?: unknown };
  const window = await getCoverageWindow(accountId);
  const parsed = parseAdSpendRanges(body.rows, window.currentMonth);
  if (!parsed.ok) return reply.code(400).send(parsed);

  const result = await writeAdSpendRanges(accountId, parsed.entries);
  return reply.send({ ...result, coverage: await getCoverageWindow(accountId) });
}

export async function handleZeroConfirm(
  accountId: number,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const body = (req.body ?? {}) as { months?: unknown; replace?: unknown; confirmedZero?: unknown };

  // Never infer zero: the caller must state it outright (D3/D5).
  if (body.confirmedZero !== true) {
    return reply.code(400).send({
      error: 'zero_unconfirmed',
      message: 'Confirm that advertising spend for these months was genuinely zero.',
    });
  }
  if (!Array.isArray(body.months) || body.months.length === 0) {
    return reply.code(400).send({ error: 'months_required', message: 'Select at least one month.' });
  }
  const months: string[] = [];
  for (const m of body.months) {
    const v = normalizeMonth(m);
    if (!v.ok) return reply.code(400).send(v);
    months.push(v.value);
  }

  const result = await confirmZeroMonths(accountId, months, { replace: body.replace === true });
  if (!result.ok) return reply.code(409).send(result);
  return reply.send({ ...result, coverage: await getCoverageWindow(accountId) });
}
