import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getLinkWithAccountState, linkLiveness, type OnboardingLinkRow } from './links.js';
import { deriveManageMode } from './manageMode.js';

// Scoped onboarding session (D2, Correction 5).
//
// DELIBERATELY NOT @fastify/session. Correction 5 requires that opening a client
// onboarding link never converts, replaces, or inherits an agency session, and
// vice versa. @fastify/session owns `request.session` and the `tention_sid`
// cookie for agency staff; registering it twice would collide on that decorator.
// So the onboarding principal is a separate, self-contained mechanism:
//
//   * its own cookie name          — tention_onb   (agency: tention_sid)
//   * its own request decorator    — request.onboarding (agency: request.session)
//   * its own signing              — HMAC-SHA256 over the payload
//   * no shared store              — onboarding_links IS the server-side state
//
// Because the two are completely disjoint, issuing or clearing one provably
// cannot touch the other, and the guards below cannot be satisfied by an agency
// cookie (nor requireAuth by an onboarding cookie).
//
// Storing no session server-side is what makes D2's "expiry and revocation
// checked on every onboarding request" cheap and unavoidable: every request
// re-reads the onboarding_links row.

export const ONBOARDING_COOKIE = 'tention_onb';

/** Uniform client-facing failure. Never says which of the reasons applied. */
export const GENERIC_LINK_ERROR = {
  error: 'invalid_link',
  message: 'This setup link is not valid. Ask your account manager for a new one.',
} as const;

/**
 * The client principal, rebuilt from live table state on every request.
 *
 * The three lifecycle facts are carried here rather than re-queried per handler
 * so that the guard, `/onboarding/me` and every route agree within one request —
 * two reads of the same fact in one request is how a page ends up disagreeing
 * with the permission that was just enforced on it.
 *
 * NONE of these comes from the cookie. See requireOnboardingLink below.
 */
export interface OnboardingPrincipal {
  accountId: number;
  linkId: number;
  /** `accounts.onboarding_complete` — the account passed Gate 1 at least once. */
  onboardingComplete: boolean;
  /** `onboarding_links.completed_at IS NOT NULL` — THIS link completed. Audit fact. */
  completedByThisLink: boolean;
  /** Permission state: onboardingComplete OR completedByThisLink (§5.4.1). */
  manageMode: boolean;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    onboarding: OnboardingPrincipal | null;
  }
}

interface CookiePayload {
  l: number; // link id
  a: number; // account id — carried for defence in depth, re-verified from the DB
  i: number; // issued-at (epoch seconds)
}

function sign(value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function encode(payload: CookiePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

function decode(raw: string | undefined): CookiePayload | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(body);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    const p = parsed as CookiePayload;
    if (typeof p?.l !== 'number' || typeof p?.a !== 'number') return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Issue the scoped cookie after a successful token exchange. maxAge is capped at
 * the link's own expiry so the cookie can never outlive it, and `secure` follows
 * the same rule as the agency cookie.
 */
export function issueOnboardingSession(
  reply: FastifyReply,
  link: OnboardingLinkRow,
): void {
  const remainingMs = link.expires_at.getTime() - Date.now();
  reply.setCookie(
    ONBOARDING_COOKIE,
    encode({ l: link.id, a: link.account_id, i: Math.floor(Date.now() / 1000) }),
    {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: Math.max(1, Math.floor(remainingMs / 1000)),
    },
  );
}

export function clearOnboardingSession(reply: FastifyReply): void {
  reply.clearCookie(ONBOARDING_COOKIE, { path: '/' });
}

/**
 * preHandler for every client-facing onboarding route.
 *
 * Re-reads the link row AND its account's completion latch on every request, so
 * revocation, expiry and the manage-mode transition all take effect inside an
 * already-open session, and re-checks that the row still belongs to the account
 * the cookie claims.
 *
 * THE COOKIE IS NOT AN AUTHORITY ON ANYTHING BUT IDENTITY. It carries a link id,
 * an account id and an issued-at, and the link id is used only to look the row
 * up again. The three lifecycle facts are computed here from that fresh read —
 * never trusted from the cookie, never cached — which is what makes agency
 * completion restrict an open client session on its next request with no
 * re-exchange, and what makes a repeated exchange unable to hand back
 * unrestricted setup access.
 */
export async function requireOnboardingLink(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  req.onboarding = null;

  const payload = decode(req.cookies?.[ONBOARDING_COOKIE]);
  if (!payload) {
    await reply.code(401).send(GENERIC_LINK_ERROR);
    return;
  }

  const resolved = await getLinkWithAccountState(payload.l);
  if (!resolved || resolved.link.account_id !== payload.a) {
    await reply.code(401).send(GENERIC_LINK_ERROR);
    return;
  }
  const { link, onboardingComplete } = resolved;
  if (!linkLiveness(link).ok) {
    // Expired or revoked mid-session: clear the cookie so the browser stops
    // presenting a dead credential.
    clearOnboardingSession(reply);
    await reply.code(401).send(GENERIC_LINK_ERROR);
    return;
  }

  const completedByThisLink = link.completed_at !== null;
  req.onboarding = {
    accountId: link.account_id,
    linkId: link.id,
    onboardingComplete,
    completedByThisLink,
    manageMode: deriveManageMode({ onboardingComplete, completedByThisLink }),
    expiresAt: link.expires_at,
  };
}

/**
 * REQUIRED SECURITY RULE — account_id is never client-controlled.
 *
 * Client-facing routes derive account_id ONLY from the scoped session. A request
 * that carries an account identifier is REJECTED rather than silently ignored:
 * silence would hide a probe, and a 400 makes the attempt visible in logs and
 * provable in tests.
 */
const FORBIDDEN_KEYS = ['accountId', 'account_id', 'account'];

export async function rejectClientAccountId(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sources: unknown[] = [req.body, req.query, req.params];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const key of FORBIDDEN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        await reply.code(400).send({
          error: 'account_identifier_not_permitted',
          message: 'This request must not carry an account identifier.',
        });
        return;
      }
    }
  }
}

/** Register the request decorator. Called once from buildApp(). */
export function registerOnboardingSessionSupport(app: FastifyInstance): void {
  app.decorateRequest('onboarding', null);
}
