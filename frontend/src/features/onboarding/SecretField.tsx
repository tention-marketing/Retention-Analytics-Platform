import { useId, useState } from 'react';

// A single secret input with a reveal toggle.
//
// SHARED MARKUP, NOT A SHARED FORM. Each provider form declares its own explicit
// fields and its own explicit request body; this component is only the input
// element and its toggle. A generic form driven by a field list would mean the
// credential values living in a keyed object that something could serialize
// wholesale — which is exactly the shape that ends up in a log line.
//
// THE VALUE IS CONTROLLED BY THE CALLER and never held here. This component has
// no state except whether the characters are visible, so unmounting it takes
// nothing with it that the caller has not already cleared.

interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Rendered under the label. Never contains an example key. */
  hint?: string;
  autoComplete?: string;
  disabled?: boolean;
  invalid?: boolean;
  errorMessage?: string | undefined;
}

export function SecretField({
  label, value, onChange, hint, autoComplete = 'off', disabled = false,
  invalid = false, errorMessage,
}: SecretFieldProps) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  // View state only. Toggling swaps the input's `type` and touches nothing else,
  // so the value never exists in a second place while it is visible.
  const [visible, setVisible] = useState(false);

  const describedBy = [hint ? hintId : null, invalid ? errorId : null]
    .filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={fieldId} className="block text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {hint}
        </p>
      ) : null}

      <div className="relative mt-1">
        <input
          id={fieldId}
          // HIDDEN BY DEFAULT. A credential typed into a visible field is a
          // credential in every screen-share and every shoulder-surf.
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // 'off' by default: a browser password manager offering to save a
          // client's provider secret into the agency user's personal vault is
          // not something to invite.
          autoComplete={autoComplete}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          disabled={disabled}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className="w-full rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] py-2 pl-3 pr-11 font-mono text-sm
                     disabled:opacity-60
                     aria-[invalid=true]:border-[var(--color-danger)]"
        />
        {/*
          type="button" is load-bearing. The HTML default inside a form is
          "submit", so without it every reveal would submit the credential — a
          real verification round-trip triggered by someone checking their typing.

          A real <button> after the input in DOM order, so Tab reaches it between
          the field and the submit control and Enter/Space activate it for free.
          The accessible name changes with the state; aria-pressed alone would
          leave a screen-reader user guessing which way it points.
        */}
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={visible}
          aria-controls={fieldId}
          disabled={disabled}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center
                     rounded-r-md text-xs font-medium text-[var(--color-ink-muted)]
                     hover:text-[var(--color-ink)] disabled:opacity-60"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>

      {invalid && errorMessage ? (
        <p id={errorId} className="mt-1 text-sm text-[var(--color-danger)]">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
