import { Link } from 'react-router';
import { PageShell } from '@/components/PageShell';

/**
 * Unknown route.
 *
 * Says nothing about what does exist. An internal tool's 404 that helpfully
 * lists real routes is a map for anyone who should not have reached it.
 */
export function NotFoundPage() {
  return (
    <PageShell title="Page not found" description="That address does not match anything in this application.">
      <p className="text-sm">
        <Link
          to="/"
          className="font-medium text-[var(--color-accent)] underline underline-offset-2
                     hover:text-[var(--color-accent-strong)]"
        >
          Return to the start page
        </Link>
      </p>
    </PageShell>
  );
}
