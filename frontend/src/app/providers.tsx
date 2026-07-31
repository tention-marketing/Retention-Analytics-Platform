import { useState, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';

interface AppProvidersProps {
  children: ReactNode;
  /** Injected by tests so each case gets an isolated cache. */
  queryClient?: QueryClient;
}

/**
 * Cross-cutting providers.
 *
 * The client is created in state rather than at module scope so a test (or a
 * future logout that recreates it) gets a genuinely fresh cache instead of one
 * shared across the whole process.
 */
export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
