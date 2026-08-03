import { ApiError } from '@/api/errors';

// Fixed, safe wording for every way a financial write can fail.
//
// WHY NOT ApiError.message. The generic normalizer adopts a server string when it
// looks displayable, which is right for the backend's written-for-humans blocker
// sentences and wrong for these routes. Their messages interpolate the caller's
// own submitted values — "Cost for COGS-B cannot be negative.", "These SKUs are
// not in this account's order history: …", "Spend is already recorded for
// 2026-07. Confirm that you want to replace it with zero." — and one of them is
// assembled from a list of months whose length nothing bounds. Rendering server
// prose in a form also means the copy on screen changes whenever a backend
// message is reworded, with no test noticing.
//
// So the CODE is what this app branches on, and every sentence below is a literal
// defined in this file. Structured fields (`months`, `skus`) are read only after
// the strict validation in api/financial.ts, never straight out of the body.

export type FinancialAction =
  | 'currency-load' | 'currency-save' | 'currency-resolve'
  | 'costs-load' | 'cogs-blended-save' | 'cogs-per-sku-save' | 'cogs-method-switch'
  | 'ocas-save'
  | 'ad-spend-load' | 'ad-spend-save' | 'ad-spend-zero';

export interface FinancialFailure {
  /** Fixed sentence, safe to render. */
  message: string;
  /** True only for faults where trying again could plausibly work. */
  retryable: boolean;
  /** True on a confirmed 401, so a caller can skip rendering before redirect. */
  sessionExpired: boolean;
}

const TITLES: Record<FinancialAction, string> = {
  'currency-load': 'Could not load the currency',
  'currency-save': 'Could not save the currency',
  'currency-resolve': 'Could not resolve the currency mismatch',
  'costs-load': 'Could not load cost of goods',
  'cogs-blended-save': 'Could not save the gross margin',
  'cogs-per-sku-save': 'Could not save these product costs',
  'cogs-method-switch': 'Could not change the costing method',
  'ocas-save': 'Could not save the operating cost',
  'ad-spend-load': 'Could not load advertising spend',
  'ad-spend-save': 'Could not save this advertising spend',
  'ad-spend-zero': 'Could not confirm a zero-spend month',
};

export function financialFailureTitle(action: FinancialAction): string {
  return TITLES[action];
}

const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';
const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SERVER = 'The server could not complete this request. Try again in a moment.';
const UNAVAILABLE = 'This account is no longer available. Return to all accounts.';
const UNEXPECTED = 'The server returned something unexpected. Nothing was changed.';

/**
 * Fixed wording per backend error code.
 *
 * Deliberately ONE table across all the financial routes rather than one per
 * action: the codes are unique enough to be unambiguous, and a per-action table
 * would mean the same `too_precise` sentence written five times and edited four.
 * Where a code genuinely needs different wording per field, the per-action
 * override below handles it.
 */
const BY_CODE: Record<string, string> = {
  // --- currency ---
  invalid_code: 'Enter a three-letter currency code, for example USD.',
  shopify_authoritative:
    'This currency comes from the connected Shopify store and cannot be changed here.',
  no_mismatch:
    'There is no currency mismatch on this account. Nothing was changed — refresh to see the '
    + 'current currency.',

  // --- COGS and OCAS ---
  bad_method: 'That costing method is not one this platform supports. Nothing was changed.',
  skus_required: 'Enter a cost for at least one product before saving.',
  sku_required: 'One of these rows has no product code. Nothing was changed.',
  unknown_skus:
    'One or more of these product codes is not in this brand’s own order history, so nothing '
    + 'was saved. Reload the list and try again.',
  not_a_number: 'Enter a number. An empty field is not the same as zero.',
  negative: 'This cannot be a negative amount.',
  too_large: 'That amount is larger than this platform can store.',
  too_precise: 'Use at most two decimal places.',
  out_of_range: 'Gross margin must be greater than 0 and less than 100.',
  zero_unconfirmed:
    'A value of zero has to be confirmed explicitly. Tick the confirmation to record it as a '
    + 'genuine zero.',

  // --- ad spend ---
  no_rows: 'Add at least one channel before saving.',
  channel_required: 'Enter a channel name.',
  channel_too_long: 'That channel name is too long. Use 64 characters or fewer.',
  bad_month: 'Choose a valid month.',
  bad_range: 'The start month cannot be after the end month.',
  future_month: 'Spend cannot be recorded for a month that has not finished arriving yet.',
  range_too_long: 'That range covers more months than this form supports. Split it up.',
  overlapping_rows:
    'Two of these rows cover the same channel in the same month. Each channel can have one '
    + 'amount per month.',
  zero_requires_confirmation:
    'A zero-spend month cannot be entered as an amount. Use “Confirm zero-spend months” '
    + 'below so the zero is recorded as a deliberate answer.',
  months_required: 'Select at least one month.',
  requires_replace:
    'Some of those months already have spend recorded. Confirm the replacement to continue.',
};

/**
 * Codes whose generic sentence is not specific enough in a particular form.
 *
 * `zero_unconfirmed` is the one that matters: on the OCAS field and on a per-SKU
 * row it means different things to the person reading it, and "tick the
 * confirmation" is only actionable if they can tell which confirmation.
 */
const PER_ACTION: Partial<Record<FinancialAction, Record<string, string>>> = {
  'ocas-save': {
    zero_unconfirmed:
      'To record a monthly operating cost of zero, tick the confirmation that the true monthly '
      + 'allocation really is zero.',
    not_a_number: 'Enter a monthly operating cost. An empty field is not the same as zero.',
    negative: 'A monthly operating cost cannot be negative.',
  },
  'cogs-per-sku-save': {
    zero_unconfirmed:
      'One of these products has a cost of zero. Tick that row’s confirmation to record it '
      + 'as a genuine zero cost.',
    not_a_number: 'Enter a cost for each product you are saving. A blank field is not zero.',
    negative: 'A product cost cannot be negative.',
  },
  'cogs-blended-save': {
    not_a_number: 'Enter a gross margin percentage.',
    too_precise: 'Gross margin supports at most two decimal places.',
  },
  'ad-spend-save': {
    negative: 'Advertising spend cannot be negative.',
    not_a_number: 'Enter a monthly amount. An empty field is not the same as zero.',
    too_precise: 'Advertising spend supports at most two decimal places.',
  },
};

/** A fixed 400 sentence per action, for a code this app does not recognise. */
const FALLBACK_400: Record<FinancialAction, string> = {
  'currency-load': UNEXPECTED,
  'currency-save': 'That currency was not accepted. Nothing was changed.',
  'currency-resolve': 'That request was not valid, so nothing was changed.',
  'costs-load': UNEXPECTED,
  'cogs-blended-save': 'That gross margin was not accepted. Nothing was changed.',
  'cogs-per-sku-save': 'Those product costs were not accepted. Nothing was saved.',
  'cogs-method-switch': 'That costing method could not be selected. Nothing was changed.',
  'ocas-save': 'That operating cost was not accepted. Nothing was changed.',
  'ad-spend-load': UNEXPECTED,
  'ad-spend-save': 'That advertising spend was not accepted. Nothing was saved.',
  'ad-spend-zero': 'That zero-spend confirmation was not accepted. Nothing was changed.',
};

export function describeFinancialFailure(
  error: unknown,
  action: FinancialAction,
): FinancialFailure {
  if (!(error instanceof ApiError)) {
    return { message: UNEXPECTED, retryable: false, sessionExpired: false };
  }
  if (error.kind === 'network' || error.kind === 'aborted') {
    return { message: NETWORK, retryable: true, sessionExpired: false };
  }
  // A client-side refusal: a response that failed validation at the boundary, or
  // a URL the client would not send. Retrying repeats it.
  if (error.kind === 'client') {
    return { message: UNEXPECTED, retryable: false, sessionExpired: false };
  }
  // 401 FIRST, before any code lookup. This is the only status that means the
  // session is gone, and the caller stops rendering on it.
  if (error.status === 401) {
    return { message: SESSION_EXPIRED, retryable: false, sessionExpired: true };
  }

  const code = error.code ?? '';
  const specific = PER_ACTION[action]?.[code] ?? BY_CODE[code];
  if (specific) return { message: specific, retryable: false, sessionExpired: false };

  // A 5xx is never read for a code — that is exactly where an internal exception
  // message surfaces.
  if (error.status >= 500) {
    return { message: SERVER, retryable: true, sessionExpired: false };
  }
  if (error.status === 404) {
    return { message: UNAVAILABLE, retryable: false, sessionExpired: false };
  }
  if (error.status === 429) {
    return {
      message: 'Too many attempts. Wait a moment and try again.',
      retryable: true,
      sessionExpired: false,
    };
  }
  if (error.status === 400 || error.status === 403 || error.status === 409
      || error.status === 415 || error.status === 422) {
    return { message: FALLBACK_400[action], retryable: false, sessionExpired: false };
  }
  return { message: UNEXPECTED, retryable: false, sessionExpired: false };
}

/**
 * Wording for a pre-flight validation failure, before any request is sent.
 *
 * Mirrors the backend's vocabulary so a value rejected here and the same value
 * rejected by the server read alike — the user should not be able to tell which
 * side refused it, because both refuse it for the same reason.
 */
export type MoneyField = 'amount' | 'cost' | 'operating cost' | 'spend';

/**
 * The article belongs with the noun, not glued on at the call site.
 *
 * "A operating cost cannot be negative" is what a naive `A ${what}` produces, and
 * it reads as a bug in a screen whose whole job is to look trustworthy.
 */
const ARTICLE: Record<MoneyField, string> = {
  amount: 'An amount',
  cost: 'A cost',
  'operating cost': 'An operating cost',
  spend: 'A spend amount',
};

export function describeMoneyProblem(
  reason: 'blank' | 'not_a_number' | 'negative' | 'too_precise' | 'too_large',
  what: MoneyField = 'amount',
): string {
  switch (reason) {
    case 'blank':
      return `Enter a ${what}. An empty field is not the same as zero.`;
    case 'not_a_number':
      return `Enter a ${what} as a plain number, with no currency symbol or separators.`;
    case 'negative':
      return `${ARTICLE[what]} cannot be negative.`;
    case 'too_precise':
      return 'Use at most two decimal places.';
    case 'too_large':
      return `That ${what} is larger than this platform can store.`;
  }
}
