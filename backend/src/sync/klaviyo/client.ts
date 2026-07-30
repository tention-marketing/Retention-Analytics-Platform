import { config } from '../../config.js';

/**
 * Klaviyo API client — read-only, revision 2026-07-15 (§4.2).
 *
 *   Auth:     Authorization: Klaviyo-API-Key <private key>
 *   Revision: revision: 2026-07-15   (newest STABLE; never a `.pre` beta)
 *   Base:     https://a.klaviyo.com
 *
 * TWO PAGINATION CONVENTIONS live side by side, which is why the list and report
 * helpers are separate functions:
 *   * list endpoints (/api/campaigns, /api/flows, /api/profiles, /api/metrics)
 *     take `page[cursor]` and return `links.next` as a fully-qualified URL;
 *   * report endpoints (POST /api/*-values-reports) take a flat `page_cursor`
 *     query param.
 * Both are handled by following `links.next` verbatim when present, which works
 * for either convention because Klaviyo embeds the right cursor param in it.
 *
 * RATE LIMITS are per-endpoint burst/steady, and the two report endpoints add a
 * hard ceiling of 225 requests/DAY (1/s burst, 2/min steady). That ceiling is
 * the reason poller.ts issues exactly ONE grouped report call per object type
 * instead of one call per campaign — see the comment there.
 *
 * 429 handling mirrors the Recharge client (§8 trap 7): honour Retry-After, back
 * off, never drop silently.
 */

export interface KlaviyoConnection {
  apiKey: string;
}

const BASE = 'https://a.klaviyo.com';
const MAX_429_RETRIES = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Timing knobs are read lazily from env rather than frozen at module load so the
// fixture verification can zero them out and run offline in milliseconds. In
// production nothing sets these and the real defaults apply.
const backoffMs = () => Number(process.env.KLAVIYO_BACKOFF_MS ?? 2000);
// Report endpoints allow 2/min steady. Pace consecutive report pages so a
// multi-page report cannot trip the limiter in the first place.
const reportIntervalMs = () => Number(process.env.KLAVIYO_REPORT_MIN_INTERVAL_MS ?? 30_000);

/**
 * Scrub anything key-shaped out of text before it can reach a log line, an
 * Error message, or the sync_errors table. The key only ever travels in a
 * request header, so this is belt-and-braces — but "never print the private
 * key" deserves a guarantee at the boundary rather than a convention.
 */
export function redactKey(text: string): string {
  return text
    .replace(/\bpk_[A-Za-z0-9_-]+/g, 'pk_***REDACTED***')
    .replace(/(Klaviyo-API-Key\s+)\S+/gi, '$1***REDACTED***');
}

function headers(conn: KlaviyoConnection): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${conn.apiKey}`,
    revision: config.klaviyoApiRevision,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };
}

function buildUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path.startsWith('http') ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

/** One request, with 429 backoff. `url` may be absolute (a links.next value). */
async function request<T = any>(
  conn: KlaviyoConnection,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: headers(conn),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(`Klaviyo rate limited (429): retries exhausted for ${method} ${redactKey(url)}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffMs() * (attempt + 1); // linear backoff fallback
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      // Klaviyo error bodies do not echo credentials, but redact regardless.
      throw new Error(
        `Klaviyo ${method} ${redactKey(url)} HTTP ${res.status}: ${redactKey(await res.text())}`,
      );
    }
    return (await res.json()) as T;
  }
}

export interface PagedResult<T> {
  items: T[];
  pagesFetched: number;
  /** True when a page budget stopped the walk before `links.next` ran out. */
  truncated: boolean;
}

/**
 * Walk every page of a JSON:API list endpoint, following `links.next`.
 * `maxPages` bounds the walk (used by the identity scan's page budget); when the
 * budget runs out the result is flagged `truncated` so callers can report a
 * PARTIAL measurement rather than a false-precision rate.
 */
export async function fetchAllPages<T = any>(
  conn: KlaviyoConnection,
  path: string,
  params: Record<string, string> = {},
  maxPages = Number.POSITIVE_INFINITY,
): Promise<PagedResult<T>> {
  const items: T[] = [];
  let url: string | null = buildUrl(path, params);
  let pagesFetched = 0;

  while (url) {
    const page: Record<string, any> = await request(conn, 'GET', url);
    items.push(...((page.data as T[]) ?? []));
    pagesFetched += 1;
    const next: string | null = page.links?.next ?? null;
    if (!next) return { items, pagesFetched, truncated: false };
    if (pagesFetched >= maxPages) return { items, pagesFetched, truncated: true };
    url = next;
  }
  return { items, pagesFetched, truncated: false };
}

/** A single row of a values-report: which groupings it covers + its statistics. */
export interface ReportResultRow {
  groupings: Record<string, string>;
  statistics: Record<string, number>;
}

/**
 * POST a values-report and follow its pages. Consecutive requests are paced to
 * stay under the 2/min steady limit; the caller is responsible for making as few
 * of these calls as possible (see poller.ts).
 */
export async function fetchReport(
  conn: KlaviyoConnection,
  path: string,
  body: unknown,
): Promise<{ results: ReportResultRow[]; pagesFetched: number }> {
  const results: ReportResultRow[] = [];
  let url: string | null = buildUrl(path);
  let pagesFetched = 0;

  while (url) {
    if (pagesFetched > 0) await sleep(reportIntervalMs());
    const page: Record<string, any> = await request(conn, 'POST', url, body);
    const rows = (page.data?.attributes?.results as ReportResultRow[]) ?? [];
    results.push(...rows);
    pagesFetched += 1;
    url = page.links?.next ?? null;
  }
  return { results, pagesFetched };
}

/**
 * Cheap credential check used at connect time. Verified against revision
 * 2026-07-15: GET /api/accounts is still the correct endpoint (scope
 * `accounts:read`) and returns exactly one account object.
 */
export async function verifyKlaviyoConnection(
  conn: KlaviyoConnection,
): Promise<{ id: string | null; name: string | null }> {
  const data = await request<{ data?: any[] }>(conn, 'GET', buildUrl('/api/accounts'));
  const account = data.data?.[0];
  const contact = account?.attributes?.contact_information;
  return {
    id: account?.id ?? null,
    name: contact?.organization_name ?? contact?.default_sender_name ?? null,
  };
}
