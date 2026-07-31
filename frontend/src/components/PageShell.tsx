import type { ReactNode } from 'react';

interface PageShellProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/**
 * Page frame: landmarks, heading, readable measure.
 *
 * Provides the skip link and the <main> landmark once, so no page has to
 * remember them and keyboard users get a way past the header on every route.
 * The full agency shell — sidebar, user menu, mobile navigation — belongs to
 * checkpoint 5B-2B, when there is more than one destination to navigate to.
 */
export function PageShell({ title, description, children }: PageShellProps) {
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
        <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
          <p className="text-sm font-semibold tracking-tight">Tention Pulse</p>
          <p className="text-xs text-[var(--color-ink-muted)]">Agency workspace</p>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">{description}</p>
        ) : null}
        <div className="mt-6 space-y-5">{children}</div>
      </main>
    </div>
  );
}
