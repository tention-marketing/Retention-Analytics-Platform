import type { FastifyReply, FastifyRequest } from 'fastify';
import { GENERIC_LINK_ERROR } from './session.js';

// Restricted manage mode (CLAUDE.md §5.4).
//
// THE ONE PLACE manageMode IS DERIVED, and the one place the permitted-action
// allowlist lives. Both exist as single definitions on purpose: the previous
// shape of this rule was a `completed_at !== null` expression inlined at the one
// call site that needed it, and a second call site would have been a second
// opinion about what "restricted" means.
//
// manageMode is a PERMISSION STATE. It is not evidence about who completed the
// account — that claim requires completedByThisLink, which is a separate fact
// carried separately on the principal and rendered separately by the UI.

/**
 * Every action an authenticated client onboarding route can perform.
 *
 * A CLOSED VOCABULARY, and route registration is typed against it, so a new
 * route cannot invent an action string that nothing has considered. Adding a
 * member here without adding it to MANAGE_MODE_ALLOWLIST below leaves it denied
 * in manage mode, which is the safe direction for the omission to fail in.
 */
export const CLIENT_ONBOARDING_ACTIONS = [
  'status.read',
  'progress.read',
  'costs.read',
  'ad_spend.read',
  'connections.klaviyo.connect',
  'connections.recharge.connect',
  'connections.shopify.request',
  'connections.choice.request',
  'connections.choice.skip',
  'currency.update',
  'cogs.update',
  'ocas.update',
  'ad_spend.update',
  'ad_spend.zero_confirm',
  'completion.submit',
  'session.logout',
] as const;

export type ClientOnboardingAction = (typeof CLIENT_ONBOARDING_ACTIONS)[number];

// Declaration merging, exactly as @fastify/rate-limit adds `rateLimit` to the
// same interface. This is what makes `config: { clientAction: … }` on a route a
// type-checked declaration rather than a loose string in an options bag.
declare module 'fastify' {
  interface FastifyContextConfig {
    clientAction?: ClientOnboardingAction;
  }
}

/**
 * THE derivation. `onboardingComplete OR completedByThisLink` (§5.4.1).
 *
 * The OR is the whole point. Deriving this from completedByThisLink alone would
 * leave a live link in unrestricted first-time setup mode on an account the
 * agency had already completed — an open editing surface on a finished account.
 * Deriving it from onboardingComplete alone would lose the case where a link
 * completed an account whose latch was somehow never set (defensive case D):
 * the OR keeps that link restricted too, without either fact being rewritten to
 * agree with the other.
 */
export function deriveManageMode(facts: {
  onboardingComplete: boolean;
  completedByThisLink: boolean;
}): boolean {
  return facts.onboardingComplete || facts.completedByThisLink;
}

/**
 * The actions still permitted once manageMode is true (§5.4.4).
 *
 * Every currently implemented action is on this list, because §5.4.4's denials
 * are either resource-state rules (a connected provider cannot be skipped) or
 * routes that do not exist on the client surface at all (disconnect, credential
 * reads, mismatch resolution, analytics, every agency route). That is the
 * intended division of labour and not an oversight:
 *
 *   this allowlist  — is this CATEGORY of action available in manage mode?
 *   the route/domain — is it legal against the CURRENT resource state?
 *
 * Folding state rules in here would mean this set had to know about connection
 * rows and currency authority, and the two layers would drift.
 */
const MANAGE_MODE_ALLOWLIST: ReadonlySet<string> = new Set<ClientOnboardingAction>([
  'status.read',
  'progress.read',
  'costs.read',
  'ad_spend.read',
  'connections.klaviyo.connect',
  'connections.recharge.connect',
  'connections.shopify.request',
  // §5.4.4 allows changing `requested` → `skipped` and `skipped` → `requested`
  // for an UNCONNECTED provider. The connected-provider restriction on both is a
  // resource-state rule enforced at the route, not a category denial here —
  // see the division of labour described above.
  'connections.choice.request',
  'connections.choice.skip',
  'currency.update',
  'cogs.update',
  'ocas.update',
  'ad_spend.update',
  'ad_spend.zero_confirm',
  'completion.submit',
  'session.logout',
]);

export function isAllowedInManageMode(action: unknown): boolean {
  return typeof action === 'string' && MANAGE_MODE_ALLOWLIST.has(action);
}

/**
 * The single manage-mode refusal.
 *
 * A module-level constant so there is exactly one of it and no call site can
 * drift into a variant that says more. It names no action, no allowlist, no
 * reason and no account — a client learns that this link cannot do that, which
 * is all it needs and all it is owed.
 */
export const MANAGE_MODE_DENIED = {
  error: 'action_not_available',
  message: 'This setup link cannot change that. Ask your account manager.',
} as const;

/**
 * preHandler for every authenticated client onboarding route.
 *
 * FAILS CLOSED ON A MISSING DECLARATION, in every mode. A route registered
 * without `config.clientAction` is refused rather than quietly permitted:
 * the alternative is that a forgotten declaration works perfectly until the
 * account completes and then breaks, which is the same bug arriving months
 * later on somebody else's shift. Denying immediately makes the omission a
 * failing check on the first run instead.
 *
 * Registered as a hook on the encapsulated plugin rather than composed into
 * each handler, so a route cannot opt out of it by forgetting to wrap itself —
 * forgetting is what the missing-declaration branch above already catches.
 */
export async function enforceManageMode(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Unreachable in practice: requireOnboardingLink runs first and replies on
  // failure, which stops the hook chain. Treated as a refusal anyway, because
  // the alternative reading of "no principal" is "no restrictions".
  if (!req.onboarding) {
    await reply.code(401).send(GENERIC_LINK_ERROR);
    return;
  }

  const action = req.routeOptions.config?.clientAction;
  if (!isKnownAction(action)) {
    await reply.code(403).send(MANAGE_MODE_DENIED);
    return;
  }

  // Before the account has completed Gate 1 the client is in first-time setup
  // and every declared action is available.
  if (!req.onboarding.manageMode) return;

  if (!isAllowedInManageMode(action)) {
    await reply.code(403).send(MANAGE_MODE_DENIED);
  }
}

function isKnownAction(action: unknown): action is ClientOnboardingAction {
  return (
    typeof action === 'string' &&
    (CLIENT_ONBOARDING_ACTIONS as readonly string[]).includes(action)
  );
}
