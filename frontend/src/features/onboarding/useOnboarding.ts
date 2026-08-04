import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  completeOnboardingForAccount, connectKlaviyoForAccount, connectRechargeForAccount,
  connectShopifyForAccount, createOnboardingLink, getAgencyOnboardingStatus, getOnboardingLinks,
  revokeOnboardingLink, skipProviderForAccount, type ShopifyCredentialsInput,
} from '@/api/onboarding';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/queryKeys';
import { useSessionExpiryReporter } from '@/features/auth/useAuth';
import type {
  AgencyOnboardingStatus, IssuedOnboardingLink, OnboardingLinkSummary, Provider, SyncState,
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
  /** True while a provider sync is active and the query is on its interval. */
  isPolling: boolean;
}

/**
 * The sync states that mean work is genuinely in flight.
 *
 * Taken from ClientSyncState in backend/src/onboarding/progress.ts, and matching
 * exactly what isSyncRunning() there treats as running. The other six —
 * not_started, completed, connected, failed, skipped, requested — are terminal
 * or idle, and polling through them would be a request every five seconds
 * forever on a page nobody is watching.
 */
const ACTIVE_SYNC_STATES: readonly SyncState[] = [
  'waiting', 'syncing', 'retrying', 'sync_delayed',
];

/** How often to re-ask while a sync is genuinely running. */
const POLL_INTERVAL_MS = 5000;

export function isSyncActive(status: AgencyOnboardingStatus | undefined | null): boolean {
  if (!status) return false;
  return status.progress.some((p) => ACTIVE_SYNC_STATES.includes(p.state));
}

export function useOnboardingStatus(accountId: number): UseOnboardingStatusResult {
  const reportSessionExpiry = useSessionExpiryReporter();
  const query = useQuery<AgencyOnboardingStatus>({
    queryKey: queryKeys.accounts.onboardingStatus(accountId),
    queryFn: ({ signal }) => getAgencyOnboardingStatus(accountId, signal),

    // POLLING, DRIVEN BY THE DATA ITSELF.
    //
    // A function rather than a number, so the decision is re-made from the
    // latest response every time: the moment the last active provider reaches a
    // terminal state, this returns false and the interval stops. There is no
    // setInterval anywhere in this feature — a hand-rolled timer is a second
    // lifecycle to get wrong, and it would keep firing after the query was
    // disabled, after an error, and after the component unmounted.
    //
    // TanStack clears the interval on unmount, so leaving the page, switching
    // account (the control centre is keyed on the id and remounts) and the
    // sign-out that unmounts the tree all stop it with no extra code.
    refetchInterval: (q) => (isSyncActive(q.state.data) ? POLL_INTERVAL_MS : false),
    // Never poll a tab nobody is looking at. A backgrounded workspace left open
    // overnight would otherwise make ~17,000 requests, each one fanning out to
    // Redis per provider, to update a screen no one can see.
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (query.error) reportSessionExpiry(query.error);
  }, [query.error, reportSessionExpiry]);

  return {
    status: query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
    data: query.data ?? null,
    error: query.error,
    // Manual refresh stays, and is the only way to update once everything has
    // settled.
    refresh: () => void query.refetch(),
    isRefreshing: query.isFetching,
    isPolling: isSyncActive(query.data),
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

// ---------------------------------------------------------------------------
// Provider connections — the credential path
// ---------------------------------------------------------------------------

export interface UseConnectProviderResult<TCredentials> {
  submit: (credentials: TCredentials) => void;
  isSubmitting: boolean;
  error: unknown;
  /** Set once after a successful connect, for the confirmation message. */
  succeeded: { queued: boolean } | null;
  reset: () => void;
}

/**
 * Submit provider credentials.
 *
 * DELIBERATELY NOT useMutation, and for a sharper reason than the one-time link
 * was. A mutation retains not only its last `data` but its last VARIABLES — and
 * the variables here ARE the credential. `mutation.state.variables` would hold a
 * Shopify client secret, a Klaviyo private key or a Recharge admin token in a
 * global store, readable from devtools and from any component with the query
 * client, until the mutation was garbage-collected. There is no configuration
 * that turns that off; the only fix is not to use the mechanism.
 *
 * So the request is a plain awaited call. The credential exists in the form's
 * state, in the argument to this function, and in the request body — and
 * nowhere else. The caller clears its own fields the moment this settles,
 * success or failure.
 *
 * Nothing here retries. A rejected credential cannot become correct by being
 * sent again, and a silent replay of a credential submission is one more copy of
 * a secret on the wire.
 *
 * NOTHING HERE LOGS. Not the credential, not the response, not the error. The
 * caught value is passed to the shared 401 reporter and to the caller's fixed
 * message mapper, and is never given to console.
 */
function useConnectProvider<TCredentials>(
  accountId: number,
  action: 'connect-shopify' | 'connect-klaviyo' | 'connect-recharge',
  send: (accountId: number, credentials: TCredentials) => Promise<{ queued: boolean }>,
): UseConnectProviderResult<TCredentials> {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [succeeded, setSucceeded] = useState<{ queued: boolean } | null>(null);

  // A ref, not the state: two clicks in one tick would both read
  // `isSubmitting === false` and both fire, and a duplicate connect is a second
  // verification round-trip with the same secret.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Switching account must not carry one brand's submission state onto another's.
  useEffect(() => {
    setError(null);
    setSucceeded(null);
  }, [accountId]);

  const submit = useCallback((credentials: TCredentials) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsSubmitting(true);
    setError(null);
    setSucceeded(null);

    void (async () => {
      try {
        const outcome = await send(accountId, credentials);
        if (mounted.current) setSucceeded({ queued: outcome.queued });

        // Provider state lives in the status query, so that is what has to be
        // re-read. Link queries are untouched: connecting a platform has nothing
        // to do with setup links, and invalidating them would be an extra
        // request that answers a question nobody asked.
        void queryClient
          .invalidateQueries({ queryKey: queryKeys.accounts.onboardingStatus(accountId) })
          .catch(() => undefined);

        // Shopify's verification also writes the account's store timezone and
        // currency (E6), so the directory row this account renders from is now
        // stale. The other two providers touch nothing on the account record.
        if (action === 'connect-shopify') {
          void queryClient
            .invalidateQueries({ queryKey: queryKeys.accounts.list() })
            .catch(() => undefined);
        }
      } catch (cause) {
        reportSessionExpiry(cause);
        if (mounted.current) setError(cause);
      } finally {
        inFlight.current = false;
        if (mounted.current) setIsSubmitting(false);
      }
    })();
  }, [accountId, action, queryClient, reportSessionExpiry, send]);

  const reset = useCallback(() => {
    setError(null);
    setSucceeded(null);
  }, []);

  return { submit, isSubmitting, error, succeeded, reset };
}

export function useConnectShopify(accountId: number) {
  return useConnectProvider<ShopifyCredentialsInput>(
    accountId, 'connect-shopify', connectShopifyForAccount,
  );
}

export function useConnectKlaviyo(accountId: number) {
  return useConnectProvider<{ apiKey: string }>(
    accountId, 'connect-klaviyo', connectKlaviyoForAccount,
  );
}

export function useConnectRecharge(accountId: number) {
  return useConnectProvider<{ token: string }>(
    accountId, 'connect-recharge', connectRechargeForAccount,
  );
}

// ---------------------------------------------------------------------------
// Skipping a provider
// ---------------------------------------------------------------------------

export interface UseSkipProviderResult {
  skip: (provider: Provider) => void;
  /** Which provider is being skipped, so only that card shows a busy state. */
  pendingProvider: Provider | null;
  error: unknown;
  reset: () => void;
}

/**
 * Record that a brand does not use a platform.
 *
 * useMutation is fine here where it was not for credentials: the variable is a
 * provider name, which is not a secret, and the response carries no credential.
 *
 * NO OPTIMISTIC UPDATE. Painting a card as skipped before the server agrees
 * would show an agency a decision that had not been recorded — and this decision
 * is what stops a platform blocking setup completion.
 */
export function useSkipProvider(accountId: number): UseSkipProviderResult {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();
  const [pendingProvider, setPendingProvider] = useState<Provider | null>(null);

  const mutation = useMutation({
    mutationFn: (provider: Provider) => skipProviderForAccount(accountId, provider),
    retry: false,
    onSettled: async () => {
      setPendingProvider(null);
      // Refetched even after a failure: a skip that 400'd because the card was
      // showing stale state is exactly when the state most needs re-reading.
      await queryClient
        .invalidateQueries({ queryKey: queryKeys.accounts.onboardingStatus(accountId) })
        .catch(() => undefined);
    },
    onError: (cause) => {
      reportSessionExpiry(cause);
    },
  });

  return {
    skip: (provider: Provider) => {
      if (mutation.isPending) return;
      setPendingProvider(provider);
      mutation.mutate(provider);
    },
    pendingProvider: mutation.isPending ? pendingProvider : null,
    error: mutation.error,
    reset: mutation.reset,
  };
}

// ---------------------------------------------------------------------------
// Completion — the last agency action in setup
// ---------------------------------------------------------------------------

export interface UseCompleteOnboardingResult {
  submit: () => void;
  isSubmitting: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * Mark this account's setup complete.
 *
 * useMutation is safe here for the reason it was not safe for credentials or the
 * one-time link: there is no variable at all (the account is in the URL, not the
 * body) and the response carries no secret — so nothing this hook leaves in the
 * mutation cache is anything that should not be there.
 *
 * NO OPTIMISTIC UPDATE, and here that matters more than anywhere else in the
 * feature. `onboarding_complete` never reverts once written, so a cache entry
 * painted `true` before the server agreed would be a claim the UI could not walk
 * back — and the one screen an agency would trust it from. The panel changes when
 * the refetched status says it changed.
 */
export function useCompleteOnboarding(accountId: number): UseCompleteOnboardingResult {
  const queryClient = useQueryClient();
  const reportSessionExpiry = useSessionExpiryReporter();

  // A ref, for the same reason useCreateOnboardingLink and useConnectProvider use
  // one: `mutation.isPending` is state, and TanStack does NOT set it synchronously
  // inside mutate(). Three clicks in one tick therefore all read `false` and all
  // fire — measured, not assumed: guarding on isPending alone sent three POSTs in
  // the duplicate-submission test. This flips before mutate() is reached.
  const inFlight = useRef(false);

  const invalidate = (key: readonly unknown[]) =>
    queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined);

  const mutation = useMutation({
    mutationFn: () => completeOnboardingForAccount(accountId),
    // Never. This is not idempotent from the user's point of view even though the
    // endpoint is: a silent replay after a timeout would mean nobody can say
    // whether the completion they are looking at was asked for once or twice.
    retry: false,

    // DELIBERATELY NOT onSettled. A single invalidation for every outcome is the
    // obvious shape and the wrong one here, because the outcomes differ in what
    // they changed:
    //
    //   success  — the account row changed, so the directory list is stale too
    //   409      — nothing changed on the server, but the page's idea of the
    //              blockers evidently had, which is the whole reason for the
    //              refusal; re-read the status and nothing else
    //   401      — the session is gone; refetching would 401 again on the way
    //              out and the cache is about to be cleared anyway
    //   network/5xx — we do not know what happened. Refetching the account list
    //              would be asking a question whose answer we would then have to
    //              interpret, and interpreting it is how a page ends up showing
    //              a completion the server never performed.
    onSuccess: async () => {
      await Promise.all([
        // The authority. Everything the panel, the two gates and the provider
        // cards render is re-read from here — nothing is written into the cache
        // by hand, so the screen can only ever show what the server said.
        invalidate(queryKeys.accounts.onboardingStatus(accountId)),
        // `accounts.onboarding_complete` moved, and it is rendered twice outside
        // this feature: the workspace's Setup detail and the directory badge.
        // Same reason useConnectShopify invalidates the list.
        invalidate(queryKeys.accounts.list()),
      ]);
    },
    onError: async (cause) => {
      if (reportSessionExpiry(cause)) return;
      if (cause instanceof ApiError && cause.status === 409) {
        await invalidate(queryKeys.accounts.onboardingStatus(accountId));
      }
    },
    // Released on both paths, so a failure does not leave the control latched
    // shut with no way back other than reloading the page.
    onSettled: () => {
      inFlight.current = false;
    },
  });

  return {
    submit: () => {
      if (inFlight.current || mutation.isPending) return;
      inFlight.current = true;
      mutation.mutate();
    },
    isSubmitting: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}
