import { ApiError } from '@/api/errors';

// Account-creation failure presentation.
//
// WHY NOT JUST RENDER ApiError.message: the generic normalizer in api/errors.ts
// adopts a server-supplied string when it looks safe, which is right for the
// backend's written-for-humans blocker messages elsewhere in the product and
// wrong here. POST /accounts answers a bad timezone with `{"error":
// "invalid_store_timezone"}` and a bad name with `{"error": "name required"}` —
// machine codes and a fragment, neither of which is a sentence to show someone.
// A malformed JSON body produces Fastify's own "Body is not valid JSON but
// content-type is set to 'application/json'", which describes our transport.
//
// So every string below is a fixed literal defined in this file. Nothing from a
// response body is ever rendered, and no field of the request is carried into
// the result.
//
// The responses POST /accounts can actually produce, verified against the
// running backend:
//
//   201  { id, name, store_timezone }
//   400  { error: 'name required' }
//   400  { error: 'invalid_store_timezone' }
//   400  { statusCode, code: 'FST_ERR_CTP_INVALID_JSON_BODY', … }
//   401  { error: 'unauthorized' }
//   403  { error: 'forbidden_origin' }          shared onRequest gate
//   415  { error: 'unsupported_media_type' }    shared onRequest gate
//   5xx  Fastify's default error envelope

export type AccountFailureKind =
  | 'invalid_timezone'
  | 'invalid_request'
  | 'session_expired'
  | 'server_error'
  | 'network'
  | 'cancelled'
  | 'unknown';

export interface AccountFailure {
  kind: AccountFailureKind;
  /** Fixed sentence, safe to render. Never derived from the response body. */
  message: string;
}

const MESSAGES: Record<AccountFailureKind, string> = {
  invalid_timezone: 'That timezone was not recognised. Choose one from the list and try again.',
  // Covers the backend's `name required` 400 too. It has no distinct message
  // because the form already blocks a blank name, so reaching it means something
  // other than the form made the request — and "check the fields" is then the
  // only honest instruction.
  invalid_request: 'That request was not valid. Check the fields and try again.',
  // Deliberately not a redirect instruction: the shared session-expiry path is
  // already navigating to the sign-in page, and this is what shows in the
  // moment before it does.
  session_expired: 'Your session has expired. Please sign in again.',
  server_error: 'The server could not create the account. Try again in a moment.',
  network: 'Could not reach the server. Check your connection and try again.',
  cancelled: 'The request was cancelled.',
  unknown: 'Something went wrong. The account was not created.',
};

function kindOf(error: ApiError): AccountFailureKind {
  if (error.kind === 'aborted') return 'cancelled';
  if (error.kind === 'network') return 'network';
  // A client-side refusal (a bad target, or a response that failed validation at
  // the boundary) is not something the user can act on beyond retrying.
  if (error.kind === 'client') return 'unknown';

  if (error.status === 401) return 'session_expired';
  if (error.status >= 500) return 'server_error';

  if (error.status === 400) {
    // The machine code, not the prose. `code` is extracted by the normalizer
    // only when the value is a short token, so a sentence never lands here.
    if (error.code === 'invalid_store_timezone') return 'invalid_timezone';
    return 'invalid_request';
  }
  // 403 and 415 are environment and transport faults. Presenting either as a
  // field problem would send someone editing a name that was never wrong.
  if (error.status === 403 || error.status === 415) return 'invalid_request';
  return 'unknown';
}

/**
 * Map any thrown value to a fixed, renderable failure.
 *
 * A non-ApiError collapses to 'unknown' rather than having its `.message` read.
 * That is the path by which a stack trace would otherwise reach the screen.
 */
export function describeAccountFailure(error: unknown): AccountFailure {
  if (!(error instanceof ApiError)) {
    return { kind: 'unknown', message: MESSAGES.unknown };
  }
  const kind = kindOf(error);
  return { kind, message: MESSAGES[kind] };
}
