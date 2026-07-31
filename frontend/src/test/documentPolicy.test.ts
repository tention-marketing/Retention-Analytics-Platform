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

  it('parses no URL fragment — onboarding tokens are Phase 5C and not handled here', () => {
    for (const [path, code] of sourceEntries()) {
      expect(code, path).not.toMatch(/location\.hash/);
      expect(code, path).not.toMatch(/#token=/);
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
