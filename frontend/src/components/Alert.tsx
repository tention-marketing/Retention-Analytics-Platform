import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
}

const TONES: Record<AlertTone, { box: string; label: string }> = {
  info: {
    box: 'bg-[var(--color-surface)] border-[var(--color-border-subtle)] text-[var(--color-ink)]',
    label: 'Note',
  },
  success: {
    box: 'bg-[var(--color-ok-surface)] border-[var(--color-ok-border)] text-[var(--color-ok)]',
    label: 'Success',
  },
  warning: {
    box: 'bg-[var(--color-warn-surface)] border-[var(--color-warn-border)] text-[var(--color-warn)]',
    label: 'Warning',
  },
  error: {
    box: 'bg-[var(--color-danger-surface)] border-[var(--color-danger-border)] text-[var(--color-danger)]',
    label: 'Error',
  },
};

/**
 * Inline message.
 *
 * SEMANTICS: an error uses role="alert" (assertive — it interrupts, because
 * something the user just did did not work); everything else uses
 * role="status" (polite — announced at the next pause). Warnings are polite on
 * purpose: an interruption for information the user has not asked about yet is
 * worse than a late one.
 *
 * The tone is also stated in text for screen readers, since colour alone must
 * never be the carrier of meaning.
 */
export function Alert({ tone = 'info', title, children }: AlertProps) {
  const { box, label } = TONES[tone];
  const isError = tone === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={`rounded-md border px-3.5 py-3 text-sm ${box}`}
    >
      <span className="sr-only">{label}: </span>
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}
