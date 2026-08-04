import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { AppShell } from '@/layouts/AppShell';
import { renderWithProviders } from '@/test/render';

// Long enough to overflow a 390px header, which is the regression this suite
// guards. Synthetic and non-routable: .invalid can never resolve. Deliberately
// hyphen-free — a hyphenated address offers Chromium a line-break opportunity
// and wraps instead of overflowing, so it would not reproduce the bug.
const LONG_EMAIL = 'alexandra.beaumontfitzgerald@averylongagencydomainname.example.invalid';
const SHORT_EMAIL = 'ops@example.invalid';

function renderShell(email: string, route = '/') {
  return renderWithProviders(
    <AppShell user={{ id: 4242, email }}>
      <h1>Page body</h1>
    </AppShell>,
    { route },
  );
}

/** The header row holding the identity and the sign-out control. */
function identityRow(): HTMLElement {
  const button = screen.getByRole('button', { name: 'Sign out' });
  const row = button.closest('div')?.parentElement;
  if (!row) throw new Error('Could not locate the identity row.');
  return row;
}

describe('the signed-in identity stays visible', () => {
  it.each([
    ['a short address', SHORT_EMAIL],
    ['a long address', LONG_EMAIL],
  ])('renders %s in full in the document', (_label, email) => {
    renderShell(email);
    expect(screen.getByText(email)).toBeInTheDocument();
  });

  it('keeps the "Signed in as" prefix for assistive technology', () => {
    renderShell(LONG_EMAIL);
    // Truncation is visual only: the whole address remains readable text, so a
    // screen reader still announces the full identity.
    const identity = screen.getByText(LONG_EMAIL);
    expect(identity).toHaveTextContent(`Signed in as ${LONG_EMAIL}`);
  });

  it('exposes the full address in a title for pointer users', () => {
    renderShell(LONG_EMAIL);
    expect(screen.getByTitle(LONG_EMAIL)).toHaveTextContent(LONG_EMAIL);
  });
});

describe('the header cannot be widened past the viewport by a long email', () => {
  // jsdom applies no Tailwind CSS, so the contract is asserted at the class
  // level. These four tokens ARE the fix; deleting any one of them brings the
  // ~2px horizontal document overflow at 390px straight back.

  it('lets the identity row shrink below its content width', () => {
    renderShell(LONG_EMAIL);
    expect(identityRow().classList.contains('min-w-0')).toBe(true);
  });

  it('lets the email shrink and ellipsize instead of pushing the row wider', () => {
    renderShell(LONG_EMAIL);
    const identity = screen.getByText(LONG_EMAIL);
    expect(identity.classList.contains('min-w-0')).toBe(true);
    expect(identity.classList.contains('truncate')).toBe(true);
  });

  it('never lets the sign-out button absorb the shrink', () => {
    renderShell(LONG_EMAIL);
    const wrapper = screen.getByRole('button', { name: 'Sign out' }).parentElement;
    expect(wrapper?.classList.contains('shrink-0')).toBe(true);
  });

  it('applies the same treatment regardless of address length', () => {
    renderShell(SHORT_EMAIL);
    // No length-conditional styling: one layout, so a short email cannot mask a
    // missing class that a long one would expose.
    expect(screen.getByText(SHORT_EMAIL).classList.contains('truncate')).toBe(true);
    expect(identityRow().classList.contains('min-w-0')).toBe(true);
  });
});

describe('sign-out remains reachable', () => {
  it('renders an enabled button in the header', () => {
    renderShell(LONG_EMAIL);
    const button = screen.getByRole('button', { name: 'Sign out' });
    expect(button).toBeEnabled();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('is keyboard reachable', async () => {
    const { user } = renderShell(LONG_EMAIL);
    const button = screen.getByRole('button', { name: 'Sign out' });
    // Tab order: skip link, the two nav links, then sign-out. Focusing it by
    // keyboard proves the truncation wrapper did not remove it from the flow.
    button.focus();
    expect(button).toHaveFocus();
    await user.tab();
    expect(button).not.toHaveFocus();
  });
});

describe('navigation is unchanged', () => {
  it('keeps the labelled nav landmark with both built routes', () => {
    renderShell(SHORT_EMAIL);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Home', 'Accounts']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/', '/accounts']);
  });

  it.each([
    ['/', 'Home'],
    ['/accounts', 'Accounts'],
  ])('marks the link for %s as the current page', (route, label) => {
    renderShell(SHORT_EMAIL, route);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    const other = label === 'Home' ? 'Accounts' : 'Home';
    expect(within(nav).getByRole('link', { name: other })).not.toHaveAttribute('aria-current');
  });
});

describe('nothing else about the shell changed', () => {
  it('renders the product identity', () => {
    renderShell(SHORT_EMAIL);
    expect(screen.getByText('Tention Pulse')).toBeInTheDocument();
    expect(screen.getByText('Agency workspace')).toBeInTheDocument();
  });

  it('keeps the skip link pointed at the main landmark', () => {
    renderShell(SHORT_EMAIL);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('renders its children inside main', () => {
    renderShell(SHORT_EMAIL);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Page body' })).toBeInTheDocument();
  });

  it('shows no sign-out error before one occurs', () => {
    renderShell(SHORT_EMAIL);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
