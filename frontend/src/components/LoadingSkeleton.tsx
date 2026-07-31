interface LoadingSkeletonProps {
  /** Number of placeholder lines. */
  lines?: number;
  /** Announced to assistive technology while content is pending. */
  label?: string;
}

/**
 * Placeholder for pending content.
 *
 * The bars are aria-hidden and the status is carried by text in an
 * aria-live region, because a screen reader user needs "Loading", not a
 * description of grey rectangles.
 *
 * The pulse is the only animation in the app and stops entirely under
 * prefers-reduced-motion (handled globally in styles/index.css).
 */
export function LoadingSkeleton({ lines = 3, label = 'Loading…' }: LoadingSkeletonProps) {
  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-3.5 animate-pulse rounded bg-[var(--color-surface-sunken)]"
          style={{ width: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  );
}
