/**
 * Dark mode — the CONTROL (`src/components/ThemeToggle.tsx`).
 *
 * `theme.test.ts` proves the store flips what it is told to flip. What it
 * cannot prove is that the control TELLS it: a radiogroup whose buttons lose
 * their `onClick`, whose `aria-checked` stops tracking the store, or whose
 * roving tabindex leaves three tab stops behind is a control that looks right
 * in a screenshot and is broken for everyone who is not using a mouse.
 *
 * Before this file the toggle's semantics were only ever checked by
 * `evidence/dark-mode-verify.cjs` — a script a human runs by hand and CI never
 * touches. That is not a gate, and the dark-mode suite exists because
 * ungated dark-mode behaviour keeps regressing (`t_fbf590fa`).
 *
 * Run: cd webapp && npx vitest run src/components/ThemeToggle.test.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** jsdom answers `false` for every media feature: pin the OS answer here. */
function fakeMatchMedia(dark: boolean) {
  const query = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = (() => query as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;

/** Fresh store + fresh component module over a clean document. */
async function mountToggle(osDark = false) {
  vi.resetModules();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.querySelector('meta[name="theme-color"]')?.remove();
  fakeMatchMedia(osDark);

  const [{ default: ThemeToggle }, theme] = await Promise.all([
    import('./ThemeToggle'),
    import('@/lib/theme'),
  ]);
  render(<ThemeToggle />);
  return theme;
}

const radio = (name: string) => screen.getByRole('radio', { name });

/**
 * Warm the module graph OUTSIDE the per-test timeout. The first dynamic
 * import of the component pays Vite's transform cost for its whole dependency
 * chain (i18n, lucide, the store) — ~5s on a cold run, which is exactly the
 * default test timeout. Paying it in a test does not "fail" that test so much
 * as strand a rendered tree in the DOM for the next one (the await resumes
 * after the timeout fires), which is how a one-tab-stop assertion started
 * seeing two.
 */
beforeAll(async () => {
  await import('./ThemeToggle');
}, 60_000);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe('ThemeToggle — the radiogroup contract', () => {
  it('renders a labelled group of three options with exactly one checked', async () => {
    await mountToggle();

    const group = screen.getByTestId('theme-toggle');
    expect(group).toHaveAttribute('role', 'radiogroup');
    expect(group).toHaveAttribute('aria-label', 'Theme');
    // The group reports its own state, which is what lets the e2e spec assert
    // the MODE (`system`) separately from the painted theme (`dark`).
    expect(group).toHaveAttribute('data-theme-mode', 'system');

    expect(screen.getAllByRole('radio').map((el) => el.textContent)).toEqual([
      'Light',
      'Dark',
      'System',
    ]);
    expect(radio('System')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Light')).toHaveAttribute('aria-checked', 'false');
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'false');
  });

  it('is ONE tab stop — only the checked radio is reachable by Tab', async () => {
    await mountToggle();

    // Three tab stops behind one setting means every keyboard user tabs past
    // the same decision three times.
    const stops = screen.getAllByRole('radio').filter((el) => el.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveTextContent('System');
  });
});

describe('ThemeToggle — clicking flips the painted attribute', () => {
  it('Dark: the click reaches the store, the DOM and storage', async () => {
    await mountToggle(false); // the OS prefers light, so the click is the cause

    await userEvent.click(radio('Dark'));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-theme-mode', 'dark');
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Light')).toHaveAttribute('aria-checked', 'false');
    expect(radio('System')).toHaveAttribute('aria-checked', 'false');
  });

  it('Light: and back again, with the tab stop following the selection', async () => {
    await mountToggle(true); // the OS prefers dark

    await userEvent.click(radio('Light'));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('theme')).toBe('light');
    const stops = screen.getAllByRole('radio').filter((el) => el.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveTextContent('Light');
  });

  it('System: paints the OS answer but stores the mode', async () => {
    await mountToggle(true);

    await userEvent.click(radio('Light'));
    await userEvent.click(radio('System'));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('system');
  });
});

describe('ThemeToggle — the keyboard moves the selection, not just focus', () => {
  it('arrows step through the options and flip the theme with them', async () => {
    await mountToggle(false);
    radio('System').focus(); // the group's single tab stop

    // From System, Right wraps to Light.
    await userEvent.keyboard('{ArrowRight}');
    expect(radio('Light')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Light')).toHaveFocus();
    expect(document.documentElement.dataset.theme, 'moving selection repaints').toBe('light');

    await userEvent.keyboard('{ArrowDown}');
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true');
    expect(window.localStorage.getItem('theme')).toBe('dark');

    await userEvent.keyboard('{ArrowLeft}');
    expect(radio('Light')).toHaveAttribute('aria-checked', 'true');
  });

  it('Home and End jump to the ends', async () => {
    await mountToggle(false);
    radio('System').focus();

    await userEvent.keyboard('{Home}');
    expect(radio('Light')).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{End}');
    expect(radio('System')).toHaveAttribute('aria-checked', 'true');
    expect(window.localStorage.getItem('theme')).toBe('system');
  });

  it('an unrelated key changes nothing', async () => {
    await mountToggle(false);
    radio('System').focus();

    await userEvent.keyboard('{Enter}x');
    await userEvent.keyboard('a');

    expect(radio('System')).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });
});
