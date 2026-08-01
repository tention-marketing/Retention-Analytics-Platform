import { Alert } from '@/components/Alert';
import type { OnboardingBlocker } from '@/types/domain';

// The two gates, side by side and never merged.
//
// A brand can finish client onboarding with only Klaviyo connected and still be
// nowhere near an RCM figure — the backend splits these into two blocker lists
// for exactly that reason. Rendering one combined list would tell an agency that
// setup was incomplete when only the cost inputs were missing, or that analytics
// were blocked when setup was fine. The headings say which is which in plain
// words rather than in the product's internal vocabulary.
//
// NO PROGRESS BAR AND NO PERCENTAGE. The backend reports real row counts and a
// list of blockers; it does not report a total to divide by, and it cannot —
// a Shopify Bulk Operation has no reliable one. "62% set up" would be invented.

/**
 * The `detail` keys this component understands, rendered as text.
 *
 * The blocker's own `message` is written by the backend for display and is safe.
 * `detail` is machine-readable context whose shape varies per code, so it is
 * read key by key — never stringified, never dumped as JSON.
 */
function BlockerDetail({ blocker }: { blocker: OnboardingBlocker }) {
  const detail = blocker.detail;
  if (!detail) return null;

  const parts: string[] = [];
  if (detail.providers?.length) parts.push(`Platforms: ${detail.providers.join(', ')}`);
  if (detail.months?.length) {
    // Months arrive as YYYY-MM-01; the day is an artefact of storing a month as
    // a date and means nothing to a reader.
    parts.push(`Months: ${detail.months.map((m) => m.slice(0, 7)).join(', ')}`);
  }
  if (detail.skus?.length) parts.push(`SKUs: ${detail.skus.join(', ')}`);
  if (parts.length === 0) return null;

  return (
    <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{parts.join(' · ')}</p>
  );
}

function BlockerList({ blockers, label }: { blockers: OnboardingBlocker[]; label: string }) {
  return (
    <ul aria-label={label} className="mt-2 space-y-2">
      {blockers.map((blocker) => (
        <li
          key={blocker.code}
          className="rounded-md border border-[var(--color-border-subtle)]
                     bg-[var(--color-surface-sunken)] px-3 py-2"
        >
          <p className="text-sm">{blocker.message}</p>
          <BlockerDetail blocker={blocker} />
        </li>
      ))}
    </ul>
  );
}

function Gate({
  heading, complete, completeLabel, incompleteLabel, blockers, blockersLabel, children,
}: {
  heading: string;
  complete: boolean;
  completeLabel: string;
  incompleteLabel: string;
  blockers: OnboardingBlocker[];
  blockersLabel: string;
  children?: React.ReactNode;
}) {
  const headingId = `${blockersLabel.replace(/\s+/g, '-').toLowerCase()}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-[var(--color-border-subtle)]
                 bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {heading}
        </h3>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            complete
              ? 'bg-[var(--color-ok-surface)] text-[var(--color-ok)]'
              : 'bg-[var(--color-warn-surface)] text-[var(--color-warn)]'
          }`}
        >
          {complete ? completeLabel : incompleteLabel}
        </span>
      </div>
      {children}
      {blockers.length > 0 ? (
        <BlockerList blockers={blockers} label={blockersLabel} />
      ) : null}
    </section>
  );
}

interface SetupOverviewProps {
  onboardingComplete: boolean;
  onboardingBlockers: OnboardingBlocker[];
  rcmReady: boolean;
  rcmBlockers: OnboardingBlocker[];
  /** From uiStates — true when setup finished without Shopify. */
  limitedAnalyticsAvailable: boolean;
}

export function SetupOverview({
  onboardingComplete, onboardingBlockers, rcmReady, rcmBlockers, limitedAnalyticsAvailable,
}: SetupOverviewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Gate
        heading="Client setup"
        complete={onboardingComplete}
        completeLabel="Setup complete"
        incompleteLabel="Setup in progress"
        blockers={onboardingBlockers}
        blockersLabel="Client setup blockers"
      >
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          What the client still has to do before their setup counts as finished.
        </p>
      </Gate>

      <Gate
        heading="Analytics readiness"
        complete={rcmReady}
        completeLabel="Ready"
        incompleteLabel="Not ready"
        blockers={rcmBlockers}
        blockersLabel="Analytics readiness blockers"
      >
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          What is still needed before retention analytics can be calculated. This is
          tracked separately from client setup and does not block it.
        </p>
        {limitedAnalyticsAvailable ? (
          <div className="mt-2">
            {/*
              The one combination worth calling out, because it looks like a
              contradiction: setup is finished, and analytics still cannot run.
            */}
            <Alert tone="info">
              <p>
                Client setup is finished without Shopify, so only the analytics their
                connected platforms support are available.
              </p>
            </Alert>
          </div>
        ) : null}
      </Gate>
    </div>
  );
}
