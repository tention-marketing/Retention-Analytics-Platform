import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { OnboardingLinksSection } from './OnboardingLinksSection';
import { ProviderStatusList } from './ProviderStatusList';
import { SetupOverview } from './SetupOverview';
import { describeOnboardingFailure, onboardingFailureTitle } from './onboardingErrors';
import { useOnboardingStatus } from './useOnboarding';

// The onboarding control centre, inside the account workspace.
//
// Three sections, in the order an agency actually works through them: where this
// client stands, how to give them a way in, and what their platforms are doing.
//
// The link section renders INDEPENDENTLY of the status query. A status failure
// must not take the link controls down with it: revoking a live credential is
// the one thing on this page that might be urgent, and "the status endpoint is
// having a bad day" is no reason to prevent it.

export function OnboardingControlCentre({ accountId }: { accountId: number }) {
  const status = useOnboardingStatus(accountId);
  const failure = status.error ? describeOnboardingFailure(status.error, 'status') : null;

  return (
    <div className="mt-8 space-y-8">
      <section aria-labelledby="setup-overview-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="setup-overview-heading" className="text-base font-semibold">
            Setup overview
          </h2>
          {/*
            Manual only. Nothing polls: a background refetch would hit Redis once
            per provider per interval to watch a sync that takes minutes to hours,
            on a page that is usually not being looked at.
          */}
          <Button
            variant="secondary"
            onClick={status.refresh}
            loading={status.isRefreshing}
            loadingLabel="Refreshing…"
          >
            Refresh status
          </Button>
        </div>

        <div className="mt-4">
          {status.status === 'loading' ? (
            <LoadingSkeleton lines={4} label="Loading setup status…" />
          ) : null}

          {status.status === 'error' && failure && !failure.sessionExpired ? (
            <Alert tone="error" title={onboardingFailureTitle('status')}>
              <p>{failure.message}</p>
              {failure.retryable ? (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    onClick={status.refresh}
                    loading={status.isRefreshing}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
            </Alert>
          ) : null}

          {status.status === 'ready' && status.data ? (
            <SetupOverview
              onboardingComplete={status.data.onboardingComplete}
              onboardingBlockers={status.data.onboardingBlockers}
              rcmReady={status.data.rcmReadiness.ready}
              rcmBlockers={status.data.rcmReadiness.blockers}
              limitedAnalyticsAvailable={status.data.uiStates.limitedAnalyticsAvailable}
            />
          ) : null}
        </div>
      </section>

      <OnboardingLinksSection accountId={accountId} />

      <section aria-labelledby="provider-status-heading">
        <h2 id="provider-status-heading" className="text-base font-semibold">
          Platforms
        </h2>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
          Read-only. Connecting, skipping and reconnecting platforms arrive in a later
          checkpoint — nothing here changes anything.
        </p>

        <div className="mt-4">
          {status.status === 'loading' ? (
            <LoadingSkeleton lines={3} label="Loading platform status…" />
          ) : null}
          {status.status === 'ready' && status.data ? (
            <ProviderStatusList
              providers={status.data.providers}
              progress={status.data.progress}
            />
          ) : null}
          {status.status === 'error' ? (
            <p className="text-sm text-[var(--color-ink-muted)]">
              Platform status is unavailable until the setup status above loads.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
