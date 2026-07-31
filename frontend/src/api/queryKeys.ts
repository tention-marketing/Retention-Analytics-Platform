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
} as const;

/** The auth key as a plain value, for cache seeding and invalidation. */
export type AuthMeKey = ReturnType<typeof queryKeys.auth.me>;
