import { Link } from 'react-router';

/**
 * Unknown route, rendered inside the authenticated shell.
 *
 * Says nothing about what does exist. An internal tool's 404 that helpfully
 * lists real routes is a map for anyone who should not have reached it.
 */
export function NotFoundPage() {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">
        That address does not match anything in this application.
      </p>
      <p className="mt-4 text-sm">
        <Link
          to="/"
          className="font-medium text-[var(--color-accent)] underline underline-offset-2
                     hover:text-[var(--color-accent-strong)]"
        >
          Return to agency home
        </Link>
      </p>
    </>
  );
}
