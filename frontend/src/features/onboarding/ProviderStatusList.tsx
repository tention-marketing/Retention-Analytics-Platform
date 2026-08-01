import { useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import {
  KlaviyoConnectForm, RechargeConnectForm, ShopifyConnectForm,
} from './ProviderConnectForms';
import { describeOnboardingFailure, onboardingFailureTitle } from './onboardingErrors';
import { useSkipProvider } from './useOnboarding';
import type {
  Provider, ProviderState, ProviderStatusSummary, ProviderSyncProgress, SyncState,
} from '@/types/domain';

// Provider status, and the actions that change it.
//
// THE ACTIONS ARE DERIVED FROM THE BACKEND'S STATE, never from local guesswork.
// A connected provider offers only "Update credentials": there is no disconnect
// endpoint and no delete endpoint, so there is no button for either — an action
// that cannot be carried out is worse than an absent one. A connected provider
// also offers no skip, because skipping records an intent and would not undo the
// connection, and a control that reads as "turn this off" but leaves the sync
// running is a lie about what happened.
//
// THE WORDING RULE: say what the backend says, and nothing stronger. The backend
// reports `connected`; it does not report `healthy`, and it has no opinion about
// whether the data is any good. It reports `syncing`; that is not `complete`.
// Every label below is a direct translation of one state, with no adjective the
// server did not earn.

const PROVIDER_LABELS: Record<Provider, string> = {
  shopify: 'Shopify',
  klaviyo: 'Klaviyo',
  recharge: 'Recharge',
};

const STATE_LABELS: Record<ProviderState, string> = {
  connected: 'Connected',
  requested: 'Setup requested',
  skipped: 'Not used',
  undecided: 'Not set up',
};

/** Deliberately not merged with STATE_LABELS — see the note in domain.ts. */
const SYNC_LABELS: Record<SyncState, string> = {
  not_started: 'No import yet',
  waiting: 'Import queued',
  syncing: 'Importing',
  retrying: 'Retrying import',
  sync_delayed: 'Import delayed',
  completed: 'Import finished',
  connected: 'Connected, nothing running',
  failed: 'Import failed',
  skipped: 'Not used',
  requested: 'Setup requested',
};

const STATE_TONE: Record<ProviderState, string> = {
  connected: 'bg-[var(--color-ok-surface)] text-[var(--color-ok)]',
  requested: 'bg-[var(--color-warn-surface)] text-[var(--color-warn)]',
  skipped: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-muted)]',
  undecided: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-muted)]',
};

/** `inventory_snapshots` reads better than the raw key; the rest are plain. */
function countLabel(key: string): string {
  return key.replace(/_/g, ' ');
}

function formatDateTime(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** The two-step confirmation for recording that a brand does not use a platform. */
function SkipConfirmation({
  providerLabel, onConfirm, onCancel, isPending,
}: {
  providerLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={`Confirm marking ${providerLabel} as not used`}
      className="mt-3 rounded-md border border-[var(--color-border-strong)]
                 bg-[var(--color-surface-sunken)] px-3 py-3"
    >
      <p className="text-sm">
        This records that the brand does not use {providerLabel}, so it stops holding up
        setup. It does not create a connection, it does not delete anything, and you can
        connect {providerLabel} later.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button loading={isPending} loadingLabel="Saving…" onClick={onConfirm}>
          Confirm
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type OpenPanel = 'none' | 'connect' | 'skip';

function ProviderRow({
  status, progress, accountId, skip,
}: {
  status: ProviderStatusSummary;
  progress: ProviderSyncProgress | undefined;
  accountId: number;
  skip: ReturnType<typeof useSkipProvider>;
}) {
  const [panel, setPanel] = useState<OpenPanel>('none');
  const label = PROVIDER_LABELS[status.provider];
  const isConnected = status.state === 'connected';
  const isSkipping = skip.pendingProvider === status.provider;

  // Reconnecting and connecting are the SAME endpoint; only the copy differs.
  // A second api function for a different button label would be two things to
  // keep in step for no gain.
  const connectLabel = isConnected ? `Update ${label} credentials`
    : status.state === 'requested' ? `Complete ${label} connection`
      : `Connect ${label}`;

  const lastSync = status.lastSyncAt ?? progress?.lastSyncAt ?? null;
  const lastSyncLabel = lastSync ? formatDateTime(lastSync) : null;
  // Real counts, sorted for a stable reading order. No total exists, so there is
  // nothing to turn them into a percentage of.
  const counts = Object.entries(progress?.counts ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <li
      className="rounded-lg border border-[var(--color-border-subtle)]
                 bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{PROVIDER_LABELS[status.provider]}</h3>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5
                      text-xs font-medium ${STATE_TONE[status.state]}`}
        >
          {STATE_LABELS[status.state]}
        </span>
      </div>

      <dl className="mt-2 space-y-1 text-sm">
        {/*
          Suppressed when the sync state only echoes the provider state. A
          skipped provider renders "Not used" as its badge; an "Import: Not used"
          row underneath is the same words twice in one small card — noise to
          scan past, and two identical strings for anyone navigating by text.
          There is no import to describe in either case.
        */}
        {progress && progress.state !== 'skipped' && progress.state !== 'requested' ? (
          <div className="flex gap-2">
            <dt className="text-[var(--color-ink-muted)]">Import</dt>
            <dd>{SYNC_LABELS[progress.state]}</dd>
          </div>
        ) : null}
        {status.shopDomain ? (
          <div className="flex gap-2">
            <dt className="text-[var(--color-ink-muted)]">Store</dt>
            <dd className="break-all">{status.shopDomain}</dd>
          </div>
        ) : null}
        {/* Only shown when there is no live connection to contradict it. */}
        {status.requestedDomain && !status.shopDomain ? (
          <div className="flex gap-2">
            <dt className="text-[var(--color-ink-muted)]">Requested store</dt>
            <dd className="break-all">{status.requestedDomain}</dd>
          </div>
        ) : null}
        {lastSyncLabel ? (
          <div className="flex gap-2">
            <dt className="text-[var(--color-ink-muted)]">Last sync</dt>
            <dd>{lastSyncLabel}</dd>
          </div>
        ) : null}
        {counts.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <dt className="text-[var(--color-ink-muted)]">Imported</dt>
            <dd>
              {counts.map(([key, value]) => `${value.toLocaleString()} ${countLabel(key)}`).join(' · ')}
            </dd>
          </div>
        ) : null}
      </dl>

      {/*
        publicMessage is a fixed sentence the backend chose from a closed
        vocabulary — see onboarding/failures.ts. The raw thrown-error text it was
        classified from stays in Postgres and the process log, which is where it
        is useful and where it is not in a browser.
      */}
      {progress?.failure ? (
        <p
          role="status"
          className="mt-2 rounded-md bg-[var(--color-warn-surface)] px-3 py-2 text-sm
                     text-[var(--color-warn)]"
        >
          {progress.failure.publicMessage}
        </p>
      ) : progress?.message ? (
        <p
          role="status"
          className="mt-2 rounded-md bg-[var(--color-warn-surface)] px-3 py-2 text-sm
                     text-[var(--color-warn)]"
        >
          {progress.message}
        </p>
      ) : null}

      {/* --- actions ------------------------------------------------------ */}
      {panel === 'none' || (panel === 'skip' && (isConnected || status.state === 'skipped')) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant={isConnected ? 'secondary' : 'primary'}
            onClick={() => setPanel('connect')}
          >
            {connectLabel}
          </Button>
          {/*
            Offered only when NOT connected and not already skipped. On a
            connected provider it would imply a disconnect that does not exist;
            on an already-skipped one it would do nothing.
          */}
          {!isConnected && status.state !== 'skipped' ? (
            <Button
              variant="secondary"
              onClick={() => setPanel('skip')}
              disabled={skip.pendingProvider !== null}
            >
              Mark as not used
            </Button>
          ) : null}
        </div>
      ) : null}

      {/*
        Gated on the provider still BEING skippable, not just on the panel flag.
        Without the state check the confirmation stays open after a successful
        skip: the card re-renders as "Not used" with a live "Confirm" underneath
        it, which reads as though the choice had not been recorded. Tying it to
        the refetched server state means the answer closes the question.
      */}
      {panel === 'skip' && !isConnected && status.state !== 'skipped' ? (
        <SkipConfirmation
          providerLabel={label}
          isPending={isSkipping}
          onConfirm={() => skip.skip(status.provider)}
          onCancel={() => setPanel('none')}
        />
      ) : null}

      {panel === 'connect' && status.provider === 'shopify' ? (
        <ShopifyConnectForm
          accountId={accountId}
          // The domain, and ONLY the domain, is prefilled: from the client's
          // agency-assist request when there is one, otherwise from the
          // connected store. No credential is ever prefilled — there is nothing
          // to prefill it from, and a masked field that looked populated would
          // suggest otherwise.
          initialDomain={status.requestedDomain ?? status.shopDomain ?? ''}
          isUpdate={isConnected}
          onDone={() => setPanel('none')}
          onCancel={() => setPanel('none')}
        />
      ) : null}
      {panel === 'connect' && status.provider === 'klaviyo' ? (
        <KlaviyoConnectForm
          accountId={accountId}
          isUpdate={isConnected}
          onDone={() => setPanel('none')}
          onCancel={() => setPanel('none')}
        />
      ) : null}
      {panel === 'connect' && status.provider === 'recharge' ? (
        <RechargeConnectForm
          accountId={accountId}
          isUpdate={isConnected}
          onDone={() => setPanel('none')}
          onCancel={() => setPanel('none')}
        />
      ) : null}
    </li>
  );
}

export function ProviderStatusList({
  accountId, providers, progress,
}: {
  accountId: number;
  providers: ProviderStatusSummary[];
  progress: ProviderSyncProgress[];
}) {
  const progressByProvider = new Map(progress.map((p) => [p.provider, p]));
  // ONE skip mutation for the section, so a skip in flight disables the others:
  // three parallel writes to the same provider-choice table is a race nobody
  // needs.
  const skip = useSkipProvider(accountId);
  const skipFailure = skip.error ? describeOnboardingFailure(skip.error, 'skip') : null;

  return (
    <>
      {skipFailure && !skipFailure.sessionExpired ? (
        <div className="mb-3">
          <Alert tone="error" title={onboardingFailureTitle('skip')}>
            <p>{skipFailure.message}</p>
          </Alert>
        </div>
      ) : null}

      {/*
        One column below `lg`. Three credential forms side by side at 640px
        produce inputs too narrow to read a domain in, and the cards are tall
        once a form is open.
      */}
      {/*
        `items-start` so each card sizes to its own content. Without it the grid
        stretches every card to the tallest, and opening one provider's
        credential form leaves the other two as tall empty boxes beside it.
      */}
      <ul className="grid grid-cols-1 items-start gap-3 lg:grid-cols-3">
        {providers.map((status) => (
          <ProviderRow
            key={status.provider}
            accountId={accountId}
            status={status}
            progress={progressByProvider.get(status.provider)}
            skip={skip}
          />
        ))}
      </ul>
    </>
  );
}
