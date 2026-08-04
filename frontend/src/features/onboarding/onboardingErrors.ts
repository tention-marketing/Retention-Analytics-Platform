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

export type OnboardingAction =
  | 'status' | 'links' | 'create' | 'revoke'
  | 'connect-shopify' | 'connect-klaviyo' | 'connect-recharge' | 'skip' | 'complete';

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
  'connect-shopify': 'Could not connect Shopify',
  'connect-klaviyo': 'Could not connect Klaviyo',
  'connect-recharge': 'Could not connect Recharge',
  skip: 'Could not save that choice',
  complete: 'Could not mark setup complete',
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

/**
 * The 409 from POST /accounts/:id/onboarding/complete.
 *
 * A conflict here means one specific thing: the server re-ran the completion gate
 * and it did not pass. Either the page was working from a status that had since
 * changed, or a platform's state moved while the request was in flight. Nothing
 * was written.
 *
 * WHY THIS SENTENCE AND NOT THE BLOCKERS THEMSELVES. The 409 body does carry
 * `onboardingBlockers`, and api/errors.ts allowlists them into ApiError.details —
 * but they are a snapshot from the instant the write was refused, and the hook
 * refetches the status immediately afterwards. Rendering both would put two
 * blocker lists on one screen, and the stale one would be the more prominent.
 * So this says what happened and where to look, and the refreshed status query
 * says what is actually still outstanding.
 *
 * It is deliberately NOT called unexpected or internal. It is neither: it is the
 * server correctly refusing a write, and telling a user that a correct refusal
 * was a system fault is how they learn to ignore the message.
 */
const COMPLETE_CONFLICT =
  'Setup changed before it could be completed. Review the latest setup status and try again.';

const PER_ACTION_400: Record<OnboardingAction, string> = {
  status: UNEXPECTED,
  links: UNEXPECTED,
  create: 'That request was not valid, so no setup link was created.',
  revoke: 'That request was not valid, so nothing was revoked.',
  'connect-shopify': 'Those Shopify details were not accepted. Nothing was changed.',
  'connect-klaviyo': 'That Klaviyo key was not accepted. Nothing was changed.',
  'connect-recharge': 'That Recharge token was not accepted. Nothing was changed.',
  skip: 'That choice could not be saved. Nothing was changed.',
  complete: 'Setup could not be marked complete. Nothing was changed.',
};

/**
 * Fixed wording per ConnectFailure code, per provider.
 *
 * NONE of these is derived from the backend's `message`. For
 * `verification_failed` that message interpolates the provider's own exception —
 * verified against the running server, a wrong domain produced
 * "Shopify verification failed: Shopify client_credentials token exchange failed
 * for … : HTTP 404". That is a provider response body, and it belongs in the
 * server log, not on an agency screen.
 */
const CONNECT_FAILURES: Record<string, Partial<Record<string, string>>> = {
  'connect-shopify': {
    missing_credentials: 'Enter the store domain, client ID and client secret.',
    invalid_domain:
      'Enter the permanent .myshopify.com store domain. A custom domain cannot be used here.',
    // Deliberately does NOT say which account holds it: that would confirm to one
    // agency user that a particular store is a client of this platform.
    domain_conflict: 'This Shopify store is already being set up. Contact your account manager.',
    verification_failed:
      'We could not verify these Shopify credentials. Check the permanent store domain and '
      + 'custom-app credentials.',
  },
  'connect-klaviyo': {
    missing_credentials: 'Enter a Klaviyo private API key.',
    verification_failed: 'We could not verify this Klaviyo API key.',
  },
  'connect-recharge': {
    missing_credentials: 'Enter a Recharge Admin API token.',
    verification_failed: 'We could not verify this Recharge API token.',
  },
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
  // A 502 on a connect route is the PROVIDER refusing us, not our server falling
  // over — the code in the body says which, and the provider-specific sentence is
  // far more actionable than "try again in a moment".
  const byCode = CONNECT_FAILURES[action]?.[error.code ?? ''];
  if (byCode) return { message: byCode, retryable: false, sessionExpired: false };

  // A 409 on completion is the gate refusing the write, not a fault.
  //
  // It sits AFTER the code lookup above so `domain_conflict` — also a 409, on a
  // connect route — keeps its own more specific sentence. `retryable:false`
  // because the button is not what fixes this: an outstanding platform decision
  // is, and the refreshed status is where that is listed. An automatic retry
  // would re-send a request the server has just finished explaining it refuses.
  if (error.status === 409 && action === 'complete') {
    return { message: COMPLETE_CONFLICT, retryable: false, sessionExpired: false };
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
