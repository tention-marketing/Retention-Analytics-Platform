import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Alert } from './Alert';
import { Button } from './Button';
import { ErrorPanel } from './ErrorPanel';
import { LoadingSkeleton } from './LoadingSkeleton';
import { PageShell } from './PageShell';
import { apiErrorFromResponse, apiErrorFromThrown } from '@/api/errors';

const STACK_TRACE = 'TypeError: fetch failed\n    at request (/Users/deployuser/app/node_modules/undici/x.js:1:1)';

describe('Button', () => {
  it('renders a real button element, so the platform supplies keyboard behaviour', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInstanceOf(HTMLButtonElement);
  });

  it('defaults to type="button" so it cannot accidentally submit a form', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('activates with Enter', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates with Space', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exposes a disabled state that blocks activation', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button disabled onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('exposes a loading state that is busy, disabled, and labelled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button loading onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Working…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not mark an idle button as busy', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-busy');
  });
});

describe('Alert', () => {
  it('uses role="alert" for an error so it interrupts', () => {
    render(<Alert tone="error">Could not save.</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
  });

  it('uses role="status" for non-errors so it does not interrupt', () => {
    render(<Alert tone="success">Saved.</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('states the tone in text, so colour is never the only carrier of meaning', () => {
    render(<Alert tone="warning">Coverage is incomplete.</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Warning:');
  });

  it('renders an optional title alongside the body', () => {
    render(<Alert tone="info" title="Heads up">Details here.</Alert>);
    const alert = screen.getByRole('status');
    expect(alert).toHaveTextContent('Heads up');
    expect(alert).toHaveTextContent('Details here.');
  });
});

describe('LoadingSkeleton', () => {
  it('announces a pending state as text rather than as decorative bars', () => {
    render(<LoadingSkeleton label="Loading accounts…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading accounts…');
  });

  it('hides the placeholder bars from assistive technology', () => {
    const { container } = render(<LoadingSkeleton lines={3} />);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
  });
});

describe('ErrorPanel', () => {
  it('renders a normalized backend message', () => {
    render(<ErrorPanel error={apiErrorFromResponse(400, { message: 'ttlDays must be 1-90.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('ttlDays must be 1-90.');
  });

  it('never renders a stack trace supplied by the server', () => {
    render(<ErrorPanel error={apiErrorFromResponse(500, { message: STACK_TRACE })} />);
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent('at request');
    expect(alert).not.toHaveTextContent('/Users/');
    expect(alert).toHaveTextContent('The server could not complete this request.');
  });

  it('never renders a raw thrown Error message', () => {
    render(<ErrorPanel error={new Error(STACK_TRACE)} />);
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent('/Users/');
    expect(alert).toHaveTextContent('Something went wrong.');
  });

  it('shows the retry delay for a rate-limited request', () => {
    const error = apiErrorFromResponse(429, {}, new Headers({ 'retry-after': '45' }));
    render(<ErrorPanel error={error} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in 45 seconds.');
  });

  it('lists field errors when the backend supplied them', () => {
    const error = apiErrorFromResponse(400, { fieldErrors: { name: 'Name is required.' } });
    render(<ErrorPanel error={error} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('name: Name is required.');
  });

  it('offers retry only when the error is actually retryable', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorPanel error={apiErrorFromResponse(404, {})} onRetry={onRetry} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    rerender(<ErrorPanel error={apiErrorFromThrown(new TypeError('x'))} onRetry={onRetry} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('calls onRetry when retry is pressed', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorPanel error={apiErrorFromThrown(new TypeError('x'))} onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('logs nothing when rendering a failure', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<ErrorPanel error={apiErrorFromResponse(500, { message: STACK_TRACE })} />);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('PageShell', () => {
  it('provides a main landmark and a single h1', () => {
    render(<PageShell title="Accounts">content</PageShell>);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument();
  });

  it('provides a skip link as the first focusable element', async () => {
    const user = userEvent.setup();
    render(<PageShell title="Accounts">content</PageShell>);
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  });

  it('points the skip link at the main landmark', () => {
    render(<PageShell title="Accounts">content</PageShell>);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });
});
