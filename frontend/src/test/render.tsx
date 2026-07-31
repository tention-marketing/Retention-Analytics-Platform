import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { AppProviders } from '@/app/providers';

/**
 * A QueryClient built for tests: retries and background refetching off, so a
 * case asserting an error state sees it immediately instead of waiting out a
 * backoff, and one case's cache can never satisfy another's query.
 */
export function createTestQueryClient(
  overrides: { gcTime?: number; staleTime?: number; retry?: boolean } = {},
): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: overrides.retry ?? false,
        // gcTime 0 by default keeps cases isolated, but it also evicts any
        // observer-less entry the instant it is written — so a test asserting
        // that a cache clear removed unrelated data must raise it, or the data
        // will have vanished on its own and the assertion proves nothing.
        gcTime: overrides.gcTime ?? 0,
        staleTime: overrides.staleTime ?? 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

/** A client that retains observer-less data, for cache-clearing assertions. */
export function createRetainingQueryClient(): QueryClient {
  return createTestQueryClient({ gcTime: Infinity });
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entry for the MemoryRouter. */
  route?: string;
  /** Router location state, for exercising redirect return paths. */
  routeState?: unknown;
  queryClient?: QueryClient;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
}

/** Render inside the real providers, with an in-memory router. */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', routeState, queryClient, ...options }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const client = queryClient ?? createTestQueryClient();
  const user = userEvent.setup();
  const entry = routeState === undefined ? route : { pathname: route, state: routeState };

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders queryClient={client}>
        <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
      </AppProviders>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient: client, user };
}
