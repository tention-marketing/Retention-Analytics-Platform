import { config } from '../../config.js';
import { getAccessToken, type ShopifyAppCredentials } from './token.js';

export interface ShopifyConnection {
  shopDomain: string; // e.g. my-store.myshopify.com
  // Exactly one auth mode is populated:
  //  - `app`: custom-app client_credentials; token fetched/refreshed on demand.
  //  - `token`: a static Admin API token (seed/tests/manual installs).
  app?: ShopifyAppCredentials;
  token?: string;
}

// Resolve the Admin API access token for a connection. App connections exchange
// (and cache/refresh) via the token manager; static-token connections return
// their token as-is.
async function resolveToken(conn: ShopifyConnection, force = false): Promise<string> {
  if (conn.app) return getAccessToken(conn.shopDomain, conn.app, force);
  if (conn.token) return conn.token;
  throw new Error(`Shopify connection for ${conn.shopDomain} has no credentials`);
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // bulk ops on 2yrs of data can take minutes

function endpoint(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
}

function post(shopDomain: string, token: string, body: string): Promise<Response> {
  return fetch(endpoint(shopDomain), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body,
  });
}

export async function shopifyGraphQL<T = any>(
  conn: ShopifyConnection,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const body = JSON.stringify({ query, variables });
  let res = await post(conn.shopDomain, await resolveToken(conn), body);
  // A 401 means the cached app token was revoked/expired early; force a fresh
  // exchange and retry once. Static-token connections can't recover this way.
  if (res.status === 401 && conn.app) {
    res = await post(conn.shopDomain, await resolveToken(conn, true), body);
  }
  if (res.status === 429) {
    throw new Error('Shopify rate limited (429)');
  }
  if (!res.ok) {
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
}

// Cheap round-trip that proves the token works and the app has read scope.
// Used at connect time to confirm the connection before kicking off a backfill.
export async function verifyShopifyConnection(conn: ShopifyConnection): Promise<ShopInfo> {
  const data = await shopifyGraphQL<{ shop: ShopInfo }>(
    conn,
    `query { shop { name myshopifyDomain } }`,
  );
  return data.shop;
}

const BULK_RUN = `
mutation bulkRun($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const BULK_POLL = `
query {
  currentBulkOperation {
    id status errorCode objectCount url
  }
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Bulk Operation query, poll to completion, download the JSONL result,
 * and return one parsed object per line. Returns [] when the store has no
 * matching data (Shopify yields a null url in that case).
 *
 * Only one bulk operation can run per shop at a time; callers must serialize.
 */
export async function runBulkQuery(conn: ShopifyConnection, bulkQuery: string): Promise<any[]> {
  const start = await shopifyGraphQL<{
    bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: any[] };
  }>(conn, BULK_RUN, { query: bulkQuery });

  const errs = start.bulkOperationRunQuery.userErrors;
  if (errs?.length) throw new Error(`bulkOperationRunQuery userErrors: ${JSON.stringify(errs)}`);
  if (!start.bulkOperationRunQuery.bulkOperation) throw new Error('bulk operation did not start');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let url: string | null = null;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await shopifyGraphQL<{
      currentBulkOperation: { status: string; errorCode: string | null; url: string | null } | null;
    }>(conn, BULK_POLL);
    const op = poll.currentBulkOperation;
    if (!op) throw new Error('no current bulk operation while polling');
    if (op.status === 'COMPLETED') {
      url = op.url;
      break;
    }
    if (op.status === 'FAILED' || op.errorCode) {
      throw new Error(`bulk operation failed: ${op.errorCode ?? op.status}`);
    }
    if (Date.now() > deadline) throw new Error('bulk operation timed out');
  }

  if (!url) return []; // no rows matched
  return downloadJsonl(url);
}

export async function downloadJsonl(url: string): Promise<any[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bulk download HTTP ${res.status}`);
  const text = await res.text();
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) out.push(JSON.parse(trimmed));
  }
  return out;
}
