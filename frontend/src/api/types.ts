// API transport types.
//
// Domain models live in src/types/domain.ts. This file is only the plumbing:
// what a request looks like, and what the backend's error envelopes look like on
// the wire before normalization flattens them.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** Forwarded to fetch, so an unmounted component's request is cancelled. */
  signal?: AbortSignal;
  /** Extra headers. Cannot override the ones the client sets itself. */
  headers?: Record<string, string>;
}

export interface RequestWithBody extends RequestOptions {
  /** JSON-serialized. Omit entirely to send no body at all. */
  body?: unknown;
}

/**
 * The error envelopes this backend actually produces.
 *
 * There are seven distinct shapes across the codebase, which is the whole
 * reason normalization exists — see api/errors.ts. This type documents them
 * rather than pretending they are uniform:
 *
 *   { error: 'unauthorized' }                                  auth.ts, accounts.ts
 *   { error: 'bad_ttl', message: '…' }                         agencyOnboarding.ts
 *   { code: 'invalid_domain', message: '…' }                   onboarding.ts
 *   { ok: false, error: 'invalid_code', message: '…' }         currency.ts
 *   { connected: false, code: '…', message: '…' }              client connect routes
 *   { connected: false, error: '…' }                           agency connect routes
 *   { completed: false, onboardingBlockers: [...] }            completion 409
 *   { statusCode, error, message }                             Fastify / rate-limit
 */
export interface ApiErrorShape {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  statusCode?: unknown;
  ok?: unknown;
  connected?: unknown;
  completed?: unknown;
  [key: string]: unknown;
}
