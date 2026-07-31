import { ApiError } from './errors';

// Login failure presentation.
//
// The backend hardening checkpoint widened what POST /auth/login can return.
// Verified against the live backend, the full set is:
//
//   200  { id, email }
//   400  { error: 'email and password required' }                      missing field
//   400  { statusCode, code: 'FST_ERR_CTP_INVALID_JSON_BODY', … }      malformed JSON
//   401  { error: 'invalid credentials' }                              generic, byte-identical
//   403  { error: 'forbidden_origin' }                                 untrusted request origin
//   415  { error: 'unsupported_media_type' }                           body was not JSON
//   429  { statusCode, error, message } + Retry-After                  rate limited
//
// WHY THIS MODULE EXISTS RATHER THAN REUSING ApiError.message: the generic
// normalizer in errors.ts adopts a server-supplied string when it looks safe to
// display, which is right for validation messages elsewhere in the product but
// wrong on the login screen. Two of the responses above would leak backend
// wording straight onto the page — the 400 would render "email and password
// required", and the malformed-JSON 400 would render "Body is not valid JSON but
// content-type is set to 'application/json'". Neither is something to show a
// person signing in, and the second describes our own transport.
//
// So every string below is a fixed literal defined in this file. Nothing from
// the response body is ever rendered, and no field of the request — least of all
// the email or password — is carried into the result.

/** What actually went wrong, for the UI to branch on. */
export type LoginFailureKind =
  | 'invalid_credentials'
  | 'blocked_origin'
  | 'unsupported_request_format'
  | 'invalid_form'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'cancelled'
  | 'unknown';

export interface LoginFailure {
  kind: LoginFailureKind;
  /** Fixed sentence, safe to render. Never derived from the response body. */
  message: string;
  /**
   * True ONLY when the credentials themselves were rejected (401).
   *
   * 403 and 415 are environment and transport faults. Presenting either as
   * "wrong password" would send someone off changing a password that was never
   * the problem — and, for the 403, hide that they are on the wrong address.
   */
  isCredentialProblem: boolean;
  /**
   * Always false. A login attempt is never replayed automatically: a retry
   * spends one of the ten attempts the backend rate limit allows, and repeating
   * a rejected credential cannot succeed. Present as a literal type so a caller
   * cannot read it as a maybe.
   */
  readonly retryAutomatically: false;
  /** From the 429 Retry-After header when present. Never invented. */
  retryAfterSeconds: number | null;
}

// The three messages the backend contract update specifies verbatim, plus the
// ones for the statuses that already existed. None names a URL, an origin, a
// header, a status code, or any backend identifier.
const MESSAGES = {
  invalid_credentials: 'Email or password is incorrect.',
  blocked_origin:
    'This login request was blocked. Open the application from its official address and try again.',
  unsupported_request_format:
    'The login request could not be sent correctly. Refresh the page and try again.',
  invalid_form: 'Please check the login form and try again.',
  rate_limited: 'Too many sign-in attempts. Please wait and try again.',
  server_error: 'Sign-in is unavailable right now. Please try again shortly.',
  network: 'Could not reach the server. Check your connection and try again.',
  cancelled: 'The sign-in request was cancelled.',
  unknown: 'Sign-in failed. Please try again.',
} as const satisfies Record<LoginFailureKind, string>;

function kindFor(error: ApiError): LoginFailureKind {
  if (error.kind === 'aborted') return 'cancelled';
  if (error.kind === 'network') return 'network';
  // 'client' is a refusal raised before the request left the browser (a bad API
  // target). It is our bug, not the user's input, so it is not a form problem.
  if (error.kind === 'client') return 'unknown';

  switch (error.status) {
    case 400:
      return 'invalid_form';
    case 401:
      return 'invalid_credentials';
    case 403:
      return 'blocked_origin';
    case 415:
      return 'unsupported_request_format';
    case 429:
      return 'rate_limited';
    default:
      return error.status >= 500 ? 'server_error' : 'unknown';
  }
}

/**
 * Turn any thrown value from a login attempt into a safe, displayable failure.
 *
 * Total by construction: a non-ApiError (a bug in our own code, say) collapses
 * to the generic message rather than having its `.message` read, which is how a
 * stack trace would otherwise reach the screen.
 */
export function describeLoginFailure(error: unknown): LoginFailure {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'unknown',
      message: MESSAGES.unknown,
      isCredentialProblem: false,
      retryAutomatically: false,
      retryAfterSeconds: null,
    };
  }

  const kind = kindFor(error);
  let message: string = MESSAGES[kind];

  // The only place a number from the response reaches the copy — and it is a
  // duration parsed from a header, not text from the body.
  if (kind === 'rate_limited' && error.retryAfterSeconds !== null) {
    const seconds = error.retryAfterSeconds;
    message = `Too many sign-in attempts. Please wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`;
  }

  return {
    kind,
    message,
    isCredentialProblem: kind === 'invalid_credentials',
    retryAutomatically: false,
    retryAfterSeconds: kind === 'rate_limited' ? error.retryAfterSeconds : null,
  };
}

/**
 * Did this failure leave the user unauthenticated?
 *
 * Every login failure does. Stated as a function so the login screen has
 * something explicit to assert against rather than inferring "not signed in"
 * from the absence of a success — 403 and 415 in particular are easy to
 * mistake for "something happened, maybe we are in".
 */
export function isStillSignedOut(_failure: LoginFailure): true {
  return true;
}
