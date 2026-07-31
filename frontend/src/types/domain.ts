// Backend-derived domain types.
//
// SCOPE RULE FOR THIS FILE: every type here is traced to a real backend response
// shape, and only the shapes the foundation needs are present. Types for
// accounts, onboarding status, RCM readiness, links, currency, costs and ad
// spend arrive with the checkpoints that actually call those routes — adding
// them now would mean guessing at field-by-field detail with nothing compiling
// against it to catch a mistake.

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
 * GET /auth/me — backend/src/routes/auth.ts.
 *
 * `email` is read from the session and is typed optional there, so it is
 * optional here too rather than being asserted into existence.
 */
export interface AgencyUser {
  id: number;
  email: string | undefined;
}
