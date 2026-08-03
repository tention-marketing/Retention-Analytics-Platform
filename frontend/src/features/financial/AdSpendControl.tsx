import { useEffect, useId, useMemo, useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { readZeroSpendConflict } from '@/api/financial';
import {
  formatMonth, formatMonthShort, fromMonthInputValue, parseMoneyInput, toCanonicalMoney,
  toMonthInputValue,
} from '@/lib/money';
import {
  describeFinancialFailure, describeMoneyProblem, financialFailureTitle,
} from './financialErrors';
import { useConfirmZeroAdSpend, useSaveAdSpend, type FinancialResource } from './useFinancial';
import type { AccountCurrencyState, AdSpendCoverage, AdSpendState } from '@/types/domain';

// Advertising spend — MANUAL MONTHLY ENTRY, and only that.
//
// NOT BUILT, and not by omission: no Meta, Google or TikTok API, no aggregator, no
// CSV import, no daily spend, no attribution modelling. V1 is locked to manual
// monthly amounts per channel, normalized into a source-agnostic model so V3's
// APIs slot in without touching RCM logic. There is no control anywhere in this
// file that reaches an ad platform.
//
// THE COVERAGE RULE IS THE BACKEND'S, ENTIRELY. Which months are required —
// trailing twelve at most, never before the first eligible order, only months with
// at least one new customer, boundaries in the account's store timezone — is
// computed server-side and rendered here. A second implementation in a browser
// would disagree with it the first time a clock or a timezone differed, and it is
// the figure that decides whether RCM can be computed.
//
// MONTHS ARE FORMATTED FROM THEIR COMPONENTS. `new Date('2026-03-01')` is UTC
// midnight, which renders as FEBRUARY anywhere west of Greenwich — see lib/money.

interface AdSpendControlProps {
  accountId: number;
  resource: FinancialResource<AdSpendState>;
  currency: AccountCurrencyState | null;
}

function MonthList({ months, tone }: { months: string[]; tone?: 'warn' | 'ok' | 'muted' }) {
  const colour =
    tone === 'warn' ? 'text-[var(--color-warn)]'
      : tone === 'ok' ? 'text-[var(--color-ok)]'
        : 'text-[var(--color-ink-muted)]';
  return (
    <span className={`${colour} text-sm`}>
      {months.map((m) => formatMonthShort(m)).join(', ')}
    </span>
  );
}

function CoveragePanel({ coverage }: { coverage: AdSpendCoverage }) {
  // No required months at all. Distinct from "complete": there is simply nothing
  // to answer, because CAC needs a month with new customers to divide into.
  if (coverage.requiredMonths.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border-subtle)]
                      bg-[var(--color-surface-sunken)] p-3">
        <p className="text-sm">No advertising spend is required for this brand yet.</p>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
          {coverage.firstOrderMonth === null
            ? 'There is no eligible order history yet, so there are no months to account for.'
            : 'No month in the last twelve has a first-time customer, so there is no customer '
              + 'acquisition cost to calculate.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border-subtle)]
                    bg-[var(--color-surface-sunken)] p-3">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
            First order
          </dt>
          <dd className="mt-0.5">
            {coverage.firstOrderMonth ? formatMonth(coverage.firstOrderMonth) : 'None yet'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
            Coverage window
          </dt>
          <dd className="mt-0.5">
            {coverage.windowStart ? formatMonth(coverage.windowStart) : '—'}
            {' – '}
            {formatMonth(coverage.currentMonth)}
          </dd>
        </div>
      </dl>

      <div className="mt-2.5 space-y-1">
        <p className="text-sm">
          <span className="font-medium">
            {coverage.requiredMonths.length} month
            {coverage.requiredMonths.length === 1 ? '' : 's'} required
          </span>{' '}
          <span className="text-[var(--color-ink-muted)]">
            — only months with at least one first-time customer, up to twelve.
          </span>
        </p>
        {coverage.coveredMonths.length > 0 ? (
          <p className="text-sm">
            Answered: <MonthList months={coverage.coveredMonths} tone="ok" />
          </p>
        ) : null}
        {coverage.zeroConfirmedMonths.length > 0 ? (
          <p className="text-sm">
            Confirmed zero: <MonthList months={coverage.zeroConfirmedMonths} tone="muted" />
          </p>
        ) : null}
        {coverage.missingMonths.length > 0 ? (
          <p className="text-sm">
            Still missing: <MonthList months={coverage.missingMonths} tone="warn" />
          </p>
        ) : null}
      </div>

      {/*
        A contradictory month holds BOTH real spend and a confirmed zero. It cannot
        arise through this UI — the backend clears one when the other is written, in
        the same transaction — so its presence is a data-integrity fault worth
        raising loudly rather than quietly picking a winner.
      */}
      {coverage.contradictoryMonths.length > 0 ? (
        <div className="mt-2.5">
          <Alert tone="error" title="Conflicting records need review">
            <p>
              These months have both recorded spend and a zero confirmation:{' '}
              {coverage.contradictoryMonths.map((m) => formatMonthShort(m)).join(', ')}.
            </p>
            <p className="mt-1">
              Coverage is not complete while that is true. Resolve each month by either
              saving the real spend for it below, or confirming it as a zero-spend month
              and replacing what is there.
            </p>
          </Alert>
        </div>
      ) : null}

      {coverage.complete && coverage.contradictoryMonths.length === 0 ? (
        <p className="mt-2.5 text-sm text-[var(--color-ok)]">
          Every required month is answered.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Positive spend entry
// ---------------------------------------------------------------------------

function SpendRangeForm({
  accountId,
  state,
  currency,
}: {
  accountId: number;
  state: AdSpendState;
  currency: AccountCurrencyState | null;
}) {
  const ids = useId();
  const save = useSaveAdSpend(accountId);
  const [channel, setChannel] = useState('');
  const [amount, setAmount] = useState('');
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const currencyCode = currency?.currency ?? null;
  const currencyMissing = currencyCode === null;
  const maxMonth = toMonthInputValue(state.coverage.currentMonth);

  useEffect(() => {
    if (save.succeeded) {
      setChannel('');
      setAmount('');
      setStartMonth('');
      setEndMonth('');
    }
  }, [save.succeeded]);

  const failure = save.error ? describeFinancialFailure(save.error, 'ad-spend-save') : null;

  function submit(): void {
    const trimmedChannel = channel.trim().replace(/\s+/g, ' ');
    if (trimmedChannel === '') {
      setLocalError('Enter a channel name.');
      return;
    }
    if (trimmedChannel.length > 64) {
      setLocalError('That channel name is too long. Use 64 characters or fewer.');
      return;
    }
    const parsed = parseMoneyInput(amount);
    if (!parsed.ok) {
      setLocalError(describeMoneyProblem(parsed.reason, 'spend'));
      return;
    }
    // ZERO IS NOT AN AMOUNT HERE. The backend refuses it with
    // `zero_requires_confirmation`; saying so before the round trip points at the
    // control that does the job instead of just rejecting.
    if (/^0+(\.0{1,2})?$/.test(parsed.value)) {
      setLocalError(
        'A zero-spend month cannot be entered as an amount. Use “Confirm zero-spend months” '
        + 'below, so the zero is recorded as a deliberate answer.',
      );
      return;
    }
    const start = fromMonthInputValue(startMonth);
    const end = fromMonthInputValue(endMonth);
    if (!start || !end) {
      setLocalError('Choose a start month and an end month.');
      return;
    }
    if (start > end) {
      setLocalError('The start month cannot be after the end month.');
      return;
    }
    if (end > state.coverage.currentMonth) {
      setLocalError('Spend cannot be recorded for a future month.');
      return;
    }
    setLocalError(null);
    save.submit([{
      channel: trimmedChannel,
      amount: toCanonicalMoney(parsed.value),
      startMonth: start,
      endMonth: end,
    }]);
  }

  return (
    <div>
      <h4 className="text-sm font-semibold">Record monthly spend</h4>
      <p className="mt-0.5 max-w-prose text-xs text-[var(--color-ink-muted)]">
        A range applies <strong>the same monthly amount to every month it covers</strong> —
        so for months that differ, save each one as a single-month range.
      </p>

      {currencyMissing ? (
        <div className="mt-2">
          <Alert tone="warning">
            <p>
              Set the account currency above before recording spend — an amount without a
              currency cannot be recorded.
            </p>
          </Alert>
        </div>
      ) : null}

      <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${ids}-channel`} className="block text-sm font-medium">
            Channel
          </label>
          <input
            id={`${ids}-channel`}
            value={channel}
            disabled={currencyMissing || save.isSubmitting}
            onChange={(event) => {
              setChannel(event.target.value);
              setLocalError(null);
            }}
            // A suggestion list, not a closed set: free text stays allowed, because
            // a brand's real channel mix is not this platform's to define.
            list={`${ids}-channels`}
            maxLength={64}
            autoComplete="off"
            placeholder="Meta"
            className="mt-1.5 w-full rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-55"
          />
          <datalist id={`${ids}-channels`}>
            {state.suggestedChannels.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Suggestions are offered; any name up to 64 characters is accepted.
          </p>
        </div>

        <div>
          <label htmlFor={`${ids}-amount`} className="block text-sm font-medium">
            Monthly amount{currencyCode ? ` (${currencyCode})` : ''}
          </label>
          <input
            id={`${ids}-amount`}
            value={amount}
            disabled={currencyMissing || save.isSubmitting}
            onChange={(event) => {
              setAmount(event.target.value);
              setLocalError(null);
            }}
            inputMode="decimal"
            autoComplete="off"
            placeholder="1000.00"
            className="mt-1.5 w-full rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-3 py-2 text-right text-sm
                       disabled:opacity-55"
          />
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            A positive amount, at most two decimal places.
          </p>
        </div>

        <div>
          <label htmlFor={`${ids}-start`} className="block text-sm font-medium">
            From month
          </label>
          <input
            id={`${ids}-start`}
            type="month"
            value={startMonth}
            max={maxMonth}
            disabled={currencyMissing || save.isSubmitting}
            onChange={(event) => {
              setStartMonth(event.target.value);
              setLocalError(null);
            }}
            className="mt-1.5 w-full rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-55"
          />
        </div>

        <div>
          <label htmlFor={`${ids}-end`} className="block text-sm font-medium">
            To month
          </label>
          <input
            id={`${ids}-end`}
            type="month"
            value={endMonth}
            max={maxMonth}
            disabled={currencyMissing || save.isSubmitting}
            onChange={(event) => {
              setEndMonth(event.target.value);
              setLocalError(null);
            }}
            className="mt-1.5 w-full rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-55"
          />
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Same month as “From” for a single month.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          onClick={submit}
          disabled={currencyMissing}
          loading={save.isSubmitting}
          loadingLabel="Saving…"
        >
          Save spend
        </Button>
      </div>

      <p className="mt-2 max-w-prose text-xs text-[var(--color-ink-muted)]">
        Saving spend for a month that was previously confirmed as zero{' '}
        <strong>removes that zero confirmation</strong> — the two cannot both be true of one
        month.
      </p>

      {localError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{localError}</p>
      ) : null}

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('ad-spend-save')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      {save.succeeded ? (
        <div className="mt-3">
          <Alert tone="success"><p>Advertising spend saved.</p></Alert>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explicit zero-spend confirmation
// ---------------------------------------------------------------------------

function ZeroSpendForm({
  accountId,
  state,
}: {
  accountId: number;
  state: AdSpendState;
}) {
  const ids = useId();
  const confirm = useConfirmZeroAdSpend(accountId);
  const [selected, setSelected] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // The 409 the backend answers when a chosen month already holds spend. Held in
  // state so the second, explicit confirmation is a separate human decision — the
  // mutation itself never retries and never escalates.
  const conflict = useMemo(() => readZeroSpendConflict(confirm.error), [confirm.error]);

  const failure = confirm.error && !conflict
    ? describeFinancialFailure(confirm.error, 'ad-spend-zero')
    : null;

  useEffect(() => {
    if (confirm.succeeded) {
      setSelected([]);
      setAcknowledged(false);
    }
  }, [confirm.succeeded]);

  const selectable = state.coverage.requiredMonths;
  if (selectable.length === 0) return null;

  function toggle(month: string): void {
    setLocalError(null);
    // Changing the selection invalidates both the acknowledgement and any
    // outstanding replacement conflict — neither was given for this set of months.
    setAcknowledged(false);
    if (conflict) confirm.reset();
    setSelected((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month]);
  }

  function submitFirst(): void {
    if (selected.length === 0) {
      setLocalError('Select at least one month.');
      return;
    }
    if (!acknowledged) {
      setLocalError('Confirm that the true advertising spend for these months was zero.');
      return;
    }
    setLocalError(null);
    // NO `replace` ON THE FIRST REQUEST. If any month already holds spend the
    // backend answers 409 and the agency is told which — deleting it silently is
    // exactly what this omission prevents.
    confirm.submit({ months: [...selected].sort() });
  }

  function submitReplacement(): void {
    if (!conflict) return;
    // Exactly one second request, sent only from this explicit confirmation.
    confirm.submit({ months: [...selected].sort(), replace: true });
  }

  return (
    <div className="mt-5 border-t border-[var(--color-border-subtle)] pt-4">
      <h4 className="text-sm font-semibold">Confirm zero-spend months</h4>
      <p className="mt-0.5 max-w-prose text-xs text-[var(--color-ink-muted)]">
        A zero-spend month is never assumed from a blank field. Select the months where this
        brand genuinely spent nothing and confirm it explicitly.
      </p>

      <fieldset className="mt-2.5">
        <legend className="sr-only">Months to confirm as zero spend</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {selectable.map((month) => (
            <div key={month} className="flex items-center gap-1.5">
              <input
                id={`${ids}-${month}`}
                type="checkbox"
                checked={selected.includes(month)}
                disabled={confirm.isSubmitting}
                onChange={() => toggle(month)}
                className="size-4 shrink-0"
              />
              <label htmlFor={`${ids}-${month}`} className="text-sm">
                {formatMonthShort(month)}
                {state.coverage.zeroConfirmedMonths.includes(month) ? (
                  <span className="ml-1 text-xs text-[var(--color-ink-muted)]">(zero)</span>
                ) : null}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="mt-2.5 flex items-start gap-2">
        <input
          id={`${ids}-ack`}
          type="checkbox"
          checked={acknowledged}
          disabled={confirm.isSubmitting}
          onChange={(event) => {
            setAcknowledged(event.target.checked);
            setLocalError(null);
          }}
          className="mt-0.5 size-4 shrink-0"
        />
        <label htmlFor={`${ids}-ack`} className="text-sm">
          The true advertising spend for these months was zero.
        </label>
      </div>

      <div className="mt-3">
        <Button
          onClick={submitFirst}
          loading={confirm.isSubmitting && !conflict}
          loadingLabel="Confirming…"
        >
          Confirm zero spend
        </Button>
      </div>

      {/*
        THE REPLACEMENT CONFIRMATION. Reached only from a 409, naming exactly the
        months that already hold spend, and stating plainly that confirming deletes
        those rows. Cancel sends nothing at all.
      */}
      {conflict ? (
        <div className="mt-3 rounded-md border-2 border-[var(--color-danger-border)]
                        bg-[var(--color-danger-surface)] p-3.5">
          <h5 role="alert" className="text-sm font-semibold text-[var(--color-danger)]">
            These months already have spend recorded
          </h5>
          <p className="mt-1.5 text-sm">
            {conflict.months.map((m) => formatMonthShort(m)).join(', ')}
          </p>
          <p className="mt-2 text-sm">
            Confirming zero for {conflict.months.length === 1 ? 'this month' : 'these months'}{' '}
            <strong>deletes every advertising spend row recorded against
            {conflict.months.length === 1 ? ' it' : ' them'}</strong>. That cannot be undone
            from this screen.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={confirm.isSubmitting}
              loadingLabel="Replacing…"
              onClick={submitReplacement}
            >
              Delete that spend and confirm zero
            </Button>
            <Button
              variant="secondary"
              disabled={confirm.isSubmitting}
              // Sends NO request. It clears the conflict and leaves every row where
              // it is.
              onClick={() => confirm.reset()}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {localError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{localError}</p>
      ) : null}

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('ad-spend-zero')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      {confirm.succeeded ? (
        <div className="mt-3">
          <Alert tone="success"><p>Zero-spend months confirmed.</p></Alert>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stored rows
// ---------------------------------------------------------------------------

function SpendRowTable({
  rows,
  currency,
}: {
  rows: AdSpendState['rows'];
  currency: AccountCurrencyState | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">No advertising spend recorded yet.</p>
    );
  }
  const code = currency?.currency ?? null;
  return (
    // Wide content scrolls inside its own container so the page body never scrolls
    // sideways on a narrow screen.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] text-sm">
        <caption className="sr-only">Recorded monthly advertising spend by channel</caption>
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-left">
            <th scope="col" className="py-1.5 pr-3 font-medium">Month</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Channel</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Amount</th>
            <th scope="col" className="py-1.5 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.month}|${row.channel}|${row.source}`}
              className="border-b border-[var(--color-border-subtle)] last:border-b-0"
            >
              {/* Formatted from components — no Date, so no month drift. */}
              <td className="py-1.5 pr-3 whitespace-nowrap">{formatMonthShort(row.month)}</td>
              <td className="py-1.5 pr-3 break-words">{row.channel}</td>
              {/*
                The stored decimal string, shown as stored. Never parsed into a
                float and re-rendered, which is how "1000.00" becomes "1000".
              */}
              <td className="py-1.5 pr-3 text-right font-mono whitespace-nowrap">
                {row.spend}{code ? ` ${code}` : ''}
              </td>
              {/* Read-only: 'manual' is all V1 writes. */}
              <td className="py-1.5 text-[var(--color-ink-muted)]">{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/*
        NO DELETE ACTION. The backend exposes no general delete for a spend row, so
        offering one would be a button that cannot work. Correcting a value means
        submitting the same channel and month again, which the form above does.
      */}
      <p className="mt-2 max-w-prose text-xs text-[var(--color-ink-muted)]">
        To correct an amount, save the same channel and month again with the right figure.
        Individual rows cannot be deleted.
      </p>
    </div>
  );
}

export function AdSpendControl({ accountId, resource, currency }: AdSpendControlProps) {
  const state = resource.data;
  const loadFailure = resource.error
    ? describeFinancialFailure(resource.error, 'ad-spend-load')
    : null;

  if (resource.status === 'loading') {
    return (
      <p role="status" className="text-sm text-[var(--color-ink-muted)]">
        Loading advertising spend…
      </p>
    );
  }

  // An ad-spend failure is contained here. Currency and cost of goods are separate
  // queries and stay on screen and usable.
  if (resource.status === 'error' || !state) {
    if (loadFailure?.sessionExpired) return null;
    return (
      <Alert tone="error" title={financialFailureTitle('ad-spend-load')}>
        <p>{loadFailure?.message ?? 'Advertising spend could not be loaded.'}</p>
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

  return (
    <div className="space-y-4">
      <CoveragePanel coverage={state.coverage} />
      <SpendRangeForm accountId={accountId} state={state} currency={currency} />
      <ZeroSpendForm accountId={accountId} state={state} />
      <div className="border-t border-[var(--color-border-subtle)] pt-4">
        <h4 className="text-sm font-semibold">Recorded spend</h4>
        <div className="mt-2">
          <SpendRowTable rows={state.rows} currency={currency} />
        </div>
      </div>
    </div>
  );
}
