import { useState } from 'react';
import { Button } from '@/components/Button';
import type { OnboardingLinkStatus, OnboardingLinkSummary } from '@/types/domain';

// The existing links.
//
// WHAT IS NOT HERE: no token, no hash, no reconstructed URL, no creator id, no
// account id. The backend does not send the first three, and the parser rejects
// a payload that does. The last two are internal identifiers that mean nothing
// to a reader and everything to somebody reading over their shoulder.
//
// THE STATUS IS THE BACKEND'S. It is never recomputed from `expires_at` against
// the browser clock: a client clock that is a day fast would show a live link as
// expired, and an agency would then reissue instead of revoking.

const STATUS_LABELS: Record<OnboardingLinkStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

const STATUS_TONE: Record<OnboardingLinkStatus, string> = {
  active: 'bg-[var(--color-ok-surface)] text-[var(--color-ok)]',
  expired: 'bg-[var(--color-surface-sunken)] text-[var(--color-ink-muted)]',
  revoked: 'bg-[var(--color-danger-surface)] text-[var(--color-danger)]',
};

function formatDate(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Fact({ label, iso }: { label: string; iso: string | null }) {
  if (!iso) return null;
  const formatted = formatDate(iso);
  if (!formatted) return null;
  return (
    <div className="flex gap-1.5">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd>{formatted}</dd>
    </div>
  );
}

interface OnboardingLinkRowProps {
  link: OnboardingLinkSummary;
  onRevoke: (linkId: number) => void;
  isRevoking: boolean;
  /** True while any revoke is in flight, so a second one cannot be started. */
  revokeBusy: boolean;
}

function OnboardingLinkRow({ link, onRevoke, isRevoking, revokeBusy }: OnboardingLinkRowProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      className="rounded-lg border border-[var(--color-border-subtle)]
                 bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5
                      text-xs font-medium ${STATUS_TONE[link.status]}`}
        >
          {STATUS_LABELS[link.status]}
        </span>

        {/*
          Only an ACTIVE link can be revoked. An expired one already stopped
          working and a revoked one is already revoked; offering the action on
          either would imply it does something.
        */}
        {link.status === 'active' && !confirming ? (
          <Button
            variant="secondary"
            onClick={() => setConfirming(true)}
            disabled={revokeBusy}
          >
            Revoke link
          </Button>
        ) : null}
      </div>

      {/*
        `completed_at` and `status` are INDEPENDENT facts, shown as two rows
        rather than folded into one word. A client can finish their setup while
        the link is still live — "Active" and "Setup finished" are both true, and
        collapsing them would hide that the credential is still usable.
      */}
      <dl className="mt-2 space-y-1 text-sm">
        <Fact label="Created" iso={link.created_at} />
        <Fact label="Expires" iso={link.expires_at} />
        <Fact label="First opened" iso={link.first_used_at} />
        <Fact label="Setup finished" iso={link.completed_at} />
        {/*
          "Revoked on", not "Revoked": the status badge above already says
          "Revoked", and two elements reading exactly the same word — one a
          state, one a date label — is ambiguous to a screen-reader user
          navigating by text and to anyone scanning the row.
        */}
        <Fact label="Revoked on" iso={link.revoked_at} />
      </dl>

      {/*
        Gated on the link still being ACTIVE, not just on `confirming`. Without
        the status check the panel stays open after a successful revoke — the row
        re-renders from the refetched list as "Revoked" while still offering
        "Confirm revoke" underneath it, which reads as though the revocation had
        not taken. Tying it to the server's status means the refetch closes it.
      */}
      {confirming && link.status === 'active' ? (
        <div
          role="group"
          aria-label="Confirm revoking this setup link"
          className="mt-3 rounded-md border border-[var(--color-danger-border)]
                     bg-[var(--color-danger-surface)] px-3 py-3"
        >
          <p className="text-sm text-[var(--color-danger)]">
            Revoking stops this link immediately. Anyone part-way through setup with it is
            signed out and cannot continue. This cannot be undone — you would have to
            create a new link.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={isRevoking}
              loadingLabel="Revoking…"
              onClick={() => {
                // The confirmation panel stays open while the request is in
                // flight; the row re-renders from the refetched list afterwards.
                if (!revokeBusy) onRevoke(link.id);
              }}
            >
              Confirm revoke
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={isRevoking}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

interface OnboardingLinkListProps {
  links: OnboardingLinkSummary[];
  onRevoke: (linkId: number) => void;
  revokingLinkId: number | null;
}

export function OnboardingLinkList({ links, onRevoke, revokingLinkId }: OnboardingLinkListProps) {
  return (
    <ul aria-label="Setup links" className="space-y-2">
      {links.map((link) => (
        <OnboardingLinkRow
          key={link.id}
          link={link}
          onRevoke={onRevoke}
          isRevoking={revokingLinkId === link.id}
          revokeBusy={revokingLinkId !== null}
        />
      ))}
    </ul>
  );
}
