import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { AppRoutes } from './router';
import { renderWithProviders } from '@/test/render';
import { calls, lastCall, stubFetch } from '@/test/server';

describe('routing', () => {
  it('renders the foundation page at /', () => {
    renderWithProviders(<AppRoutes />, { route: '/' });
    expect(screen.getByRole('heading', { level: 1, name: 'Frontend foundation ready' })).toBeInTheDocument();
  });

  it('renders the 404 page for an unknown route', () => {
    renderWithProviders(<AppRoutes />, { route: '/definitely-not-a-route' });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });

  it('renders 404 for a route that a later checkpoint will add', () => {
    // /accounts is planned but not built. It must 404 today rather than render
    // a placeholder that reads as a working page.
    renderWithProviders(<AppRoutes />, { route: '/accounts' });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });

  it('gives the 404 page a route home without listing what else exists', () => {
    renderWithProviders(<AppRoutes />, { route: '/nope' });
    const main = screen.getByRole('main');
    expect(screen.getByRole('link', { name: 'Return to the start page' })).toHaveAttribute('href', '/');
    expect(main).not.toHaveTextContent('/accounts');
    expect(main).not.toHaveTextContent('/login');
  });
});

describe('foundation page', () => {
  it('states that requests go through the /api prefix', () => {
    renderWithProviders(<AppRoutes />, { route: '/' });
    expect(screen.getAllByText(/\/api/).length).toBeGreaterThan(0);
  });

  it('shows no business data, statistics, or placeholder account', () => {
    renderWithProviders(<AppRoutes />, { route: '/' });
    const main = screen.getByRole('main');
    for (const forbidden of ['Acme', 'Revenue', 'RCM', 'Churn', 'customers', 'Tier']) {
      expect(main).not.toHaveTextContent(forbidden);
    }
  });

  it('issues no request until the connectivity check is pressed', () => {
    stubFetch({ json: { ok: true } });
    renderWithProviders(<AppRoutes />, { route: '/' });
    expect(calls).toHaveLength(0);
  });

  it('calls /api/health with credentials when the check is pressed', async () => {
    stubFetch({ json: { ok: true } });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/' });

    await user.click(screen.getByRole('button', { name: 'Check API connectivity' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(lastCall().url).toBe('/api/health');
    expect(lastCall().credentials).toBe('include');
    expect(await screen.findByText('Backend reachable')).toBeInTheDocument();
  });

  it('shows a safe error panel when the API is unreachable', async () => {
    stubFetch({ status: 500, json: { message: 'at /Users/deployuser/app/index.js' } });
    const { user } = renderWithProviders(<AppRoutes />, { route: '/' });

    await user.click(screen.getByRole('button', { name: 'Check API connectivity' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the API');
    expect(alert).not.toHaveTextContent('/Users/');
  });
});
