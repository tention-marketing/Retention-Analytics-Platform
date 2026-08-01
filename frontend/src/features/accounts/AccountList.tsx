import { Link } from 'react-router';
import type { Account } from '@/types/domain';

/**
 * Format an ISO timestamp for display, or fall back to nothing.
 *
 * The value comes from the network. `new Date('nonsense')` is an Invalid Date
 * whose `toLocaleDateString()` is the literal string "Invalid Date", which would
 * render as a date. Returning null instead lets the caller omit the field.
 *
 * No timezone is passed: this is the CREATION timestamp, a fact about when an
 * agency user clicked a button, so the viewer's own locale is the right frame.
 * The brand's `store_timezone` is what business-day boundaries are computed in,
 * and it is shown as its own field rather than being applied here.
 */
export function formatCreatedAt(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The onboarding state, derived from ONE boolean and nothing else.
 *
 * `onboarding_complete` is the only signal the backend sends, so these are the
 * only two labels there can honestly be. No percentage, no "3 of 7 steps", no
 * RCM readiness — the routes that would back any of those are 5B-2D's, and a
 * progress figure invented from a boolean is a number an agency would plan
 * around.
 */
function SetupBadge({ complete }: { complete: boolean }) {
  return (
    <span
      // `self-start` matters on the stacked mobile layout: the row is a flex
      // COLUMN there, so the default `stretch` makes this badge span the full
      // card width and read as a banner rather than a tag.
      className={`inline-flex shrink-0 self-start items-center rounded-full px-2 py-0.5
                  text-xs font-medium sm:self-center ${
        complete
          ? 'bg-[var(--color-ok-surface)] text-[var(--color-ok)]'
          : 'bg-[var(--color-warn-surface)] text-[var(--color-warn)]'
      }`}
    >
      {complete ? 'Setup complete' : 'Setup in progress'}
    </span>
  );
}

/**
 * The directory list.
 *
 * A <ul> of links rather than a table: there are four fields, one of which is
 * the row's own title, and on a phone a table of four columns becomes a
 * horizontal scroll for no gain. The whole card is one link, so the tap target
 * is the row and the accessible name is the brand name.
 */
export function AccountList({ accounts }: { accounts: Account[] }) {
  return (
    <ul className="space-y-2">
      {accounts.map((account) => {
        const created = formatCreatedAt(account.created_at);
        return (
          <li key={account.id}>
            <Link
              to={`/accounts/${account.id}`}
              className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-subtle)]
                         bg-[var(--color-surface)] p-4 transition-colors
                         hover:border-[var(--color-border-strong)]
                         hover:bg-[var(--color-surface-sunken)]
                         sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{account.name}</span>
                <span className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">
                  {account.store_timezone.replace(/_/g, ' ')}
                  {created ? <> &middot; Created {created}</> : null}
                </span>
              </span>
              <SetupBadge complete={account.onboarding_complete} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
