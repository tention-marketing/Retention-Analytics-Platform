import { apiClientError, apiErrorFromResponse, apiErrorFromThrown } from './errors';
import type { HttpMethod, RequestOptions, RequestWithBody } from './types';

// The single API client.
//
// AUTHENTICATION MODEL — the one rule everything else follows: the agency
// session is the backend's httpOnly `tention_sid` cookie. This client sets
// `credentials: 'include'` and then does nothing else about auth. It never reads
// a cookie (it cannot — the cookie is httpOnly), never writes or deletes one,
// never mints a token, and never touches localStorage, sessionStorage or
// IndexedDB. There is no code path here that could store a credential, because
// there is no code here that ever holds one.
//
// TARGET RESTRICTION: every request resolves against a same-origin base path
// (default `/api`) and is rejected if the resolved URL leaves it. So a path that
// arrives from data — an id, a filter, a future link value — cannot redirect a
// credentialed request to another host. `credentials: 'include'` plus an
// attacker-influenced URL is exactly how a session gets handed to somebody else.
//
// LOGGING: this file contains no console call. Not for requests, not for
// responses, not for errors. A logged body is a logged credential the first time
// somebody posts one.

const DEFAULT_BASE = '/api';

/**
 * Validate and normalize the configured base.
 *
 * Must be a same-origin absolute path. An absolute URL is refused outright:
 * pointing the base at another origin would send the session cookie there.
 */
export function normalizeApiBase(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_BASE).trim();
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error(
      'VITE_API_BASE_URL must be a same-origin absolute path such as "/api".',
    );
  }
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export const API_BASE = normalizeApiBase(import.meta.env.VITE_API_BASE_URL as string | undefined);

/**
 * Resolve an API path to a same-origin URL inside the base, or throw.
 *
 * Rejects: absolute URLs, scheme-relative `//host` paths, anything not starting
 * with `/`, and any `..` traversal that escapes the base once the URL parser has
 * normalized it. Returns a path-only string so no origin is ever passed to fetch.
 */
export function resolveApiUrl(path: string, base: string = API_BASE): string {
  if (typeof path !== 'string' || path === '') {
    throw apiClientError('Invalid API path.', 'invalid_api_path');
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw apiClientError('API paths must be same-origin and start with "/".', 'invalid_api_path');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw apiClientError('API paths must not include a scheme.', 'invalid_api_path');
  }

  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(`${base}${path}`, origin);
  } catch {
    throw apiClientError('Invalid API path.', 'invalid_api_path');
  }

  if (url.origin !== origin) {
    throw apiClientError('Refusing to send a credentialed request off-origin.', 'off_origin_request');
  }
  // `..` segments are collapsed by the URL parser, so this catches an escape
  // attempt after normalization rather than by pattern-matching the input.
  const prefix = base === '/' ? '/' : `${base}/`;
  if (url.pathname !== base && !url.pathname.startsWith(prefix)) {
    throw apiClientError('Refusing to send a request outside the API base.', 'outside_api_base');
  }

  // Path + query only. The fragment is dropped: it is never transmitted anyway,
  // and it is where Phase 5C's onboarding token will live.
  return `${url.pathname}${url.search}`;
}

/**
 * Read a body without letting a malformed one become an exception.
 *
 * Returns a parsed value for JSON, a string for anything else with content, and
 * null for an empty body (204, or a 200 with no content — both of which several
 * backend routes legitimately produce).
 */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;

  const text = await response.text().catch(() => '');
  if (text === '') return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Malformed JSON despite the header. Fall through to the raw string, which
      // the error normalizer will decline to display.
      return text;
    }
  }
  return text;
}

async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestWithBody = {},
): Promise<T> {
  const url = resolveApiUrl(path);
  const hasBody = options.body !== undefined;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Caller headers first so the client's own values below always win: a caller
    // must not be able to change the content type of a serialized JSON body, and
    // must not be able to turn off the Accept header the backend branches on.
    ...options.headers,
  };
  if (hasBody) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method,
    headers,
    // THE AUTHENTICATION MECHANISM. The browser attaches the httpOnly agency
    // cookie; this app never sees, sets, or stores it.
    credentials: 'include',
    // Authenticated responses must not be reused from the HTTP cache.
    cache: 'no-store',
    redirect: 'error',
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    // Network failure or abort. The thrown value is never logged or re-exposed.
    throw apiErrorFromThrown(cause);
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw apiErrorFromResponse(response.status, body, response.headers);
  }
  // An empty 200 is a success, not a parse failure. Callers expecting nothing
  // type it as void; callers expecting data get whatever was parsed.
  return body as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('GET', path, options ?? {}),
  post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('POST', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('PUT', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    request<T>('PATCH', path, { ...options, ...(body !== undefined ? { body } : {}) }),
  delete: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('DELETE', path, options ?? {}),
};

export type ApiClient = typeof api;
