import { useEffect, useId, useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { describeFinancialFailure, financialFailureTitle } from './financialErrors';
import { useResolveCurrencyMismatch, useSetCurrency, type FinancialResource } from './useFinancial';
import type { AccountCurrencyState } from '@/types/domain';

// Currency.
//
// FOUR STATES, and they are genuinely different situations rather than variations
// on a form:
//
//   unknown    — nothing recorded. Money cannot be entered yet; a percentage can.
//   manual     — an agency member typed it. Editable.
//   shopify    — Shopify reported it. READ-ONLY: changing it is a mismatch
//                resolution, not a preference.
//   mismatch   — Shopify disagrees with the currency the stored money is in. Both
//                values are kept, nothing has been converted, and RCM is blocked.
//
// THE CODE IS ALWAYS SHOWN, NEVER A BARE SYMBOL. "$1,000.00" does not say whether
// that is US, Canadian, Australian, Singapore or Hong Kong dollars, and this
// product's premise is not presenting an ambiguous number as a finding.

const CURRENCY_INPUT = /^[A-Za-z]{0,3}$/;

interface CurrencyControlProps {
  accountId: number;
  resource: FinancialResource<AccountCurrencyState>;
}

/** The mismatch state, derived exactly as the backend derives it. */
export function hasCurrencyMismatch(state: AccountCurrencyState): boolean {
  return state.shopifyCurrencyDetected !== null
    && state.currency !== state.shopifyCurrencyDetected;
}

function SourceLine({ state }: { state: AccountCurrencyState }) {
  if (state.currencySource === 'shopify') {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">
        Source: the connected Shopify store.
      </p>
    );
  }
  if (state.currencySource === 'manual') {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">
        Source: manually selected by your team.
      </p>
    );
  }
  return null;
}

function ManualCurrencyForm({
  accountId,
  currentCode,
}: {
  accountId: number;
  currentCode: string | null;
}) {
  const inputId = useId();
  const save = useSetCurrency(accountId);
  const [code, setCode] = useState(currentCode ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  const failure = save.error ? describeFinancialFailure(save.error, 'currency-save') : null;

  function submit(): void {
    const normalized = code.trim().toUpperCase();
    // Exactly three ASCII letters. Note the deliberately careful wording below:
    // this checks the FORMAT, which is all the backend checks too. Claiming the
    // code had been verified against the ISO 4217 register would be asserting
    // something neither side does.
    if (!/^[A-Z]{3}$/.test(normalized)) {
      setLocalError('Enter exactly three letters, for example USD.');
      return;
    }
    setLocalError(null);
    save.submit(normalized);
  }

  return (
    <div className="mt-3">
      <label htmlFor={inputId} className="block text-sm font-medium">
        Currency code
      </label>
      <div className="mt-1.5 flex flex-wrap items-start gap-2">
        <input
          id={inputId}
          value={code}
          // Filtered as typed so the field cannot hold something unsendable, and
          // uppercased on the way in so what is on screen is what gets stored.
          onChange={(event) => {
            const next = event.target.value.trim().toUpperCase();
            if (CURRENCY_INPUT.test(next)) {
              setCode(next);
              setLocalError(null);
            }
          }}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={3}
          placeholder="USD"
          aria-describedby={`${inputId}-help`}
          aria-invalid={localError !== null || failure !== null || undefined}
          className="w-24 rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] px-3 py-2 font-mono text-sm uppercase
                     tracking-widest"
        />
        <Button onClick={submit} loading={save.isSubmitting} loadingLabel="Saving…">
          Save currency
        </Button>
      </div>
      <p id={`${inputId}-help`} className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
        Three letters, for example USD, GBP or CAD. This is the currency every amount
        below is recorded in — nothing is converted.
      </p>

      {localError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
          {localError}
        </p>
      ) : null}

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('currency-save')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      {save.succeeded ? (
        <div className="mt-3">
          <Alert tone="success">
            <p>Currency saved.</p>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The mismatch panel.
 *
 * The acknowledgement checkbox is not ceremony. Resolving a mismatch adopts the
 * Shopify currency as the account currency and CHANGES NOTHING ELSE — every
 * stored amount keeps its digits and acquires a new label. If those amounts were
 * entered in the old currency and nobody re-enters them, the account is now
 * asserting, say, Canadian figures as US dollars, and every RCM number built on
 * them is wrong while looking entirely plausible. So the person clicking has to
 * state that the re-entry has already happened.
 */
function MismatchPanel({
  accountId,
  state,
}: {
  accountId: number;
  state: AccountCurrencyState;
}) {
  const checkboxId = useId();
  const resolve = useResolveCurrencyMismatch(accountId);
  const [acknowledged, setAcknowledged] = useState(false);
  const shopifyCode = state.shopifyCurrencyDetected ?? '';
  const storedCode = state.currency ?? '';

  const failure = resolve.error ? describeFinancialFailure(resolve.error, 'currency-resolve') : null;

  // Once resolved, the acknowledgement must not stay ticked behind the panel: a
  // second mismatch later is a second decision.
  useEffect(() => {
    if (resolve.succeeded) setAcknowledged(false);
  }, [resolve.succeeded]);

  return (
    <div
      className="mt-3 rounded-md border-2 border-[var(--color-danger-border)]
                 bg-[var(--color-danger-surface)] p-3.5"
    >
      <h4 role="alert" className="text-sm font-semibold text-[var(--color-danger)]">
        Currency mismatch — RCM analytics are unavailable
      </h4>

      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
            Amounts on file are recorded in
          </dt>
          <dd className="mt-0.5 font-mono text-sm font-semibold">{storedCode}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
            Shopify reports
          </dt>
          <dd className="mt-0.5 font-mono text-sm font-semibold">{shopifyCode}</dd>
        </div>
      </dl>

      <div className="mt-3 space-y-1.5 text-sm">
        <p>
          Both currencies have been kept. <strong>No amount has been converted and nothing
          has been deleted</strong> — and nothing will be. Resolving this records which
          currency the figures are in; it does not change a single number.
        </p>
        <p>
          Before resolving, re-enter every amount below in {shopifyCode}: per-product
          costs, the monthly operating cost, and advertising spend. Gross margin is a
          percentage, so it needs no change.
        </p>
      </div>

      <div className="mt-3.5 flex items-start gap-2">
        <input
          id={checkboxId}
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5 size-4 shrink-0"
        />
        <label htmlFor={checkboxId} className="text-sm">
          I have reviewed and re-entered all affected money values in {shopifyCode}.
        </label>
      </div>

      <div className="mt-3">
        <Button
          variant="danger"
          // The checkbox is the gate. Nothing auto-resolves after another form is
          // saved, and there is exactly one request per click.
          disabled={!acknowledged}
          loading={resolve.isSubmitting}
          loadingLabel="Resolving…"
          onClick={() => resolve.submit(undefined)}
        >
          Resolve mismatch
        </Button>
      </div>

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('currency-resolve')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

export function CurrencyControl({ accountId, resource }: CurrencyControlProps) {
  const state = resource.data;
  const failure = resource.error ? describeFinancialFailure(resource.error, 'currency-load') : null;

  if (resource.status === 'loading') {
    return (
      <p role="status" className="text-sm text-[var(--color-ink-muted)]">
        Loading currency…
      </p>
    );
  }

  if (resource.status === 'error' || !state) {
    if (failure?.sessionExpired) return null;
    return (
      <Alert tone="error" title={financialFailureTitle('currency-load')}>
        <p>{failure?.message ?? 'Currency could not be loaded.'}</p>
        {failure?.retryable ? (
          <div className="mt-3">
            <Button variant="secondary" onClick={resource.retry} loading={resource.isRetrying}>
              Try again
            </Button>
          </div>
        ) : null}
      </Alert>
    );
  }

  const mismatch = hasCurrencyMismatch(state);

  // --- nothing recorded ---------------------------------------------------
  if (!state.currency) {
    return (
      <div>
        <p className="text-sm">
          No currency recorded yet.
        </p>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
          A currency is required before any amount can be entered — product costs, the
          monthly operating cost and advertising spend are all money.{' '}
          <strong>Gross margin is a percentage, so it can be entered now.</strong>
        </p>
        {state.shopifyCurrencyDetected ? (
          <p className="mt-2 text-sm">
            Shopify reports{' '}
            <span className="font-mono font-semibold">{state.shopifyCurrencyDetected}</span>.
          </p>
        ) : null}
        <ManualCurrencyForm accountId={accountId} currentCode={null} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-[var(--color-ink-muted)]">Currency</span>
        {/* The three-letter code, always. Never a symbol on its own. */}
        <span className="font-mono text-base font-semibold">{state.currency}</span>
      </div>
      <div className="mt-1">
        <SourceLine state={state} />
      </div>

      {state.shopifyCurrencyDetected && !mismatch ? (
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Shopify reports{' '}
          <span className="font-mono">{state.shopifyCurrencyDetected}</span>, which agrees.
        </p>
      ) : null}

      {mismatch ? <MismatchPanel accountId={accountId} state={state} /> : null}

      {/*
        Shopify-authoritative and consistent: READ-ONLY, with no edit control at
        all. The backend refuses a manual change with `shopify_authoritative`, and
        offering a field that is always rejected is worse than offering none.
      */}
      {state.currencySource === 'shopify' && !mismatch ? (
        <p className="mt-3 max-w-prose text-sm text-[var(--color-ink-muted)]">
          This comes from the connected Shopify store and is not editable here. If it is
          wrong, correct it in Shopify — the next sync will bring the change through.
        </p>
      ) : null}

      {/* Manual: still editable, because no authoritative source has spoken. */}
      {state.currencySource !== 'shopify' && !mismatch ? (
        <ManualCurrencyForm accountId={accountId} currentCode={state.currency} />
      ) : null}
    </div>
  );
}
