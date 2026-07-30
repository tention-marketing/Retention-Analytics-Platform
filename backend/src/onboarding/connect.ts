import { query } from '../db/pool.js';
import {
  upsertShopifyAppConnection, upsertKlaviyoConnection, upsertRechargeConnection,
} from '../db/connections.js';
import { verifyShopifyConnection, type ShopInfo } from '../sync/shopify/client.js';
import { verifyKlaviyoConnection } from '../sync/klaviyo/client.js';
import { verifyRechargeConnection } from '../sync/recharge/client.js';
import { enqueueBackfill, enqueueKlaviyoBackfill, enqueueRechargeBackfill } from '../queue/queues.js';
import { runShopifyBackfill } from '../sync/shopify/backfill.js';
import { runKlaviyoBackfill } from '../sync/klaviyo/poller.js';
import { runRechargeBackfill } from '../sync/recharge/backfill.js';
import { normalizeShopDomain, findDomainConflict, domainConflictMessage } from './domain.js';
import { applyShopifyCurrency, applyShopifyTimezone, type ShopifyCurrencyOutcome } from './currency.js';
import { supersedeChoiceOnConnect } from './choices.js';

// Shared provider connection services (D10 / plan §11).
//
// EXTRACTED, NOT REWRITTEN: the verify → encrypt → upsert → enqueue sequence is
// exactly what routes/connections.ts already did. Verification clients, AES
// encryption, connection upserts, queue helpers, sync engines and identity logic
// are all reused unchanged.
//
// THE ONE BEHAVIOURAL RULE THESE SERVICES ADD (D10/E10, trap: cross-tenant
// credential binding): credentials are ALWAYS parameters. Nothing here reads
// config.klaviyoApiKey / config.rechargeApiToken / config.shopify*. The previous
// route handlers fell back to those env values when a field was blank, which on a
// client-facing route would silently bind ANOTHER brand's credentials to this
// account. Env fallback now exists only where a caller opts in explicitly.

export type ConnectMode = 'queue' | 'sync';

export interface ConnectOptions {
  /** 'sync' runs the backfill inline (pilot verification without a worker). */
  mode?: ConnectMode;
}

export type ConnectFailure =
  | { ok: false; code: 'missing_credentials'; message: string }
  | { ok: false; code: 'account_not_found'; message: string }
  | { ok: false; code: 'invalid_domain'; message: string }
  | { ok: false; code: 'domain_conflict'; message: string }
  | { ok: false; code: 'verification_failed'; message: string };

interface QueueOutcome {
  queued: boolean;
  /** Set when enqueueing failed (Redis down). The connection is still saved. */
  queueNote?: string;
  backfill?: unknown;
}

async function accountExists(accountId: number): Promise<boolean> {
  const { rowCount } = await query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Enqueue (or run) the provider backfill. A failure to enqueue is NOT a connect
 * failure — the credential is already persisted, and losing that would be worse
 * than a delayed sync. Mirrors the tolerance the existing routes had.
 */
async function dispatchBackfill(
  mode: ConnectMode,
  runInline: () => Promise<unknown>,
  enqueue: () => Promise<void>,
): Promise<QueueOutcome> {
  if (mode === 'sync') {
    return { queued: false, backfill: await runInline() };
  }
  try {
    await enqueue();
    return { queued: true };
  } catch {
    return { queued: false, queueNote: 'stored; enqueue failed (is Redis up?)' };
  }
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

export interface ShopifyCredentials {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}

export interface ShopifyConnectResult extends QueueOutcome {
  ok: true;
  shop: ShopInfo;
  shopDomain: string;
  currency: { outcome: ShopifyCurrencyOutcome; currency: string; detected: string } | null;
  timezoneApplied: boolean;
}

/**
 * Connect Shopify with per-store credentials (D11 Option A).
 *
 * The credentials are the store's OWN custom-app client_id/secret — Shopify's
 * client_credentials grant only works for the app's own store (see
 * sync/shopify/token.ts), which is exactly why a single env-wide pair cannot
 * serve unrelated stores and why this takes them as parameters.
 *
 * On success it also captures currency and store timezone from the same
 * verification round-trip (E6) — no extra API call.
 */
export async function connectShopify(
  accountId: number,
  creds: ShopifyCredentials,
  opts: ConnectOptions = {},
): Promise<ShopifyConnectResult | ConnectFailure> {
  if (!creds?.clientId?.trim() || !creds?.clientSecret?.trim()) {
    return {
      ok: false, code: 'missing_credentials',
      message: 'Shopify client id and client secret are required.',
    };
  }
  const normalized = normalizeShopDomain(creds.shopDomain);
  if (!normalized.ok) {
    return { ok: false, code: 'invalid_domain', message: normalized.message };
  }
  if (!(await accountExists(accountId))) {
    return { ok: false, code: 'account_not_found', message: 'Account not found.' };
  }
  if (await findDomainConflict(accountId, normalized.domain)) {
    return { ok: false, code: 'domain_conflict', message: domainConflictMessage() };
  }

  let shop: ShopInfo;
  try {
    shop = await verifyShopifyConnection({
      shopDomain: normalized.domain,
      app: { clientId: creds.clientId.trim(), clientSecret: creds.clientSecret.trim() },
    });
  } catch (err) {
    return {
      ok: false, code: 'verification_failed',
      message: `Shopify verification failed: ${(err as Error).message}`,
    };
  }

  await upsertShopifyAppConnection(
    accountId, normalized.domain, creds.clientId.trim(), creds.clientSecret.trim(),
  );
  await supersedeChoiceOnConnect(accountId, 'shopify');

  // E6: currency + timezone from the verification response.
  const currency = shop.currencyCode
    ? await applyShopifyCurrency(accountId, shop.currencyCode)
    : null;
  const timezoneApplied = shop.ianaTimezone
    ? await applyShopifyTimezone(accountId, shop.ianaTimezone)
    : false;

  const dispatched = await dispatchBackfill(
    opts.mode ?? 'queue',
    () => runShopifyBackfill(accountId),
    () => enqueueBackfill(accountId),
  );

  return {
    ok: true, shop, shopDomain: normalized.domain, currency, timezoneApplied, ...dispatched,
  };
}

// ---------------------------------------------------------------------------
// Klaviyo
// ---------------------------------------------------------------------------

export interface KlaviyoConnectResult extends QueueOutcome {
  ok: true;
  account: unknown;
}

export async function connectKlaviyo(
  accountId: number,
  creds: { apiKey: string },
  opts: ConnectOptions = {},
): Promise<KlaviyoConnectResult | ConnectFailure> {
  const apiKey = creds?.apiKey?.trim();
  if (!apiKey) {
    return {
      ok: false, code: 'missing_credentials',
      message: 'A Klaviyo private API key is required.',
    };
  }
  if (!(await accountExists(accountId))) {
    return { ok: false, code: 'account_not_found', message: 'Account not found.' };
  }

  let account: unknown;
  try {
    // client.ts already redacts key-shaped strings from its error messages.
    account = await verifyKlaviyoConnection({ apiKey });
  } catch (err) {
    return {
      ok: false, code: 'verification_failed',
      message: `Klaviyo verification failed: ${(err as Error).message}`,
    };
  }

  await upsertKlaviyoConnection(accountId, apiKey);
  await supersedeChoiceOnConnect(accountId, 'klaviyo');

  const dispatched = await dispatchBackfill(
    opts.mode ?? 'queue',
    () => runKlaviyoBackfill(accountId),
    () => enqueueKlaviyoBackfill(accountId),
  );
  return { ok: true, account, ...dispatched };
}

// ---------------------------------------------------------------------------
// Recharge
// ---------------------------------------------------------------------------

export interface RechargeConnectResult extends QueueOutcome {
  ok: true;
  store: unknown;
}

export async function connectRecharge(
  accountId: number,
  creds: { token: string },
  opts: ConnectOptions = {},
): Promise<RechargeConnectResult | ConnectFailure> {
  const token = creds?.token?.trim();
  if (!token) {
    return {
      ok: false, code: 'missing_credentials',
      message: 'A Recharge API token is required.',
    };
  }
  if (!(await accountExists(accountId))) {
    return { ok: false, code: 'account_not_found', message: 'Account not found.' };
  }

  let store: unknown;
  try {
    store = await verifyRechargeConnection({ token });
  } catch (err) {
    return {
      ok: false, code: 'verification_failed',
      message: `Recharge verification failed: ${(err as Error).message}`,
    };
  }

  await upsertRechargeConnection(accountId, token);
  await supersedeChoiceOnConnect(accountId, 'recharge');

  const dispatched = await dispatchBackfill(
    opts.mode ?? 'queue',
    () => runRechargeBackfill(accountId),
    () => enqueueRechargeBackfill(accountId),
  );
  return { ok: true, store, ...dispatched };
}
