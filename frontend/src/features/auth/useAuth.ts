import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fetchCurrentUser, login, logout, type LoginCredentials } from '@/api/auth';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryKeys';
import type { AgencyUser } from '@/types/domain';

// Authentication state.
//
// GET /auth/me is the single source of truth for "is anyone signed in". The
// query resolves to an AgencyUser, or to `null` when the backend confirmed a
// 401. Everything else throws and stays an error, because the difference
// between "signed out" and "cannot reach the server" is the difference between
// a login screen and a retry button.

/** Three states, kept apart deliberately. */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'unavailable';

/**
 * Wipe every cached response and re-seed only the known auth state.
 *
 * `clear()` empties the whole cache — the requirement, and the reason browser
 * Back cannot resurrect another account's data after a logout or an expiry.
 * Seeding the auth key immediately afterwards is not a loophole: it records the
 * fact we just established (signed out, or this user), and without it the
 * still-mounted auth observer would find no data and immediately refetch,
 * producing a redirect-refetch loop on the way to /login.
 */
export function resetAuthCache(queryClient: QueryClient, nextUser: AgencyUser | null): void {
  queryClient.clear();
  queryClient.setQueryData(queryKeys.auth.me(), nextUser);
}

/** A failure that means the service is unreachable — never a sign-out. */
function isServiceFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  // 401 never arrives here: fetchCurrentUser turns it into `null`.
  return error.status === 0 || error.status >= 500 || error.status === 408 || error.status === 429;
}

export interface CurrentUserResult {
  status: AuthStatus;
  user: AgencyUser | null;
  error: unknown;
  /** Manual recovery for the 'unavailable' state. */
  retry: () => void;
  isRetrying: boolean;
}

export function useCurrentUser(): CurrentUserResult {
  const query = useQuery<AgencyUser | null>({
    queryKey: queryKeys.auth.me(),
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    // A confirmed 401 is data (`null`), not an error, so it is structurally
    // impossible for this to retry a sign-out. Only transport and server faults
    // reach here at all.
    retry: (failureCount, error) => isServiceFailure(error) && failureCount < 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    // Overrides the conservative global default: coming back to a tab is
    // exactly when a session may have expired elsewhere, and it is better to
    // find out then than on the next mutation.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);

  let status: AuthStatus;
  if (query.isPending) status = 'loading';
  else if (query.isError) status = 'unavailable';
  else if (query.data === null) status = 'unauthenticated';
  else status = 'authenticated';

  return {
    status,
    user: query.data ?? null,
    error: query.error,
    retry,
    isRetrying: query.isFetching,
  };
}

export interface UseLoginResult {
  submit: (credentials: LoginCredentials) => void;
  isSubmitting: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * The login mutation.
 *
 * On success the returned user is written straight into the auth cache, so the
 * shell renders from the login response rather than bouncing through a second
 * /auth/me round trip that would flash a loading state.
 */
export function useLogin(onSuccess: (user: AgencyUser) => void): UseLoginResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (credentials: LoginCredentials) => login(credentials),
    // Never. A retry burns one of the ten attempts the backend rate limit
    // allows, and a rejected credential cannot succeed by being sent again.
    retry: false,
    onSuccess: (user) => {
      // Start from an empty cache: whatever a previous session left behind must
      // not be visible to whoever just signed in.
      resetAuthCache(queryClient, user);
      onSuccess(user);
    },
  });

  return {
    // `mutate`, not `mutateAsync`, and guarded by isPending — react-hook-form
    // already blocks concurrent submits, this is the second lock.
    submit: (credentials) => {
      if (mutation.isPending) return;
      mutation.mutate(credentials);
    },
    isSubmitting: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}

export interface UseLogoutResult {
  submit: () => void;
  isSubmitting: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * The logout mutation.
 *
 * The cache is cleared ONLY on a confirmed logout. If the request fails for any
 * other reason the session may well still be live on the server, and discarding
 * the cache while showing the login screen would be claiming something we do
 * not know — the user would appear signed out while their session kept working.
 */
export function useLogout(onSuccess: () => void): UseLogoutResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => logout(),
    retry: false,
    onSuccess: () => {
      resetAuthCache(queryClient, null);
      onSuccess();
    },
  });

  return {
    submit: () => {
      if (mutation.isPending) return;
      mutation.mutate();
    },
    isSubmitting: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}
