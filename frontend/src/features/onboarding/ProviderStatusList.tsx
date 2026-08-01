import type {
  Provider, ProviderState, ProviderStatusSummary, ProviderSyncProgress, SyncState,
} from '@/types/domain';

// Read-only provider status.
//
// NO BUTTONS. There is no connect, no skip, no reconnect and no retry here: the
// credential forms and the skip action belong to a later checkpoint, and a
// control that looks live but does nothing is worse than no control.
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

function ProviderRow({
  status, progress,
}: {
  status: ProviderStatusSummary;
  progress: ProviderSyncProgress | undefined;
}) {
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
        {progress ? (
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
    </li>
  );
}

export function ProviderStatusList({
  providers, progress,
}: {
  providers: ProviderStatusSummary[];
  progress: ProviderSyncProgress[];
}) {
  const progressByProvider = new Map(progress.map((p) => [p.provider, p]));
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {providers.map((status) => (
        <ProviderRow
          key={status.provider}
          status={status}
          progress={progressByProvider.get(status.provider)}
        />
      ))}
    </ul>
  );
}
