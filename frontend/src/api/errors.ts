import type { ApiErrorShape } from './types';

// Error normalization.
//
// The backend emits seven different error envelopes (catalogued in api/types.ts),
// so without a single normalizer every call site would grow its own guesswork
// about where the message lives. ApiError is that single shape.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: it never adopts a response body as
// the user-facing message just because one was present. A 500 from Fastify can
// carry an internal exception message, and logSyncError-shaped text can carry a
// stack trace with deploy-host paths. So a body message is used only when it
// passes isDisplayableMessage() below, and never for a 5xx.

export type ApiErrorKind = 'http' | 'network' | 'aborted' | 'client';

/**
 * Body keys the backend documents as client-safe structured payloads, and which
 * a caller legitimately needs in order to act on a 409.
 *
 * An ALLOWLIST, not a passthrough: everything else in the body is dropped, so
 * an unexpected field (or a future one carrying internals) cannot ride along
 * into a component. Nothing in this checkpoint reads `details` yet — it exists
 * so that the checkpoints handling completion blockers and the ad-spend
 * `requires_replace` conflict do not have to bypass ApiError to get at them.
 */
const SAFE_DETAIL_KEYS = [
  'onboardingBlockers',
  'rcmBlockers',
  'blockers',
  'months',
  'skus',
  'providers',
] as const;

/** Fixed messages by status. Used whenever the body has nothing safe to say. */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'That request was not valid.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have access to that.',
  404: 'That was not found.',
  409: 'That conflicts with the current state. Review the details and try again.',
  422: 'That request was not valid.',
  429: 'Too many attempts. Please wait a moment and try again.',
};

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
const ABORTED_MESSAGE = 'The request was cancelled.';
const SERVER_MESSAGE = 'The server could not complete this request.';
const UNKNOWN_MESSAGE = 'Something went wrong.';

/**
 * Is a server-supplied string safe to show a user?
 *
 * Backend validation and blocker messages are written for display and pass.
 * Stack traces do not: they are multiline, contain frame markers and absolute
 * paths, and are far longer than a sentence. Rejecting on those properties
 * catches the shape rather than a blocklist of known-bad substrings.
 */
export function isDisplayableMessage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 300) return false;

  if (/[\n\r]/.test(text)) return false; // stack traces are multiline

  // A stack frame, anchored to the START of a line.
  //
  // This was briefly `/\s+at\s/`, which matched the word "at" anywhere and so
  // rejected "Connect at least one platform to finish setup." — a real backend
  // blocker message. A filter that silently swallows legitimate copy is worse
  // than no filter, because the failure is invisible. Anchoring to line start
  // distinguishes a frame from ordinary English.
  if (/(^|\n)\s*at\s+\S/.test(text)) return false;

  // file:line:column, which appears in every frame and in no backend message.
  if (/:\d+:\d+/.test(text)) return false;

  if (/\/(?:Users|home|var|opt|srv|etc|root)\//.test(text)) return false; // deploy paths
  if (/node_modules|node:internal|file:\/\//.test(text)) return false;
  if (/^[A-Za-z]*Error:/.test(text)) return false; // "TypeError: ..."
  return true;
}

/** Normalized, frontend-safe error. The only error type the app throws or catches. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  readonly kind: ApiErrorKind;
  /** Stable machine code from the body when present, e.g. 'bad_ttl'. */
  readonly code: string | null;
  /** Whether retrying could plausibly succeed without user intervention. */
  readonly retryable: boolean;
  /** Parsed from Retry-After on a 429, when the server supplied it. */
  readonly retryAfterSeconds: number | null;
  /** Per-field validation messages, when the backend expressed them that way. */
  readonly fieldErrors: Record<string, string> | null;
  /** Allowlisted structured payload — see SAFE_DETAIL_KEYS. */
  readonly details: Record<string, unknown> | null;

  constructor(init: {
    status: number;
    kind: ApiErrorKind;
    message: string;
    code?: string | null;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
    fieldErrors?: Record<string, string> | null;
    details?: Record<string, unknown> | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.kind = init.kind;
    this.code = init.code ?? null;
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.fieldErrors = init.fieldErrors ?? null;
    this.details = init.details ?? null;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** True when the session is gone and the app should return to sign-in. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

/** 4xx are the caller's problem; transient transport and server faults are not. */
function computeRetryable(status: number, kind: ApiErrorKind): boolean {
  if (kind === 'aborted' || kind === 'client') return false;
  if (kind === 'network') return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/** Retry-After is either delta-seconds or an HTTP-date (RFC 9110). Both handled. */
export function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86_400) : null;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const seconds = Math.ceil((when - Date.now()) / 1000);
  return seconds > 0 ? Math.min(seconds, 86_400) : 0;
}

function extractCode(body: ApiErrorShape): string | null {
  // `code` is the newer convention; `error` carries the code on older routes.
  // Only a short token-like string is treated as a code — `error` is sometimes a
  // whole sentence ("accountId (number) required"), which is a message.
  for (const candidate of [body.code, body.error]) {
    if (typeof candidate === 'string') {
      const value = candidate.trim();
      if (value && value.length <= 64 && !/\s/.test(value)) return value;
    }
  }
  return null;
}

function extractFieldErrors(body: ApiErrorShape): Record<string, string> | null {
  const raw = body.fieldErrors ?? body.errors ?? body.validation;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [field, message] of Object.entries(raw as Record<string, unknown>)) {
    if (isDisplayableMessage(message)) out[field] = message.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractDetails(body: ApiErrorShape): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_DETAIL_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractMessage(body: ApiErrorShape, status: number): string {
  // A 5xx body is never trusted for display: that is exactly where an internal
  // exception message surfaces.
  if (status < 500) {
    if (isDisplayableMessage(body.message)) return body.message.trim();
    // Some older routes put a human sentence in `error` instead of a code.
    if (typeof body.error === 'string' && /\s/.test(body.error) && isDisplayableMessage(body.error)) {
      return body.error.trim();
    }
  }
  return STATUS_MESSAGES[status] ?? (status >= 500 ? SERVER_MESSAGE : UNKNOWN_MESSAGE);
}

/**
 * Build an ApiError from a response whose body has already been read.
 *
 * `body` is whatever safe-parsing produced: a parsed object, a string for a
 * non-JSON response, or null. A string body is NOT adopted as the message —
 * an HTML error page or a proxy's plain-text output is not something to render.
 */
export function apiErrorFromResponse(
  status: number,
  body: unknown,
  headers?: Headers,
): ApiError {
  const shape: ApiErrorShape =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as ApiErrorShape)
      : {};

  return new ApiError({
    status,
    kind: 'http',
    message: extractMessage(shape, status),
    code: extractCode(shape),
    retryable: computeRetryable(status, 'http'),
    retryAfterSeconds: status === 429 ? parseRetryAfter(headers?.get('retry-after') ?? null) : null,
    fieldErrors: extractFieldErrors(shape),
    details: extractDetails(shape),
  });
}

/** A request that never produced a response: DNS, offline, CORS, or abort. */
export function apiErrorFromThrown(cause: unknown): ApiError {
  const aborted =
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error && cause.name === 'AbortError');

  if (aborted) {
    return new ApiError({ status: 0, kind: 'aborted', message: ABORTED_MESSAGE, retryable: false });
  }
  // The thrown value is deliberately dropped rather than wrapped: a TypeError
  // from fetch carries a stack, and nothing in it helps a user.
  return new ApiError({ status: 0, kind: 'network', message: NETWORK_MESSAGE, retryable: true });
}

/** A refusal raised before any request was sent (bad target, bad base). */
export function apiClientError(message: string, code: string): ApiError {
  return new ApiError({ status: 0, kind: 'client', message, code, retryable: false });
}

/** Narrow an unknown caught value to a renderable message, without leaking internals. */
export function toDisplayMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return UNKNOWN_MESSAGE;
}
