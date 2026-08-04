import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { describeOnboardingFailure, onboardingFailureTitle } from './onboardingErrors';
import { useCompleteOnboarding } from './useOnboarding';
import type { OnboardingBlocker } from '@/types/domain';

// The last action in agency-side setup.
//
// THREE STATES, ALL READ FROM THE SERVER: complete, blocked, ready. Nothing here
// decides which one applies — `onboardingComplete` and `onboardingBlockers` come
// from the same status response the two gates above render, so this panel and
// those gates cannot disagree about whether setup is finished.
//
// WHAT COMPLETION DOES NOT MEAN. It means the gate passed: every platform was
// answered, and at least one is genuinely connected. It does not mean all three
// are connected, that imports have finished, that Shopify is among them, that any
// cost figure exists, or that RCM can be calculated. The copy below says so
// outright rather than leaving a reader to infer it from a green badge — a brand
// can be complete here and permanently unable to produce an RCM figure, and that
// combination has to read as normal, because it is.
//
// AND IT IS NOT A CLAIM ABOUT THE CLIENT. An agency member can connect platforms
// and record decisions themselves, so "setup complete" is a statement about this
// workspace, never about who did the work.
//
// The disabled button is not the control. The server re-runs the whole gate on
// every request and answers 409 when it does not pass; this is only what stops a
// pointless round trip.

/**
 * The blocked case's pointer, kept deliberately vague about the specifics.
 *
 * SetupOverview is directly above this panel and already lists every blocker with
 * its own wording and detail. Repeating them here would put two lists of the same
 * facts on one screen, and the moment they were ever generated differently the
 * page would contradict itself. So this counts them and points up.
 */
function blockedSummary(count: number): string {
  return count === 1
    ? 'One item above is still outstanding.'
    : `${count} items above are still outstanding.`;
}

interface CompleteSetupPanelProps {
  accountId: number;
  onboardingComplete: boolean;
  onboardingBlockers: OnboardingBlocker[];
}

export function CompleteSetupPanel({
  accountId, onboardingComplete, onboardingBlockers,
}: CompleteSetupPanelProps) {
  const completion = useCompleteOnboarding(accountId);
  const failure = completion.error
    ? describeOnboardingFailure(completion.error, 'complete')
    : null;

  // A confirmed 401 is already on its way to /login through the shared reporter.
  // Rendering an error panel behind that redirect would leave a protected screen
  // showing a message about a session that no longer exists.
  const showFailure = failure !== null && !failure.sessionExpired;

  const blocked = onboardingBlockers.length > 0;

  return (
    <section
      aria-labelledby="complete-setup-heading"
      className="mt-4 rounded-lg border border-[var(--color-border-subtle)]
                 bg-[var(--color-surface)] p-4"
    >
      <h3 id="complete-setup-heading" className="text-sm font-semibold">
        Finish setup
      </h3>

      {onboardingComplete ? (
        <>
          <p className="mt-1 max-w-prose text-sm">Setup is complete for this brand.</p>
          {/*
            The sentence that stops a green state being over-read. It is plain
            text rather than a tone-carrying Alert: this is not a warning, it is
            the definition of what the state above does and does not cover.
          */}
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
            Analytics readiness is tracked separately and may still require Shopify or
            financial inputs.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
            {blocked
              ? `Setup is not ready to be marked complete. ${blockedSummary(onboardingBlockers.length)}`
              : 'Every platform has been answered and at least one is connected, so setup can be '
                + 'marked complete. Advertising spend and cost figures are not required for this.'}
          </p>

          <div className="mt-3">
            <Button
              onClick={completion.submit}
              disabled={blocked}
              loading={completion.isSubmitting}
              loadingLabel="Marking complete…"
            >
              Mark setup complete
            </Button>
          </div>
        </>
      )}

      {showFailure ? (
        <div className="mt-3">
          <Alert tone="error" title={onboardingFailureTitle('complete')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}
    </section>
  );
}
