import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/errors';

// Shared QueryClient.
//
// Conservative by intent: this is authenticated internal data, so the defaults
// favour "ask when asked" over aggressive freshness. Everything here is
// in-memory only — no persister is installed, so the cache never reaches
// localStorage, sessionStorage or IndexedDB, and a closed tab takes the cached
// account data with it.

/** Retries only what could plausibly succeed on a second attempt. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  // A non-ApiError means the query function threw something unexpected. Retrying
  // an unknown fault just repeats it.
  if (!(error instanceof ApiError)) return false;
  // ApiError.retryable is false for 401/403/404/409 and every validation
  // failure, and true only for network faults, 408, 429 and 5xx.
  if (!error.retryable) return false;
  // A rate-limited request must not be hammered: the backoff below is shorter
  // than the login window, so a retry would burn the caller's remaining budget.
  if (error.status === 429) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // No background chatter. Sync progress opts into polling explicitly in
        // a later checkpoint; nothing polls by default.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: false,
        throwOnError: false,
      },
      mutations: {
        // Never automatically. Creating an account or minting an onboarding link
        // is not idempotent — an auto-retry after a timeout produces a second
        // account, or a second live link.
        retry: false,
      },
    },
  });
}
