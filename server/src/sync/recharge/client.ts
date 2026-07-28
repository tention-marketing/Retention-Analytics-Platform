import { config } from '../../config.js';

// Recharge Admin API client (2021-11). Read-only.
//   Auth:    X-Recharge-Access-Token: <token>
//   Version: X-Recharge-Version: 2021-11
//   Base:    https://api.rechargeapps.com
// List endpoints are cursor-paginated: the response carries `next_cursor`, and
// follow-up requests may ONLY send `cursor` + `limit` (all other filters are
// rejected once a cursor is in play). Rate limit is a leaky bucket that returns
// 429 with a Retry-After header (§8 trap 7: back off, never drop silently).

export interface RechargeConnection {
  token: string;
}

const BASE = 'https://api.rechargeapps.com';
export const MAX_LIMIT = 250;
const MAX_429_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

async function rechargeGet<T = any>(
  conn: RechargeConnection,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(buildUrl(path, params), {
      method: 'GET',
      headers: {
        'X-Recharge-Access-Token': conn.token,
        'X-Recharge-Version': config.rechargeApiVersion,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) throw new Error('Recharge rate limited (429): retries exhausted');
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : DEFAULT_BACKOFF_MS * (attempt + 1); // linear backoff fallback
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Recharge GET ${path} HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Fetch every page of a list resource and concatenate the arrays under `key`.
 * `filters` apply to the first request only; subsequent pages follow the cursor.
 */
export async function fetchAllPages<T = any>(
  conn: RechargeConnection,
  resource: string,
  key: string,
  filters: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  let params: Record<string, string> = { ...filters, limit: String(MAX_LIMIT) };
  for (;;) {
    const page = await rechargeGet<Record<string, any>>(conn, `/${resource}`, params);
    const items = (page[key] as T[]) ?? [];
    out.push(...items);
    const next: string | null = page.next_cursor ?? null;
    if (!next) break;
    // Cursor requests must not carry the original filters.
    params = { cursor: next, limit: String(MAX_LIMIT) };
  }
  return out;
}

// Cheap credential check used at connect time.
export async function verifyRechargeConnection(conn: RechargeConnection): Promise<{ name: string | null }> {
  const data = await rechargeGet<{ store?: { name?: string } }>(conn, '/store');
  return { name: data.store?.name ?? null };
}
