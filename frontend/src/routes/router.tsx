import { Route, Routes } from 'react-router';
import { ProtectedRoute, PublicOnlyRoute } from '@/features/auth/guards';
import { AccountsPage } from '@/pages/AccountsPage';
import { AccountWorkspacePage } from '@/pages/AccountWorkspacePage';
import { AgencyHomePage } from '@/pages/AgencyHomePage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

/**
 * Route table.
 *
 * Two zones. `/login` is the only route reachable while signed out; everything
 * else sits behind ProtectedRoute, including the catch-all.
 *
 * The catch-all is INSIDE the protected zone on purpose. A 404 rendered outside
 * it would be a page that answers before authentication resolves, and the shape
 * of that answer tells an unauthenticated visitor which paths exist. Behind the
 * guard, an unknown path is a not-found page inside the shell for a signed-in
 * user, and a redirect to /login for everyone else.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />

      {/* Layout route: the shell and its Outlet mount only once auth resolves. */}
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<AgencyHomePage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        {/*
          `:accountId` is matched as any segment and validated in the page, not
          by a route pattern. A pattern that only matched digits would send
          /accounts/abc to the catch-all "Page not found", which is a different
          and less useful answer than "that address does not contain an account
          id" — and it would leave the page free to assume its param is numeric,
          which is exactly the assumption that produces a crash the day the
          pattern changes.
        */}
        <Route path="/accounts/:accountId" element={<AccountWorkspacePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
