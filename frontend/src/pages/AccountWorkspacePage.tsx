import { Link, useParams } from 'react-router';
import { Alert } from '@/components/Alert';
import { ErrorPanel } from '@/components/ErrorPanel';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { formatCreatedAt } from '@/features/accounts/AccountList';
import { useAccount } from '@/features/accounts/useAccounts';

/**
 * One account.
 *
 * THERE IS NO GET /accounts/:id. The backend exposes the list and nothing else,
 * so this page resolves its account out of the list query rather than calling an
 * endpoint that does not exist — and no endpoint was added to the backend merely
 * to make this page's data-fetching tidier. A direct browser refresh therefore
 * works with no special handling: the query has no cached data, it fetches the
 * list, and the account is found in it.
 *
 * WHAT IS NOT HERE: no metric cards, no provider badges, no sync state, no RCM
 * readiness. Onboarding links and provider management are 5B-2D. A placeholder
 * card showing "0 connections" would be indistinguishable from a real answer.
 */
function BackToAccounts() {
  return (
    <p className="mt-4 text-sm">
      <Link
        to="/accounts"
        className="font-medium text-[var(--color-accent)] underline underline-offset-2
                   hover:text-[var(--color-accent-strong)]"
      >
        Back to all accounts
      </Link>
    </p>
  );
}

/** A shared frame for the states that are not a resolved account. */
function WorkspaceMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-1.5 text-sm text-[var(--color-ink-muted)]">{children}</div>
      <BackToAccounts />
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

export function AccountWorkspacePage() {
  const { accountId } = useParams();
  const resolution = useAccount(accountId);

  // An id that is not a positive integer never became a lookup. Saying so
  // plainly beats a 404 that implies the account might once have existed, and
  // beats the crash that `Number(undefined)` would eventually cause.
  if (resolution.state === 'invalid_id') {
    return (
      <WorkspaceMessage title="Not a valid account address">
        <p>That address does not contain an account id.</p>
      </WorkspaceMessage>
    );
  }

  if (resolution.state === 'loading') {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <div className="mt-6">
          <LoadingSkeleton lines={4} label="Loading this account…" />
        </div>
      </>
    );
  }

  // The list could not be loaded, so whether this account exists is UNKNOWN.
  // Rendering "not found" here would be asserting something we cannot see.
  if (resolution.state === 'error') {
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <div className="mt-6">
          <ErrorPanel
            error={resolution.error}
            title="Could not load this account"
            onRetry={resolution.retry}
            retrying={resolution.isRetrying}
          />
        </div>
        <BackToAccounts />
      </>
    );
  }

  if (resolution.state === 'not_found') {
    return (
      <WorkspaceMessage title="Account not found">
        <p>No account with that id is set up in this workspace.</p>
      </WorkspaceMessage>
    );
  }

  const { account } = resolution;
  const created = formatCreatedAt(account.created_at);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{account.name}</h1>
      <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">Client brand workspace.</p>

      <section
        aria-labelledby="account-details-heading"
        className="mt-6 rounded-lg border border-[var(--color-border-subtle)]
                   bg-[var(--color-surface)] p-4"
      >
        <h2 id="account-details-heading" className="text-sm font-semibold">
          Details
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Detail label="Store timezone" value={account.store_timezone.replace(/_/g, ' ')} />
          <Detail label="Setup" value={account.onboarding_complete ? 'Setup complete' : 'Setup in progress'} />
          {created ? <Detail label="Created" value={created} /> : null}
        </dl>
      </section>

      <div className="mt-4">
        <Alert tone="info" title="Setup tools arrive next">
          <p>
            Onboarding links and provider connections for this account are part of the next
            checkpoint. Nothing on this page stands in for them.
          </p>
        </Alert>
      </div>

      <BackToAccounts />
    </>
  );
}
