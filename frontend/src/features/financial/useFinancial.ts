import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  confirmZeroAdSpendMonths, getAccountAdSpend, getAccountCosts, getAccountCurrency,
  resolveAccountCurrencyMismatch, saveAdSpendRanges, saveBlendedMargin, saveOcas,
  savePerSkuCosts, setAccountCurrency, type ZeroSpendRequest,
} from '@/api/financial';
import { queryKeys } from '@/api/queryKeys';
import { useSessionExpiryReporter } from '@/features/auth/useAuth';
import type {
  AccountCostsResponse, AccountCurrencyState, AdSpendRangeInput, AdSpendState, SkuCostInput,
} from '@/types/domain';

// Financial state for one account.
//
// THREE INDEPENDENT QUERIES, ONE PER RESOURCE. Currency, costs and ad spend load
// and fail separately, so a failing ad-spend endpoint leaves the currency and
// cost sections on screen and usable. Folding them into one query would make any
// single failure blank the whole section — and the ad-spend window is the most
// expensive of the three to compute, so it is the most likely to be the one that
// fails.
//
// EVERY MUTATION HERE:
//   * retry: false. These are writes. A replay after a 409 cannot succeed, and a
//     replay after a timeout could double-apply something the user only asked for
//     once. There is no financial write in this product worth retrying silently.
//   * no optimistic update. The screen changes when the server says it changed.
//     Painting a saved cost before the server agrees is exactly the lie this
//     product cannot afford: the number on screen would be one nothing has
//     stored, in a tool whose entire premise is honest data completeness.
//   * awaits invalidation before reporting success, so the "saved" state the user
//     sees is rendered from a re-read, not from the write's own echo.
//   * refreshes RCM READINESS as well as the resource, because every one of these
//     values is an input to it and the readiness payload is derived on read.

export type FinancialResourceStatus = 'loading' | 'ready' | 'error';

/**
 * Everything a financial write invalidates.
 *
 * The changed resource plus the onboarding status, which carries `rcmReadiness` —
 * derived live from connections, accounts.currency, account_costs, sku_costs and
 * ad_spend on every call. A cost saved without refreshing it leaves the setup
 * overview asserting a blocker the user has just cleared.
 *
 * ONBOARDING-LINK QUERIES ARE DELIBERATELY NOT TOUCHED. A cost figure has nothing
 * to do with a setup link, and invalidating that list would be an extra request
 * answering a question nobody asked.
 *
 * Failures are swallowed per key: a refresh that cannot complete must not turn a
 * successful save into a reported failure.
 */
async function invalidateAfterWrite(
  queryClient: QueryClient,
  accountId: number,
  keys: readonly (readonly unknown[])[],
): Promise<void> {
  await Promise.all([
    ...keys.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined)),
    queryClient
      .invalidateQueries({ queryKey: queryKeys.accounts.onboardingStatus(accountId) })
      .catch(() => undefined),
  ]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface FinancialResource<T> {
  status: FinancialResourceStatus;
  data: T | null;
  error: unknown;
  retry: () => void;
  isRetrying: boolean;
}

/**
 * The shared read shape.
 *
 * `enabled` exists for one reason: an account id that has not resolved yet must
 * not fire three requests against a placeholder. It is not used to express
 * "Shopify is not connected" — these resources are readable and writable
 * regardless, and gating them on a provider state would be the frontend inventing
 * an authorization rule the server does not have.
 */
function useFinancialQuery<T>(
  queryKey: readonly unknown[],
  fetcher: (signal: AbortSignal) => Promise<T>,
): FinancialResource<T> {
  const reportSessionExpiry = useSessionExpiryReporter();
  const query = useQuery<T>({
    queryKey,
    queryFn: ({ signal }) => fetcher(signal),
  });

  // In an EFFECT, not during render. reportSessionExpiry writes to the query cache,
  // and doing that while rendering another component is a side effect React is
  // entitled to reorder or discard — which showed up as the redirect to /login
  // simply not happening. This matches the pattern the onboarding hooks already
  // use, so both features take the same single sign-out path.
  useEffect(() => {
    if (query.error) reportSessionExpiry(query.error);
  }, [query.error, reportSessionExpiry]);

  return {
    status: query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
    data: query.data ?? null,
    error: query.error,
    retry: () => void query.refetch(),
    isRetrying: query.isFetching,
  };
}

export function useAccountCurrency(accountId: number): FinancialResource<AccountCurrencyState> {
  return useFinancialQuery(
    queryKeys.accounts.currency(accountId),
    (signal) => getAccountCurrency(accountId, signal),
  );
}

export function useAccountCosts(accountId: number): FinancialResource<AccountCostsResponse> {
  return useFinancialQuery(
    queryKeys.accounts.costs(accountId),
    (signal) => getAccountCosts(accountId, signal),
  );
}

export function useAccountAdSpend(accountId: number): FinancialResource<AdSpendState> {
  return useFinancialQuery(
    queryKeys.accounts.adSpend(accountId),
    (signal) => getAccountAdSpend(accountId, signal),
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface FinancialMutation<TInput> {
  submit: (input: TInput) => void;
  isSubmitting: boolean;
  error: unknown;
  /** True once the write succeeded AND the re-read completed. */
  succeeded: boolean;
  reset: () => void;
}

/**
 * The shared write shape.
 *
 * A `useRef` guard, not the `isSubmitting` state: state updates are asynchronous,
 * so two clicks in the same tick would both read `isSubmitting === false` and both
 * fire. A duplicate financial write is a second round trip that could, on the
 * zero-replace path, delete rows twice over.
 *
 * `succeeded` is set in `onSuccess` AFTER the awaited invalidation, so the moment
 * the UI says "Saved" the data behind it has already been re-fetched.
 */
function useFinancialMutation<TInput>(
  accountId: number,
  keys: readonly (readonly unknown[])[],
  write: (input: TInput) => Promise<unknown>,
): FinancialMutation<TInput> {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();
  const [succeeded, setSucceeded] = useState(false);
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: (input: TInput) => write(input),
    retry: false,
    onSuccess: async () => {
      await invalidateAfterWrite(queryClient, accountId, keys);
      setSucceeded(true);
    },
    onError: (cause) => {
      reportSessionExpiry(cause);
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const submit = useCallback((input: TInput) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSucceeded(false);
    mutation.mutate(input);
  }, [mutation]);

  const reset = useCallback(() => {
    setSucceeded(false);
    mutation.reset();
  }, [mutation]);

  return { submit, isSubmitting: mutation.isPending, error: mutation.error, succeeded, reset };
}

export function useSetCurrency(accountId: number): FinancialMutation<string> {
  return useFinancialMutation(
    accountId,
    [queryKeys.accounts.currency(accountId)],
    (currency) => setAccountCurrency(accountId, currency),
  );
}

/**
 * Resolve a currency mismatch.
 *
 * INVALIDATES EVERY FINANCIAL RESOURCE, not just the currency. Adopting the
 * Shopify currency changes what every stored money value on the page MEANS — the
 * OCAS figure, each per-SKU cost and every spend row are now labelled with a
 * different code — so all three sections must re-render from a fresh read. The
 * numbers themselves are untouched; that is precisely why the labels around them
 * cannot be left stale.
 *
 * Also invalidates the accounts LIST, because the workspace header renders from
 * it and the Shopify verification writes the account record.
 */
export function useResolveCurrencyMismatch(accountId: number): FinancialMutation<void> {
  return useFinancialMutation(
    accountId,
    [
      queryKeys.accounts.currency(accountId),
      queryKeys.accounts.costs(accountId),
      queryKeys.accounts.adSpend(accountId),
      queryKeys.accounts.list(),
    ],
    () => resolveAccountCurrencyMismatch(accountId),
  );
}

export function useSaveBlendedMargin(accountId: number): FinancialMutation<number> {
  return useFinancialMutation(
    accountId,
    [queryKeys.accounts.costs(accountId)],
    (pct) => saveBlendedMargin(accountId, pct),
  );
}

export function useSavePerSkuCosts(accountId: number): FinancialMutation<SkuCostInput[]> {
  return useFinancialMutation(
    accountId,
    [queryKeys.accounts.costs(accountId)],
    (rows) => savePerSkuCosts(accountId, rows),
  );
}

export interface OcasInput {
  /** A canonical decimal string. */
  ocasMonthly: string;
  confirmedZero: boolean;
}

export function useSaveOcas(accountId: number): FinancialMutation<OcasInput> {
  return useFinancialMutation(
    accountId,
    [queryKeys.accounts.costs(accountId)],
    (input) => saveOcas(accountId, input.ocasMonthly, input.confirmedZero),
  );
}

export function useSaveAdSpend(accountId: number): FinancialMutation<AdSpendRangeInput[]> {
  return useFinancialMutation(
    accountId,
    [queryKeys.accounts.adSpend(accountId)],
    (rows) => saveAdSpendRanges(accountId, rows),
  );
}

/**
 * Confirm zero-spend months.
 *
 * The `replace` flag is part of the INPUT, never a retry decision made here. The
 * first request omits it; if the server answers 409 `requires_replace` the
 * component surfaces which months already hold spend and asks again, and only an
 * explicit second confirmation sends `replace: true`. Nothing in this hook
 * escalates on the user's behalf — `retry: false` in the shared mutation is what
 * guarantees the second request is a second human decision.
 */
export function useConfirmZeroAdSpend(accountId: number): FinancialMutation<ZeroSpendRequest> {
  return useFinancialMutation(
    accountId,
    [queryKeys.accounts.adSpend(accountId)],
    (request) => confirmZeroAdSpendMonths(accountId, request),
  );
}
