import { describe, it, expect } from 'vitest';
import {
  analyzeTouShifts,
  classifyBlock,
  confidenceBadge,
  collapseHeadline,
  worstConfidence,
  LOOKBACK_WEEKS,
  type ShiftBlock,
} from './touShift';
import { processRawData, type DataPoint, type RateSet } from './energy';

const rates: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Unix seconds for a local-time date (mirrors how DataPoint timestamps work). */
function ts(year: number, month: number, day: number, hour: number): number {
  return Math.floor(new Date(year, month, day, hour, 0, 0).getTime() / 1000);
}

/**
 * Build raw readings for a weekly pattern.
 * @param weeks        how many consecutive weeks (ending at the anchor week)
 * @param pattern      weekday(0=Sun)-to-hours + kWh factory (weekIndex => kWh)
 * @param anchor       a date inside the newest week (the data's "last" week)
 */
type PatternSlot = { weekday: number; hours: number[]; kwh: (week: number) => number };

function buildData(
  weeks: number,
  pattern: PatternSlot[],
  anchor: { year: number; month: number; day: number },
): DataPoint[] {
  // Monday of the anchor week
  const anchorDate = new Date(anchor.year, anchor.month, anchor.day);
  const dow = anchorDate.getDay(); // 0=Sun
  const daysBackToMonday = (dow + 6) % 7;
  const monday = new Date(anchorDate);
  monday.setDate(monday.getDate() - daysBackToMonday);

  const out: DataPoint[] = [];
  for (let w = 0; w < weeks; w++) {
    const weekMonday = new Date(monday);
    weekMonday.setDate(weekMonday.getDate() - (weeks - 1 - w) * 7);
    for (const slot of pattern) {
      // Map slot weekday (0=Sun) onto this week's dates
      const delta = (slot.weekday + 6) % 7; // Monday=0 offset
      const day = new Date(weekMonday);
      day.setDate(day.getDate() + delta);
      for (const hour of slot.hours) {
        out.push({ timestamp: ts(day.getFullYear(), day.getMonth(), day.getDate(), hour), usage_kwh: slot.kwh(w) });
      }
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function run(raw: DataPoint[], plan: 'TOU' | 'Tiered' | 'ULO' = 'TOU') {
  return analyzeTouShifts(processRawData(raw, [rates]), plan, rates);
}

describe('analyzeTouShifts', () => {
  it('returns no-data for an empty dataset', () => {
    const result = run([]);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-data');
  });

  it('returns insufficient-history when fewer than 3 weeks are loaded', () => {
    const raw = buildData(2, [{ weekday: 3, hours: [12, 13], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('insufficient-history');
    expect(result.dataWeeks).toBe(2);
  });

  it('detects a recurring On-Peak block present in 4 of 5 weeks and prices shift options', () => {
    // Wednesday 12:00-14:00, present in weeks 0-3 but missing in week 4
    // (week index counts from the OLDEST week; pattern drops out recently)
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        {
          weekday: 3,
          hours: [12, 13],
          kwh: (w) => (w < 4 ? 2.0 : 0),
        },
      ],
      { year: 2026, month: 7, day: 15 },
    ).filter((d) => d.usage_kwh > 0);

    const result = run(raw);
    expect(result.emptyReason).toBeNull();
    expect(result.blocks).toHaveLength(1);

    const block = result.blocks[0];
    expect(block.weekday).toBe(3); // Wednesday
    expect(block.startHour).toBe(12);
    expect(block.endHour).toBe(14); // 12:00 and 13:00 → exclusive end
    expect(block.label).toBe('Wed 12:00–14:00');
    expect(block.weeksSeen).toBe(4);
    expect(block.avgWeeklyKwh).toBeCloseTo(4.0, 5); // 2h × 2.0 kWh
    expect(block.consistencyCv).toBeCloseTo(0, 5); // perfectly steady
    expect(block.baselineRateCents).toBe(20.3); // TOU On-Peak

    // Options ranked by monthly $: Overnight ULO (20.3−3.9=16.4¢) beats
    // weekend/off-peak TOU (20.3−9.8=10.5¢). Weekend and off-peak tie on rate.
    expect(block.options.map((o) => o.target)).toEqual(['overnight_ulo', 'weekend', 'offpeak_tou']);
    const overnight = block.options[0];
    expect(overnight.savingsCentsPerKwh).toBeCloseTo(16.4, 5);
    // 4 kWh/wk × 0.164 $/kWh × 52/12 wk/mo = 2.8427…
    expect(overnight.monthlySavings).toBeCloseTo(4.0 * 0.164 * (52 / 12), 4);
    expect(block.bestMonthlySavings).toBe(overnight.monthlySavings);
    // Every option must carry its honest assumption
    for (const o of block.options) expect(o.assumption.length).toBeGreaterThan(10);
  });

  it('requires recurrence in >=3 of the last 5 weeks (2 weeks of a 5-week dataset is rejected)', () => {
    // Data spans all 5 weeks (baseline night reading every week) but the
    // On-Peak pattern only shows up in the last 2 → rejected as non-recurring.
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 3, hours: [12], kwh: (w) => (w >= 3 ? 2.0 : 0) },
        { weekday: 3, hours: [22], kwh: () => 0.4 }, // Off-Peak anchor reading
      ],
      { year: 2026, month: 7, day: 15 },
    ).filter((d) => d.usage_kwh > 0);
    const result = run(raw);
    expect(result.dataWeeks).toBe(LOOKBACK_WEEKS);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('rejects inconsistent usage (CV > 0.4) even when the slot recurs every week', () => {
    // Wildly varying kWh: 0.5 / 6.0 alternating → CV ≈ 0.77
    const raw = buildData(
      LOOKBACK_WEEKS,
      [{ weekday: 3, hours: [12], kwh: (w) => (w % 2 === 0 ? 0.5 : 6.0) }],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('ignores Off-Peak slots: weekend recurrence is never recommended', () => {
    // Saturday 13:00 is Off-Peak under TOU all year → nothing to shift from
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 6, hours: [13], kwh: () => 2.5 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('ignores weekday Off-Peak hours (e.g. 22:00)', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 2, hours: [22], kwh: () => 2.5 }], { year: 2026, month: 7, day: 15 });
    expect(run(raw).blocks).toEqual([]);
  });

  it('merges consecutive On-Peak hours into one block and splits non-consecutive ones', () => {
    // Summer weekday On-Peak = 11:00–17:00 → 12,13,14 and 16 qualify (15 is the gap)
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 1, hours: [12, 13, 14], kwh: () => 1.5 }, // 12–15 contiguous
        { weekday: 1, hours: [16], kwh: () => 1.2 },         // gap at 15 → separate
      ],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks.map((b) => b.id)).toEqual(['mon-12-15', 'mon-16-17']);
    expect(result.blocks[0].avgWeeklyKwh).toBeCloseTo(4.5, 5);
    expect(result.blocks[0].label).toBe('Mon 12:00–15:00');
  });

  it('ranks blocks by monthly dollar impact (bigger shiftable load first)', () => {
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 2, hours: [12], kwh: () => 1.0 },   // smaller block
        { weekday: 4, hours: [12, 13], kwh: () => 3.0 }, // 6 kWh/wk → bigger
      ],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].weekday).toBe(4);
    expect(result.blocks[0].bestMonthlySavings).toBeGreaterThan(result.blocks[1].bestMonthlySavings);
    // Total = sum of best options
    expect(result.totalMonthlySavings).toBeCloseTo(
      result.blocks.reduce((acc, b) => acc + b.bestMonthlySavings, 0),
      6,
    );
  });

  it('drops destinations that cannot save money (never shows negative/nonsense savings)', () => {
    // Custom rate set where ULO overnight is MORE expensive than TOU on-peak:
    // the overnight option must vanish, not show a negative number.
    const weirdRates: RateSet = {
      ...rates,
      ulo: { ...rates.ulo, overnight: 99.0 },
    };
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const processed = processRawData(raw, [weirdRates]);
    const result = analyzeTouShifts(processed, 'TOU', weirdRates);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].options.map((o) => o.target)).not.toContain('overnight_ulo');
    for (const o of result.blocks[0].options) {
      expect(o.savingsCentsPerKwh).toBeGreaterThan(0);
      expect(o.monthlySavings).toBeGreaterThan(0);
    }
  });

  it('uses the ULO mid-peak baseline when the plan is ULO (same wall-clock, different category)', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw, 'ULO');
    expect(result.blocks).toHaveLength(1);
    // Summer 12:00 is ULO Mid-Peak (Overnight ends at 07:00, On-Peak starts 16:00)
    expect(result.blocks[0].baselineRateCents).toBe(15.7);
    // Savings priced against mid-peak: 15.7 − 9.8 = 5.9¢ for off-peak targets
    const offpeak = result.blocks[0].options.find((o) => o.target === 'weekend')!;
    expect(offpeak.savingsCentsPerKwh).toBeCloseTo(5.9, 5);
  });

  it('prices against the Tiered flat baseline when the plan is Tiered', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw, 'Tiered');
    expect(result.blocks[0].baselineRateCents).toBe(12.0);
    const overnight = result.blocks[0].options.find((o) => o.target === 'overnight_ulo')!;
    expect(overnight.savingsCentsPerKwh).toBeCloseTo(8.1, 5); // 12.0 − 3.9
  });

  it('anchors the 5-week window to the newest reading, not to today', () => {
    // Data from January (past relative to "now" = October 2026) — analysis must
    // still work (deterministic: no Date.now() anywhere in the window math).
    // Winter weekday On-Peak = 07:00–11:00 and 17:00–19:00 → use 18:00.
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [18], kwh: () => 2.0 }], { year: 2026, month: 0, day: 20 });
    const result = run(raw);
    expect(result.blocks).toHaveLength(1);
    expect(result.dataWeeks).toBe(LOOKBACK_WEEKS);
  });

  it('handles a dataset longer than 5 weeks by only considering the last 5', () => {
    const raw = buildData(
      8,
      [{ weekday: 3, hours: [12], kwh: (w) => (w >= 5 ? 2.0 : 0) }],
      { year: 2026, month: 7, day: 15 },
    ).filter((d) => d.usage_kwh > 0);
    const result = run(raw);
    // Pattern exists only in the last 3 of 8 weeks → inside the window, qualifies
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].weeksSeen).toBe(3);
    // Only 3 weeks carry any readings at all (older weeks were filtered out)
    expect(result.dataWeeks).toBe(3);
  });

  it('treats zero-usage weeks as absent, not as consistent zeros', () => {
    const raw = buildData(
      LOOKBACK_WEEKS,
      [{ weekday: 3, hours: [12], kwh: (w) => (w === 0 ? 2.0 : 0) }],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toEqual([]); // only 1 real week
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });
});

/**
 * Wave E — user-centric rewrite. Every heuristic ships as a pure function
 * with a synthesized fixture per branch BEFORE the implementation lands.
 */
describe('classifyBlock', () => {
  const base = { weeksSeen: 5, intraBlockCv: 0.05, consistencyCv: 0.1 };

  it('calls a steady, bounded, same-window block a fixed-schedule load', () => {
    const c = classifyBlock({ ...base, startHour: 1, endHour: 4 });
    expect(c.signature).toBe('fixed-schedule');
    expect(c.label).toContain('fixed-schedule load');
    expect(c.label).toContain('EV timer / appliance cycle');
    expect(c.detail.length).toBeGreaterThan(10);
  });

  it('calls a broad daytime block that swings week to week HVAC-like', () => {
    // Real Oakville shape: flat hourly curve (intraCV 0.14) but the weekly
    // total moves with the weather (consistencyCv 0.34).
    const c = classifyBlock({ startHour: 11, endHour: 17, weeksSeen: 4, intraBlockCv: 0.14, consistencyCv: 0.34 });
    expect(c.signature).toBe('hvac-like');
    expect(c.label).toContain('HVAC-like whole-house load');
  });

  it('calls a broad daytime block with a ramping intra-day curve HVAC-like', () => {
    const c = classifyBlock({ startHour: 11, endHour: 16, weeksSeen: 5, intraBlockCv: 0.45, consistencyCv: 0.12 });
    expect(c.signature).toBe('hvac-like');
  });

  it('falls back to the honest "unidentified" label for a single-hour block', () => {
    const c = classifyBlock({ startHour: 13, endHour: 14, weeksSeen: 5, intraBlockCv: 0, consistencyCv: 0.34 });
    expect(c.signature).toBe('unidentified');
    expect(c.label).toBe('Unidentified weekday routine');
  });

  it('never claims a fixed schedule for a block seen in fewer than 4 of 5 weeks', () => {
    const c = classifyBlock({ startHour: 1, endHour: 4, weeksSeen: 3, intraBlockCv: 0.02, consistencyCv: 0.05 });
    expect(c.signature).toBe('unidentified');
  });

  it('never claims a fixed schedule for a block whose weekly volume swings', () => {
    // Steady hour-to-hour, but the weekly total varies 45% → not a timer.
    const c = classifyBlock({ startHour: 1, endHour: 4, weeksSeen: 5, intraBlockCv: 0.05, consistencyCv: 0.45 });
    expect(c.signature).not.toBe('fixed-schedule');
    expect(c.signature).toBe('unidentified');
  });

  it('does not guess at a broad block that sits outside daytime hours', () => {
    const c = classifyBlock({ startHour: 18, endHour: 23, weeksSeen: 5, intraBlockCv: 0.5, consistencyCv: 0.5 });
    expect(c.signature).toBe('unidentified');
    expect(c.label).toBe('Unidentified weekday routine');
  });
});

describe('confidenceBadge', () => {
  it('is "Very consistent" only when cv < 0.15 AND the block is in all 5 weeks', () => {
    expect(confidenceBadge(0.1, 5).level).toBe('very-consistent');
    expect(confidenceBadge(0.1, 5).label).toBe('Very consistent');
    expect(confidenceBadge(0.149, 5).level).toBe('very-consistent');
    // cv at the threshold drops a level
    expect(confidenceBadge(0.15, 5).level).toBe('somewhat');
    // 4 of 5 weeks drops a level even with a rock-steady volume
    expect(confidenceBadge(0.1, 4).level).toBe('somewhat');
  });

  it('is "Somewhat" for cv < 0.4', () => {
    expect(confidenceBadge(0.39, 4).level).toBe('somewhat');
    expect(confidenceBadge(0.39, 4).label).toBe('Somewhat');
  });

  it('is "Irregular" at or above cv 0.4', () => {
    expect(confidenceBadge(0.4, 5).level).toBe('irregular');
    expect(confidenceBadge(0.9, 3).level).toBe('irregular');
    expect(confidenceBadge(0.9, 3).label).toBe('Irregular');
  });

  it('worstConfidence takes the least confident badge of the group', () => {
    const badges = [confidenceBadge(0.05, 5), confidenceBadge(0.3, 5), confidenceBadge(0.5, 5)];
    expect(worstConfidence(badges).level).toBe('irregular');
    expect(worstConfidence([confidenceBadge(0.05, 5)]).level).toBe('very-consistent');
  });
});

function mkBlock(overrides: Partial<ShiftBlock> = {}): ShiftBlock {
  const classification = classifyBlock({ startHour: 11, endHour: 17, weeksSeen: 5, intraBlockCv: 0.14, consistencyCv: 0.34 });
  return {
    id: 'fri-11-17',
    weekday: 5,
    startHour: 11,
    endHour: 17,
    label: 'Fri 11:00–17:00',
    avgWeeklyKwh: 17.06,
    weeksSeen: 4,
    consistencyCv: 0.34,
    intraBlockCv: 0.14,
    baselineRateCents: 20.3,
    tier: 'on-peak',
    classification,
    confidence: confidenceBadge(0.34, 4),
    options: [
      {
        target: 'overnight_ulo',
        label: 'Overnight (ULO 23:00–07:00)',
        destRateCents: 3.9,
        savingsCentsPerKwh: 16.4,
        monthlySavings: 12.12,
        effort: 'plan-switch-required',
        assumption: 'Requires switching to the ULO plan and moving the load into 23:00–07:00.',
      },
      {
        target: 'weekend',
        label: 'Weekend off-peak',
        destRateCents: 9.8,
        savingsCentsPerKwh: 10.5,
        monthlySavings: 8.4,
        effort: 'no-plan-switch',
        assumption: 'Move the activity to any weekend hour — off-peak on TOU, no plan switch.',
      },
    ],
    bestMonthlySavings: 12.12,
    ...overrides,
  };
}

describe('collapseHeadline', () => {
  it('collapses when one target carries >50% of the savings, with the routine phrasing', () => {
    const blocks = [
      mkBlock({ id: 'fri-11-17', label: 'Fri 11:00–17:00', bestMonthlySavings: 12.12 }),
      mkBlock({ id: 'thu-12-17', label: 'Thu 12:00–17:00', bestMonthlySavings: 10.93 }),
      mkBlock({ id: 'tue-11-16', label: 'Tue 11:00–16:00', bestMonthlySavings: 8.71 }),
    ];
    const total = blocks.reduce((a, b) => a + b.bestMonthlySavings, 0);
    const h = collapseHeadline(blocks, total);
    expect(h).not.toBeNull();
    expect(h!.target).toBe('overnight_ulo');
    expect(h!.routine).toBe('weekday daytime routine');
    expect(h!.savings).toBeCloseTo(total, 6);
    expect(h!.blockCount).toBe(3);
    expect(h!.totalCount).toBe(3);
    expect(h!.share).toBeCloseTo(1, 6);
    expect(h!.headline).toBe(`Switch to ULO and move your weekday daytime routine → ~$${total.toFixed(2)}/mo`);
    expect(h!.effort).toBe('plan-switch-required');
  });

  it('collapses on a majority, carrying only the dominant target’s dollars', () => {
    const blocks = [
      mkBlock({ id: 'a', bestMonthlySavings: 10 }),
      mkBlock({ id: 'b', bestMonthlySavings: 8 }),
      mkBlock({ id: 'c', bestMonthlySavings: 4, options: [{ ...mkBlock().options[1], monthlySavings: 4 }] }),
      mkBlock({ id: 'd', bestMonthlySavings: 4 }),
    ];
    const overnight = blocks.filter((b) => b.options[0].target === 'overnight_ulo');
    const total = blocks.reduce((a, b) => a + b.bestMonthlySavings, 0);
    const groupTotal = overnight.reduce((a, b) => a + b.bestMonthlySavings, 0);
    const h = collapseHeadline(blocks, total);
    expect(h).not.toBeNull();
    expect(groupTotal / total).toBeGreaterThan(0.5);
    expect(h!.savings).toBeCloseTo(groupTotal, 6);
    expect(h!.blockCount).toBe(overnight.length);
    expect(h!.totalCount).toBe(4);
  });

  it('does NOT collapse at exactly 50% (a tie is not a consensus)', () => {
    const blocks = [
      mkBlock({ id: 'a', bestMonthlySavings: 10 }),
      mkBlock({ id: 'b', bestMonthlySavings: 10, options: [{ ...mkBlock().options[1], monthlySavings: 10 }], }),
    ];
    const h = collapseHeadline(blocks, 20);
    expect(h).toBeNull();
  });

  it('returns null when there is nothing to collapse', () => {
    expect(collapseHeadline([], 0)).toBeNull();
    expect(collapseHeadline([mkBlock()], 0)).toBeNull();
  });

  it('takes the WORST confidence badge of the supporting blocks', () => {
    const blocks = [
      mkBlock({ id: 'a', confidence: confidenceBadge(0.05, 5) }),
      mkBlock({ id: 'b', confidence: confidenceBadge(0.9, 4) }),
    ];
    const h = collapseHeadline(blocks, 24.24);
    expect(h!.confidence.level).toBe('irregular');
  });

  it('describes a weekend-only group as a weekend routine', () => {
    const blocks = [mkBlock({ id: 'sat-11-17', weekday: 6, bestMonthlySavings: 10 })];
    const h = collapseHeadline(blocks, 10);
    expect(h!.routine).toBe('weekend routine');
    expect(h!.headline).toContain('weekend routine');
  });

  it('keeps the option’s assumption and effort so the headline stays actionable', () => {
    const h = collapseHeadline([mkBlock()], 12.12);
    expect(h!.assumption.length).toBeGreaterThan(10);
    expect(h!.optionLabel).toContain('Overnight');
  });
});

describe('analyzeTouShifts — Wave E tiers, effort and classification', () => {
  it('prices recurring TOU Mid-Peak hours as a lower tier (baseline = tou.midPeak), ranked behind On-Peak blocks', () => {
    // Summer weekday: 12:00 is On-Peak, 07:00-10:00 is Mid-Peak.
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 2, hours: [12], kwh: () => 1.0 },
        { weekday: 2, hours: [7, 8, 9, 10], kwh: () => 2.0 },
      ],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toHaveLength(2);

    const onPeak = result.blocks.filter((b) => b.tier === 'on-peak');
    const midPeak = result.blocks.filter((b) => b.tier === 'mid-peak');
    expect(onPeak).toHaveLength(1);
    expect(midPeak).toHaveLength(1);

    // The Mid-Peak block is the bigger prize in this fixture (8 kWh/wk), yet
    // the primary tier always ranks first.
    expect(midPeak[0].bestMonthlySavings).toBeGreaterThan(onPeak[0].bestMonthlySavings);
    expect(result.blocks[0].tier).toBe('on-peak');
    expect(result.blocks[1].tier).toBe('mid-peak');

    expect(midPeak[0].id).toBe('tue-7-11');
    expect(midPeak[0].baselineRateCents).toBe(15.7); // rates.tou.midPeak
    expect(midPeak[0].options.map((o) => o.target)).toEqual(['overnight_ulo', 'weekend', 'offpeak_tou']);
    expect(result.totalMonthlySavings).toBeCloseTo(
      result.blocks.reduce((a, b) => a + b.bestMonthlySavings, 0),
      6,
    );
  });

  it('keeps Off-Peak hours out of both tiers (weekends and 22:00 stay excluded)', () => {
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 6, hours: [12], kwh: () => 2.5 },
        { weekday: 2, hours: [22], kwh: () => 2.5 },
      ],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('labels every option with a first-class effort (plan switch or not) and keeps the assumption in sync', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });

    const byTarget = (plan: 'TOU' | 'Tiered' | 'ULO') =>
      Object.fromEntries(run(raw, plan).blocks[0].options.map((o) => [o.target, o]));

    const tou = byTarget('TOU');
    expect(tou.overnight_ulo.effort).toBe('plan-switch-required');
    expect(tou.weekend.effort).toBe('no-plan-switch');
    expect(tou.offpeak_tou.effort).toBe('no-plan-switch');
    expect(tou.overnight_ulo.assumption).toMatch(/requires switching to the ulo plan/i);

    const ulo = byTarget('ULO');
    expect(ulo.overnight_ulo.effort).toBe('no-plan-switch');
    expect(ulo.overnight_ulo.assumption).toMatch(/already on ulo/i);
    expect(ulo.offpeak_tou.effort).toBe('plan-switch-required');
    expect(ulo.offpeak_tou.assumption).toMatch(/requires switching to tou/i);

    const tiered = byTarget('Tiered');
    expect(tiered.weekend.effort).toBe('plan-switch-required'); // Tiered has no off-peak window
    expect(tiered.weekend.assumption).toMatch(/requires switching/i);
    expect(tiered.overnight_ulo.effort).toBe('plan-switch-required');

    for (const opt of [...Object.values(tou), ...Object.values(ulo), ...Object.values(tiered)]) {
      expect(opt.assumption.length).toBeGreaterThan(10);
      expect(['no-plan-switch', 'plan-switch-required']).toContain(opt.effort);
    }
  });

  it('attaches a classification and a confidence badge to every block', () => {
    // Steady 07:00-10:00 every week for 5 weeks → fixed-schedule signature.
    const steady = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [7, 8, 9], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const fixed = run(steady);
    expect(fixed.blocks).toHaveLength(1);
    expect(fixed.blocks[0].classification.signature).toBe('fixed-schedule');
    expect(fixed.blocks[0].confidence.level).toBe('very-consistent'); // cv 0, 5/5 weeks
    expect(fixed.blocks[0].intraBlockCv).toBeCloseTo(0, 5);

    // 4 of 5 weeks only → same evidence, one confidence level down.
    const fourWeeks = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [7, 8, 9], kwh: (w) => (w < 4 ? 2.0 : 0) }], {
      year: 2026,
      month: 7,
      day: 15,
    }).filter((d) => d.usage_kwh > 0);
    const partial = run(fourWeeks);
    expect(partial.blocks[0].weeksSeen).toBe(4);
    expect(partial.blocks[0].confidence.level).toBe('somewhat');

    // A single-hour block can never be identified — the label says so.
    const single = run(buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [13], kwh: () => 2.5 }], { year: 2026, month: 7, day: 15 }));
    expect(single.blocks[0].classification.signature).toBe('unidentified');
    expect(single.blocks[0].classification.label).toBe('Unidentified weekday routine');
  });
});


