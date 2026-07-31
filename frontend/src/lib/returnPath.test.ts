import { describe, expect, it } from 'vitest';
import { isSafeReturnPath, safeReturnPath, toReturnPath } from './returnPath';

describe('safe internal return paths', () => {
  it.each([
    '/',
    '/accounts',
    '/accounts/5',
    '/accounts/5/onboarding',
    '/accounts?filter=active',
    '/accounts/5?tab=links',
  ])('accepts the internal path %s', (path) => {
    expect(isSafeReturnPath(path)).toBe(true);
    expect(safeReturnPath(path)).toBe(path);
  });
});

describe('unsafe return paths are rejected', () => {
  it.each([
    ['an absolute https URL', 'https://evil.example/steal'],
    ['an absolute http URL', 'http://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a backslash authority', '/\\evil.example/steal'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a vbscript: URL', 'vbscript:msgbox(1)'],
    ['a file: URL', 'file:///etc/passwd'],
    ['a bare hostname', 'evil.example'],
    ['a relative path', 'accounts'],
    ['an empty string', ''],
    ['a newline-smuggled authority', '/\n//evil.example'],
    ['a tab-smuggled authority', '/\t/evil.example'],
    ['a carriage-return smuggle', '/\r//evil.example'],
    ['a NUL byte', '/accounts\u0000'],
  ])('rejects %s', (_label, path) => {
    expect(isSafeReturnPath(path)).toBe(false);
    expect(safeReturnPath(path)).toBe('/');
  });

  it.each([undefined, null, 42, {}, [], true])('rejects the non-string %s', (value) => {
    expect(isSafeReturnPath(value)).toBe(false);
    expect(safeReturnPath(value)).toBe('/');
  });

  it('refuses /login, which would be a redirect loop', () => {
    expect(isSafeReturnPath('/login')).toBe(false);
    expect(safeReturnPath('/login')).toBe('/');
  });

  it('honours an explicit fallback', () => {
    expect(safeReturnPath('https://evil.example', '/accounts')).toBe('/accounts');
  });
});

describe('toReturnPath', () => {
  it('captures pathname and search together', () => {
    expect(toReturnPath({ pathname: '/accounts/5', search: '?tab=links' }))
      .toBe('/accounts/5?tab=links');
  });

  it('falls back to / for the login page itself', () => {
    expect(toReturnPath({ pathname: '/login', search: '' })).toBe('/');
  });
});
