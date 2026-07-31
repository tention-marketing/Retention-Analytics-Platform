import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { AppRoutes } from './router';
import { renderWithProviders } from '@/test/render';
import { calls, stubFetchRoutes, type RouteStub } from '@/test/server';

// Route-table shape. The behaviour of each guard state lives in
// features/auth/guards.test.tsx; this file is about which routes exist, which
// zone they belong to, and what the table refuses to expose.

const EMAIL = 'synthetic.agent@example.invalid';
const ME = 'GET /api/auth/me';
const SIGNED_IN: RouteStub = { status: 200, json: { id: 4242, email: EMAIL } };
const SIGNED_OUT: RouteStub = { status: 401, json: { error: 'unauthorized' } };

function renderAt(route: string, me: RouteStub) {
  stubFetchRoutes({ [ME]: me });
  return renderWithProviders(<AppRoutes />, { route });
}

describe('the public zone', () => {
  it('serves /login to a signed-out visitor', async () => {
    renderAt('/login', SIGNED_OUT);
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('is the only route reachable while signed out', async () => {
    renderAt('/', SIGNED_OUT);
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
  });
});

describe('the protected zone', () => {
  it('serves the agency home at /', async () => {
    renderAt('/', SIGNED_IN);
    expect(await screen.findByRole('heading', { name: 'Agency home' })).toBeInTheDocument();
  });

  it('renders unknown routes as a not-found page inside the shell', async () => {
    renderAt('/no-such-route', SIGNED_IN);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('gives the not-found page a route home without listing what exists', async () => {
    renderAt('/no-such-route', SIGNED_IN);
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(screen.getByRole('link', { name: 'Return to agency home' })).toHaveAttribute('href', '/');
    const main = screen.getByRole('main');
    expect(main).not.toHaveTextContent('/accounts');
    expect(main).not.toHaveTextContent('/login');
  });

  it('shows no invented metrics, totals, or provider state', async () => {
    renderAt('/', SIGNED_IN);
    await screen.findByRole('heading', { name: 'Agency home' });
    const main = screen.getByRole('main');
    for (const invented of [
      'Revenue', 'RCM', 'Churn', 'Tier', 'Shopify', 'Klaviyo', 'Recharge',
      'accounts connected', 'Total', 'customers',
    ]) {
      expect(main).not.toHaveTextContent(invented);
    }
  });

  it('states plainly that later features are not built', async () => {
    renderAt('/', SIGNED_IN);
    expect(await screen.findByRole('heading', { name: 'Not built yet' })).toBeInTheDocument();
  });
});

describe('the route table talks only to /api', () => {
  it('resolves authentication through the same-origin proxy prefix', async () => {
    renderAt('/', SIGNED_IN);
    await screen.findByRole('heading', { name: 'Agency home' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith('/api/')).toBe(true);
      expect(call.credentials).toBe('include');
    }
  });

  it('never calls a client-scoped onboarding route', async () => {
    renderAt('/', SIGNED_IN);
    await screen.findByRole('heading', { name: 'Agency home' });
    for (const call of calls) {
      expect(call.url.startsWith('/api/onboarding')).toBe(false);
    }
  });
});
