import type { Provider } from './choices.js';

// Safe, browser-facing representation of a sync failure.
//
// WHY THIS EXISTS: two raw strings used to travel straight from an internal
// source into an agency HTTP response —
//
//   * BullMQ's `job.failedReason`, which is the thrown Error's message and
//     frequently carries a provider response body or a URL, and
//   * `sync_errors.error`, which logSyncError() writes as
//     `${error.message}\n${error.stack}` — a full stack trace, with absolute
//     filesystem paths from the deploy host.
//
// Both were rendered in a browser. Neither told the agency anything it could
// act on that a stable code and a category do not. So the raw text now stays
// where it is useful (Postgres and the process log, unchanged) and the API
// returns this instead.
//
// THE RULE THIS MODULE ENFORCES: classify() reads the raw text but never
// returns any part of it. Every string it emits is a literal defined in this
// file, so no stack frame, path, credential, or provider payload can reach a
// response by way of a message the classifier "passed through".

export type FailureCategory =
  | 'auth'        // the provider rejected our credentials
  | 'rate_limit'  // the provider throttled us
  | 'network'     // we could not reach the provider
  | 'provider'    // the provider answered, with an error
  | 'internal';   // anything else — our side, or unrecognised

export interface SafeFailure {
  /** Stable machine code. Safe to branch on in the frontend. */
  code: string;
  category: FailureCategory;
  provider: Provider;
  /**
   * Which job was running: the `sync_errors.job_type` value (e.g.
   * 'klaviyo.backfill'), or '<provider>.backfill' for a BullMQ job failure.
   * An internal identifier, but a fixed vocabulary — no paths, no payloads.
   */
  stage: string;
  /** Whether retrying stands a chance without human intervention. */
  retryable: boolean;
  /** Fixed sentence, safe to render verbatim. Never contains raw error text. */
  publicMessage: string;
  occurredAt: Date | null;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  shopify: 'Shopify',
  klaviyo: 'Klaviyo',
  recharge: 'Recharge',
};

interface Rule {
  code: string;
  category: FailureCategory;
  retryable: boolean;
  test: RegExp;
  message: (providerLabel: string) => string;
}

// Ordered: the first match wins. Auth is checked before the generic 4xx/5xx
// rule so "401 Unauthorized" is reported as a credential problem rather than as
// a generic provider error, which is the difference between "re-enter the key"
// and "wait and retry".
const RULES: Rule[] = [
  {
    code: 'provider_auth_failed',
    category: 'auth',
    retryable: false,
    test: /\b(401|403)\b|unauthor|forbidden|invalid[ _-]?(api[ _-]?)?(key|token|credential)|authentication[ _-]?fail|access[ _-]?denied|not[ _-]?authenticated/i,
    message: (p) => `Authentication with ${p} failed. The stored credentials need to be re-entered.`,
  },
  {
    code: 'provider_rate_limited',
    category: 'rate_limit',
    retryable: true,
    test: /\b429\b|rate[ _-]?limit|too[ _-]?many[ _-]?requests|throttl/i,
    message: (p) => `${p} rate-limited the sync. It will be retried automatically.`,
  },
  {
    code: 'provider_unreachable',
    category: 'network',
    retryable: true,
    test: /fetch[ _-]?failed|econnrefused|econnreset|enotfound|etimedout|epipe|network|socket[ _-]?hang|dns|getaddrinfo|timed?[ _-]?out|abort/i,
    message: (p) => `${p} could not be reached. The sync will be retried.`,
  },
  {
    code: 'provider_error',
    category: 'provider',
    retryable: true,
    test: /\b5\d\d\b|bad[ _-]?gateway|service[ _-]?unavailable|internal[ _-]?server[ _-]?error|gateway[ _-]?timeout|\b4\d\d\b/i,
    message: (p) => `${p} returned an error. The sync will be retried.`,
  },
];

const FALLBACK: Omit<Rule, 'test'> = {
  code: 'sync_failed',
  category: 'internal',
  retryable: true,
  message: (p) => `The ${p} sync failed. Additional agency attention is required.`,
};

/**
 * Turn raw failure text into a safe, structured failure.
 *
 * `raw` is READ ONLY — it is matched against the rules above and then dropped.
 * Nothing derived from its contents appears in the return value.
 */
export function classifyFailure(
  raw: string | null | undefined,
  provider: Provider,
  stage: string,
  occurredAt: Date | null = null,
): SafeFailure {
  const label = PROVIDER_LABEL[provider];
  const text = typeof raw === 'string' ? raw : '';
  const rule = RULES.find((r) => r.test.test(text)) ?? FALLBACK;
  return {
    code: rule.code,
    category: rule.category,
    provider,
    stage,
    retryable: rule.retryable,
    publicMessage: rule.message(label),
    occurredAt,
  };
}

/** A job that has been queued too long. Not an error — a status. */
export function delayedFailure(provider: Provider, stage: string): SafeFailure {
  return {
    code: 'sync_delayed',
    category: 'internal',
    provider,
    stage,
    retryable: true,
    publicMessage: `The ${PROVIDER_LABEL[provider]} sync was delayed and will be retried.`,
    occurredAt: null,
  };
}
