import { ApiError } from '@/api/errors';

// Fixed, safe wording for every way an onboarding action can fail.
//
// WHY NOT ApiError.message: the generic normalizer in api/errors.ts adopts a
// server string when it looks displayable, which is right for the backend's
// written-for-humans blocker messages and wrong for these routes. They answer
// with machine codes — `bad_account_id`, `link_not_found`, `bad_ttl` — and
// Fastify's own 400 for a malformed body describes our transport. Neither is
// something to show an agency user.
//
// Every string below is a literal defined in this file. No response body, no
// submitted id, and above all no URL or token is ever interpolated into one:
// an error message is a string that gets copied into a bug report.

export type OnboardingAction = 'status' | 'links' | 'create' | 'revoke';

export interface OnboardingFailure {
  /** Fixed sentence, safe to render. */
  message: string;
  /** True only for faults where trying again could plausibly work. */
  retryable: boolean;
  /** True on a confirmed 401, so a caller can skip rendering before redirect. */
  sessionExpired: boolean;
}

const TITLES: Record<OnboardingAction, string> = {
  status: 'Could not load setup status',
  links: 'Could not load setup links',
  create: 'Could not create the setup link',
  revoke: 'Could not revoke the setup link',
};

export function onboardingFailureTitle(action: OnboardingAction): string {
  return TITLES[action];
}

const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';
const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SERVER = 'The server could not complete this request. Try again in a moment.';
const UNAVAILABLE = 'This account is no longer available. Return to all accounts.';
const UNEXPECTED = 'The server returned something unexpected. Nothing was changed.';

/**
 * A 404 on revoke means "no such link IN THIS ACCOUNT", and the backend
 * deliberately answers identically for a link that never existed and one owned
 * by another account. This message must preserve that: saying "that link belongs
 * to a different account" would turn the endpoint into a probe for which link
 * ids are real.
 */
const LINK_GONE = 'That setup link is no longer available. Refresh the list and try again.';

const PER_ACTION_400: Record<OnboardingAction, string> = {
  status: UNEXPECTED,
  links: UNEXPECTED,
  create: 'That request was not valid, so no setup link was created.',
  revoke: 'That request was not valid, so nothing was revoked.',
};

export function describeOnboardingFailure(
  error: unknown,
  action: OnboardingAction,
): OnboardingFailure {
  if (!(error instanceof ApiError)) {
    return { message: UNEXPECTED, retryable: false, sessionExpired: false };
  }
  if (error.kind === 'network') {
    return { message: NETWORK, retryable: true, sessionExpired: false };
  }
  if (error.kind === 'aborted') {
    return { message: NETWORK, retryable: true, sessionExpired: false };
  }
  // A client-side refusal: a response that failed validation at the boundary,
  // or a URL the client would not send. Retrying repeats it.
  if (error.kind === 'client') {
    return { message: UNEXPECTED, retryable: false, sessionExpired: false };
  }
  if (error.status === 401) {
    return { message: SESSION_EXPIRED, retryable: false, sessionExpired: true };
  }
  if (error.status >= 500) {
    return { message: SERVER, retryable: true, sessionExpired: false };
  }
  if (error.status === 404) {
    // `account_not_found` and `link_not_found` are different situations but the
    // same instruction: the thing you were looking at is gone, go back and look
    // again. Distinguishing them here would leak which ids exist.
    return {
      message: action === 'revoke' ? LINK_GONE : UNAVAILABLE,
      retryable: false,
      sessionExpired: false,
    };
  }
  if (error.status === 400 || error.status === 403 || error.status === 415 || error.status === 422) {
    return { message: PER_ACTION_400[action], retryable: false, sessionExpired: false };
  }
  if (error.status === 429) {
    return { message: 'Too many attempts. Wait a moment and try again.', retryable: true, sessionExpired: false };
  }
  return { message: UNEXPECTED, retryable: false, sessionExpired: false };
}
