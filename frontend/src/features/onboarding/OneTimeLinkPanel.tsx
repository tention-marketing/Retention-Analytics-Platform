import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import type { IssuedOnboardingLink } from '@/types/domain';

// The one-time setup URL, on screen exactly once.
//
// This component holds a live credential. Three rules shape every line of it:
//
//   1. The URL comes in as a prop and goes nowhere else. It is not written to
//      storage, not put in the URL bar, not logged, and not handed to any
//      global store. When the parent clears its state this component unmounts
//      and the string has no other referent.
//   2. The only copy path is a button the user presses. There is no automatic
//      clipboard write on mount: silently taking over someone's clipboard is
//      hostile, and it would put a credential there without them deciding to.
//   3. Nothing here logs. Not the URL, not a clipboard error, not a "copied"
//      confirmation. A console.log of this value is the credential in a
//      screen-share recording.

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the "Copied" confirmation stays before reverting. */
const COPIED_RESET_MS = 4000;

function formatExpiry(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

interface OneTimeLinkPanelProps {
  link: IssuedOnboardingLink;
  onDismiss: () => void;
}

export function OneTimeLinkPanel({ link, onDismiss }: OneTimeLinkPanelProps) {
  const fieldId = useId();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus lands on the panel heading so a keyboard or screen-reader user is put
  // where the thing they cannot retrieve again actually is.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);

  const copy = useCallback(() => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);

    // Optional chaining, not a truthiness check on `navigator.clipboard`: the
    // API is absent in non-secure contexts and in some embedded webviews, and
    // reading `.writeText` off undefined would throw where a failed copy should
    // just leave the field there to select by hand.
    const write = navigator.clipboard?.writeText?.(link.url);
    if (!write) {
      setCopyState('failed');
      return;
    }
    void write.then(
      () => {
        setCopyState('copied');
        resetTimer.current = setTimeout(() => setCopyState('idle'), COPIED_RESET_MS);
      },
      // The rejection value is deliberately dropped rather than surfaced: a
      // DOMException from the clipboard API tells the user nothing, and its
      // message is not something to render.
      () => setCopyState('failed'),
    );
  }, [link.url]);

  const expiry = formatExpiry(link.expiresAt);

  return (
    <section
      aria-labelledby={`${fieldId}-heading`}
      className="rounded-lg border-2 border-[var(--color-accent)]
                 bg-[var(--color-surface)] p-4"
    >
      <h3
        id={`${fieldId}-heading`}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold"
      >
        Copy this setup link now
      </h3>
      <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
        It is shown once and cannot be retrieved again. If you leave or refresh this page
        without copying it, create a new one.
        {expiry ? ` This link stops working on ${expiry}.` : null}
      </p>

      {/*
        "One-time setup link", not "Setup link": the surrounding section is
        labelled "Setup links", and an accessible name that is a strict prefix of
        a nearby region's name is ambiguous to anyone navigating by name — and to
        any tool doing substring matching.
      */}
      <label htmlFor={fieldId} className="mt-3 block text-sm font-medium">
        One-time setup link
      </label>
      {/*
        A readonly input rather than a <p>: it gives select-all, keyboard copy
        and a sensible focus target for free, so a clipboard failure still leaves
        a usable manual path. `readOnly` and not `disabled` — a disabled field
        cannot be focused or selected, which would remove that path.
      */}
      <input
        id={fieldId}
        type="text"
        readOnly
        value={link.url}
        onFocus={(event) => event.currentTarget.select()}
        spellCheck={false}
        className="mt-1 w-full rounded-md border border-[var(--color-border-strong)]
                   bg-[var(--color-surface-sunken)] px-3 py-2 font-mono text-xs
                   sm:text-sm"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/*
          type="button" is load-bearing: the HTML default inside a form is
          "submit", and this panel sits next to the create control. A copy that
          submitted the form would mint a second link.
        */}
        <Button type="button" onClick={copy}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy link'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDismiss}>
          Dismiss securely
        </Button>
      </div>

      {/*
        One live region, updated in place. Announced politely rather than
        assertively — the user just pressed the button, so this confirms rather
        than interrupts. The failure text never contains the URL.
      */}
      <p role="status" aria-live="polite" className="mt-2 text-sm">
        {copyState === 'copied' ? (
          <span className="text-[var(--color-ok)]">Setup link copied to your clipboard.</span>
        ) : copyState === 'failed' ? (
          <span className="text-[var(--color-danger)]">
            Could not copy automatically. Select the link above and copy it manually.
          </span>
        ) : (
          <span className="sr-only">The setup link is ready to copy.</span>
        )}
      </p>
    </section>
  );
}
