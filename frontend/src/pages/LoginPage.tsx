import { useLocation, useNavigate } from 'react-router';
import { LoginForm } from '@/features/auth/LoginForm';
import { safeReturnPath } from '@/lib/returnPath';

/**
 * The agency sign-in page.
 *
 * Internal tool: no registration link, no password reset, no social sign-in, no
 * remember-me. None of those exists on the backend — registration in particular
 * is closed by default and must never be advertised — and offering a control
 * that cannot work is worse than omitting it.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: unknown } | null;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-surface-muted)] px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight">Tention Pulse</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Sign in to the internal agency workspace.
          </p>
        </div>

        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
          <LoginForm
            onSignedIn={() => {
              // Validated before use: an unsafe or absent value falls back to '/'
              // so a crafted link cannot turn a real sign-in into a redirect off-site.
              void navigate(safeReturnPath(state?.from), { replace: true });
            }}
          />
        </div>
      </main>
    </div>
  );
}
