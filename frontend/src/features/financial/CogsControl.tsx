import { useEffect, useId, useMemo, useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { formatPercent, isZeroMoney, parseMoneyInput, toCanonicalMoney } from '@/lib/money';
import {
  describeFinancialFailure, describeMoneyProblem, financialFailureTitle,
} from './financialErrors';
import { useSaveBlendedMargin, useSavePerSkuCosts, type FinancialResource } from './useFinancial';
import type {
  AccountCostsResponse, AccountCurrencyState, CogsMethod, SkuCostInput, SkuRevenueCost,
} from '@/types/domain';

// Cost of goods.
//
// EXACTLY TWO METHODS, AND ONLY ONE ACTIVE. Per-SKU costs or one blended gross
// margin — never both, because Phase 6 must never combine them. `cogs_method`
// alone decides which is active, and the backend's v_active_* views make the
// inactive set structurally unreadable to every consumer including Phase 6's raw
// SQL.
//
// SWITCHING RETAINS THE OTHER METHOD'S VALUES. Twenty SKUs of entered work is
// never destroyed by picking the other radio button; the values stay in the
// database, become inactive, and come back when the method is switched back. The
// confirmation dialogue says exactly that, because "your entries will be lost" is
// the assumption a user brings to a method switch and it is not true here.
//
// COVERAGE IS THE BINDING CONDITION, NOT ROW COUNT. The 80% target is a share of
// eligible line-item value. Filling every displayed row can leave coverage well
// short of it — that is the whole reason `cappedBelowTarget` exists — so this
// component never infers completeness from "all the rows I showed are filled".

const COGS_COVERAGE_TARGET_PCT = 80;

interface CogsControlProps {
  accountId: number;
  resource: FinancialResource<AccountCostsResponse>;
  currency: AccountCurrencyState | null;
}

// ---------------------------------------------------------------------------
// Blended gross margin
// ---------------------------------------------------------------------------

function BlendedMarginForm({
  accountId,
  retained,
  active,
}: {
  accountId: number;
  retained: number | null;
  active: boolean;
}) {
  const inputId = useId();
  const save = useSaveBlendedMargin(accountId);
  const [value, setValue] = useState(retained === null ? '' : String(retained));
  const [localError, setLocalError] = useState<string | null>(null);

  // Re-prefill when the stored value changes underneath (after a save, or after
  // switching back to this method and finding the retained figure).
  useEffect(() => {
    setValue(retained === null ? '' : String(retained));
  }, [retained]);

  const failure = save.error ? describeFinancialFailure(save.error, 'cogs-blended-save') : null;

  function submit(): void {
    const trimmed = value.trim();
    if (trimmed === '') {
      setLocalError('Enter a gross margin percentage.');
      return;
    }
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) {
      setLocalError('Enter a percentage with at most two decimal places.');
      return;
    }
    const pct = Number(trimmed);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      setLocalError('Gross margin must be greater than 0 and less than 100.');
      return;
    }
    setLocalError(null);
    save.submit(pct);
  }

  return (
    <div className="mt-3">
      <label htmlFor={inputId} className="block text-sm font-medium">
        Blended gross margin
      </label>
      <div className="mt-1.5 flex flex-wrap items-start gap-2">
        <div className="flex items-center gap-1.5">
          <input
            id={inputId}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setLocalError(null);
            }}
            inputMode="decimal"
            autoComplete="off"
            placeholder="62.5"
            aria-describedby={`${inputId}-help`}
            aria-invalid={localError !== null || failure !== null || undefined}
            className="w-24 rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          {/* A PERCENTAGE, not money — hence no currency code anywhere near it. */}
          <span aria-hidden="true" className="text-sm text-[var(--color-ink-muted)]">%</span>
        </div>
        <Button onClick={submit} loading={save.isSubmitting} loadingLabel="Saving…">
          Save gross margin
        </Button>
      </div>
      <p id={`${inputId}-help`} className="mt-1.5 max-w-prose text-xs text-[var(--color-ink-muted)]">
        A percentage between 0 and 100, with at most two decimal places. This is a
        percentage rather than an amount, so <strong>no currency is needed</strong> to
        enter it.
      </p>

      {!active ? (
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          Per-product costs are the active method, so this figure is retained but not used.
        </p>
      ) : null}

      {localError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{localError}</p>
      ) : null}

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('cogs-blended-save')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      {save.succeeded ? (
        <div className="mt-3">
          <Alert tone="success"><p>Gross margin saved.</p></Alert>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-SKU costs
// ---------------------------------------------------------------------------

interface DraftRow {
  /** What the user typed. Never coerced; a blank stays blank. */
  text: string;
  zeroConfirmed: boolean;
}

type Drafts = Record<string, DraftRow>;

function draftFor(drafts: Drafts, row: SkuRevenueCost): DraftRow {
  return drafts[row.sku] ?? {
    // Prefilled from the stored cost, as a decimal string — never re-derived
    // through a float.
    text: row.cogs ?? '',
    zeroConfirmed: row.zeroConfirmed,
  };
}

function SkuRow({
  row,
  draft,
  currencyCode,
  disabled,
  onChange,
  rowError,
}: {
  row: SkuRevenueCost;
  draft: DraftRow;
  currencyCode: string | null;
  disabled: boolean;
  onChange: (next: DraftRow) => void;
  rowError: string | null;
}) {
  const inputId = useId();
  const entered = draft.text.trim();
  const parsed = entered === '' ? null : parseMoneyInput(entered);
  // The zero confirmation appears ONLY when the entered amount is exactly zero.
  // It is never shown speculatively and never pre-ticked.
  const isZero = parsed?.ok === true && isZeroMoney(parsed.value);

  return (
    <li className="border-t border-[var(--color-border-subtle)] py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <label htmlFor={inputId} className="block break-words font-mono text-sm font-medium">
            {row.sku}
          </label>
          {row.cogs !== null ? (
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Saved: {row.cogs}
              {currencyCode ? ` ${currencyCode}` : ''}
              {row.zeroConfirmed ? ' (zero confirmed)' : ''}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">No cost entered</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <input
            id={inputId}
            value={draft.text}
            disabled={disabled}
            onChange={(event) => {
              const text = event.target.value;
              const next = text.trim() === '' ? null : parseMoneyInput(text.trim());
              onChange({
                text,
                // Moving the amount away from zero drops the confirmation. Leaving
                // it ticked would let a confirmation given for 0 ride along with a
                // number the user changed afterwards.
                zeroConfirmed:
                  next?.ok === true && isZeroMoney(next.value) ? draft.zeroConfirmed : false,
              });
            }}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-invalid={rowError !== null || undefined}
            className="w-28 rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-2.5 py-1.5 text-right text-sm
                       disabled:opacity-55"
          />
          {currencyCode ? (
            <span className="font-mono text-xs text-[var(--color-ink-muted)]">
              {currencyCode}
            </span>
          ) : null}
        </div>
      </div>

      {isZero ? (
        <div className="mt-1.5 flex items-start gap-2">
          <input
            id={`${inputId}-zero`}
            type="checkbox"
            checked={draft.zeroConfirmed}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, zeroConfirmed: event.target.checked })}
            className="mt-0.5 size-4 shrink-0"
          />
          <label htmlFor={`${inputId}-zero`} className="text-xs">
            Confirm the true cost of {row.sku} really is zero.
          </label>
        </div>
      ) : null}

      {rowError ? (
        <p role="alert" className="mt-1.5 text-sm text-[var(--color-danger)]">{rowError}</p>
      ) : null}
    </li>
  );
}

function CoverageSummary({ coverage }: { coverage: AccountCostsResponse['coverage'] }) {
  const met = coverage.coveragePct >= COGS_COVERAGE_TARGET_PCT;
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border-subtle)]
                    bg-[var(--color-surface-sunken)] p-3">
      <p className="text-sm">
        {/*
          THE BACKEND'S ACTUAL FIGURE. Never recomputed here, and never replaced by
          "all rows filled" — the two are different facts and only this one gates
          RCM.
        */}
        <span className="font-semibold">{formatPercent(coverage.coveragePct)}</span> of eligible
        product value has a cost recorded. {COGS_COVERAGE_TARGET_PCT}% is needed.
      </p>
      {/*
        eligibleLineRevenue and costedRevenue are deliberately NOT shown. They are
        line-item values used as the denominator and numerator of this ratio, and
        they are not the same measure as net sales — presenting either as a revenue
        figure would put a number on screen that disagrees with Shopify.
      */}
      {met ? (
        <p className="mt-1 text-sm text-[var(--color-ok)]">
          The {COGS_COVERAGE_TARGET_PCT}% target is met.
        </p>
      ) : (
        <p className="mt-1 text-sm text-[var(--color-warn)]">
          Below the {COGS_COVERAGE_TARGET_PCT}% target.
        </p>
      )}
      {coverage.missingSkus.length > 0 ? (
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          {coverage.missingSkus.length} of the listed product
          {coverage.missingSkus.length === 1 ? '' : 's'} still
          {coverage.missingSkus.length === 1 ? ' has' : ' have'} no cost.
        </p>
      ) : null}
      {coverage.unconfirmedZeroSkus.length > 0 ? (
        <div className="mt-2">
          <Alert tone="warning">
            <p>
              {coverage.unconfirmedZeroSkus.length} product
              {coverage.unconfirmedZeroSkus.length === 1 ? '' : 's'} recorded at zero cost
              without confirmation. Tick each row&rsquo;s confirmation, or enter the real
              cost.
            </p>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

function PerSkuForm({
  accountId,
  coverage,
  currency,
  active,
}: {
  accountId: number;
  coverage: AccountCostsResponse['coverage'];
  currency: AccountCurrencyState | null;
  active: boolean;
}) {
  const save = useSavePerSkuCosts(accountId);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [showAdditional, setShowAdditional] = useState(false);
  const [search, setSearch] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const currencyCode = currency?.currency ?? null;
  // Money cannot be submitted without a currency: an amount with no unit is not a
  // cost. The gross-margin alternative remains available above, because a
  // percentage needs no unit.
  const currencyMissing = currencyCode === null;

  // A successful save re-reads coverage, and the prefill comes from that — so the
  // local drafts are dropped rather than left to shadow the server's values.
  useEffect(() => {
    if (save.succeeded) {
      setDrafts({});
      setRowErrors({});
    }
  }, [save.succeeded]);

  const requiredSkus = useMemo(
    () => new Set(coverage.required.map((r) => r.sku)),
    [coverage.required],
  );
  const additional = useMemo(
    () => coverage.all.filter((r) => !requiredSkus.has(r.sku)),
    [coverage.all, requiredSkus],
  );
  const filteredAdditional = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle === ''
      ? additional
      : additional.filter((r) => r.sku.toLowerCase().includes(needle));
  }, [additional, search]);

  const failure = save.error ? describeFinancialFailure(save.error, 'cogs-per-sku-save') : null;

  function submit(): void {
    setFormError(null);
    const nextRowErrors: Record<string, string> = {};
    const rows: SkuCostInput[] = [];

    // Only rows the user actually filled are submitted. A blank row is NOT sent as
    // zero and is not an error — partial saves are the normal way this form is
    // used, and requiring all twenty before anything can be kept is how entered
    // work gets lost.
    for (const [sku, draft] of Object.entries(drafts)) {
      const text = draft.text.trim();
      if (text === '') continue;
      const parsed = parseMoneyInput(text);
      if (!parsed.ok) {
        nextRowErrors[sku] = describeMoneyProblem(parsed.reason, 'cost');
        continue;
      }
      const zero = isZeroMoney(parsed.value);
      if (zero && !draft.zeroConfirmed) {
        nextRowErrors[sku] = `Confirm that the true cost of ${sku} is zero, or enter a cost.`;
        continue;
      }
      rows.push({
        sku,
        cogs: toCanonicalMoney(parsed.value),
        ...(zero ? { zeroConfirmed: true } : {}),
      });
    }

    if (Object.keys(nextRowErrors).length > 0) {
      setRowErrors(nextRowErrors);
      return;
    }
    setRowErrors({});
    if (rows.length === 0) {
      setFormError('Enter a cost for at least one product before saving.');
      return;
    }
    save.submit(rows);
  }

  function renderRow(row: SkuRevenueCost) {
    return (
      <SkuRow
        key={row.sku}
        row={row}
        draft={draftFor(drafts, row)}
        currencyCode={currencyCode}
        disabled={currencyMissing || save.isSubmitting}
        rowError={rowErrors[row.sku] ?? null}
        onChange={(next) => setDrafts((prev) => ({ ...prev, [row.sku]: next }))}
      />
    );
  }

  // No eligible SKU data at all: a neutral waiting state, and NOT an invented
  // list of rows.
  if (coverage.all.length === 0) {
    return (
      <div className="mt-3">
        <Alert tone="info">
          <p>
            Waiting for Shopify product and order data. Per-product costs will appear here
            once the import has found products with sales in the last twelve months.
          </p>
        </Alert>
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
          A blended gross margin can be entered now instead — it does not depend on product
          data.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      {!active ? (
        <p className="mb-2 text-xs text-[var(--color-ink-muted)]">
          Blended gross margin is the active method, so these costs are retained but not used.
        </p>
      ) : null}

      {currencyMissing ? (
        <div className="mb-3">
          <Alert tone="warning">
            <p>
              Set the account currency above before entering product costs — an amount
              without a currency cannot be recorded. Blended gross margin is a percentage
              and can still be saved.
            </p>
          </Alert>
        </div>
      ) : null}

      <h4 className="text-sm font-semibold">
        Highest-value products
        <span className="ml-1.5 font-normal text-[var(--color-ink-muted)]">
          ({coverage.required.length})
        </span>
      </h4>
      <p className="mt-0.5 max-w-prose text-xs text-[var(--color-ink-muted)]">
        In the order Shopify&rsquo;s sales data puts them. Costing these first is the
        quickest route to the {COGS_COVERAGE_TARGET_PCT}% target.
      </p>
      <ul className="mt-1.5">{coverage.required.map(renderRow)}</ul>

      {/*
        cappedBelowTarget: the top 20 by revenue represent LESS than 80% of eligible
        product value, so no amount of filling in this list reaches the target. Say
        so plainly and open the door to the rest, rather than letting someone fill
        twenty boxes and find RCM still blocked.
      */}
      {coverage.cappedBelowTarget ? (
        <div className="mt-3">
          <Alert tone="warning" title="These 20 products cannot reach the target on their own">
            <p>
              This brand&rsquo;s sales are spread widely enough that the twenty highest-value
              products come to less than {COGS_COVERAGE_TARGET_PCT}% of eligible product
              value. Add costs for more products below, or use a blended gross margin
              instead.
            </p>
          </Alert>
        </div>
      ) : null}

      {additional.length > 0 ? (
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={() => setShowAdditional((prev) => !prev)}
            aria-expanded={showAdditional}
          >
            {showAdditional ? 'Hide' : 'Show'} additional products ({additional.length})
          </Button>

          {showAdditional ? (
            <div className="mt-3">
              <label htmlFor="cogs-sku-search" className="block text-sm font-medium">
                Search products
              </label>
              <input
                id="cogs-sku-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
                placeholder="SKU"
                className="mt-1.5 w-full max-w-xs rounded-md border
                           border-[var(--color-border-strong)] bg-[var(--color-surface)]
                           px-3 py-2 text-sm"
              />
              {filteredAdditional.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
                  No product matches that search.
                </p>
              ) : (
                <ul className="mt-1.5">{filteredAdditional.map(renderRow)}</ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button
          onClick={submit}
          disabled={currencyMissing}
          loading={save.isSubmitting}
          loadingLabel="Saving…"
        >
          Save product costs
        </Button>
        <span className="text-xs text-[var(--color-ink-muted)]">
          Saves the rows you have filled in. Partial entry is fine.
        </span>
      </div>

      {formError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{formError}</p>
      ) : null}

      {failure && !failure.sessionExpired ? (
        <div className="mt-3">
          <Alert tone="error" title={financialFailureTitle('cogs-per-sku-save')}>
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      {save.succeeded ? (
        <div className="mt-3">
          <Alert tone="success"><p>Product costs saved.</p></Alert>
        </div>
      ) : null}

      <CoverageSummary coverage={coverage} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Method selection
// ---------------------------------------------------------------------------

const METHOD_LABELS: Record<CogsMethod, string> = {
  per_sku: 'Per-product costs',
  blended: 'Blended gross margin',
};

export function CogsControl({ accountId, resource, currency }: CogsControlProps) {
  const groupName = useId();
  const data = resource.data;
  const loadFailure = resource.error
    ? describeFinancialFailure(resource.error, 'costs-load')
    : null;

  const storedMethod = data?.costs.cogsMethod ?? null;
  // The selection shown before anything is stored. Local, because choosing a
  // radio button is not itself a write — the method is recorded by the save that
  // follows, which is what keeps "chose blended" and "started per-SKU and
  // abandoned it" distinguishable.
  const [selected, setSelected] = useState<CogsMethod>(storedMethod ?? 'per_sku');
  const [pendingSwitch, setPendingSwitch] = useState<CogsMethod | null>(null);

  useEffect(() => {
    if (storedMethod) setSelected(storedMethod);
  }, [storedMethod]);

  if (resource.status === 'loading') {
    return (
      <p role="status" className="text-sm text-[var(--color-ink-muted)]">
        Loading cost of goods…
      </p>
    );
  }

  if (resource.status === 'error' || !data) {
    if (loadFailure?.sessionExpired) return null;
    return (
      <Alert tone="error" title={financialFailureTitle('costs-load')}>
        <p>{loadFailure?.message ?? 'Cost of goods could not be loaded.'}</p>
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

  function requestMethod(next: CogsMethod): void {
    if (next === selected) return;
    // A confirmation only when a method is ALREADY STORED. Picking between the two
    // for the first time is not a change to anything.
    if (storedMethod !== null && storedMethod !== next) {
      setPendingSwitch(next);
      return;
    }
    setSelected(next);
  }

  return (
    <div>
      <fieldset>
        <legend className="text-sm font-medium">How are product costs recorded?</legend>
        <p className="mt-0.5 max-w-prose text-xs text-[var(--color-ink-muted)]">
          One method is active at a time. They are never combined.
        </p>
        <div className="mt-2 space-y-1.5">
          {(['per_sku', 'blended'] as const).map((method) => (
            <div key={method} className="flex items-start gap-2">
              <input
                id={`${groupName}-${method}`}
                type="radio"
                name={groupName}
                checked={selected === method}
                onChange={() => requestMethod(method)}
                className="mt-0.5 size-4 shrink-0"
              />
              <label htmlFor={`${groupName}-${method}`} className="text-sm">
                {METHOD_LABELS[method]}
                {storedMethod === method ? (
                  <span className="ml-1.5 text-xs text-[var(--color-ok)]">Active</span>
                ) : null}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      {pendingSwitch ? (
        <div className="mt-3 rounded-md border border-[var(--color-warn-border)]
                        bg-[var(--color-warn-surface)] p-3.5">
          <h4 className="text-sm font-semibold">
            Switch to {METHOD_LABELS[pendingSwitch].toLowerCase()}?
          </h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {/*
              The retention promise is the important one and it is literally true:
              the backend keeps both sets of values and switches which is ACTIVE.
              Nothing is deleted here, and the copy must not imply otherwise.
            */}
            <li>
              Everything you have already entered is <strong>kept</strong> — nothing is
              deleted.
            </li>
            <li>Only {METHOD_LABELS[pendingSwitch].toLowerCase()} will be used for RCM.</li>
            <li>The two methods are never combined.</li>
            <li>Switching back restores the values you entered before.</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setSelected(pendingSwitch);
                setPendingSwitch(null);
              }}
            >
              Switch method
            </Button>
            <Button variant="secondary" onClick={() => setPendingSwitch(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        Only the selected method's form is rendered, so there is no way to submit
        both. The other method's stored value is still described as retained by the
        note inside each form.
      */}
      {selected === 'blended' ? (
        <BlendedMarginForm
          accountId={accountId}
          retained={data.costs.blendedMarginPct}
          active={storedMethod === 'blended'}
        />
      ) : (
        <PerSkuForm
          accountId={accountId}
          coverage={data.coverage}
          currency={currency}
          active={storedMethod === 'per_sku'}
        />
      )}
    </div>
  );
}
