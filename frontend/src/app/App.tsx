import { BrowserRouter } from 'react-router';
import { AppProviders } from './providers';
import { AppRoutes } from '@/routes/router';

/**
 * Application root.
 *
 * The router lives here rather than inside AppRoutes so tests can mount the
 * route table under a MemoryRouter without a nested-router conflict.
 */
export function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}
