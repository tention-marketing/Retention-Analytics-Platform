// TanStack Query key registry.
//
// Centralised so invalidation targets a shared constant rather than a string
// re-typed at each call site, where a single typo silently produces a second
// cache entry that never invalidates.
//
// NOTHING SECRET MAY APPEAR IN A KEY. Keys are held in memory, shown in
// devtools, and used as cache identity — an email or password in a key would be
// a credential stored in a place nobody thinks of as storage. Keys here carry
// only literals and resource ids.
export const queryKeys = {
  auth: {
    /** The authenticated agency user, or null when confirmed signed out. */
    me: () => ['auth', 'me'] as const,
  },
  accounts: {
    /**
     * Prefix for everything account-shaped. Invalidating this reaches the list
     * and every id-scoped entry under it in one call.
     */
    all: () => ['accounts'] as const,
    /** GET /accounts. THE ONLY account fetch in the app. */
    list: () => ['accounts', 'list'] as const,
    /**
     * Identity for one account.
     *
     * NOTHING FETCHES THIS TODAY, and that is deliberate rather than an
     * oversight: the backend has no GET /accounts/:id, so the workspace route
     * resolves an account out of the list above instead of inventing an
     * endpoint. The key exists so that id-scoped data does not later land under
     * an ad-hoc string, and so `all()` already covers it when it does.
     *
     * The id is a database primary key from the URL — a resource identifier, not
     * a secret.
     */
    detail: (accountId: number) => ['accounts', 'detail', accountId] as const,

    /**
     * GET /accounts/:id/onboarding/status.
     *
     * Nested under `detail(accountId)` so it is scoped to one account and so
     * `all()` still reaches it — a revoke that refreshes only half of an
     * account's data is how a page ends up disagreeing with itself.
     */
    onboardingStatus: (accountId: number) =>
      ['accounts', 'detail', accountId, 'onboarding-status'] as const,

    /**
     * GET /accounts/:id/onboarding-links.
     *
     * SUMMARIES ONLY. The list the backend returns carries no token, no hash and
     * no URL, and the parser rejects a payload that does — so nothing cached
     * under this key can be a secret. The one-time URL from link CREATION never
     * touches the query cache at all; it lives in component state only. See
     * features/onboarding/useOnboardingLinks.ts.
     */
    onboardingLinks: (accountId: number) =>
      ['accounts', 'detail', accountId, 'onboarding-links'] as const,

    /**
     * The three financial resources, each nested under `detail(accountId)`.
     *
     * ONE KEY PER RESOURCE, and no resource appears twice. The costs response
     * carries the SKU coverage as well, so there is deliberately no separate
     * `skus` key: GET /accounts/:id/skus returns the same coverage object, and
     * caching it twice means a per-SKU save that invalidates one leaves the other
     * showing the old percentage on the same screen.
     *
     * All three sit under the `accounts` prefix, so `all()` still reaches them —
     * and under `detail(accountId)`, so switching account cannot show one brand's
     * cost figures under another brand's name.
     */
    currency: (accountId: number) =>
      ['accounts', 'detail', accountId, 'currency'] as const,
    costs: (accountId: number) =>
      ['accounts', 'detail', accountId, 'costs'] as const,
    adSpend: (accountId: number) =>
      ['accounts', 'detail', accountId, 'ad-spend'] as const,
  },
} as const;

/** The auth key as a plain value, for cache seeding and invalidation. */
export type AuthMeKey = ReturnType<typeof queryKeys.auth.me>;

/** The accounts-list key as a plain value, for invalidation after a create. */
export type AccountsListKey = ReturnType<typeof queryKeys.accounts.list>;
