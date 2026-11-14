/**
 * selectInitialWindow must never enter its coverage loop over an instant
 * that is not a date (F1, t_bcc1b9c6): with an undateable anchor both loop
 * endpoints are Invalid, `isAfter(Invalid, Invalid)` is false, so
 * `for (let d = s; !isAfter(d, e); d = addDays(d, 1))` never exits — a
 * synchronous infinite loop that freezes the tab on init (the payload is
 * persisted first, so every later load hung with no in-app recovery).
 *
 * The guard is fail-closed and two-layered:
 *   1. rows whose `new Date(ts * 1000)` is not a date are not window
 *      anchors — a dataset holding some real rows still opens on them, and
 *      a dataset holding none returns null exactly like an empty one;
 *   2. `coverage()` returns 0 for an endpoint that is not a date, so a
 *      regression in (1) degrades to the raw-range fallback instead of
 *      spinning.
 *
 * RED control (guards reverted): this file HANGS by design — the defect is
 * a synchronous loop no per-test timeout can interrupt. Run the control as
 * `timeout 90 npx vitest run src/lib/energy.initialWindow.test.ts` and
 * assert the killed exit (124) rather than letting the suite spin. With
 * ONLY layer (1) reverted (layer 2 kept) the cases fail as plain
 * assertion mismatches on `NaN-NaN-NaN` day keys instead — no hang.
 */
import { describe, expect, it } from 'vitest';
import { selectInitialWindow } from './energy';
import type { DataPoint } from './energy';

/**
 * The five shapes `GasSection.outOfRangeStart.test.tsx` pins — every one a
 * finite number whose `new Date(ts * 1000)` is Invalid, both signs.
 */
const HOSTILE_STARTS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  Number.MAX_SAFE_INTEGER,
  1e308,
];

/** Local noon, 2026-01-01 — the day the healthy row sits on. */
const REAL = Math.floor(new Date(2026, 0, 1, 12).getTime() / 1000);
/** Injected clock: the window maths must not depend on today's date. */
const TODAY = new Date(2026, 10, 14, 12);
const WINDOW = { start: '2026-01-01', end: '2026-01-01', scope: 'Custom' as const };

const point = (timestamp: number): DataPoint => ({ timestamp, usage_kwh: 1 });

describe('selectInitialWindow over undateable instants', () => {
  it('control: one real instant opens the data-anchored window instantly', () => {
    expect(selectInitialWindow([point(REAL)], 1, TODAY)).toEqual(WINDOW);
  });

  it.each(HOSTILE_STARTS)(
    'a dataset holding %s still opens on its dateable rows (no hang, no NaN keys)',
    (ts) => {
      expect(selectInitialWindow([point(REAL), point(ts)], 1, TODAY)).toEqual(WINDOW);
    },
  );

  it.each(HOSTILE_STARTS)('an all-%s dataset returns null — no window, no loop', (ts) => {
    expect(selectInitialWindow([point(ts)], 1, TODAY)).toBeNull();
  });

  it('control: empty data still returns null', () => {
    expect(selectInitialWindow([], 1, TODAY)).toBeNull();
  });

  it('control: a spread of real rows still picks the covered window', () => {
    const rows = Array.from({ length: 10 }, (_, i) => point(REAL + i * 86_400));
    const w = selectInitialWindow(rows, 1, TODAY);
    expect(w).not.toBeNull();
    expect(w!.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(w!.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});