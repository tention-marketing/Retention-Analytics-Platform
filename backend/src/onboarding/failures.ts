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

// ---------------------------------------------------------------------------
// CONNECT-TIME failures, for the client surface (Phase 5C-4)
// ---------------------------------------------------------------------------
//
// classifyFailure() above covers a SYNC that failed after a connection existed.
// This is its connect-time sibling, and it lives in the same file for the same
// reason: one home for every sentence a client may be shown about a provider, so
// no route can hand-roll a variant that says more.
//
// WHAT IT FIXES. onboarding/connect.ts builds its `verification_failed` message
// as `` `Klaviyo verification failed: ${(err as Error).message}` ``, and the
// provider clients put the raw HTTP response body in that Error — Klaviyo redacts
// only `pk_`-shaped strings and the `Klaviyo-API-Key` header, and Recharge redacts
// nothing at all. A poisoned provider body therefore reached the client verbatim,
// carrying whatever it contained: SQL fragments, absolute deploy-host paths,
// stack frames, and non-Klaviyo credential shapes such as a `shpat_` token.
//
// THE RAW TEXT IS NOT DESTROYED. connect.ts is unchanged, so the agency routes
// and sync_errors keep the full detail they need for troubleshooting. What
// changes is only what crosses the CLIENT boundary: this helper reads the code
// and nothing else.

/**
 * Derived FROM connect.ts rather than re-spelled beside it, so the two cannot
 * drift: a new ConnectFailure code becomes a compile error in the exhaustive
 * switch below instead of silently falling through to a default.
 *
 * `import type` — erased at build time, so failures.ts gains no runtime
 * dependency on the provider clients connect.ts pulls in.
 */
export type ConnectFailureCode = import('./connect.js').ConnectFailure['code'];

export interface PublicConnectFailure {
  /** Unchanged from the internal failure. Safe to branch on in the frontend. */
  code: ConnectFailureCode;
  /** Fixed, application-owned wording. Never derived from provider text. */
  message: string;
}

/** What this provider's credential is actually called, for accurate copy. */
const CREDENTIAL_NOUN: Record<Provider, string> = {
  shopify: 'app credentials',
  klaviyo: 'private API key',
  recharge: 'API token',
};

/**
 * The client-facing form of a connect failure.
 *
 * EVERY branch returns a literal composed only of strings defined in this file.
 * There is no default case and no parameter carrying provider text — the raw
 * message is not even passed in, so it cannot be concatenated by accident.
 */
export function publicConnectFailure(
  code: ConnectFailureCode,
  provider: Provider,
): PublicConnectFailure {
  const label = PROVIDER_LABEL[provider];
  switch (code) {
    case 'missing_credentials':
      return { code, message: `Enter your ${label} ${CREDENTIAL_NOUN[provider]} to continue.` };

    case 'verification_failed':
      // Covers a rejected credential, an unreachable provider and a provider
      // 5xx alike, so it must not assert which one happened — "could not verify"
      // is true of all three, where "rejected your key" would be wrong for an
      // outage.
      return {
        code,
        message:
          `We could not verify those ${label} credentials. Check them and try again, ` +
          'or ask your account manager for help.',
      };

    case 'account_not_found':
      // Unreachable from a valid client request now that the session refuses a
      // link whose account cannot be safely loaded (5C-4). Mapped anyway, and
      // mapped to wording that CONFIRMS NOTHING about whether an account exists.
      return { code, message: 'We could not complete this connection. Ask your account manager.' };

    case 'invalid_domain':
      return { code, message: `That ${label} store domain is not valid.` };

    case 'domain_conflict':
      // Same sentence as domain.ts's client-safe message: never names the other
      // account.
      return {
        code,
        message: `This ${label} store is already being set up. Contact your account manager.`,
      };
  }
  // Exhaustive above. This makes a future unmapped code a TYPE error rather than
  // a silent fallthrough that might return provider text.
  return assertNever(code);
}

function assertNever(value: never): never {
  throw new Error(`unmapped connect failure code: ${String(value)}`);
}
