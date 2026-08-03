import { useEffect, useId, useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { isZeroMoney, parseMoneyInput, toCanonicalMoney } from '@/lib/money';
import {
  describeFinancialFailure, describeMoneyProblem, financialFailureTitle,
} from './financialErrors';
import { useSaveOcas, type FinancialResource } from './useFinancial';
import type { AccountCostsResponse, AccountCurrencyState } from '@/types/domain';

// Monthly operating cost allocation (OCAS).
//
// ONE FIELD, and the reason it needs this much care is what a zero here does: the
// core RCM verdict is "RCM >= OCAS -> self-funding", so an OCAS of zero makes that
// verdict trivially true. A tabbed-through empty box must never become that
// claim — which is why zero requires an explicit confirmation, the confirmation
// only appears when the amount is exactly zero, and it is dropped the moment the
// amount changes to something else.
//
// NOT BUILT, deliberately: annual OCAS, cost-category breakdowns, accounting
// integrations. The schema holds one monthly figure and Phase 6 reads one monthly
// figure.

interface OcasControlProps {
  accountId: number;
  resource: FinancialResource<AccountCostsResponse>;
  currency: AccountCurrencyState | null;
}

export function OcasControl({ accountId, resource, currency }: OcasControlProps) {
  const inputId = useId();
  const save = useSaveOcas(accountId);
  const data = resource.data;
  const stored = data?.costs.ocasMonthly ?? null;
  const storedZeroConfirmed = data?.costs.ocasZeroConfirmed ?? false;

  const [text, setText] = useState(stored ?? '');
  const [zeroConfirmed, setZeroConfirmed] = useState(storedZeroConfirmed);
  const [localError, setLocalError] = useState<string | null>(null);

  // Prefill from the stored decimal string, and re-prefill whenever it changes
  // underneath — after a save, or after the resource is re-read.
  useEffect(() => {
    setText(stored ?? '');
    setZeroConfirmed(storedZeroConfirmed);
  }, [stored, storedZeroConfirmed]);

  const currencyCode = currency?.currency ?? null;
  const currencyMissing = currencyCode === null;

  const entered = text.trim();
  const parsed = entered === '' ? null : parseMoneyInput(entered);
  // The checkbox exists only for an amount that is exactly zero. It is never shown
  // speculatively, and it is never ticked automatically.
  const isZero = parsed?.ok === true && isZeroMoney(parsed.value);

  const failure = save.error ? describeFinancialFailure(save.error, 'ocas-save') : null;

  const loadFailure = resource.error
    ? describeFinancialFailure(resource.error, 'costs-load')
    : null;

  if (resource.status === 'loading') {
    return (
      <p role="status" className="text-sm text-[var(--color-ink-muted)]">
        Loading operating costs…
      </p>
    );
  }

  if (resource.status === 'error' || !data) {
    if (loadFailure?.sessionExpired) return null;
    return (
      <Alert tone="error" title={financialFailureTitle('costs-load')}>
        <p>{loadFailure?.message ?? 'Operating costs could not be loaded.'}</p>
        {loadFailure?.retryable ? (
          <div className="mt-3">
            <Button variant="secondary" onClick={resource.retry} loading={resource.isRetrying}>
              Try again
            </Button>
          </div>
        ) : null}
      </Alert>
    );
  }

  function submit(): void {
    if (entered === '') {
      // A BLANK FIELD IS NOT ZERO. Saying so outright is better than a generic
      // "required": the whole point is that the two are different answers.
      setLocalError('Enter a monthly operating cost. An empty field is not the same as zero.');
      return;
    }
    const result = parseMoneyInput(entered);
    if (!result.ok) {
      setLocalError(describeMoneyProblem(result.reason, 'operating cost'));
      return;
    }
    const zero = isZeroMoney(result.value);
    if (zero && !zeroConfirmed) {
      setLocalError(
        'To record zero, confirm that the true monthly operating cost allocation really is zero.',
      );
      return;
    }
    setLocalError(null);
    save.submit({
      ocasMonthly: toCanonicalMoney(result.value),
      // Only ever sent for a genuine zero.
      confirmedZero: zero,
    });
  }

  return (
    <div>
      {stored === null ? (
        <p className="text-sm text-[var(--color-ink-muted)]">Not configured yet.</p>
      ) : (
        <p className="text-sm">
          Currently recorded:{' '}
          <span className="font-semibold">
            {stored}
            {currencyCode ? ` ${currencyCode}` : ''}
          </span>
          {isZeroMoney(stored) && storedZeroConfirmed ? (
            <span className="ml-1.5 text-xs text-[var(--color-ink-muted)]">
              (zero, explicitly confirmed)
            </span>
          ) : null}
        </p>
      )}

      {currencyMissing ? (
        <div className="mt-2">
          <Alert tone="warning">
            <p>
              Set the account currency above before entering a monthly operating cost — an
              amount without a currency cannot be recorded.
            </p>
          </Alert>
        </div>
      ) : null}

      <label htmlFor={inputId} className="mt-3 block text-sm font-medium">
        {/* The currency CODE inline, never a bare symbol. */}
        Monthly operating cost allocation{currencyCode ? ` (${currencyCode})` : ''}
      </label>
      <div className="mt-1.5 flex flex-wrap items-start gap-2">
        <input
          id={inputId}
          value={text}
          disabled={currencyMissing || save.isSubmitting}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            setLocalError(null);
            const nextParsed = next.trim() === '' ? null : parseMoneyInput(next.trim());
            // Changing the amount away from zero DROPS a ticked confirmation. A
            // confirmation given for 0 must not silently ride along with 4500.
            if (!(nextParsed?.ok === true && isZeroMoney(nextParsed.value))) {
              setZeroConfirmed(false);
            }
          }}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          aria-describedby={`${inputId}-help`}
          aria-invalid={localError !== null || failure !== null || undefined}
          className="w-36 rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] px-3 py-2 text-right text-sm
                     disabled:opacity-55"
        />
        <Button
          onClick={submit}
          disabled={currencyMissing}
          loading={save.isSubmitting}
          loadingLabel="Saving…"
        >
          Save operating cost
        </Button>
      </div>
      <p id={`${inputId}-help`} className="mt-1.5 max-w-prose text-xs text-[var(--color-ink-muted)]">
        The share of monthly operating costs allocated to this brand. At most two decimal
        places. Nothing is saved until you choose Save.
      </p>

      {isZero ? (
        <div className="mt-2.5 flex items-start gap-2">
          <input
            id={`${inputId}-zero`}
            type="checkbox"
            checked={zeroConfirmed}
            onChange={(event) => setZeroConfirmed(event.target.checked)}
            className="mt-0.5 size-4 shrink-0"
          />
          <label htmlFor={`${inputId}-zero`} className="text-sm">
            I confirm the true monthly operating cost allocation for this brand is zero.
          </label>
        </div>
      ) : null}

      {localError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{localError}</p>
      ) : null}

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('ocas-save')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      {save.succeeded ? (
        <div className="mt-3">
          <Alert tone="success"><p>Monthly operating cost saved.</p></Alert>
        </div>
      ) : null}
    </div>
  );
}
