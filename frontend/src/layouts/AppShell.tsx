import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { useLogout } from '@/features/auth/useAuth';
import type { AgencyUser } from '@/types/domain';

interface AppShellProps {
  user: AgencyUser;
  children: ReactNode;
}

/**
 * The authenticated agency shell.
 *
 * Product identity, who is signed in, a way out, and the protected content
 * area. Nothing else — there are no counts, no provider badges and no metrics
 * here, because no backend call in this checkpoint returns any, and a plausible
 * looking zero is worse than an absent section.
 */
export function AppShell({ user, children }: AppShellProps) {
  const navigate = useNavigate();
  const logoutMutation = useLogout(() => {
    // replace, not push: the protected page must not be one Back press away.
    void navigate('/login', { replace: true });
  });

  return (
    <div className="min-h-dvh bg-[var(--color-surface-muted)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-10
                   focus:rounded-md focus:bg-[var(--color-surface)] focus:px-3 focus:py-2
                   focus:text-sm focus:font-medium focus:shadow"
      >
        Skip to content
      </a>

      <header className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row
                        sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="text-sm font-semibold tracking-tight">Tention Pulse</p>
            <p className="text-xs text-[var(--color-ink-muted)]">Agency workspace</p>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-[var(--color-ink-muted)]">
              {/* The only identity the backend returns, shown as-is. */}
              <span className="sr-only">Signed in as </span>
              {user.email}
            </span>
            <Button
              variant="secondary"
              onClick={logoutMutation.submit}
              loading={logoutMutation.isSubmitting}
              loadingLabel="Signing out…"
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      {logoutMutation.error ? (
        <div className="mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6">
          {/*
            A failed sign-out leaves the session alive on the server. Saying so
            plainly beats clearing the screen and implying it worked.
          */}
          <Alert tone="error" title="Could not sign out">
            <p>
              You are still signed in. Check your connection and try again.
            </p>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={logoutMutation.submit}
                loading={logoutMutation.isSubmitting}
              >
                Try again
              </Button>
            </div>
          </Alert>
        </div>
      ) : null}

      <main id="main" className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}
