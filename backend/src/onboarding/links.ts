import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';

// Scoped onboarding links (D2).
//
// 32 cryptographically random bytes (256 bits) → base64url. Only sha256(token)
// is persisted, so the raw token cannot be recovered from the database; it is
// returned exactly once, at creation.
//
// The raw token NEVER appears in a URL path (Correction 2): the client sends it
// in a POST body, is issued a scoped httpOnly cookie, and every later request
// uses only that cookie. No route in this codebase accepts a token as a path or
// query parameter, so it cannot reach access logs, proxy logs, or referer
// headers.

const TOKEN_BYTES = 32;
export const DEFAULT_TTL_DAYS = 14;

export interface OnboardingLinkRow {
  id: number;
  account_id: number;
  expires_at: Date;
  revoked_at: Date | null;
  first_used_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  created_by: number | null;
}

/** Every reason a token can fail to resolve. Never sent to a client verbatim. */
export type LinkFailure =
  | 'malformed'
  | 'not_found'
  | 'expired'
  | 'revoked';

export type LinkResolution =
  | { ok: true; link: OnboardingLinkRow }
  | { ok: false; reason: LinkFailure };

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * A token is well-formed if it is base64url of exactly TOKEN_BYTES. Checking
 * shape before touching the database keeps junk input off the hot path and
 * means a malformed token is indistinguishable (to the caller) from a real one
 * that does not exist.
 */
export function isWellFormedToken(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const expectedLen = Math.ceil((TOKEN_BYTES * 4) / 3); // 32 bytes → 43 chars, unpadded
  return raw.length === expectedLen && /^[A-Za-z0-9_-]+$/.test(raw);
}

export interface MintedLink {
  id: number;
  /** Raw token — returned ONCE. Never stored, never logged. */
  token: string;
  expiresAt: Date;
}

export async function mintOnboardingLink(
  accountId: number,
  createdBy: number | null,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<MintedLink> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const { rows } = await query<{ id: number; expires_at: Date }>(
    `INSERT INTO onboarding_links (account_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id, expires_at`,
    [accountId, hashToken(token), createdBy, expiresAt],
  );
  return { id: rows[0].id, token, expiresAt: rows[0].expires_at };
}

/**
 * Resolve a raw token to its link row. Callers MUST collapse every failure
 * reason into one identical client-facing response (§G): the reason exists for
 * agency-side diagnostics and tests, not for the client.
 */
export async function resolveToken(rawToken: unknown): Promise<LinkResolution> {
  if (!isWellFormedToken(rawToken)) return { ok: false, reason: 'malformed' };

  const hash = hashToken(rawToken);
  const { rows } = await query<OnboardingLinkRow & { token_hash: string }>(
    `SELECT * FROM onboarding_links WHERE token_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };

  // The lookup above is an indexed equality match on a hash, which never
  // exposes the secret itself. This second constant-time compare guards against
  // a future change to a non-exact lookup (e.g. a prefix scan).
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(row.token_hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'not_found' };

  return { ok: true, link: row };
}

/** Re-checked on EVERY onboarding request, not only at token exchange (D2). */
export function linkLiveness(link: OnboardingLinkRow, now = new Date()): LinkResolution {
  if (link.revoked_at) return { ok: false, reason: 'revoked' };
  if (link.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, link };
}

export async function getLinkById(linkId: number): Promise<OnboardingLinkRow | null> {
  const { rows } = await query<OnboardingLinkRow>(
    `SELECT * FROM onboarding_links WHERE id = $1`,
    [linkId],
  );
  return rows[0] ?? null;
}

/**
 * The account fields a client session needs, once the account has been PROVEN
 * loadable. Reaching this type at all is the proof — see safeAccountState().
 */
export interface SafeAccountState {
  /** `accounts.name`. NOT NULL in the schema, so a loaded account always has one. */
  name: string;
  /** `accounts.onboarding_complete` — a real boolean, never an absent value. */
  onboardingComplete: boolean;
}

/**
 * THE safety predicate (Phase 5C-4). One definition, two call shapes below.
 *
 * WHY A NULL LATCH IS UNSAFE RATHER THAN FALSE. `accounts.onboarding_complete`
 * is `BOOLEAN DEFAULT false` and NULLABLE, and a LEFT JOIN against a missing
 * account produces exactly the same NULL. Both used to be flattened by
 * `onboarding_complete === true`, which reads either one as `false` — and per
 * §5.4.1 a false latch means manageMode is false, which is UNRESTRICTED
 * first-time setup access. So the one value meaning "this account's lifecycle
 * cannot be determined" was granting the widest permission the client surface
 * has. It is now refused instead.
 *
 * A genuine stored `false` is untouched and remains completely valid: the
 * distinction is between a boolean that was read and a value that was absent.
 */
function safeAccountState(
  name: string | null | undefined,
  onboardingComplete: boolean | null | undefined,
): SafeAccountState | null {
  if (typeof name !== 'string') return null;
  // Deliberately a type check, not a truthiness check: `false` must pass.
  if (typeof onboardingComplete !== 'boolean') return null;
  return { name, onboardingComplete };
}

/**
 * The account state behind an already-resolved link, or null when it cannot be
 * safely loaded. Used by the token-exchange route, which has the link row from
 * resolveToken() and needs only the account half.
 *
 * Callers MUST collapse a null into the same neutral client failure every other
 * link fault produces: whether an account is missing is not a client's business
 * (§5.4.8).
 */
export async function loadSafeAccountState(accountId: number): Promise<SafeAccountState | null> {
  const { rows } = await query<{ name: string | null; onboarding_complete: boolean | null }>(
    `SELECT name, onboarding_complete FROM accounts WHERE id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  return safeAccountState(row.name, row.onboarding_complete);
}

/**
 * A DISCRIMINATED UNION, not a nullable field.
 *
 * `account` exists only on the ok branch, so a caller cannot read the
 * completion latch without having handled the unsafe case first — the compiler
 * enforces what a comment used to ask for. `reason` is for server-side
 * diagnostics only and must never reach a client.
 */
export type LinkAccountLoad =
  | { ok: true; link: OnboardingLinkRow; account: SafeAccountState }
  | { ok: false; reason: 'link_not_found' | 'account_unsafe' };

/**
 * The link row plus its account's safely-loaded state, in ONE round trip.
 *
 * This is what every authenticated client request reads (session.ts), because
 * all three lifecycle facts have to come from live table state rather than from
 * the cookie: agency completion must restrict an already-open client session on
 * its very next request, and a stored copy of the latch could not do that.
 *
 * LEFT JOIN, and NOT because an orphan is expected. `onboarding_links.account_id`
 * carries a foreign key to `accounts(id)`; because no ON DELETE action is
 * specified, PostgreSQL's default NO ACTION applies and the database REFUSES to
 * delete an account while any onboarding link still references it. Normal
 * account deletion therefore cannot produce an orphaned link — the delete fails
 * instead, or the links are removed first.
 *
 * The LEFT JOIN is kept purely as defence in depth against database state this
 * code did not create: a manually inconsistent row, legacy data predating the
 * constraint, or an externally modified database. Phase 5C-4 completes that
 * defence — such a row now yields `account_unsafe` and is refused, rather than
 * reading as not-complete and handing back unrestricted setup access.
 */
export async function getLinkWithAccountState(linkId: number): Promise<LinkAccountLoad> {
  const { rows } = await query<OnboardingLinkRow & {
    account_name: string | null; onboarding_complete: boolean | null;
  }>(
    `SELECT l.*, a.name AS account_name, a.onboarding_complete
       FROM onboarding_links l
       LEFT JOIN accounts a ON a.id = l.account_id
      WHERE l.id = $1`,
    [linkId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'link_not_found' };
  const { account_name, onboarding_complete, ...link } = row;
  const account = safeAccountState(account_name, onboarding_complete);
  if (!account) return { ok: false, reason: 'account_unsafe' };
  return { ok: true, link: link as OnboardingLinkRow, account };
}

export async function markFirstUsed(linkId: number): Promise<void> {
  await query(
    `UPDATE onboarding_links SET first_used_at = now()
      WHERE id = $1 AND first_used_at IS NULL`,
    [linkId],
  );
}

export async function markLinkCompleted(linkId: number): Promise<void> {
  await query(
    `UPDATE onboarding_links SET completed_at = now()
      WHERE id = $1 AND completed_at IS NULL`,
    [linkId],
  );
}

/**
 * Revoke a link, scoped to its owning account.
 *
 * account_id is part of the WHERE clause rather than checked in the route,
 * so ownership is enforced by the statement that does the write and cannot be
 * bypassed by a caller that forgets to check first. There is deliberately no
 * unscoped variant of this function: an id-only revoke is exactly the shape a
 * future caller would reach for and get wrong.
 *
 * Idempotent (`COALESCE(revoked_at, now())` — re-revoking keeps the original
 * timestamp). Returns false both when the link does not exist and when it
 * belongs to another account, so callers cannot distinguish the two.
 */
export async function revokeLink(accountId: number, linkId: number): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE onboarding_links SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND account_id = $2`,
    [linkId, accountId],
  );
  return (rowCount ?? 0) > 0;
}

export type LinkStatus = 'active' | 'expired' | 'revoked';

export interface LinkSummary {
  id: number;
  status: LinkStatus;
  expires_at: Date;
  revoked_at: Date | null;
  first_used_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

/** Agency-facing listing. Deliberately returns neither the token nor its hash. */
export async function listLinks(accountId: number): Promise<LinkSummary[]> {
  const { rows } = await query<OnboardingLinkRow>(
    `SELECT id, account_id, created_by, expires_at, revoked_at, first_used_at,
            completed_at, created_at
       FROM onboarding_links WHERE account_id = $1 ORDER BY id DESC`,
    [accountId],
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    status: r.revoked_at ? 'revoked' : r.expires_at.getTime() <= now ? 'expired' : 'active',
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    first_used_at: r.first_used_at,
    completed_at: r.completed_at,
    created_at: r.created_at,
  }));
}
