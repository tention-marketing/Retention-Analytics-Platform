import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  children: ReactNode;
  variant?: Variant;
  /** Shows a busy state and blocks activation. */
  loading?: boolean;
  /** Announced while loading, replacing the label for assistive technology. */
  loadingLabel?: string;
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md border px-3.5 py-2 ' +
  'text-sm font-medium transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-55';

const VARIANTS: Record<Variant, string> = {
  primary:
    'border-transparent bg-[var(--color-accent)] text-white ' +
    'hover:bg-[var(--color-accent-strong)] disabled:hover:bg-[var(--color-accent)]',
  secondary:
    'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink)] ' +
    'hover:bg-[var(--color-surface-sunken)] disabled:hover:bg-[var(--color-surface)]',
  danger:
    'border-transparent bg-[var(--color-danger)] text-white ' +
    'hover:brightness-110 disabled:hover:brightness-100',
};

/**
 * The one button.
 *
 * A real <button> rather than a clickable div, so Enter and Space, focus order
 * and the disabled state all come from the platform instead of being
 * reimplemented (usually incompletely).
 *
 * `type` defaults to "button". The HTML default is "submit", which turns any
 * button placed inside a form into an accidental submit — a live hazard in the
 * cost and ad-spend forms coming in later checkpoints.
 */
export function Button({
  children,
  variant = 'primary',
  loading = false,
  loadingLabel = 'Working…',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      // eslint-disable-next-line react/button-has-type -- narrowed by the prop type
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`${BASE} ${VARIANTS[variant]}`}
      {...rest}
    >
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
