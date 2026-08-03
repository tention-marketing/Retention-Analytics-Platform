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

// ---------------------------------------------------------------------------
// Provider connections
// ---------------------------------------------------------------------------

/**
 * backend/src/onboarding/connect.ts — ConnectFailure codes.
 *
 * These are what the UI branches on. The accompanying `message` is NEVER
 * rendered: for `verification_failed` the backend interpolates the provider's
 * own exception text into it (verified — a bad domain came back as
 * "Shopify verification failed: Shopify client_credentials token exchange failed
 * for … : HTTP 404"), which is a provider response body on an agency screen.
 */
export const CONNECTION_FAILURE_CODES = [
  'missing_credentials',
  'account_not_found',
  'invalid_domain',
  'domain_conflict',
  'verification_failed',
] as const;
export type ConnectionFailureCode = (typeof CONNECTION_FAILURE_CODES)[number];

/**
 * What a successful connection tells the UI, AFTER the response has been
 * stripped to its safe parts.
 *
 * The wire carries much more: Shopify's raw `shop` object, Klaviyo's `account`,
 * Recharge's `store`, and a `backfill` result in sync mode. None of it is
 * modelled, so none of it can be rendered — those are provider payloads whose
 * shape this product does not control and whose contents nobody has reviewed.
 *
 * `queued` is the honest distinction the UI must preserve: `true` means the
 * initial import was accepted onto the queue, `false` means the credential is
 * saved but nothing has started (Redis was unreachable when the job was
 * enqueued). Reporting the second as if it were the first would tell an agency
 * that data was on its way when it was not.
 *
 * `queueNote` is deliberately absent even though the backend sends one: its text
 * is "stored; enqueue failed (is Redis up?)", which is an operator's sentence,
 * not a user's. Its PRESENCE is already captured by `queued: false`.
 */
export interface ProviderConnectionOutcome {
  ok: true;
  queued: boolean;
}

/**
 * Shopify adds three facts worth showing, all derived from the same verification
 * round-trip rather than an extra API call.
 *
 * `currencyOutcome` is reported but not acted on here — currency conflict
 * resolution is its own screen in a later checkpoint, and this checkpoint must
 * not start editing currency.
 */
export interface ShopifyConnectionOutcome extends ProviderConnectionOutcome {
  /** The normalized permanent domain the backend actually stored. */
  shopDomain: string;
  /** Whether Shopify's own store timezone was applied to the account. */
  timezoneApplied: boolean;
  /** The currency Shopify reports, when it reported one. */
  detectedCurrency: string | null;
}

/** POST /accounts/:id/connections/:provider/skip. */
export interface ProviderSkipOutcome {
  provider: Provider;
  /** Always 'skipped' on success; validated rather than assumed. */
  state: 'skipped';
  /** The refreshed provider list the backend returns alongside. */
  providers: ProviderStatusSummary[];
}

// ---------------------------------------------------------------------------
// Financial inputs (Phase 5B-2F)
// ---------------------------------------------------------------------------
//
// EVERY TYPE BELOW IS TRACED TO A RESPONSE THIS APP ACTUALLY READS, verified
// against the running backend rather than inferred from the route names.
//
// CAMELCASE INTERNALLY, even where the wire is snake_case. The currency and costs
// routes select raw columns (`currency_source`, `cogs_method`, `ocas_monthly`),
// and those names are mapped once at the API boundary. That differs from
// `Account` above, which deliberately keeps its wire names because they are also
// the POST /accounts REQUEST field names — here the write bodies use different
// names again (`blendedMarginPct`, `ocasMonthly`), so there is no single spelling
// to preserve and camelCase is the one the rest of the app reads in.
//
// MONEY IS A STRING. `blendedMarginPct` is the exception: it is a PERCENTAGE, not
// money — currency-independent, never converted, and safe as a number because it
// is only ever compared against 0 and 100.

/** backend/src/onboarding/currency.ts — accounts.currency_source. */
export const CURRENCY_SOURCES = ['shopify', 'manual'] as const;
export type CurrencySource = (typeof CURRENCY_SOURCES)[number];

/**
 * GET /accounts/:id/currency.
 *
 * THREE COLUMNS, NOT TWO, and that is load-bearing: `currency` is the currency
 * the account's STORED MONEY VALUES are expressed in, while
 * `shopifyCurrencyDetected` is what Shopify reports, recorded independently. When
 * they disagree the backend keeps both — nothing is converted and nothing is
 * deleted — and the mismatch is DERIVED from the two columns rather than stored
 * as a flag, so resolving the data clears it.
 */
export interface AccountCurrencyState {
  currency: string | null;
  currencySource: CurrencySource | null;
  shopifyCurrencyDetected: string | null;
}

/** backend/src/onboarding/costs.ts — account_costs.cogs_method. */
export const COGS_METHODS = ['per_sku', 'blended'] as const;
export type CogsMethod = (typeof COGS_METHODS)[number];

/**
 * One eligible SKU with its trailing-12-month line-item revenue and any cost
 * already entered.
 *
 * `revenue` is a NUMBER, not a money string, and it is not presented as a
 * business revenue figure anywhere — see the note on `SkuCoverage`.
 *
 * `cogs` IS THE ONE MONEY FIELD THIS BACKEND DOES NOT SEND AS A STRING, and the
 * distinction matters enough to record. `account_costs.ocas_monthly` and
 * `ad_spend.spend` arrive as NUMERIC strings ("1500.25") and are kept as strings
 * end to end. `getSkuCoverage()` in backend/src/onboarding/costs.ts instead maps
 * its column through `Number()` before serializing, so a per-SKU cost reaches us
 * as `33.33` — already a binary float, whatever we do next.
 *
 * So the string here is RECONSTRUCTED from that number at the API boundary, not
 * preserved from the database. That is honest about what is available: the
 * conversion has already happened server-side and cannot be undone from here, and
 * turning it into a canonical two-decimal string at the edge at least stops a
 * SECOND float round trip happening in the browser every time the value is
 * rendered, prefilled into a form, or sent back. Two decimal places is well
 * inside the exactly-representable range for the magnitudes NUMERIC(12,2) holds,
 * so the reconstruction is faithful; it is the principle of not floating money
 * twice that this preserves, not a guarantee the backend already gave up.
 */
export interface SkuRevenueCost {
  sku: string;
  revenue: number;
  /**
   * A canonical two-decimal string, or null when no cost has been entered.
   * Reconstructed from the number the backend sends — see above.
   */
  cogs: string | null;
  zeroConfirmed: boolean;
}

/**
 * The coverage arithmetic behind the 80% COGS target.
 *
 * `eligibleLineRevenue` AND `costedRevenue` ARE NOT NET REVENUE. They are
 * line-item values (price x quantity) over eligible orders, gross of order-level
 * discounts and refunds — deliberately a different measure from
 * `orders.total_net`, which Phase 6 uses for RCM revenue. They exist only as the
 * denominator and numerator of a RATIO, and mixing measures would make that
 * ratio wrong in both directions. The UI shows `coveragePct`; it must never
 * label either of these as revenue.
 */
export interface SkuCoverage {
  /** The default required set: smallest group reaching 80%, capped at 20. */
  required: SkuRevenueCost[];
  /** Every eligible SKU, so costs can be added beyond the initial 20. */
  all: SkuRevenueCost[];
  /** Ratio denominator. NOT a revenue figure — see above. */
  eligibleLineRevenue: number;
  /** Ratio numerator. NOT a revenue figure — see above. */
  costedRevenue: number;
  /** The one figure this UI displays: costedRevenue / eligibleLineRevenue. */
  coveragePct: number;
  /** True when even all 20 required SKUs cannot reach the target. */
  cappedBelowTarget: boolean;
  missingSkus: string[];
  /** Costed SKUs sitting at zero with no explicit confirmation. */
  unconfirmedZeroSkus: string[];
}

/** GET /accounts/:id/costs — the `costs` half. */
export interface FinancialCostsState {
  cogsMethod: CogsMethod | null;
  /** A percentage, not money. Null until entered. */
  blendedMarginPct: number | null;
  /** A validated money string, or null when never entered. NEVER "0" by default. */
  ocasMonthly: string | null;
  ocasZeroConfirmed: boolean;
}

/** GET /accounts/:id/costs, whole. */
export interface AccountCostsResponse {
  costs: FinancialCostsState;
  coverage: SkuCoverage;
}

/**
 * One stored monthly spend row.
 *
 * `source` is read-only and is 'manual' for everything V1 can produce — the
 * column exists so V3's aggregator and direct-API paths slot into the same model.
 * It is displayed, never edited.
 */
export interface AdSpendRow {
  /** First-of-month, YYYY-MM-DD. */
  month: string;
  channel: string;
  /** A validated money string. */
  spend: string;
  source: string;
}

/**
 * The required coverage window, computed entirely by the backend.
 *
 * THE FRONTEND NEVER DERIVES ANY OF THIS. The rule (trailing 12 months, never
 * before the first eligible order, only months with at least one new customer,
 * all boundaries in the account's store timezone) lives in one place, and a
 * second implementation in a browser would disagree with it the moment a clock,
 * a timezone or a cache differed.
 */
export interface AdSpendCoverage {
  firstOrderMonth: string | null;
  currentMonth: string;
  windowStart: string | null;
  requiredMonths: string[];
  missingMonths: string[];
  /** Months holding BOTH real spend and a confirmed zero. A data-integrity fault. */
  contradictoryMonths: string[];
  coveredMonths: string[];
  zeroConfirmedMonths: string[];
  complete: boolean;
}

/** GET /accounts/:id/ad-spend. */
export interface AdSpendState {
  rows: AdSpendRow[];
  coverage: AdSpendCoverage;
  suggestedChannels: string[];
}

/** One channel x month-range row, as submitted to PUT /accounts/:id/ad-spend. */
export interface AdSpendRangeInput {
  channel: string;
  /** A canonical decimal string. Positive — zero goes through the dedicated route. */
  amount: string;
  startMonth: string;
  endMonth: string;
}

/** One per-SKU cost, as submitted to PUT /accounts/:id/costs. */
export interface SkuCostInput {
  sku: string;
  /** A canonical decimal string. */
  cogs: string;
  /** Required, and only ever true, when `cogs` is zero. */
  zeroConfirmed?: boolean;
}

/**
 * What a financial write tells the UI once the response has been stripped to its
 * safe parts.
 *
 * Deliberately thin. These routes echo a good deal more — refreshed coverage, a
 * `note` sentence, `monthsWritten`/`rowsWritten` counts — and none of it is read
 * into the UI's state, because the UI re-reads the resource after every write
 * rather than believing a write response. A screen built from an echo and a
 * screen built from a fresh GET disagree exactly when it matters most.
 */
export interface FinancialWriteOutcome {
  ok: true;
}

/**
 * POST /accounts/:id/ad-spend/zero answering 409 `requires_replace`.
 *
 * The months are the ones that ALREADY HOLD SPEND. Replacing them deletes every
 * spend row for those months, so this is surfaced as a second, explicit
 * confirmation rather than retried — and never as an automatic retry.
 */
export interface ZeroSpendConflict {
  months: string[];
}
