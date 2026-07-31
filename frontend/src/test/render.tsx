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
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entries for the MemoryRouter. */
  route?: string;
  queryClient?: QueryClient;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
}

/** Render inside the real providers, with an in-memory router. */
export function renderWithProviders(
  ui: ReactElement,
  { route = '/', queryClient, ...options }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const client = queryClient ?? createTestQueryClient();
  const user = userEvent.setup();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders queryClient={client}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </AppProviders>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient: client, user };
}
