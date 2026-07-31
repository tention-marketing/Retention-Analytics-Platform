import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetCalls } from './server';

// Global test setup.
//
// cleanup() unmounts every tree between cases so a leaked component cannot keep
// a query subscription (or a timer) alive into the next test and make failures
// depend on file order.

beforeEach(() => {
  resetCalls();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom implements neither of these, and both are read by components under test.
if (!window.matchMedia) {
  window.matchMedia = ((queryString: string) => ({
    matches: false,
    media: queryString,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
