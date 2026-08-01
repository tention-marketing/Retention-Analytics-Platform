import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createOnboardingLink, getAgencyOnboardingStatus, getOnboardingLinks, revokeOnboardingLink,
} from '@/api/onboarding';
import { queryKeys } from '@/api/queryKeys';
import { useSessionExpiryReporter } from '@/features/auth/useAuth';
import type {
  AgencyOnboardingStatus, IssuedOnboardingLink, OnboardingLinkSummary,
} from '@/types/domain';

// Onboarding state for one account.
//
// ONE FETCH PER RESOURCE. The status payload also contains a `links` array, and
// it is deliberately ignored: the link list has its own query, and having two
// cached copies of the same list means a revoke that refreshes one of them
// leaves the page disagreeing with itself.
//
// Every 401 goes through the shared reporter, so a dead session takes the one
// existing sign-out path rather than each hook inventing a redirect.

export type OnboardingResourceStatus = 'loading' | 'ready' | 'error';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface UseOnboardingStatusResult {
  status: OnboardingResourceStatus;
  data: AgencyOnboardingStatus | null;
  error: unknown;
  refresh: () => void;
  isRefreshing: boolean;
}

export function useOnboardingStatus(accountId: number): UseOnboardingStatusResult {
  const reportSessionExpiry = useSessionExpiryReporter();
  const query = useQuery<AgencyOnboardingStatus>({
    queryKey: queryKeys.accounts.onboardingStatus(accountId),
    queryFn: ({ signal }) => getAgencyOnboardingStatus(accountId, signal),
  });

  useEffect(() => {
    if (query.error) reportSessionExpiry(query.error);
  }, [query.error, reportSessionExpiry]);

  return {
    status: query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
    data: query.data ?? null,
    error: query.error,
    // MANUAL only. There is no polling in this checkpoint: a background refetch
    // of an agency page nobody is watching costs a Redis round trip per provider
    // per interval, and the sync it would be watching takes minutes to hours.
    refresh: () => void query.refetch(),
    isRefreshing: query.isFetching,
  };
}

// ---------------------------------------------------------------------------
// Link list
// ---------------------------------------------------------------------------

export interface UseOnboardingLinksResult {
  status: OnboardingResourceStatus;
  links: OnboardingLinkSummary[];
  /** True only when the request SUCCEEDED and there genuinely are none. */
  isEmpty: boolean;
  error: unknown;
  retry: () => void;
  isRetrying: boolean;
}

export function useOnboardingLinks(accountId: number): UseOnboardingLinksResult {
  const reportSessionExpiry = useSessionExpiryReporter();
  const query = useQuery<OnboardingLinkSummary[]>({
    queryKey: queryKeys.accounts.onboardingLinks(accountId),
    queryFn: ({ signal }) => getOnboardingLinks(accountId, signal),
  });

  useEffect(() => {
    if (query.error) reportSessionExpiry(query.error);
  }, [query.error, reportSessionExpiry]);

  const links = query.data ?? [];
  const status: OnboardingResourceStatus =
    query.isPending ? 'loading' : query.isError ? 'error' : 'ready';

  return {
    status,
    links,
    isEmpty: status === 'ready' && links.length === 0,
    error: query.error,
    retry: () => void query.refetch(),
    isRetrying: query.isFetching,
  };
}

// ---------------------------------------------------------------------------
// Creation — the one-time secret
// ---------------------------------------------------------------------------

export interface UseCreateOnboardingLinkResult {
  /** The freshly minted link, in component memory only. Null once dismissed. */
  issued: IssuedOnboardingLink | null;
  create: () => void;
  dismiss: () => void;
  isCreating: boolean;
  error: unknown;
}

/**
 * Mint an onboarding link.
 *
 * DELIBERATELY NOT useMutation. A mutation keeps its last successful `data` in
 * the mutation cache until it is garbage-collected or reset, and that data would
 * be the one-time setup URL — a live credential sitting in a global store,
 * visible in devtools, surviving navigation away from this page, and readable by
 * any other component with the query client. Resetting after the fact leaves a
 * window; not putting it there at all does not.
 *
 * So the request is a plain awaited call and the result goes into `useState`.
 * The URL therefore exists in exactly four places, all of them required: the
 * network response, this component's memory, the panel on screen, and the
 * clipboard after the user explicitly asks for it. It dies on dismiss, on
 * unmount, on an account change, and on the sign-out that unmounts the tree.
 *
 * `retry` is not "disabled" here — there is no retry mechanism to disable, which
 * is a stronger guarantee. POST /accounts/:id/onboarding-links is not
 * idempotent: a replayed request is a second live credential for the same brand.
 */
export function useCreateOnboardingLink(accountId: number): UseCreateOnboardingLinkResult {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();

  const [issued, setIssued] = useState<IssuedOnboardingLink | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // A ref, not the isCreating state: state updates are asynchronous, so two
  // clicks in the same tick would both read `isCreating === false` and both
  // fire. This flips synchronously.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Switching accounts must not carry one brand's live credential onto another
  // brand's page. Clearing on the id change covers the case where the route
  // param changes without the component remounting.
  useEffect(() => {
    setIssued(null);
    setError(null);
  }, [accountId]);

  const create = useCallback(() => {
    // Both guards matter: `inFlight` blocks the double click, `issued` enforces
    // "dismiss the panel before minting another", so an unread secret is never
    // replaced on screen by a newer one.
    if (inFlight.current || issued !== null) return;
    inFlight.current = true;
    setIsCreating(true);
    setError(null);

    void (async () => {
      try {
        const link = await createOnboardingLink(accountId);
        if (!mounted.current) return; // Unmounted mid-flight: `link` goes out of scope.
        setIssued(link);

        // Fired AFTER the secret is on screen, and not awaited. The URL cannot
        // be retrieved again, so a slow or failing list refresh must never be
        // what stands between the agency and the only copy of it.
        void queryClient
          .invalidateQueries({ queryKey: queryKeys.accounts.onboardingLinks(accountId) })
          .catch(() => undefined);
        void queryClient
          .invalidateQueries({ queryKey: queryKeys.accounts.onboardingStatus(accountId) })
          .catch(() => undefined);
      } catch (cause) {
        reportSessionExpiry(cause);
        if (mounted.current) setError(cause);
      } finally {
        inFlight.current = false;
        if (mounted.current) setIsCreating(false);
      }
    })();
  }, [accountId, issued, queryClient, reportSessionExpiry]);

  const dismiss = useCallback(() => {
    setIssued(null);
    setError(null);
  }, []);

  return { issued, create, dismiss, isCreating, error };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export interface UseRevokeOnboardingLinkResult {
  revoke: (linkId: number) => void;
  /** The link currently being revoked, so only its row shows a busy state. */
  pendingLinkId: number | null;
  error: unknown;
  reset: () => void;
}

/**
 * Revoke one link, scoped to its account.
 *
 * useMutation is fine here where it was not for creation: this call returns
 * `{ revoked: true, id }` and the wrapper discards even that, so there is
 * nothing secret for the mutation cache to hold.
 *
 * NO OPTIMISTIC UPDATE. Painting a row as revoked before the server agrees would
 * show an agency that a live credential had been killed when it had not — the
 * one lie this screen must never tell. The row changes when the refetched list
 * says it changed.
 */
export function useRevokeOnboardingLink(accountId: number): UseRevokeOnboardingLinkResult {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();
  const [pendingLinkId, setPendingLinkId] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: (linkId: number) => revokeOnboardingLink(accountId, linkId),
    // Never. The call is idempotent server-side, but a retry after a 404 or a
    // 400 cannot succeed, and an automatic replay of a destructive action is not
    // something to do on the user's behalf.
    retry: false,
    onSettled: async () => {
      setPendingLinkId(null);
      // Both, always — including after a failure. A revoke that returned 404
      // because the list was stale is exactly when the list most needs refetching.
      await Promise.all([
        queryClient
          .invalidateQueries({ queryKey: queryKeys.accounts.onboardingLinks(accountId) })
          .catch(() => undefined),
        queryClient
          .invalidateQueries({ queryKey: queryKeys.accounts.onboardingStatus(accountId) })
          .catch(() => undefined),
      ]);
    },
    onError: (cause) => {
      reportSessionExpiry(cause);
    },
  });

  return {
    revoke: (linkId: number) => {
      if (mutation.isPending) return;
      setPendingLinkId(linkId);
      mutation.mutate(linkId);
    },
    pendingLinkId: mutation.isPending ? pendingLinkId : null,
    error: mutation.error,
    reset: mutation.reset,
  };
}
