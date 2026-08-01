import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { ONBOARDING_LINK_TTL_DAYS } from '@/api/onboarding';
import { OnboardingLinkList } from './OnboardingLinkList';
import { OneTimeLinkPanel } from './OneTimeLinkPanel';
import { describeOnboardingFailure, onboardingFailureTitle } from './onboardingErrors';
import {
  useCreateOnboardingLink, useOnboardingLinks, useRevokeOnboardingLink,
} from './useOnboarding';

/**
 * A failure, rendered from this feature's fixed vocabulary.
 *
 * Never ErrorPanel: that renders ApiError.message, which on these routes is a
 * machine code (`link_not_found`) or Fastify's own transport wording. Retry is
 * offered only where retrying could plausibly work — a 404 will keep being a 404.
 */
function SafeError({
  error, action, onRetry, retrying,
}: {
  error: unknown;
  action: 'links' | 'create' | 'revoke';
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const failure = describeOnboardingFailure(error, action);
  // A confirmed 401 is already redirecting to sign-in; a second message about it
  // would flash on the way out.
  if (failure.sessionExpired) return null;

  return (
    <Alert tone="error" title={onboardingFailureTitle(action)}>
      <p>{failure.message}</p>
      {onRetry && failure.retryable ? (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry} loading={retrying === true}>
            Try again
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

export function OnboardingLinksSection({ accountId }: { accountId: number }) {
  const list = useOnboardingLinks(accountId);
  const creation = useCreateOnboardingLink(accountId);
  const revocation = useRevokeOnboardingLink(accountId);

  // While an unread one-time URL is on screen, creating another is blocked —
  // the second panel would replace the first and the first link would be lost
  // while still live. The hook enforces this too; this only hides the control.
  const createBlocked = creation.issued !== null;

  return (
    <section aria-labelledby="onboarding-links-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="onboarding-links-heading" className="text-base font-semibold">
            Setup links
          </h2>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
            A setup link lets the client connect their own platforms without an account.
            It lasts {ONBOARDING_LINK_TTL_DAYS} days, and they can stop and pick up where
            they left off any time while it is valid. The link is shown once when you
            create it — copy it before you leave this page.
          </p>
        </div>
        {!createBlocked ? (
          <Button
            onClick={creation.create}
            loading={creation.isCreating}
            loadingLabel="Creating…"
          >
            Create setup link
          </Button>
        ) : null}
      </div>

      {creation.error ? (
        <div className="mt-4">
          <SafeError error={creation.error} action="create" />
        </div>
      ) : null}

      {creation.issued ? (
        <div className="mt-4">
          <OneTimeLinkPanel link={creation.issued} onDismiss={creation.dismiss} />
        </div>
      ) : null}

      {revocation.error ? (
        <div className="mt-4">
          <SafeError error={revocation.error} action="revoke" />
        </div>
      ) : null}

      <div className="mt-4">
        {list.status === 'loading' ? (
          <LoadingSkeleton lines={3} label="Loading setup links…" />
        ) : null}

        {list.status === 'error' ? (
          <SafeError
            error={list.error}
            action="links"
            onRetry={list.retry}
            retrying={list.isRetrying}
          />
        ) : null}

        {list.isEmpty ? (
          <div
            className="rounded-lg border border-dashed border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] p-6 text-center"
          >
            <p className="text-sm font-medium">No setup link yet</p>
            {/*
              Says only what is true: no link has been CREATED. It deliberately
              does not say the client has or has not been contacted — this
              product has no idea whether anyone emailed them.
            */}
            <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--color-ink-muted)]">
              Create one when you are ready for this client to connect their platforms.
            </p>
          </div>
        ) : null}

        {list.status === 'ready' && list.links.length > 0 ? (
          <OnboardingLinkList
            links={list.links}
            onRevoke={revocation.revoke}
            revokingLinkId={revocation.pendingLinkId}
          />
        ) : null}
      </div>
    </section>
  );
}
