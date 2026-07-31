import { api } from './client';
import { ApiError, apiClientError } from './errors';
import type { AgencyUser } from '@/types/domain';

// The three agency authentication calls.
//
// The session is the backend's HttpOnly `tention_sid` cookie and nothing else.
// These functions send credentials in a JSON body, let the browser carry the
// cookie via the client's `credentials: 'include'`, and never touch
// document.cookie, localStorage, sessionStorage, or a token of any kind.

export interface LoginCredentials {
  email: string;
  password: string;
}

/**
 * Validate a user payload at the trust boundary.
 *
 * `AgencyUser.email` is typed as a required string, so a response missing it
 * would put `undefined` behind a `string` type and surface as a blank identity
 * in the shell. The backend always sets both fields — its own verification
 * asserts /auth/me returns exactly `{id, email}` — but a type assertion is not a
 * guarantee, so the shape is checked once here rather than trusted everywhere
 * downstream. A malformed payload is a service fault, not a sign-out.
 */
function parseAgencyUser(value: unknown): AgencyUser {
  const candidate = value as Partial<AgencyUser> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.id !== 'number' ||
    typeof candidate.email !== 'string' ||
    candidate.email === ''
  ) {
    throw apiClientError('The server returned an unexpected response.', 'malformed_user_payload');
  }
  return { id: candidate.id, email: candidate.email };
}

/**
 * POST /auth/login.
 *
 * Throws ApiError on every failure; the caller maps it through
 * describeLoginFailure so no backend wording reaches the screen. Credentials go
 * in the body — never the URL, never a query key, never a log.
 */
export async function login(credentials: LoginCredentials): Promise<AgencyUser> {
  const body = await api.post<unknown>('/auth/login', {
    email: credentials.email,
    password: credentials.password,
  });
  return parseAgencyUser(body);
}

/**
 * GET /auth/me.
 *
 * THE CENTRAL DISTINCTION IN THIS FILE: `null` means the backend confirmed the
 * caller is signed out (401). Anything else that goes wrong — offline, 500, a
 * malformed body, an unexpected status — throws, and stays an error.
 *
 * Collapsing those two cases is the classic failure here: a backend restart
 * would log every agency user out and bounce them to a login screen that also
 * cannot reach the server. Only a 401 is a logout.
 */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<AgencyUser | null> {
  try {
    const body = await api.get<unknown>('/auth/me', signal ? { signal } : {});
    return parseAgencyUser(body);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * POST /auth/logout.
 *
 * Resolves only when the session is genuinely gone. A 401 counts as gone — the
 * session cannot outlive a rejected credential — though the current backend
 * always answers 200 here, authenticated or not. Every other failure throws, so
 * the caller can show a retryable error instead of claiming a logout that did
 * not happen and discarding the cache on a false premise.
 */
export async function logout(): Promise<void> {
  try {
    await api.post<unknown>('/auth/logout');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    throw error;
  }
}
