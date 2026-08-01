import { api } from './client';
import { apiClientError } from './errors';
import type { Account, CreatedAccount } from '@/types/domain';

// The two account calls.
//
// Both go through the shared client, so both carry the HttpOnly `tention_sid`
// cookie via `credentials: 'include'` and nothing else. There is no token here,
// no storage, no second authentication mechanism — the session is the cookie the
// browser holds and this app cannot read.
//
// VALIDATION AT THE BOUNDARY. Every response is checked field by field before it
// becomes an `Account`. A TypeScript interface is a compile-time claim about a
// runtime value that arrives over a network; without a check, a renamed column
// or a proxy's error page becomes `undefined` inside a component and renders as
// a blank name or a missing date with no error anywhere. Checking once, here,
// is what lets every consumer downstream treat the type as true.

/** A finite, non-negative integer account id — what the backend's SERIAL emits. */
function isAccountId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validate one row from GET /accounts.
 *
 * Returns null rather than throwing so the caller decides what a bad row means;
 * see fetchAccounts for why it is treated as a failed response and not skipped.
 */
function parseAccount(value: unknown): Account | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;

  if (!isAccountId(row.id)) return null;
  if (typeof row.name !== 'string') return null;
  if (typeof row.store_timezone !== 'string' || row.store_timezone === '') return null;
  if (typeof row.onboarding_complete !== 'boolean') return null;
  if (typeof row.created_at !== 'string' || row.created_at === '') return null;

  // Constructed field by field rather than spread, so an extra property the
  // backend starts sending cannot silently become part of the object the UI
  // holds — a new column would have to be added to the type and to this
  // function before anything could render it.
  return {
    id: row.id,
    name: row.name,
    store_timezone: row.store_timezone,
    onboarding_complete: row.onboarding_complete,
    created_at: row.created_at,
  };
}

const MALFORMED = 'The server returned an unexpected response.';

/**
 * GET /accounts.
 *
 * A malformed row FAILS THE WHOLE REQUEST rather than being filtered out. A
 * directory that quietly drops the account it could not parse looks exactly like
 * a directory that is complete, and the person reading it has no way to tell —
 * far better to show the error state and a retry than a short list presented as
 * the whole list.
 *
 * A 401 propagates as an ApiError for the caller to route into the single
 * session-expiry path. It is not converted to an empty list: "signed out" and
 * "this agency has no clients yet" are different screens.
 */
export async function fetchAccounts(signal?: AbortSignal): Promise<Account[]> {
  const body = await api.get<unknown>('/accounts', signal ? { signal } : {});

  if (!Array.isArray(body)) {
    throw apiClientError(MALFORMED, 'malformed_accounts_payload');
  }

  const accounts: Account[] = [];
  for (const row of body) {
    const account = parseAccount(row);
    if (account === null) {
      throw apiClientError(MALFORMED, 'malformed_accounts_payload');
    }
    accounts.push(account);
  }
  return accounts;
}

/**
 * The POST /accounts request body.
 *
 * `store_timezone` is the backend's field name, not a camel-cased alias, so
 * there is no rename step that could be wrong. Both values are sent exactly as
 * the caller supplies them; trimming happens in the form, and the backend trims
 * again because it does not trust us to have done it.
 */
export interface CreateAccountInput {
  name: string;
  store_timezone: string;
}

/**
 * POST /accounts.
 *
 * NOT IDEMPOTENT: two requests make two brands. Nothing in this module retries,
 * and the mutation that calls it sets `retry: false` explicitly — see
 * features/accounts/useAccounts.ts. A retry after a timeout whose response was
 * merely lost creates a duplicate account that someone then has to find and
 * delete.
 */
export async function createAccount(input: CreateAccountInput): Promise<CreatedAccount> {
  const body = await api.post<unknown>('/accounts', {
    name: input.name,
    store_timezone: input.store_timezone,
  });

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw apiClientError(MALFORMED, 'malformed_account_payload');
  }
  const row = body as Record<string, unknown>;
  if (
    !isAccountId(row.id) ||
    typeof row.name !== 'string' ||
    typeof row.store_timezone !== 'string'
  ) {
    // Without this the success path could navigate to `/accounts/undefined`.
    throw apiClientError(MALFORMED, 'malformed_account_payload');
  }
  return { id: row.id, name: row.name, store_timezone: row.store_timezone };
}
