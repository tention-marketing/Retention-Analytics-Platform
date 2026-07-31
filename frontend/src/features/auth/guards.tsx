import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { PageShell } from '@/components/PageShell';
import { AppShell } from '@/layouts/AppShell';
import { safeReturnPath, toReturnPath } from '@/lib/returnPath';
import { resetAuthCache, useCurrentUser } from './useAuth';

// Route guards.
//
// FOUR STATES, NEVER THREE. Folding "the auth service is down" into "signed
// out" is the mistake these guards exist to prevent: a backend restart would
// silently sign every agency user out and send them to a login form that also
// cannot reach the server, where the only visible explanation would be a
// credential error that was never the problem.

/**
 * Shown while /auth/me is in flight. Never renders protected content.
 *
 * LoadingSkeleton already supplies the single `role="status"` live region, so
 * there is no wrapper here — nesting a second one gives assistive technology
 * two competing announcements for one event.
 */
function AuthResolving() {
  return (
    <PageShell title="Tention Pulse">
      <LoadingSkeleton lines={3} label="Checking your sign-in status…" />
    </PageShell>
  );
}

/**
 * Shown when /auth/me could not be answered.
 *
 * Deliberately NOT a redirect. The user may well still be signed in; we simply
 * do not know, and guessing in either direction is worse than saying so.
 */
function AuthUnavailable({ onRetry, isRetrying }: { onRetry: () => void; isRetrying: boolean }) {
  return (
    <PageShell title="Tention Pulse">
      <Alert tone="error" title="Cannot reach the sign-in service">
        <p>
          We could not confirm your sign-in status. This is a problem with the service, not with
          your account.
        </p>
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry} loading={isRetrying}>
            Try again
          </Button>
        </div>
      </Alert>
    </PageShell>
  );
}

/**
 * Gate for every protected route.
 *
 * Rendered as a layout route, so the shell and its `<Outlet/>` mount only after
 * authentication resolves — protected markup is never in the tree first and
 * hidden afterwards, which is what makes the no-flash guarantee structural
 * rather than a CSS trick.
 */
export function ProtectedRoute() {
  const { status, user, retry, isRetrying } = useCurrentUser();
  const location = useLocation();
  const queryClient = useQueryClient();

  // Session expiry: a live session that later resolves to `null`. Everything
  // cached under the old identity is dropped before the redirect, so browser
  // Back cannot paint stale protected data from memory.
  const wasAuthenticated = useRef(false);
  useEffect(() => {
    if (status === 'authenticated') {
      wasAuthenticated.current = true;
      return;
    }
    if (status === 'unauthenticated' && wasAuthenticated.current) {
      wasAuthenticated.current = false;
      resetAuthCache(queryClient, null);
    }
  }, [status, queryClient]);

  if (status === 'loading') return <AuthResolving />;
  if (status === 'unavailable') return <AuthUnavailable onRetry={retry} isRetrying={isRetrying} />;

  if (status === 'unauthenticated' || user === null) {
    // Remember where they were going, but only if it is a path on this origin.
    return <Navigate to="/login" replace state={{ from: toReturnPath(location) }} />;
  }

  return (
    <AppShell user={user}>
      <Outlet />
    </AppShell>
  );
}

/**
 * Gate for /login.
 *
 * Uses the same four states. An authenticated visitor is sent on to their
 * return path; a service failure shows the retry panel rather than a login form
 * that cannot possibly work.
 */
export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { status, retry, isRetrying } = useCurrentUser();
  const location = useLocation();

  if (status === 'loading') return <AuthResolving />;
  if (status === 'unavailable') return <AuthUnavailable onRetry={retry} isRetrying={isRetrying} />;

  if (status === 'authenticated') {
    const state = location.state as { from?: unknown } | null;
    // safeReturnPath also refuses '/login', so this cannot bounce back here.
    return <Navigate to={safeReturnPath(state?.from)} replace />;
  }

  return <>{children}</>;
}
