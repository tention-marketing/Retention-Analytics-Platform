import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/Button';
import { ErrorPanel } from '@/components/ErrorPanel';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { AccountList } from '@/features/accounts/AccountList';
import { CreateAccountForm } from '@/features/accounts/CreateAccountForm';
import { useAccounts } from '@/features/accounts/useAccounts';

/**
 * The account directory.
 *
 * Four states, all of them explicit: pending, empty, populated, and failed. The
 * one that is usually skipped is the fourth — a list component that renders
 * `data ?? []` shows an empty directory when the backend is down, which reads as
 * "this agency has no clients" and is the wrong thing to tell someone whose
 * clients are all still there.
 */
export function AccountsPage() {
  const navigate = useNavigate();
  const { status, accounts, isEmpty, error, retry, isRetrying } = useAccounts();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">
            Every client brand this agency has set up. Open one to manage its connections and
            setup.
          </p>
        </div>
        {!creating ? (
          <Button onClick={() => setCreating(true)}>New account</Button>
        ) : null}
      </div>

      {creating ? (
        <section
          aria-labelledby="create-account-heading"
          className="mt-6 rounded-lg border border-[var(--color-border-subtle)]
                     bg-[var(--color-surface)] p-4"
        >
          <h2 id="create-account-heading" className="text-sm font-semibold">
            New account
          </h2>
          <p className="mt-1 mb-4 text-sm text-[var(--color-ink-muted)]">
            A name and the store&rsquo;s timezone are all that is needed now. Connections and
            costs come later.
          </p>
          <CreateAccountForm
            onCreated={(account) => {
              setCreating(false);
              // The list has already been refetched by the mutation, so the
              // workspace can resolve this account from it immediately.
              void navigate(`/accounts/${account.id}`);
            }}
            onCancel={() => setCreating(false)}
          />
        </section>
      ) : null}

      <section aria-labelledby="account-list-heading" className="mt-6">
        <h2 id="account-list-heading" className="sr-only">
          Account list
        </h2>

        {status === 'loading' ? <LoadingSkeleton lines={4} label="Loading accounts…" /> : null}

        {status === 'error' ? (
          <ErrorPanel
            error={error}
            title="Could not load accounts"
            onRetry={retry}
            retrying={isRetrying}
          />
        ) : null}

        {isEmpty ? (
          <div
            className="rounded-lg border border-dashed border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] p-6 text-center"
          >
            <p className="text-sm font-medium">No accounts yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--color-ink-muted)]">
              Create one for your first client brand. You can connect Shopify, Klaviyo and
              Recharge to it afterwards.
            </p>
          </div>
        ) : null}

        {status === 'ready' && accounts.length > 0 ? <AccountList accounts={accounts} /> : null}
      </section>
    </>
  );
}
