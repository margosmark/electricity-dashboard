/**
 * Wave M — banner visibility rules, end to end through the hook.
 *
 * The component itself only renders what it is handed, so the interesting
 * assertions are about WHEN it is handed something: a manual-upload-only
 * browser must get nothing, an acknowledged answer must not come back, the
 * first ever observation of a rate date must record a baseline in silence,
 * and page load must never go near `Notification.requestPermission()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, renderHook, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RefreshNoticeBanner from './RefreshNoticeBanner';
import { pushCoversNotice, useRefreshNotices } from '@/hooks/useRefreshNotices';
import {
  PLAN_ACK_KEY,
  RATE_ACK_KEY,
  NOTIFICATIONS_ENABLED_KEY,
  NOTIFIED_KEY,
  buildRefreshNotices,
} from '@/lib/backgroundRefresh';
import {
  calculateFullDataTotals,
  processRawData,
  type DataPoint,
  type ProcessedPoint,
  type RateSet,
} from '@/lib/energy';
import type { PlanId } from '@/hooks/useSelectedPlan';

const RATES_2024: RateSet = {
  effectiveDate: '2024-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 600, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};
const RATES_2025: RateSet = {
  ...RATES_2024,
  effectiveDate: '2025-11-01',
  tou: { offPeak: 10.2, midPeak: 16.1, onPeak: 21.0 },
  tiered: { ...RATES_2024.tiered, tier1: 12.6, tier2: 14.9 },
  ulo: { ...RATES_2024.ulo, overnight: 4.1 },
};
const RATE_HISTORY = [RATES_2024, RATES_2025];

function hourlyFrom(start: Date, days: number, kwhPerHour: number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, h, 0, 0);
      raw.push({ timestamp: Math.floor(dt.getTime() / 1000), usage_kwh: kwhPerHour });
    }
  }
  return processRawData(raw, RATE_HISTORY);
}

const June2025 = () => hourlyFrom(new Date(2025, 5, 1), 30, 1.5);
const Dec2025 = () => [...hourlyFrom(new Date(2025, 5, 1), 30, 1.5), ...hourlyFrom(new Date(2025, 11, 1), 3, 1.5)];

const otherPlans = (best: PlanId): PlanId[] =>
  (['Tiered', 'TOU', 'ULO'] as const).filter((p) => p !== best);

/** A controllable Notification API so we can prove nothing prompts on load. */
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
  static raised: string[] = [];
  constructor(public title: string) {
    FakeNotification.raised.push(title);
  }
}

beforeEach(() => {
  localStorage.clear();
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission.mockClear();
  FakeNotification.raised = [];
  vi.stubGlobal('Notification', FakeNotification);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- *
 * The component
 * -------------------------------------------------------------------------- */

describe('RefreshNoticeBanner', () => {
  const processed = June2025();
  const totals = calculateFullDataTotals(processed)!;
  const loser = otherPlans(totals.bestPlan)[0];

  const planNotice = buildRefreshNotices({
    connected: true,
    totals,
    processedData: processed,
    currentPlan: loser,
    ackPlan: null,
    ackRateDate: '2024-11-01',
  }).notices[0];

  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<RefreshNoticeBanner notices={[]} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('refresh-notice-banner')).not.toBeInTheDocument();
  });

  it('states the card’s headline and the gap against what the user is on', () => {
    render(<RefreshNoticeBanner notices={[planNotice]} onDismiss={() => {}} />);
    const banner = screen.getByTestId('refresh-notice-plan');
    expect(banner).toHaveAttribute('data-plan', totals.bestPlan);
    expect(banner).toHaveAttribute('data-previous-plan', planNotice.kind === 'plan-change' ? planNotice.previousBest : '');
    expect(screen.getByTestId('refresh-notice-headline')).toHaveTextContent('Your best plan changed');
    expect(screen.getByTestId('refresh-notice-headline')).toHaveTextContent(/now saves ~\$\d+\.\d{2}\/mo vs/);
    // The privacy tradeoff is printed where the user reads the banner.
    // State-free on purpose: the banner must not need the account state in
    // `Dashboard`, and the product has no email or SMS in ANY state.
    expect(screen.getByText(/no email or SMS/i)).toBeInTheDocument();
  });

  it('dismisses through the callback with the notice id', async () => {
    const onDismiss = vi.fn();
    render(<RefreshNoticeBanner notices={[planNotice]} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByTestId('refresh-notice-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith(planNotice.id);
  });

  it('renders the rate notice with both effective dates as data attributes', () => {
    const advanced = Dec2025();
    const result = buildRefreshNotices({
      connected: true,
      totals: calculateFullDataTotals(advanced),
      processedData: advanced,
      currentPlan: loser,
      ackPlan: totals.bestPlan,
      ackRateDate: '2024-11-01',
    });
    const rate = result.notices.find((n) => n.kind === 'rate-change');
    expect(rate).toBeDefined();

    render(<RefreshNoticeBanner notices={[rate!]} onDismiss={() => {}} />);
    const banner = screen.getByTestId('refresh-notice-rate');
    expect(banner).toHaveAttribute('data-effective-date', '2025-11-01');
    expect(banner).toHaveAttribute('data-previous-effective-date', '2024-11-01');
    expect(screen.getByTestId('refresh-notice-headline')).toHaveTextContent(
      'New OEB rates in effect — re-comparing your plans',
    );
  });

  it('stacks both, plan change first', () => {
    const advanced = Dec2025();
    const { notices } = buildRefreshNotices({
      connected: true,
      totals: calculateFullDataTotals(advanced),
      processedData: advanced,
      currentPlan: loser,
      ackPlan: null,
      ackRateDate: '2024-11-01',
    });
    expect(notices.map((n) => n.kind)).toEqual(['plan-change', 'rate-change']);

    render(<RefreshNoticeBanner notices={notices} onDismiss={() => {}} />);
    const kinds = Array.from(
      document.querySelectorAll('[data-testid="refresh-notice-plan"], [data-testid="refresh-notice-rate"]'),
    );
    expect(kinds.map((el) => el.getAttribute('data-testid'))).toEqual([
      'refresh-notice-plan',
      'refresh-notice-rate',
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * Visibility rules, through the hook
 * -------------------------------------------------------------------------- */

describe('useRefreshNotices visibility', () => {
  const processed = June2025();
  const totals = calculateFullDataTotals(processed)!;
  const loser = otherPlans(totals.bestPlan)[0];

  type HookProps = Parameters<typeof useRefreshNotices>[0];
  const makeProps = (overrides: Partial<HookProps> = {}): HookProps => ({
    connected: true,
    totals,
    processedData: processed,
    currentPlan: loser,
    refreshTick: 0,
    // No push subscription by default: every existing case is "the on-device
    // channel alone", which is what it was before the merge.
    pushTopics: [],
    ...overrides,
  });
  /** Renders the hook and hands back the props so a test can advance the tick. */
  const hook = (overrides: Partial<HookProps> = {}) => {
    const props = makeProps(overrides);
    return { ...renderHook((p: HookProps) => useRefreshNotices(p), { initialProps: props }), props };
  };

  it('shows the plan change on first sight for an authorised browser', () => {
    const { result } = hook();
    expect(result.current.notices).toHaveLength(1);
    expect(result.current.notices[0].kind).toBe('plan-change');
  });

  it('shows NOTHING to a manual-DMD-only browser, and writes no keys (scope 4)', () => {
    const { result } = hook({ connected: false });
    expect(result.current.notices).toEqual([]);
    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem(PLAN_ACK_KEY)).toBeNull();
    expect(localStorage.getItem(RATE_ACK_KEY)).toBeNull();
  });

  it('stays dismissed after the user acknowledges it', () => {
    const { result, rerender, props } = hook();

    act(() => result.current.dismiss(result.current.notices[0].id));
    expect(localStorage.getItem(PLAN_ACK_KEY)).toBe(totals.bestPlan);
    expect(result.current.notices).toEqual([]);

    // A later refresh (tick advanced) must not bring it back.
    rerender({ ...props, refreshTick: 1 });
    expect(result.current.notices).toEqual([]);
  });

  it('never calls requestPermission on its own — load and refresh stay silent', () => {
    const { rerender, props } = hook();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeNotification.raised).toEqual([]);

    rerender({ ...props, refreshTick: 1 });
    rerender({ ...props, refreshTick: 2 });
    expect(FakeNotification.requestPermission, 'a prompt may only come from the drawer click').not.toHaveBeenCalled();
    expect(FakeNotification.raised, 'no opt-in ⇒ no on-device alert').toEqual([]);
  });

  it('raises exactly one on-device alert when the user HAS opted in', () => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '1');
    FakeNotification.permission = 'granted';

    const { result, rerender, props } = hook();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeNotification.raised).toHaveLength(1);
    expect(result.current.notices[0].kind).toBe('plan-change');

    // One per notice, not one per refresh.
    rerender({ ...props, refreshTick: 1 });
    rerender({ ...props, refreshTick: 2 });
    expect(FakeNotification.raised).toHaveLength(1);
  });

  it('the ONE code path that prompts is the explicit opt-in call', async () => {
    const { enableNotifications } = await import('@/lib/notifications');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    const state = await enableNotifications();

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(state).toBe('on');
    expect(localStorage.getItem(NOTIFICATIONS_ENABLED_KEY)).toBe('1');
  });

  it('says nothing about rates until the effectiveDate actually advances', () => {
    // First sight: baseline persisted, no rate notice.
    const first = hook();
    expect(localStorage.getItem(RATE_ACK_KEY)).toBe('2024-11-01');
    expect(first.result.current.notices.filter((n) => n.kind === 'rate-change')).toEqual([]);

    // Readings cross into the 2025-11-01 set: the notice appears.
    const advanced = Dec2025();
    const second = renderHook(() =>
      useRefreshNotices({
        connected: true,
        totals: calculateFullDataTotals(advanced),
        processedData: advanced,
        currentPlan: totals.bestPlan, // suppress the plan notice to isolate this one
        refreshTick: 0,
      }),
    );
    const rate = second.result.current.notices.find((n) => n.kind === 'rate-change');
    expect(rate).toBeDefined();
    expect(rate!.id).toBe('rate:2025-11-01');

    act(() => second.result.current.dismiss(rate!.id));
    expect(localStorage.getItem(RATE_ACK_KEY)).toBe('2025-11-01');
    expect(second.result.current.notices.filter((n) => n.kind === 'rate-change')).toEqual([]);
  });

  it('stays silent while the user is already on the best plan', () => {
    const { result } = hook({ currentPlan: totals.bestPlan });
    expect(result.current.notices).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * One event ⇒ at most one system notification (the merge's dedup guard)
 * -------------------------------------------------------------------------- */

describe('the push dedup guard', () => {
  /** The rate notice alone: `currentPlan` at its best suppresses the plan one. */
  const rateOnly = () => {
    const advanced = Dec2025();
    return { advanced, totals: calculateFullDataTotals(advanced)! };
  };

  const rateHook = (pushTopics: string[]) => {
    const { advanced, totals } = rateOnly();
    // First sight of a rate date only records a baseline (no notice), so seed
    // the acknowledgement the way an established browser has it.
    localStorage.setItem(RATE_ACK_KEY, '2024-11-01');
    return renderHook(() =>
      useRefreshNotices({
        connected: true,
        totals,
        processedData: advanced,
        currentPlan: totals.bestPlan,
        refreshTick: 0,
        pushTopics,
      }),
    );
  };

  it('knows which topics a push would already deliver', () => {
    // `oeb_rates` has a live producer (the server's rates poll) …
    expect(pushCoversNotice('rate-change', ['oeb_rates'])).toBe(true);
    expect(pushCoversNotice('rate-change', ['plan_change'])).toBe(false);
    // … `plan_change` does not yet, so push cannot be what tells the user
    // about it — the on-device alert stays until that producer lands.
    expect(pushCoversNotice('plan-change', ['plan_change'])).toBe(false);
    expect(pushCoversNotice('plan-change', ['oeb_rates'])).toBe(false);
    // No subscription ⇒ push covers nothing.
    expect(pushCoversNotice('rate-change', [])).toBe(false);
  });

  it('lets push own the event when its topic is subscribed: no double pop', () => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '1');
    FakeNotification.permission = 'granted';

    const { result } = rateHook(['oeb_rates']);

    // The notice still exists — the banner always renders — but the system
    // notification does not: push (governed by the cap and quiet hours)
    // already carries it.
    expect(result.current.notices.map((n) => n.kind)).toEqual(['rate-change']);
    expect(FakeNotification.raised).toEqual([]);
    // It is still marked as told, so turning push off later does not
    // retro-notify an event the user has already been given.
    expect(localStorage.getItem(NOTIFIED_KEY)).toBe(result.current.notices[0].id);
  });

  it('keeps the on-device alert when push does not cover the topic', () => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '1');
    FakeNotification.permission = 'granted';

    const { result } = rateHook([]);

    expect(FakeNotification.raised).toHaveLength(1);
    expect(result.current.notices).toHaveLength(1);
  });

  it('never suppresses a topic with no producer (plan_change today)', () => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, '1');
    FakeNotification.permission = 'granted';

    const processed = June2025();
    const tot = calculateFullDataTotals(processed)!;
    renderHook(() =>
      useRefreshNotices({
        connected: true,
        totals: tot,
        processedData: processed,
        currentPlan: (['Tiered', 'TOU', 'ULO'] as const).find((p) => p !== tot.bestPlan)!,
        refreshTick: 0,
        // Subscribed to it anyway — but nothing emits it, so nothing pushed.
        pushTopics: ['plan_change'],
      }),
    );

    expect(FakeNotification.raised).toHaveLength(1);
  });
});
