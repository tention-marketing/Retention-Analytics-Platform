import { api } from './client';
import { apiClientError } from './errors';
import {
  FAILURE_CATEGORIES, LINK_STATUSES, PROVIDERS, PROVIDER_STATES, SYNC_STATES,
  type AgencyOnboardingStatus, type IssuedOnboardingLink, type OnboardingBlocker,
  type OnboardingBlockerDetail, type OnboardingLinkSummary, type OnboardingLinkStatus,
  type Provider, type ProviderState, type ProviderStatusSummary, type ProviderSyncProgress,
  type RcmReadiness, type SafeFailure, type SyncState, type FailureCategory,
  type OnboardingUiStates,
} from '@/types/domain';

// The four agency onboarding calls.
//
// All four are authenticated by the HttpOnly `tention_sid` cookie the shared
// client already sends. No bearer token, no storage, no second mechanism.
//
// THIS FILE IS THE TRUST BOUNDARY, and it is stricter than the account parsers
// because of what flows through it. Two rules that are not merely defensive
// typing:
//
//   1. TRIPWIRES. `token` / `token_hash` on a link summary, and `failedReason` /
//      `recentErrors` on a progress entry, are fields the backend deliberately
//      removed when it was hardened. If any of them reappears, that is a
//      regression that has put a secret or a stack trace on the wire — so the
//      response is rejected outright rather than having the offending key
//      quietly dropped. A silent drop would let the leak ship, visible to
//      anyone reading the network tab, with the UI looking perfectly normal.
//
//   2. THE MINTED TOKEN IS DISCARDED HERE. createOnboardingLink validates the
//      one-time URL and returns only `{ id, expiresAt, url }`. The raw `token`
//      field never leaves this function, so no component can hold, log or store
//      it separately from the URL it belongs to.

const MALFORMED = 'The server returned an unexpected response.';

function malformed(code: string): never {
  // The code is for branching and tests. The message is fixed: a validation
  // failure must never quote the payload that failed it.
  throw apiClientError(MALFORMED, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** A non-empty string that Date.parse understands. Dates arrive as ISO 8601. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value));
}

/** ISO 8601 or null — the shape every nullable timestamp on these routes uses. */
function nullableIsoDate(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isIsoDate(value)) malformed(code);
  return value;
}

function isMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Onboarding links
// ---------------------------------------------------------------------------

/** Fields whose presence means the backend leaked a secret. See rule 1 above. */
const LINK_SECRET_KEYS = ['token', 'token_hash', 'tokenHash', 'url'] as const;

function parseLinkSummary(value: unknown): OnboardingLinkSummary {
  if (!isRecord(value)) malformed('malformed_link_payload');

  for (const key of LINK_SECRET_KEYS) {
    if (key in value) malformed('link_payload_contains_secret');
  }

  if (!isPositiveInt(value.id)) malformed('malformed_link_payload');
  if (!isMember<OnboardingLinkStatus>(LINK_STATUSES, value.status)) {
    malformed('malformed_link_payload');
  }
  if (!isIsoDate(value.expires_at)) malformed('malformed_link_payload');
  if (!isIsoDate(value.created_at)) malformed('malformed_link_payload');

  // Built field by field, so a column added later cannot ride into the UI
  // without first being added to the type and to this function.
  return {
    id: value.id,
    status: value.status,
    expires_at: value.expires_at,
    revoked_at: nullableIsoDate(value.revoked_at, 'malformed_link_payload'),
    first_used_at: nullableIsoDate(value.first_used_at, 'malformed_link_payload'),
    completed_at: nullableIsoDate(value.completed_at, 'malformed_link_payload'),
    created_at: value.created_at,
  };
}

/**
 * GET /accounts/:id/onboarding-links.
 *
 * Order is the backend's (`id DESC`, newest first) and is preserved rather than
 * re-sorted here — the server decides what "newest" means.
 *
 * One bad row fails the whole request. A list that silently omits what it could
 * not parse looks exactly like a complete list, and "there is no active link"
 * is a conclusion an agency would act on.
 */
export async function getOnboardingLinks(
  accountId: number,
  signal?: AbortSignal,
): Promise<OnboardingLinkSummary[]> {
  const body = await api.get<unknown>(
    `/accounts/${accountId}/onboarding-links`,
    signal ? { signal } : {},
  );
  if (!Array.isArray(body)) malformed('malformed_links_payload');
  return body.map(parseLinkSummary);
}

/**
 * The fixed lifetime this frontend requests.
 *
 * Sent explicitly rather than relying on the backend default. Both agree today —
 * `DEFAULT_TTL_DAYS = 14` in onboarding/links.ts, confirmed against the running
 * server — but the copy on screen promises the client fourteen days, and a
 * change to the server default would silently make that copy wrong. Stating the
 * number is how the promise and the request stay the same fact.
 */
export const ONBOARDING_LINK_TTL_DAYS = 14;

/** Exactly 32 bytes of base64url: what onboarding/links.ts mints, unpadded. */
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Validate the one-time setup URL the server assembled.
 *
 * The token must be in the FRAGMENT and nowhere else. That is not a style
 * preference: browsers never transmit a fragment, so a token there cannot reach
 * an access log, a proxy log, or a Referer header — whereas the same token in a
 * path or a query string is written to every one of them. A URL that puts it
 * anywhere else is refused rather than displayed, because displaying it is what
 * would get it copied into a chat message and then into somebody's logs.
 */
function validateSetupUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') malformed('malformed_setup_url');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    malformed('malformed_setup_url');
  }

  // Only real web schemes. `javascript:` and `data:` would otherwise be rendered
  // as a link for someone to click.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') malformed('setup_url_bad_scheme');
  // Credentials in the authority would be sent to whatever host follows them.
  if (url.username !== '' || url.password !== '') malformed('setup_url_has_credentials');
  // A query string is the classic place a token gets logged.
  if (url.search !== '') malformed('setup_url_has_query');
  if (!url.pathname.endsWith('/onboarding')) malformed('setup_url_bad_path');

  // Matched against the raw fragment rather than parsed with URLSearchParams:
  // this asserts the fragment is EXACTLY one token parameter, with no second
  // parameter riding alongside and no percent-decoding in between.
  if (!/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)) malformed('setup_url_bad_fragment');
  if (!RAW_TOKEN.test(url.hash.slice('#token='.length))) malformed('setup_url_bad_fragment');

  // The server's own string, returned unchanged. Reassembling it from the parsed
  // pieces would mean displaying a link this application invented.
  return raw;
}

/**
 * POST /accounts/:id/onboarding-links.
 *
 * NOT IDEMPOTENT — every call mints another live link. Nothing here retries, and
 * the caller drives it through a controlled action rather than a mutation with a
 * cache; see features/onboarding/useOnboardingLinks.ts.
 *
 * The response's `token` and `note` fields are read and discarded. What comes
 * back is the validated URL and the two pieces of metadata the panel shows.
 */
export async function createOnboardingLink(accountId: number): Promise<IssuedOnboardingLink> {
  const body = await api.post<unknown>(`/accounts/${accountId}/onboarding-links`, {
    ttlDays: ONBOARDING_LINK_TTL_DAYS,
  });

  if (!isRecord(body)) malformed('malformed_created_link');
  if (!isPositiveInt(body.id)) malformed('malformed_created_link');
  if (!isIsoDate(body.expiresAt)) malformed('malformed_created_link');

  const url = validateSetupUrl(body.url);

  // `body.token` is deliberately not read into the result. It is already inside
  // the validated URL; a second reference to it is a second thing to leak.
  return { id: body.id, expiresAt: body.expiresAt, url };
}

/**
 * DELETE /accounts/:id/onboarding-links/:linkId — ACCOUNT-SCOPED.
 *
 * The unscoped `DELETE /onboarding-links/:linkId` was removed from the backend
 * during hardening and must never be called. Ownership is enforced in the SQL
 * WHERE clause, and a link belonging to another account answers with the same
 * 404 as one that never existed, so this cannot be used to probe which ids are
 * real. The caller must not undo that by telling the user which case it was.
 */
export async function revokeOnboardingLink(accountId: number, linkId: number): Promise<void> {
  await api.delete<unknown>(`/accounts/${accountId}/onboarding-links/${linkId}`);
}

// ---------------------------------------------------------------------------
// Agency onboarding status
// ---------------------------------------------------------------------------

/** Only these `detail` keys are understood; everything else is discarded. */
function parseBlockerDetail(value: unknown): OnboardingBlockerDetail | null {
  if (!isRecord(value)) return null;
  const detail: OnboardingBlockerDetail = {};

  if (Array.isArray(value.providers)) {
    const providers = value.providers.filter((p): p is Provider => isMember(PROVIDERS, p));
    if (providers.length > 0) detail.providers = providers;
  }
  for (const key of ['months', 'skus'] as const) {
    const raw = value[key];
    if (Array.isArray(raw)) {
      const items = raw.filter((v): v is string => typeof v === 'string' && v !== '');
      if (items.length > 0) detail[key] = items;
    }
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

function parseBlocker(value: unknown): OnboardingBlocker {
  if (!isRecord(value)) malformed('malformed_blocker');
  if (typeof value.code !== 'string' || value.code === '') malformed('malformed_blocker');
  if (typeof value.message !== 'string' || value.message === '') malformed('malformed_blocker');
  return {
    code: value.code,
    message: value.message,
    step: typeof value.step === 'string' && value.step !== '' ? value.step : null,
    detail: parseBlockerDetail(value.detail),
  };
}

function parseBlockers(value: unknown): OnboardingBlocker[] {
  if (!Array.isArray(value)) malformed('malformed_blocker');
  return value.map(parseBlocker);
}

/** Fields the hardening removed. Their return is a regression, not a surprise. */
const PROGRESS_LEAK_KEYS = ['failedReason', 'recentErrors'] as const;

function parseSafeFailure(value: unknown): SafeFailure | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) malformed('malformed_failure');

  // A SafeFailure that carries raw text alongside its classification is not a
  // SafeFailure.
  for (const key of PROGRESS_LEAK_KEYS) {
    if (key in value) malformed('progress_payload_contains_raw_error');
  }
  if (typeof value.code !== 'string' || value.code === '') malformed('malformed_failure');
  if (!isMember<FailureCategory>(FAILURE_CATEGORIES, value.category)) malformed('malformed_failure');
  if (!isMember<Provider>(PROVIDERS, value.provider)) malformed('malformed_failure');
  if (typeof value.stage !== 'string') malformed('malformed_failure');
  if (typeof value.retryable !== 'boolean') malformed('malformed_failure');
  if (typeof value.publicMessage !== 'string' || value.publicMessage === '') {
    malformed('malformed_failure');
  }
  return {
    code: value.code,
    category: value.category,
    provider: value.provider,
    stage: value.stage,
    retryable: value.retryable,
    publicMessage: value.publicMessage,
    occurredAt: nullableIsoDate(value.occurredAt, 'malformed_failure'),
  };
}

function parseProviderStatus(value: unknown): ProviderStatusSummary {
  if (!isRecord(value)) malformed('malformed_provider_status');
  if (!isMember<Provider>(PROVIDERS, value.provider)) malformed('malformed_provider_status');
  if (!isMember<ProviderState>(PROVIDER_STATES, value.state)) malformed('malformed_provider_status');
  const optionalString = (raw: unknown): string | null =>
    typeof raw === 'string' && raw !== '' ? raw : null;
  return {
    provider: value.provider,
    state: value.state,
    connectionStatus: optionalString(value.connectionStatus),
    requestedDomain: optionalString(value.requestedDomain),
    shopDomain: optionalString(value.shopDomain),
    lastSyncAt: nullableIsoDate(value.lastSyncAt, 'malformed_provider_status'),
  };
}

function parseProgress(value: unknown): ProviderSyncProgress {
  if (!isRecord(value)) malformed('malformed_progress');

  for (const key of PROGRESS_LEAK_KEYS) {
    if (key in value) malformed('progress_payload_contains_raw_error');
  }
  if (!isMember<Provider>(PROVIDERS, value.provider)) malformed('malformed_progress');
  if (!isMember<SyncState>(SYNC_STATES, value.state)) malformed('malformed_progress');

  // Real counts only, and only numeric ones. `jobId`, `jobState` and
  // `attemptsMade` are present on the wire and are not read: see the note on
  // ProviderSyncProgress.
  const counts: Record<string, number> = {};
  if (isRecord(value.counts)) {
    for (const [key, count] of Object.entries(value.counts)) {
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) counts[key] = count;
    }
  }

  return {
    provider: value.provider,
    state: value.state,
    counts,
    lastSyncAt: nullableIsoDate(value.lastSyncAt, 'malformed_progress'),
    message: typeof value.message === 'string' && value.message !== '' ? value.message : null,
    failure: parseSafeFailure(value.failure),
  };
}

function parseUiStates(value: unknown): OnboardingUiStates {
  if (!isRecord(value)) malformed('malformed_ui_states');
  const flag = (raw: unknown): boolean => {
    if (typeof raw !== 'boolean') malformed('malformed_ui_states');
    return raw;
  };
  return {
    onboardingInProgress: flag(value.onboardingInProgress),
    onboardingComplete: flag(value.onboardingComplete),
    limitedAnalyticsAvailable: flag(value.limitedAnalyticsAvailable),
    shopifyNotConnected: flag(value.shopifyNotConnected),
    rcmSetupIncomplete: flag(value.rcmSetupIncomplete),
    rcmReady: flag(value.rcmReady),
    syncStillRunning: flag(value.syncStillRunning),
  };
}

function parseRcmReadiness(value: unknown): RcmReadiness {
  if (!isRecord(value)) malformed('malformed_rcm_readiness');
  if (typeof value.ready !== 'boolean') malformed('malformed_rcm_readiness');
  // `details` is read past deliberately: it is the cost-coverage and ad-spend
  // arithmetic, which belongs to a checkpoint that builds those screens.
  return { ready: value.ready, blockers: parseBlockers(value.blockers) };
}

/**
 * GET /accounts/:id/onboarding/status.
 *
 * The two blocker groups are parsed into two separate fields and are never
 * concatenated. Merging them is the single most tempting simplification on this
 * screen and the one the backend split apart on purpose: a brand can finish
 * client onboarding with Klaviyo alone and still be far from an RCM figure.
 */
export async function getAgencyOnboardingStatus(
  accountId: number,
  signal?: AbortSignal,
): Promise<AgencyOnboardingStatus> {
  const body = await api.get<unknown>(
    `/accounts/${accountId}/onboarding/status`,
    signal ? { signal } : {},
  );
  if (!isRecord(body)) malformed('malformed_status_payload');
  if (typeof body.onboardingComplete !== 'boolean') malformed('malformed_status_payload');
  if (!Array.isArray(body.providers)) malformed('malformed_status_payload');
  if (!Array.isArray(body.progress)) malformed('malformed_status_payload');

  return {
    onboardingComplete: body.onboardingComplete,
    onboardingBlockers: parseBlockers(body.onboardingBlockers),
    rcmReadiness: parseRcmReadiness(body.rcmReadiness),
    providers: body.providers.map(parseProviderStatus),
    progress: body.progress.map(parseProgress),
    uiStates: parseUiStates(body.uiStates),
  };
}
