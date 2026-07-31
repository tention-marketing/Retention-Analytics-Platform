import { vi } from 'vitest';

// Minimal request stub.
//
// DELIBERATELY NOT MSW. The only thing under test at this checkpoint is the API
// client itself, and what those tests need to assert is the exact fetch call it
// makes — the URL, `credentials: 'include'`, the headers, the serialized body.
// A service-worker-based mock sits between the client and that assertion and
// normalizes some of it away. A ~60-line fetch double keeps the assertions
// direct, and adds no dependency.
//
// When a later checkpoint tests real feature flows against many endpoints at
// once, MSW becomes the better tool. It is not needed to test one function.

export interface StubResponse {
  status?: number;
  /** Serialized as JSON with a JSON content-type. */
  json?: unknown;
  /** Sent verbatim. Use to simulate HTML error pages or malformed JSON. */
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}

export const calls: RecordedCall[] = [];

function buildResponse(stub: StubResponse): Response {
  const status = stub.status ?? 200;
  const headers = new Headers(stub.headers ?? {});

  let body: string | null;
  if (stub.text !== undefined) {
    body = stub.text;
    if (!headers.has('content-type')) {
      headers.set('content-type', stub.contentType ?? 'text/plain');
    }
  } else if (stub.json !== undefined) {
    body = JSON.stringify(stub.json);
    headers.set('content-type', stub.contentType ?? 'application/json');
  } else {
    body = null;
  }

  // 204/205 must not carry a body, per the fetch spec.
  const bodyless = status === 204 || status === 205;
  return new Response(bodyless ? null : body, { status, headers });
}

function record(input: RequestInfo | URL, init: RequestInit | undefined): void {
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  calls.push({
    url: String(input),
    method: init?.method ?? 'GET',
    headers,
    body: typeof init?.body === 'string' ? init.body : null,
    credentials: init?.credentials,
    cache: init?.cache,
    redirect: init?.redirect,
    signal: init?.signal,
  });
}

/** Answer the next request(s) with a canned response. */
export function stubFetch(stub: StubResponse): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      return buildResponse(stub);
    }),
  );
}

/** Make fetch reject, as it does for DNS failure, offline, or a blocked request. */
export function stubFetchNetworkError(error: unknown = new TypeError('Failed to fetch')): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      throw error;
    }),
  );
}

/** Never settles until the caller's AbortSignal fires, then rejects like the platform. */
export function stubFetchNeverResolves(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    }),
  );
}

/** Answer each request with the next stub in sequence. */
export function stubFetchSequence(stubs: StubResponse[]): void {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      const stub = stubs[Math.min(index, stubs.length - 1)];
      index += 1;
      return buildResponse(stub ?? {});
    }),
  );
}

export function resetCalls(): void {
  calls.length = 0;
}

export function lastCall(): RecordedCall {
  const call = calls[calls.length - 1];
  if (!call) throw new Error('No fetch call was recorded.');
  return call;
}
