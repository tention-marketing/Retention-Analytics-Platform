import { describe, expect, it } from 'vitest';
// The real index.html, imported through Vite's ?raw loader rather than node:fs
// so this suite needs no Node type globals leaking into the app tsconfig.
import indexHtml from '../../index.html?raw';

// Document-level security policies are declared in index.html, which no
// component test would ever load. These assertions read the real file, so
// deleting the meta tag fails the suite rather than silently shipping.

describe('document security policy', () => {
  it('declares Referrer-Policy: no-referrer via a meta referrer tag', () => {
    expect(indexHtml).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/);
  });

  it('sets no weaker referrer policy anywhere in the document', () => {
    const policies = [...indexHtml.matchAll(/name="referrer"\s+content="([^"]+)"/g)].map((m) => m[1]);
    expect(policies).toEqual(['no-referrer']);
  });

  it('registers no service worker, which could outlive a logout with cached data', () => {
    expect(indexHtml).not.toContain('serviceWorker');
    expect(indexHtml).not.toContain('sw.js');
  });

  it('loads no third-party origin', () => {
    const urls = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const url of urls) {
      expect(url.startsWith('/')).toBe(true);
    }
  });

  it('contains no inline script', () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
  });
});

describe('source-level security discipline', () => {
  const sources = import.meta.glob('../**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' });

  /**
   * Strip comments before scanning.
   *
   * Without this the scan matches its own documentation: client.ts explains that
   * it never touches localStorage, and a naive grep counts that sentence as a
   * violation. The scan must look at code, not prose.
   */
  function stripComments(code: string): string {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // the [^:] guard spares "https://"
  }

  function sourceEntries(): [string, string][] {
    return Object.entries(sources)
      .filter(([path]) => !path.includes('.test.'))
      .map(([path, code]) => [path, stripComments(code as string)]);
  }

  it('never uses dangerouslySetInnerHTML', () => {
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('never touches localStorage, sessionStorage, or IndexedDB', () => {
    for (const [path, code] of sourceEntries()) {
      // The test harness itself asserts against these APIs; app code must not use them.
      if (path.includes('/test/')) continue;
      expect(code, path).not.toMatch(/\blocalStorage\b/);
      expect(code, path).not.toMatch(/\bsessionStorage\b/);
      expect(code, path).not.toMatch(/\bindexedDB\b/);
    }
  });

  it('never reads or writes document.cookie', () => {
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toMatch(/document\.cookie/);
    }
  });

  it('never registers a service worker', () => {
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toMatch(/navigator\.serviceWorker/);
    }
  });

  it('never sends useEnvCredentials', () => {
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toContain('useEnvCredentials: true');
    }
  });

  it('never reads a token out of the browser URL — that is the client wizard, not this app', () => {
    // Unchanged and non-negotiable. The agency app ISSUES setup links; it never
    // consumes one. Reading location.hash here would mean an agency session and
    // a client link token meeting inside the same page.
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toMatch(/location\.hash/);
    }
  });

  it('mentions the token fragment only where the minted URL is validated', () => {
    // `#token=` is now legitimate in exactly one place: the validator in
    // api/onboarding.ts that refuses a setup URL carrying its token anywhere
    // other than the fragment. Anywhere else it would be a hand-built link, and
    // a link this app assembled is a link the server did not issue.
    for (const [path, code] of sourceEntries()) {
      if (path.endsWith('/api/onboarding.ts')) continue;
      expect(code, path).not.toMatch(/#token=/);
    }
  });

  it('contains no literal that looks like a real setup token', () => {
    // A minted token is 32 bytes of base64url — exactly 43 unpadded characters.
    // A literal of that shape in source is either a real leaked credential or a
    // fixture realistic enough to be mistaken for one. Neither belongs here.
    //
    // Test files are scanned too: this is the rule that stops a debugging
    // session's real token from being pasted into an assertion.
    const tokenShaped = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;
    const all = Object.entries(sources).map(
      ([path, code]) => [path, stripComments(code as string)] as [string, string],
    );
    for (const [path, code] of all) {
      const match = tokenShaped.exec(code);
      // Report the path only. Printing the match would put the very thing this
      // test exists to catch into the CI log.
      expect(match === null, `${path} contains a 43-character token-shaped literal`).toBe(true);
    }
  });

  it('never persists a setup URL or token anywhere', () => {
    // Belt and braces over the storage tests above: the one-time URL lives in
    // component state only, so no source may hand it to a storage API, a query
    // key, or the address bar.
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toMatch(/history\.(?:push|replace)State/);
      expect(code, path).not.toMatch(/location\.(?:href|search)\s*=/);
    }
  });

  it('contains no console call in the API layer', () => {
    for (const [path, code] of sourceEntries()) {
      if (!path.includes('/api/')) continue;
      expect(code, path).not.toMatch(/console\.\w+\(/);
    }
  });

  // The backend now decides whether a login is allowed partly from Origin and
  // Sec-Fetch-Site. Those are browser-controlled forbidden header names: fetch
  // silently drops any attempt to set them, so spoofing cannot work — but code
  // that tries is code that misunderstands the control, and it would read as
  // though the frontend were asserting its own trustworthiness. The browser
  // generates them; this app never touches them.
  //
  // Matches a quoted object key or a setRequestHeader argument only, so
  // `window.location.origin` and `url.origin` are correctly ignored.
  const FORBIDDEN_HEADERS = ['origin', 'referer', 'referrer', 'host', 'sec-fetch-site',
    'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'] as const;

  it.each(FORBIDDEN_HEADERS)('never sets the browser-controlled "%s" header', (header) => {
    const asObjectKey = new RegExp(`['"\`]${header}['"\`]\\s*:`, 'i');
    const asSetHeader = new RegExp(`setRequestHeader\\s*\\(\\s*['"\`]${header}['"\`]`, 'i');
    const asHeadersApi = new RegExp(`\\.(?:set|append)\\s*\\(\\s*['"\`]${header}['"\`]`, 'i');
    for (const [path, code] of sourceEntries()) {
      expect(code, `${path} sets ${header}`).not.toMatch(asObjectKey);
      expect(code, `${path} sets ${header}`).not.toMatch(asSetHeader);
      expect(code, `${path} sets ${header}`).not.toMatch(asHeadersApi);
    }
  });

  it('sets only Accept and Content-Type in the API client', () => {
    const client = sourceEntries().find(([path]) => path.endsWith('/api/client.ts'))?.[1] ?? '';
    expect(client).not.toBe('');

    // Both forms the client uses: an object key (`Accept: '…'`) and a bracket
    // assignment (`headers['Content-Type'] = '…'`).
    const names = [
      ...[...client.matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z][\w-]*)):\s*['"`]/gm)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? ''),
      ...[...client.matchAll(/headers\[\s*['"`]([^'"`]+)['"`]\s*\]\s*=/g)].map((m) => m[1] ?? ''),
    ].map((n) => n.toLowerCase());

    expect(names).toContain('accept');
    expect(names).toContain('content-type');
    for (const forbidden of FORBIDDEN_HEADERS) {
      expect(names, `client.ts sets ${forbidden}`).not.toContain(forbidden);
    }
  });
});
