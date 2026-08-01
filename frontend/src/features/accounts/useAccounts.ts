import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAccount, fetchAccounts, type CreateAccountInput } from '@/api/accounts';
import { queryKeys } from '@/api/queryKeys';
import { useSessionExpiryReporter } from '@/features/auth/useAuth';
import type { Account, CreatedAccount } from '@/types/domain';

// Account state.
//
// ONE FETCH, ONE CACHE ENTRY. GET /accounts is requested from exactly one place
// — the hook below — under exactly one key. The directory reads it, and so does
// the workspace route, which resolves a single account out of the same list
// rather than calling an endpoint that does not exist. Two components fetching
// the same list separately is how a page ends up making the same request twice
// and then disagreeing with itself about the answer.

export type AccountsStatus = 'loading' | 'ready' | 'error';

export interface UseAccountsResult {
  status: AccountsStatus;
  accounts: Account[];
  /** True only when the request succeeded and the agency genuinely has none. */
  isEmpty: boolean;
  error: unknown;
  retry: () => void;
  isRetrying: boolean;
}

export function useAccounts(): UseAccountsResult {
  const query = useQuery<Account[]>({
    queryKey: queryKeys.accounts.list(),
    queryFn: ({ signal }) => fetchAccounts(signal),
  });

  // A 401 here is a session that expired between sign-in and now. Handing it to
  // the shared reporter turns it into the app's one sign-out path instead of a
  // local redirect; see features/auth/useAuth.ts.
  const reportSessionExpiry = useSessionExpiryReporter();
  useEffect(() => {
    if (query.error) reportSessionExpiry(query.error);
  }, [query.error, reportSessionExpiry]);

  const accounts = query.data ?? [];
  let status: AccountsStatus;
  if (query.isPending) status = 'loading';
  else if (query.isError) status = 'error';
  else status = 'ready';

  return {
    status,
    accounts,
    isEmpty: status === 'ready' && accounts.length === 0,
    error: query.error,
    retry: () => void query.refetch(),
    isRetrying: query.isFetching,
  };
}

/**
 * How the workspace route resolved `:accountId`.
 *
 * Five outcomes, kept apart because they need five different screens. Folding
 * 'invalid_id' and 'not_found' together would be tolerable; folding either into
 * 'error' would tell someone who mistyped a URL that the service is broken, and
 * folding 'error' into 'not_found' would tell them a real account does not exist
 * because the backend happened to be down.
 */
export type AccountResolution =
  | { state: 'invalid_id' }
  | { state: 'loading' }
  | { state: 'not_found' }
  | { state: 'error'; error: unknown; retry: () => void; isRetrying: boolean }
  | { state: 'found'; account: Account };

/**
 * Parse a route parameter into an account id.
 *
 * `Number('12abc')` is NaN but `parseInt('12abc')` is 12, and `Number(' ')` is 0
 * — both of which would turn a nonsense URL into a lookup for a real account. So
 * the string is required to be nothing but digits before it is converted, and
 * the result must be a positive safe integer.
 */
export function parseAccountId(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Resolve one account from the list query.
 *
 * NO GET /accounts/:id. The backend does not have that route, and adding one
 * purely so a page could call it would be a backend change made for the
 * convenience of a frontend that already has the data. Reading from the list
 * also means a direct browser refresh works with no extra machinery: the list is
 * fetched because the query has no cached data, and the account is found in it.
 */
export function useAccount(rawAccountId: string | undefined): AccountResolution {
  const accountId = parseAccountId(rawAccountId);
  const { status, accounts, error, retry, isRetrying } = useAccounts();

  // The id is checked before the result is read, but the hook above still runs
  // unconditionally — hooks cannot be skipped, and the list is wanted anyway.
  if (accountId === null) return { state: 'invalid_id' };
  if (status === 'loading') return { state: 'loading' };
  if (status === 'error') return { state: 'error', error, retry, isRetrying };

  const account = accounts.find((candidate) => candidate.id === accountId);
  return account ? { state: 'found', account } : { state: 'not_found' };
}

export interface UseCreateAccountResult {
  submit: (input: CreateAccountInput) => void;
  isSubmitting: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * The create-account mutation.
 *
 * `retry: false` is load-bearing, not a default being restated: POST /accounts
 * is not idempotent, so a replay after a request whose response was merely lost
 * produces a second brand that someone has to notice and delete. The isPending
 * guard in `submit` is the second lock, for the double-click that react-hook-form
 * does not catch.
 *
 * On success the list is INVALIDATED rather than patched. The 201 body carries
 * only `{id, name, store_timezone}` — no `onboarding_complete`, no `created_at` —
 * so writing it into the list cache would insert a row missing two fields the
 * directory renders. Refetching costs one request and gets the real row.
 */
export function useCreateAccount(
  onCreated: (account: CreatedAccount) => void,
): UseCreateAccountResult {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();

  const mutation = useMutation({
    mutationFn: (input: CreateAccountInput) => createAccount(input),
    retry: false,
    onSuccess: async (account) => {
      // AWAITED, not fired and forgotten. The next thing that happens is a
      // navigation to the workspace, which resolves the account out of this very
      // list — so navigating before the refetch lands would show "Account not
      // found" for an account created a moment ago. The catch keeps a failed
      // refetch from turning a successful creation into an unhandled rejection;
      // the workspace will show the list's own error state instead.
      await queryClient
        .invalidateQueries({ queryKey: queryKeys.accounts.all() })
        .catch(() => undefined);
      onCreated(account);
    },
    onError: (error) => {
      reportSessionExpiry(error);
    },
  });

  return {
    submit: (input) => {
      if (mutation.isPending) return;
      mutation.mutate(input);
    },
    isSubmitting: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}
