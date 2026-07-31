import { useQuery } from '@tanstack/react-query';
import { API_BASE, api } from '@/api/client';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ErrorPanel } from '@/components/ErrorPanel';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { PageShell } from '@/components/PageShell';

interface HealthResponse {
  ok: boolean;
}

/**
 * Checkpoint landing page.
 *
 * Shows configuration and nothing else. There is no account data, no
 * statistics, and no placeholder brand here — a fake dashboard on a foundation
 * checkpoint is how a team ends up believing a feature exists.
 *
 * The connectivity check is deliberately manual and hits GET /api/health, the
 * one unauthenticated backend route. Pressing it proves end to end that the
 * client resolves against /api, that the dev proxy strips the prefix, and that
 * the shared components render a real pending, success and failure state
 * against a real response.
 */
export function FoundationPage() {
  const health = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.get<HealthResponse>('/health', { signal }),
    enabled: false, // on demand only — nothing polls on this page
    retry: false,
    gcTime: 0,
  });

  return (
    <PageShell
      title="Frontend foundation ready"
      description="Phase 5B-2A. Workspace, API client, error model, query client, router and shared components are in place."
    >
      <Alert tone="info" title="What this checkpoint contains">
        <p>
          Application code calls the backend only through the same-origin{' '}
          <code className="rounded bg-[var(--color-surface-sunken)] px-1 py-0.5">{API_BASE}</code>{' '}
          prefix. In development Vite proxies it to the backend and strips the prefix, so{' '}
          <code className="rounded bg-[var(--color-surface-sunken)] px-1 py-0.5">
            {API_BASE}/auth/me
          </code>{' '}
          reaches the backend as <code className="rounded bg-[var(--color-surface-sunken)] px-1 py-0.5">/auth/me</code>.
        </p>
      </Alert>

      <section
        aria-labelledby="connectivity-heading"
        className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4"
      >
        <h2 id="connectivity-heading" className="text-sm font-semibold">
          API connectivity
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Sends one unauthenticated request to {API_BASE}/health. No sign-in, no account data.
        </p>

        <div className="mt-3">
          <Button onClick={() => void health.refetch()} loading={health.isFetching}>
            Check API connectivity
          </Button>
        </div>

        <div className="mt-4">
          {health.isFetching ? <LoadingSkeleton lines={1} label="Contacting the API…" /> : null}

          {!health.isFetching && health.isSuccess ? (
            <Alert tone="success" title="Backend reachable">
              <p>The API responded successfully through the {API_BASE} proxy.</p>
            </Alert>
          ) : null}

          {!health.isFetching && health.isError ? (
            <ErrorPanel
              error={health.error}
              title="Could not reach the API"
              onRetry={() => void health.refetch()}
            />
          ) : null}
        </div>
      </section>

      <section
        aria-labelledby="next-heading"
        className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4"
      >
        <h2 id="next-heading" className="text-sm font-semibold">
          Not built yet
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Sign-in, the agency shell, account list and workspace, onboarding-link management,
          provider connections, currency, costs and advertising spend all arrive in later
          checkpoints. Nothing on this page is a placeholder for them.
        </p>
      </section>
    </PageShell>
  );
}
