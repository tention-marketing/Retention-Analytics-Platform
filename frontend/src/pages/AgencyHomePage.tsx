/**
 * Protected home.
 *
 * A placeholder with nothing invented in it. The account list, workspace and
 * onboarding control centre arrive in 5B-2C and 5B-2D; until a real backend
 * call backs a number, none is shown.
 */
export function AgencyHomePage() {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Agency home</h1>
      <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">
        You are signed in to the internal agency workspace.
      </p>

      <section
        aria-labelledby="next-heading"
        className="mt-6 rounded-lg border border-[var(--color-border-subtle)]
                   bg-[var(--color-surface)] p-4"
      >
        <h2 id="next-heading" className="text-sm font-semibold">
          Not built yet
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Client accounts, the account workspace, onboarding links, provider connections, currency,
          costs and advertising spend arrive in later checkpoints. Nothing on this page stands in
          for them.
        </p>
      </section>
    </>
  );
}
