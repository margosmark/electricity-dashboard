/**
 * Wave M — the visibility rules, tested as pure functions.
 *
 * The bugs worth catching here are all "a banner fired when it should not"
 * (a manual-upload-only user, a notice that re-fires every quarter hour) or
 * "the arithmetic behind `~$X/mo` is wrong" — both are only cheap to test if
 * the rule is a function of its inputs, which is why `buildRefreshNotices`
 * takes acknowledgements as arguments instead of reading them itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BACKGROUND_REFRESH_MIN_MS,
  GB_CURSOR_CACHE,
  GB_CURSOR_URL,
  GB_PERIODIC_TAG,
  GB_STAGED_CACHE,
  GB_STAGED_URL,
  PLAN_ACK_KEY,
  RATE_ACK_KEY,
  backgroundRefreshMinMs,
  buildRefreshNotices,
  datasetDays,
  detectPlanChange,
  detectRateChange,
  maxActiveEffectiveDate,
  notificationPayload,
  perMonth,
  shouldBackgroundRefresh,
  type RefreshDecisionInput,
} from './backgroundRefresh';
import {
  calculateFullDataTotals,
  processRawData,
  type DataPoint,
  type ProcessedPoint,
  type RateSet,
} from './energy';
import { PLAN_LABEL, type PlanId } from '@/hooks/useSelectedPlan';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

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

/** `days` of hourly readings starting at `start`. */
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

const OTHER_PLANS = (best: PlanId): PlanId[] =>
  (['Tiered', 'TOU', 'ULO'] as const).filter((p) => p !== best);

afterEach(() => {
  window.__GB_BG_MIN_MS = undefined;
});

/* -------------------------------------------------------------------------- *
 * Trigger rules
 * -------------------------------------------------------------------------- */

const base: Omit<RefreshDecisionInput, 'trigger'> = {
  now: 1_000_000,
  lastRefreshAt: 0,
  minIntervalMs: 15 * 60 * 1000,
  connected: true,
  syncing: false,
  visibility: 'visible',
};

describe('shouldBackgroundRefresh', () => {
  it('refuses every trigger without an authorisation — manual-DMD users get nothing', () => {
    for (const trigger of ['load', 'interval', 'visibility', 'focus', 'staged'] as const) {
      expect(
        shouldBackgroundRefresh({ ...base, trigger, connected: false }),
        `${trigger} must not fire for a browser with no gb_session`,
      ).toBe(false);
    }
  });

  it('refuses while a refresh is already running', () => {
    expect(shouldBackgroundRefresh({ ...base, trigger: 'visibility', syncing: true })).toBe(false);
  });

  it('only runs the interval while the tab is visible', () => {
    expect(shouldBackgroundRefresh({ ...base, trigger: 'interval', visibility: 'hidden' })).toBe(false);
    expect(shouldBackgroundRefresh({ ...base, trigger: 'interval', visibility: 'visible' })).toBe(true);
  });

  it('refuses visibility/focus while the document is not visible', () => {
    expect(
      shouldBackgroundRefresh({ ...base, trigger: 'visibility', visibility: 'hidden' }),
    ).toBe(false);
    expect(shouldBackgroundRefresh({ ...base, trigger: 'focus', visibility: 'hidden' })).toBe(false);
  });

  it('throttles everything except the first load by minIntervalMs', () => {
    expect(
      shouldBackgroundRefresh({
        ...base,
        trigger: 'visibility',
        lastRefreshAt: base.now - 60_000,
      }),
      'a refresh one minute ago must suppress the next one',
    ).toBe(false);
    expect(
      shouldBackgroundRefresh({
        ...base,
        trigger: 'visibility',
        lastRefreshAt: base.now - 16 * 60_000,
      }),
    ).toBe(true);
    // lastRefreshAt === 0 means "nothing has refreshed yet" and is NOT
    // treated as an epoch-0 timestamp.
    expect(
      shouldBackgroundRefresh({ ...base, trigger: 'load', lastRefreshAt: 0, now: 1 }),
    ).toBe(true);
  });

  it('fires visibility AND focus exactly once when a window is restored', () => {
    // The real sequence: both events land in the same tick.
    const first = shouldBackgroundRefresh({ ...base, trigger: 'visibility', now: 500 });
    const lastRefreshAt = first ? 500 : base.lastRefreshAt;
    const second = shouldBackgroundRefresh({ ...base, trigger: 'focus', now: 501, lastRefreshAt });
    expect(first).toBe(true);
    expect(second, 'the second event of the pair must be refused').toBe(false);
  });
});

describe('backgroundRefreshMinMs', () => {
  it('defaults to the same quarter-hour cadence Wave K established', () => {
    expect(DEFAULT_BACKGROUND_REFRESH_MIN_MS).toBe(15 * 60 * 1000);
    expect(backgroundRefreshMinMs()).toBe(DEFAULT_BACKGROUND_REFRESH_MIN_MS);
  });

  it('honours the documented test seam, and only a sane value', () => {
    window.__GB_BG_MIN_MS = 1500;
    expect(backgroundRefreshMinMs()).toBe(1500);
    window.__GB_BG_MIN_MS = -1;
    expect(backgroundRefreshMinMs(), 'a negative floor would disable the throttle').toBe(
      DEFAULT_BACKGROUND_REFRESH_MIN_MS,
    );
    window.__GB_BG_MIN_MS = Number.NaN;
    expect(backgroundRefreshMinMs()).toBe(DEFAULT_BACKGROUND_REFRESH_MIN_MS);
  });
});

/* -------------------------------------------------------------------------- *
 * The plan-switch signal
 * -------------------------------------------------------------------------- */

describe('detectPlanChange', () => {
  const processed = hourlyFrom(new Date(2025, 5, 1), 30, 1.5);
  const totals = calculateFullDataTotals(processed)!;

  it('stays silent when the user is already on the best plan', () => {
    expect(detectPlanChange({ totals, currentPlan: totals.bestPlan, ackPlan: null })).toBeNull();
    expect(detectPlanChange({ totals, currentPlan: totals.bestPlan, ackPlan: totals.bestPlan })).toBeNull();
  });

  it('stays silent once the answer has been acknowledged', () => {
    expect(detectPlanChange({ totals, currentPlan: OTHER_PLANS(totals.bestPlan)[0], ackPlan: totals.bestPlan })).toBeNull();
  });

  it('stays silent with no readings at all', () => {
    expect(detectPlanChange({ totals: null, currentPlan: 'TOU', ackPlan: null })).toBeNull();
  });

  it('fires on first sight when the stored plan is not the winner', () => {
    const currentPlan = OTHER_PLANS(totals.bestPlan)[0];
    const notice = detectPlanChange({ totals, currentPlan, ackPlan: null });
    expect(notice).not.toBeNull();
    expect(notice!.kind).toBe('plan-change');
    expect(notice!.plan).toBe(totals.bestPlan);
    // No prior acknowledgement ⇒ the "old" answer is what the user picked.
    expect(notice!.previousBest).toBe(currentPlan);
    expect(notice!.currentPlan).toBe(currentPlan);
    expect(notice!.id).toBe(`plan:${totals.bestPlan}`);
    expect(notice!.headline).toContain('Your best plan changed');
    expect(notice!.headline).toContain(PLAN_LABEL[totals.bestPlan]);
    expect(notice!.headline).toContain(`vs ${PLAN_LABEL[currentPlan]}`);
  });

  it('reports the previous acknowledged best as {old}, not the user plan', () => {
    const currentPlan = OTHER_PLANS(totals.bestPlan)[0];
    const oldBest = OTHER_PLANS(totals.bestPlan)[1];
    const notice = detectPlanChange({ totals, currentPlan, ackPlan: oldBest })!;
    expect(notice.previousBest).toBe(oldBest);
    expect(notice.headline).toContain(`vs ${PLAN_LABEL[oldBest]}`);
    expect(notice.detail).toContain(`You are on ${PLAN_LABEL[currentPlan]}`);
  });

  it('prices the gap per month on the whole dataset', () => {
    const currentPlan = OTHER_PLANS(totals.bestPlan)[0];
    const notice = detectPlanChange({ totals, currentPlan, ackPlan: null })!;
    const days = datasetDays(totals);
    const cost = (p: PlanId) =>
      p === 'TOU' ? totals.costTOU : p === 'Tiered' ? totals.costTiered : totals.costULO;

    expect(notice.monthlySavingVsPrevious).toBeCloseTo(
      Math.round(Math.max(0, perMonth(cost(notice.previousBest), days) - perMonth(cost(notice.plan), days)) * 100) / 100,
      5,
    );
    expect(notice.monthlySavingVsCurrent).toBeGreaterThanOrEqual(0);
    // Three plans, cheapest first — the comparison the card asks to recompute.
    expect(notice.monthlyCosts).toHaveLength(3);
    expect(notice.monthlyCosts.map((c) => c.plan)).toContain('TOU');
    expect(notice.monthlyCosts.map((c) => c.plan)).toContain('Tiered');
    expect(notice.monthlyCosts.map((c) => c.plan)).toContain('ULO');
    const costs = notice.monthlyCosts.map((c) => c.cost);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it('refuses to call a rounding-to-nothing margin a change (a tie is not news)', () => {
    // The shape a 43-kWh-across-seven-years dataset produces: a "winner" that
    // wins by an amount which vanishes at two decimals. Everything else about
    // the notice would fire — different plan, not acknowledged — and only the
    // $0.00 gap stops it.
    const tied = {
      ...totals,
      costTOU: 1000,
      costTiered: 1000,
      costULO: 1000,
      bestPlan: 'Tiered' as const,
      worstPlan: 'ULO' as const,
      planDelta: 0,
    };
    expect(detectPlanChange({ totals: tied, currentPlan: 'TOU', ackPlan: null })).toBeNull();

    // The same gate, with a real one-and-a-half-cent monthly margin.
    const real = { ...tied, costTiered: 999.985 };
    expect(detectPlanChange({ totals: real, currentPlan: 'TOU', ackPlan: null })).not.toBeNull();
  });

  it('treats a corrupt stored acknowledgement as "same as the user plan"', () => {
    const currentPlan = OTHER_PLANS(totals.bestPlan)[0];
    const notice = detectPlanChange({ totals, currentPlan, ackPlan: 'Windpower' })!;
    expect(notice.previousBest).toBe(currentPlan);
  });
});

/* -------------------------------------------------------------------------- *
 * The rate-change signal
 * -------------------------------------------------------------------------- */

describe('detectRateChange / maxActiveEffectiveDate', () => {
  it('records a baseline on the first observation and says nothing', () => {
    const processed = hourlyFrom(new Date(2025, 0, 10), 5, 1);
    expect(maxActiveEffectiveDate(processed)).toBe('2024-11-01');
    expect(detectRateChange({ processedData: processed, ackRateDate: null })).toEqual({
      kind: 'baseline',
      baseline: '2024-11-01',
    });
  });

  it('stays silent while the effectiveDate has not moved', () => {
    const processed = hourlyFrom(new Date(2025, 0, 10), 5, 1);
    expect(detectRateChange({ processedData: processed, ackRateDate: '2024-11-01' })).toEqual({
      kind: 'none',
    });
  });

  it('fires when readings cross into a newer rate set', () => {
    // June 2025 prices under 2024-11-01; December 2025 under 2025-11-01.
    const before = hourlyFrom(new Date(2025, 5, 1), 5, 1);
    const after = hourlyFrom(new Date(2025, 11, 1), 5, 1);
    expect(maxActiveEffectiveDate(after)).toBe('2025-11-01');

    const outcome = detectRateChange({
      processedData: after,
      ackRateDate: maxActiveEffectiveDate(before),
    });
    expect(outcome.kind).toBe('changed');
    if (outcome.kind !== 'changed') throw new Error('unreachable');
    expect(outcome.notice.effectiveDate).toBe('2025-11-01');
    expect(outcome.notice.previousEffectiveDate).toBe('2024-11-01');
    expect(outcome.notice.headline).toBe('New OEB rates in effect — re-comparing your plans');
    expect(outcome.notice.detail).toContain('2025-11-01');
  });

  it('reports nothing with no readings', () => {
    expect(maxActiveEffectiveDate([])).toBeNull();
    expect(detectRateChange({ processedData: [], ackRateDate: null })).toEqual({ kind: 'none' });
  });
});

/* -------------------------------------------------------------------------- *
 * The whole payload, and the card's scope-4 gate
 * -------------------------------------------------------------------------- */

describe('buildRefreshNotices', () => {
  const processed = hourlyFrom(new Date(2025, 5, 1), 30, 1.5);
  const totals = calculateFullDataTotals(processed)!;
  const loser = OTHER_PLANS(totals.bestPlan)[0];

  const input = {
    connected: true,
    totals,
    processedData: processed,
    currentPlan: loser,
    ackPlan: null as string | null,
    ackRateDate: null as string | null,
  };

  it('emits nothing at all for a browser with no gb_session (scope 4)', () => {
    // Everything below would otherwise produce BOTH notices.
    expect(totals).not.toBeNull();
    expect(detectPlanChange({ totals, currentPlan: loser, ackPlan: null })).not.toBeNull();

    expect(buildRefreshNotices({ ...input, connected: false })).toEqual({
      notices: [],
      rateBaseline: null,
    });
  });

  it('returns the plan notice and establishes the rate baseline, silently', () => {
    const result = buildRefreshNotices(input);
    expect(result.notices.map((n) => n.kind)).toEqual(['plan-change']);
    expect(result.rateBaseline).toBe('2024-11-01');
    // The baseline must NOT also be reported as a notice — that is the whole
    // point of a baseline.
    expect(result.notices.some((n) => n.kind === 'rate-change')).toBe(false);
  });

  it('stacks both notices, plan first, once the rate has advanced', () => {
    const advanced = [...hourlyFrom(new Date(2025, 5, 1), 30, 1.5), ...hourlyFrom(new Date(2025, 11, 1), 3, 1.5)];
    const advancedTotals = calculateFullDataTotals(advanced)!;
    const result = buildRefreshNotices({
      ...input,
      totals: advancedTotals,
      processedData: advanced,
      ackRateDate: '2024-11-01',
    });
    expect(result.rateBaseline).toBeNull();
    expect(result.notices.map((n) => n.kind)).toEqual(['plan-change', 'rate-change']);
  });

  it('is silent once both acknowledgements match reality', () => {
    const result = buildRefreshNotices({
      ...input,
      ackPlan: totals.bestPlan,
      ackRateDate: '2024-11-01',
    });
    expect(result).toEqual({ notices: [], rateBaseline: null });
  });
});

/* -------------------------------------------------------------------------- *
 * On-device notification copy
 * -------------------------------------------------------------------------- */

describe('notificationPayload', () => {
  const processed = hourlyFrom(new Date(2025, 5, 1), 30, 1.5);
  const totals = calculateFullDataTotals(processed)!;
  const loser = OTHER_PLANS(totals.bestPlan)[0];

  it('names the winner and the gap, and tags itself with the notice id', () => {
    const notice = detectPlanChange({ totals, currentPlan: loser, ackPlan: null })!;
    const payload = notificationPayload(notice);
    expect(payload.title).toContain(PLAN_LABEL[notice.plan]);
    expect(payload.body).toContain(`$${notice.monthlySavingVsPrevious.toFixed(2)}/mo`);
    expect(payload.body).toContain(PLAN_LABEL[notice.previousBest]);
    expect(payload.tag).toBe(notice.id);
  });

  it('states the effective date for a rate change', () => {
    const outcome = detectRateChange({
      processedData: hourlyFrom(new Date(2025, 11, 1), 3, 1),
      ackRateDate: '2024-11-01',
    });
    if (outcome.kind !== 'changed') throw new Error('expected a rate notice');
    const payload = notificationPayload(outcome.notice);
    expect(payload.title).toBe('New Ontario energy rates');
    expect(payload.body).toContain('2025-11-01');
    expect(payload.tag).toBe(outcome.notice.id);
  });
});

/* -------------------------------------------------------------------------- *
 * The page ⇄ service-worker handshake
 * -------------------------------------------------------------------------- */

describe('storage keys', () => {
  it('are namespaced so an unrelated localStorage wipe cannot fake a notice', () => {
    expect(PLAN_ACK_KEY).toBe('wave_m_ack_plan');
    expect(RATE_ACK_KEY).toBe('wave_m_ack_rate');
  });
});

describe('public/sw.js mirrors the handshake names', () => {
  const webappRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const source = fs.readFileSync(path.join(webappRoot, 'public', 'sw.js'), 'utf8');

  it('uses the same cache names, keys and message tag as the bundle', () => {
    expect(source).toContain(`'${GB_CURSOR_CACHE}'`);
    expect(source).toContain(`'${GB_STAGED_CACHE}'`);
    expect(source).toContain(`'${GB_CURSOR_URL}'`);
    expect(source).toContain(`'${GB_STAGED_URL}'`);
    expect(source).toContain(`'${GB_PERIODIC_TAG}'`);
  });

  it('keeps those caches out of the VERSION sweep so they survive a deploy', () => {
    expect(source).not.toMatch(/const GB_(CURSOR|STAGED)_CACHE = `\$\{VERSION\}/);
    expect(source).toMatch(/!key\.startsWith\(VERSION\)/);
  });

  it('handles the periodicsync event for exactly our tag', () => {
    expect(source).toContain("addEventListener('periodicsync'");
    expect(source).toContain('event.tag !== GB_PERIODIC_TAG');
  });
});
