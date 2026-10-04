/**
 * Wave H item 8 — the crash state.
 *
 * Two failure paths must both land on the same screen:
 *   · a render error inside the tree (React error boundary), and
 *   · an error thrown from an event handler / async callback, which React
 *     boundaries never see and would otherwise only surface in the console.
 *
 * Plus the two things that make the screen useful to a human: a stable,
 * copyable incident id and a reset that actually recovers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppErrorBoundary, { incidentIdFor } from './AppErrorBoundary';

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('kaboom: the chart exploded');
  return <div data-testid="healthy-child">all good</div>;
}

beforeEach(() => {
  // React logs every caught render error; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('incidentIdFor', () => {
  it('is short, prefixed and stable for the same cause', () => {
    const a = incidentIdFor('TypeError:undefined is not a function');
    const b = incidentIdFor('TypeError:undefined is not a function');
    const c = incidentIdFor('RangeError:invalid array length');
    expect(a).toMatch(/^ERR-[0-9A-F]{6,}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('AppErrorBoundary', () => {
  it('renders children untouched when nothing is wrong', () => {
    render(
      <AppErrorBoundary>
        <Bomb explode={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).toBeInTheDocument();
    expect(screen.queryByTestId('crash-screen')).not.toBeInTheDocument();
  });

  it('turns a render error into a readable screen with an id, not a blank frame', () => {
    render(
      <AppErrorBoundary>
        <Bomb explode />
      </AppErrorBoundary>,
    );

    const crash = screen.getByTestId('crash-screen');
    expect(crash).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('heading', { name: /something broke/i })).toBeInTheDocument();
    // The promise a panicking user needs: their readings are untouched.
    expect(crash).toHaveTextContent(/readings were not touched/i);
    // The id is on screen and selectable.
    expect(screen.getByTestId('crash-id').textContent).toMatch(/^ERR-[0-9A-F]+/);
    expect(screen.getByTestId('crash-detail')).toHaveTextContent(/kaboom/);
    // The app tree is gone — no half-rendered dashboard behind it.
    expect(screen.queryByTestId('healthy-child')).not.toBeInTheDocument();
  });

  it('gives the same cause the same id, so two reports can be matched', () => {
    const first = render(
      <AppErrorBoundary>
        <Bomb explode />
      </AppErrorBoundary>,
    );
    const id = screen.getByTestId('crash-screen').getAttribute('data-incident-id');
    first.unmount();

    render(
      <AppErrorBoundary>
        <Bomb explode />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('crash-screen').getAttribute('data-incident-id')).toBe(id);
  });

  it('recovers when Try again re-mounts a healthy tree', async () => {
    const { rerender } = render(
      <AppErrorBoundary>
        <Bomb explode />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('crash-screen')).toBeInTheDocument();

    // The underlying cause is fixed; only the reset can get us back there.
    rerender(
      <AppErrorBoundary>
        <Bomb explode={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('crash-screen')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('crash-reset'));

    await waitFor(() => {
      expect(screen.getByTestId('healthy-child')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('crash-screen')).not.toBeInTheDocument();
  });

  it('copies the incident id for a bug report', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(
      <AppErrorBoundary>
        <Bomb explode />
      </AppErrorBoundary>,
    );
    const id = screen.getByTestId('crash-id').textContent || '';

    await userEvent.click(screen.getByTestId('crash-copy'));

    expect(writeText).toHaveBeenCalledWith(id);
    await waitFor(() => {
      expect(screen.getByTestId('crash-copy')).toHaveTextContent(/copied/i);
    });
  });

  it('catches an uncaught runtime error that React boundaries never see', async () => {
    render(
      <AppErrorBoundary>
        <Bomb explode={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).toBeInTheDocument();

    // e.g. thrown inside an onClick handler — nothing in the tree throws.
    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', {
          message: 'handler blew up',
          error: new TypeError('handler blew up'),
        }),
      );
    });

    const crash = await screen.findByTestId('crash-screen');
    expect(crash).toHaveTextContent(/runtime error/i);
    expect(screen.getByTestId('crash-detail')).toHaveTextContent(/handler blew up/);
    expect(screen.queryByTestId('healthy-child')).not.toBeInTheDocument();
  });

  it('catches an unhandled promise rejection too', async () => {
    render(
      <AppErrorBoundary>
        <Bomb explode={false} />
      </AppErrorBoundary>,
    );

    act(() => {
      window.dispatchEvent(new Event('unhandledrejection'));
    });

    const crash = await screen.findByTestId('crash-screen');
    expect(crash).toHaveTextContent(/runtime error/i);
    expect(screen.getByTestId('crash-detail').textContent).toBeTruthy();
  });

  it('does not repaint over an error it is already showing', async () => {
    render(
      <AppErrorBoundary>
        <Bomb explode />
      </AppErrorBoundary>,
    );
    const id = screen.getByTestId('crash-screen').getAttribute('data-incident-id');

    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'second error', error: new Error('second error') }),
      );
    });

    expect(screen.getByTestId('crash-screen').getAttribute('data-incident-id')).toBe(id);
    expect(screen.getByTestId('crash-detail')).toHaveTextContent(/kaboom/);
  });
});
