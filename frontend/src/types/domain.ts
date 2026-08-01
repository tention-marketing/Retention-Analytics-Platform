// Backend-derived domain types.
//
// SCOPE RULE FOR THIS FILE: every type here is traced to a real backend response
// shape, and only the shapes a built screen needs are present. Types for
// currency, costs and ad spend arrive with the checkpoints that actually call
// those routes — adding them now would mean guessing at field-by-field detail
// with nothing compiling against it to catch a mistake.
//
// THE OMISSIONS ARE DELIBERATE AND LOAD-BEARING. Several fields the backend does
// return are absent here on purpose, because a field that has no type cannot be
// rendered by accident: the agency progress payload's `jobId`, `jobState` and
// `attemptsMade` are queue internals, and the minted link's `token` is a secret
// that must not survive past validation. Adding any of them back is a decision,
// not a convenience.

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

// ---------------------------------------------------------------------------
// Onboarding links
// ---------------------------------------------------------------------------

/**
 * backend/src/onboarding/links.ts — LinkStatus.
 *
 * Derived by the backend on every read from `revoked_at` and `expires_at`. The
 * frontend NEVER recomputes it: a client's clock, a stale cache and a timezone
 * are three ways to disagree with the server about whether a link is still live,
 * and the server is the one enforcing it.
 */
export const LINK_STATUSES = ['active', 'expired', 'revoked'] as const;
export type OnboardingLinkStatus = (typeof LINK_STATUSES)[number];

/**
 * One row of GET /accounts/:id/onboarding-links, newest first (the backend
 * orders by `id DESC`).
 *
 * SNAKE_CASE because that is what the wire carries — listLinks() returns the
 * column names. Note what is NOT here and never will be: `token`, `token_hash`,
 * `created_by`, `account_id`, or anything from which a setup URL could be
 * rebuilt. The backend does not send the first two at all; the api/onboarding.ts
 * parser treats their appearance as a malformed response rather than dropping
 * them quietly, because a token in a list payload is a backend regression and
 * not something to paper over.
 *
 * `completed_at` and `status` are INDEPENDENT facts: a client can finish setup
 * while the link stays active, so the UI shows both rather than inferring one
 * from the other.
 */
export interface OnboardingLinkSummary {
  id: number;
  status: OnboardingLinkStatus;
  /** ISO 8601. */
  expires_at: string;
  revoked_at: string | null;
  first_used_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/**
 * A freshly minted link, AFTER validation and after the raw token has been
 * dropped.
 *
 * POST /accounts/:id/onboarding-links answers with
 * `{ id, expiresAt, token, url, note }`. `token` is deliberately absent from
 * this type: the only thing any component needs is the assembled one-time `url`,
 * and a separately addressable token is a second copy of the secret with its own
 * chances of being logged, stored or rendered. `url` is the server's own string
 * passed through unchanged after validation — never reassembled here, because a
 * link rebuilt from parts is a link the server did not issue.
 *
 * This value must never enter the query cache, the mutation cache, a query key,
 * a URL, history state, or any browser storage. See features/onboarding/
 * useOnboardingLinks.ts for the mechanism that keeps it in component memory only.
 */
export interface IssuedOnboardingLink {
  id: number;
  /** ISO 8601. */
  expiresAt: string;
  /** The full one-time setup URL, `<base>/onboarding#token=<43-char token>`. */
  url: string;
}

// ---------------------------------------------------------------------------
// Agency onboarding status
// ---------------------------------------------------------------------------

/**
 * backend/src/onboarding/state.ts — Blocker.
 *
 * `message` is written by the backend for display and is safe to render;
 * `detail` is machine-readable context whose shape varies per code, so the UI
 * reads only the specific keys it understands rather than rendering the object.
 */
export interface OnboardingBlocker {
  code: string;
  message: string;
  step: string | null;
  /**
   * Allowlisted context only — see api/onboarding.ts. The backend's `detail`
   * carries different keys per blocker (`providers`, `months`, `skus`,
   * `coveragePct`, …); anything not on the allowlist is dropped at the boundary
   * so no unrecognised object can reach a component and be stringified onto the
   * page.
   */
  detail: OnboardingBlockerDetail | null;
}

/** The only `detail` keys any UI here reads. Everything else is discarded. */
export interface OnboardingBlockerDetail {
  providers?: Provider[];
  months?: string[];
  skus?: string[];
}

/**
 * backend/src/onboarding/state.ts — the RCM gate.
 *
 * SEPARATE FROM ONBOARDING COMPLETION, and modelled separately so the two can
 * never be merged by accident. A brand can finish client onboarding with only
 * Klaviyo connected and still be nowhere near an RCM figure; presenting one
 * state would tell an agency their analytics were blocked when setup was fine,
 * or that setup was incomplete when only the cost inputs were missing.
 *
 * `details` is not modelled: it is the cost-coverage and ad-spend arithmetic
 * behind the blockers, and rendering any of it would be the RCM interface this
 * checkpoint does not build.
 */
export interface RcmReadiness {
  ready: boolean;
  blockers: OnboardingBlocker[];
}

/**
 * backend/src/onboarding/choices.ts — ProviderStatus.
 *
 * Read-only in this checkpoint. `connectionStatus` is the stored
 * `connections.status` string; it is modelled because it is real, and it is not
 * rendered as a health word — "connected" is the only thing the backend claims,
 * and calling that "healthy" would be an assertion nothing stands behind.
 */
export interface ProviderStatusSummary {
  provider: Provider;
  state: ProviderState;
  connectionStatus: string | null;
  requestedDomain: string | null;
  shopDomain: string | null;
  /** ISO 8601, or null when the provider has never synced. */
  lastSyncAt: string | null;
}

/**
 * backend/src/onboarding/progress.ts — AgencyProviderDetail, MINUS the queue
 * internals.
 *
 * `jobId`, `jobState` and `attemptsMade` are on the wire and are dropped at the
 * boundary: they are BullMQ identifiers, they mean nothing to an agency user,
 * and a job id on screen is an internal handle in a screenshot.
 *
 * `counts` are REAL imported row counts. There is no total to divide them by —
 * a Shopify Bulk Operation does not report one — so there is no percentage and
 * no progress bar anywhere in this feature. An invented completion figure in a
 * product whose premise is honest data completeness is the worst possible lie.
 */
export interface ProviderSyncProgress {
  provider: Provider;
  state: SyncState;
  counts: Record<string, number>;
  lastSyncAt: string | null;
  /** Fixed sentence supplied by the backend when state is 'failed'. */
  message: string | null;
  /** Classified current failure. Only `publicMessage` is ever rendered. */
  failure: SafeFailure | null;
}

/** backend/src/onboarding/state.ts — UiStateFlags. All derived, none stored. */
export interface OnboardingUiStates {
  onboardingInProgress: boolean;
  onboardingComplete: boolean;
  limitedAnalyticsAvailable: boolean;
  shopifyNotConnected: boolean;
  rcmSetupIncomplete: boolean;
  rcmReady: boolean;
  syncStillRunning: boolean;
}

/**
 * GET /accounts/:id/onboarding/status.
 *
 * `capabilities` and `links` are on the wire and deliberately not modelled.
 * Capabilities drive the Phase 7 dashboards, which do not exist. `links` is
 * owned by the dedicated links query — one resource, one fetch, one cache entry;
 * two components reading two copies of the same list is how a page ends up
 * disagreeing with itself after a revoke refreshes only one of them.
 */
export interface AgencyOnboardingStatus {
  onboardingComplete: boolean;
  onboardingBlockers: OnboardingBlocker[];
  rcmReadiness: RcmReadiness;
  providers: ProviderStatusSummary[];
  progress: ProviderSyncProgress[];
  uiStates: OnboardingUiStates;
}
