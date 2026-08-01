// Backend-derived domain types.
//
// SCOPE RULE FOR THIS FILE: every type here is traced to a real backend response
// shape, and only the shapes the foundation needs are present. Types for
// onboarding status, RCM readiness, links, currency, costs and ad spend arrive
// with the checkpoints that actually call those routes — adding them now would
// mean guessing at field-by-field detail with nothing compiling against it to
// catch a mistake.

/** backend/src/onboarding/choices.ts — PROVIDERS */
export const PROVIDERS = ['shopify', 'klaviyo', 'recharge'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * backend/src/onboarding/choices.ts — ProviderState.
 *
 * Resolved onboarding intent per provider. 'connected' is derived from the
 * `connections` table and always wins over any stored choice.
 */
export const PROVIDER_STATES = ['connected', 'requested', 'skipped', 'undecided'] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

/**
 * backend/src/onboarding/progress.ts — ClientSyncState.
 *
 * Distinct from ProviderState and deliberately NOT merged with it: both include
 * a member called 'connected' meaning different things — here "connected, and no
 * sync is currently running", there "a verified credential exists".
 */
export const SYNC_STATES = [
  'not_started', 'waiting', 'syncing', 'retrying', 'sync_delayed',
  'completed', 'connected', 'failed', 'skipped', 'requested',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** backend/src/onboarding/failures.ts — FailureCategory */
export const FAILURE_CATEGORIES = ['auth', 'rate_limit', 'network', 'provider', 'internal'] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * backend/src/onboarding/failures.ts — SafeFailure.
 *
 * The classified replacement for the raw `failedReason` string and
 * `recentErrors[].error` stack traces that agency progress responses used to
 * return. `publicMessage` is a fixed sentence chosen by the backend from a
 * closed vocabulary and is safe to render verbatim; no field here can contain
 * raw exception text, a filesystem path, or a provider credential.
 *
 * `occurredAt` is nullable in the backend type (null for a live job failure,
 * set from sync_errors.created_at for a historical one) and serializes to an
 * ISO string over JSON.
 */
export interface SafeFailure {
  /** Stable machine code, e.g. 'provider_auth_failed'. Safe to branch on. */
  code: string;
  category: FailureCategory;
  provider: Provider;
  /** Job identifier such as 'klaviyo.backfill'. Fixed vocabulary, no payloads. */
  stage: string;
  /** Whether retrying stands a chance without human intervention. */
  retryable: boolean;
  /** Fixed sentence. Safe to render as-is. */
  publicMessage: string;
  occurredAt: string | null;
}

/**
 * The authenticated agency user. Source: GET /auth/me and POST /auth/login.
 *
 * Exactly two fields. There is no role, permission set, account list,
 * organization, token or session identifier — the backend does not return any
 * of those (its own verification asserts both routes return exactly
 * `{id, email}`), and inventing one here would create a client-side
 * authorization model that no server check stands behind.
 *
 * `email` is required. The backend's session type marks it optional, but both
 * writers set it together with `userId`, and a response missing it is a
 * malformed payload rather than a valid anonymous-ish user — so api/auth.ts
 * validates the shape at the boundary instead of pushing `undefined` into the UI.
 */
export interface AgencyUser {
  id: number;
  email: string;
}

/**
 * A client brand. Source: GET /accounts.
 *
 * backend/src/routes/accounts.ts selects exactly these five columns:
 *
 *   SELECT id, name, store_timezone, onboarding_complete, created_at
 *     FROM accounts ORDER BY id
 *
 * FIVE FIELDS, AND THERE IS NO SIXTH. No revenue, no RCM tier, no provider
 * count, no owner, no completion percentage, no last-sync time, no subscription
 * status. Every one of those is a number an agency would act on, and the backend
 * returns none of them at this checkpoint — a plausible-looking zero in a
 * retention tool is worse than an absent section, because it reads as a finding.
 *
 * SNAKE_CASE ON PURPOSE. These are the wire names, kept as they arrive rather
 * than camel-cased on the way in. `store_timezone` in particular is also the
 * request field POST /accounts expects, and having one spelling of it in the
 * codebase removes the class of bug where the read path and the write path
 * disagree about what the field is called.
 *
 * `created_at` is a TIMESTAMPTZ that serializes to an ISO 8601 string over JSON
 * (verified against the running backend), not a Date — nothing has parsed it.
 */
export interface Account {
  id: number;
  name: string;
  store_timezone: string;
  onboarding_complete: boolean;
  /** ISO 8601, UTC. Rendered in the viewer's locale; never used for math here. */
  created_at: string;
}

/**
 * What POST /accounts returns on 201 — deliberately NOT `Account`.
 *
 * The create handler sends back only `{ id, name, store_timezone }`. It does not
 * echo `onboarding_complete` or `created_at`, so typing the response as a full
 * Account would put `undefined` behind two required fields and render as a blank
 * date and a missing setup state on the page the user lands on. The list query
 * is the thing that knows the whole row, which is why creation invalidates it
 * rather than seeding the new account into the cache from this payload.
 */
export interface CreatedAccount {
  id: number;
  name: string;
  store_timezone: string;
}
