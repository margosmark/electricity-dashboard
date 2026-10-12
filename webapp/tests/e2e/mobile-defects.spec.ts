import { test, expect, type Page } from '@playwright/test';

/**
 * Mark's four mobile defects (t_fcbba376, built in t_c58f1459) — the
 * MECHANICAL acceptance checks, run at both viewports the evidence covers:
 *
 *   390×844   the iPhone-class viewport ux spec'd against;
 *   427×952   Mark's actual device (DPR 3.0, 1280×2856 screenshot — six
 *             independent anchors all give exactly 3.0). The width
 *             compensation in D3a is what makes the SAME code pass both.
 *
 * D1 (the black full-bleed rule under the pills) is deliberately absent: its
 * only open question is @designerbot's `border-accent` vs
 * `border-b-2 border-edge-muted` colour call, and nothing ships until that
 * lands. D1's checks ride along with D1.
 *
 * The seed is Mark-shaped: 24 monthly bills (Aug 2024 → Jul 2026) plus
 * readings running into the current month so the projection gate opens — the
 * same fixture the spec's screenshots were taken against.
 */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 427, height: 952 },
];

/**
 * Seed 24 UsageSummary bills into localStorage. Runs in the page, so it must
 * be self-contained: no closures over Node values.
 *
 * Bills are anchored 24 months back from LAST month, so the fixture stays
 * "24 closed bills + an open current month" whenever the suite runs.
 */
function seedBills() {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const ymd = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
  const meas = (v: number) => ({ scaled: round2(v), value: round2(v), powerOfTenMultiplier: 0, uom: 72 });
  const item = (note: string, amount: number | null, measurement?: ReturnType<typeof meas> | null) => ({
    note,
    amount,
    rawAmount: amount === null ? null : Math.round(amount * 10000),
    itemKind: null,
    unitCost: null,
    measurement: measurement || null,
  });

  const now = new Date();
  const bills = [];
  for (let i = 0; i < 24; i++) {
    // 24 monthly bills ending last month.
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - (23 - i), 1));
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth();
    const start = Date.UTC(y, m, 1) / 1000;
    const duration = 28 * 86400;
    const summer = m >= 4 && m <= 9;
    const kwh = round2((summer ? 1250 : 880) + 120 * Math.sin(i * 1.7));
    const rate = round2(8.5 + 2.2 * Math.sin(i * 0.9) + (summer ? 1.1 : 0));
    const commodity = round2((kwh * rate) / 100);
    const delivery = round2(36 + 0.0252 * kwh);
    const regulatory = round2(45.15);
    const total = round2(commodity + delivery + regulatory);
    const tax = round2(total * 0.13);
    bills.push({
      source: 'UsageSummary',
      start,
      duration,
      startDate: ymd(start),
      endDate: ymd(start + duration),
      days: 28,
      billLastPeriod: duration,
      billToDate: 0,
      costAdditionalLastPeriod: 0,
      currency: 124,
      consumption: meas(kwh),
      items: [
        item('Total Electricity Charges', total, null),
        item('Electricity Commodity', commodity, null),
        item('Delivery', delivery, null),
        item('Regulatory Charges', regulatory, null),
        item('HST', tax, null),
        item('Off Peak Usage', null, meas(round2(kwh * 0.55))),
        item('Mid Peak Usage', null, meas(round2(kwh * 0.2))),
        item('On Peak Usage', null, meas(round2(kwh * 0.25))),
      ],
    });
  }
  localStorage.setItem('usage_summaries', JSON.stringify(bills));

  // Carry the example-data readings into the current month so the projection
  // banner has a month to project (day-of-month gate opens after day 5).
  const payload = JSON.parse(localStorage.getItem('energy_data_v2') || 'null');
  if (payload && Array.isArray(payload.points) && payload.points.length > 0) {
    let ts = payload.points[payload.points.length - 1].timestamp;
    const target = Math.floor(Date.now() / 1000);
    let guard = 0;
    while (ts < target && guard++ < 500) {
      ts += 6 * 3600;
      payload.points.push({ timestamp: ts, usage_kwh: 0.28 + 0.18 * Math.sin(ts / 9000) });
    }
    localStorage.setItem('energy_data_v2', JSON.stringify(payload));
  }
  return { bills: bills.length, points: payload?.points?.length ?? 0 };
}

/** Land, take the example dataset, overlay the 24-bill fixture, reload. */
async function seedAndReload(page: Page) {
  await page.goto('/');
  await page.getByTestId('try-example-data').click();
  await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 });
  const seeded = await page.evaluate(seedBills);
  expect(seeded.bills, 'fixture bills written').toBe(24);
  expect(seeded.points, 'readings carried into the current month').toBeGreaterThan(8760);

  await page.reload();
  await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 });
  await page.getByTestId('efficiency-chart').waitFor({ timeout: 60_000 });
  await page.getByTestId('bill-projection').waitFor({ timeout: 60_000 });
  // The compensated size is measured by a ResizeObserver on the svg; give it
  // a frame to land before anything reads a bounding box.
  await page.waitForTimeout(500);
}

/** D2 — clearance between the selected pill's hard blue shadow and its neighbour. */
async function measureD2(page: Page) {
  return page.evaluate(() => {
    const active = document.querySelector('[role="tab"][data-active="true"]');
    const list = active?.parentElement;
    if (!active || !list) return null;
    const pills = [...list.querySelectorAll('[role="tab"]')];
    const index = pills.indexOf(active as HTMLButtonElement);
    const next = pills[index + 1];
    if (!next) return null;
    const cs = getComputedStyle(active as Element);
    const shadow = /rgb\(37,\s*99,\s*235\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(cs.boxShadow);
    const offset = shadow ? Math.abs(parseFloat(shadow[1])) : 0;
    const a = active.getBoundingClientRect();
    const n = next.getBoundingClientRect();
    return {
      shadow: cs.boxShadow,
      pillGap: n.left - a.right,
      shadowClearance: n.left - (a.right + offset),
      focusVisible: (active as HTMLElement).matches(':focus-visible'),
      offset,
    };
  });
}

/** D3 — every label legible, none overlapping, each season word inside its band. */
async function measureD3(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="efficiency-chart"]') as SVGSVGElement | null;
    if (!svg) return null;
    const svgBox = svg.getBoundingClientRect();
    const texts = [...svg.querySelectorAll('text')].map((t) => {
      const r = t.getBoundingClientRect();
      return {
        text: t.textContent || '',
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        fontSize: getComputedStyle(t).fontSize,
        anchor: t.getAttribute('text-anchor'),
      };
    });

    const overlaps: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const b = texts[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) overlaps.push(`"${a.text}" × "${b.text}" (${ox.toFixed(1)}×${oy.toFixed(1)}px)`);
      }
    }

    const bands = [...svg.querySelectorAll('[data-testid="efficiency-season-band"]')].map((rect) => {
      const rb = rect.getBoundingClientRect();
      const label = (rect.closest('g') as Element | null)?.querySelector('text') || null;
      const lb = label?.getBoundingClientRect() || null;
      return {
        season: rect.getAttribute('data-season'),
        width: rb.width,
        units: Number(rect.getAttribute('width')),
        x1: Number(rect.getAttribute('x')),
        bars: 0,
        x2: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')),
        label: label?.textContent || null,
        escapes: lb
          ? lb.left < rb.left - 1 ||
            lb.right > rb.right + 1 ||
            lb.top < rb.top - 1 ||
            lb.bottom > rb.bottom + 1
          : false,
      };
    });
    // Bill count per band: the bands tile the plot, so one bill's worth of
    // width is the span divided by the number of periods. That is what the
    // pre-D3 `bars >= 3` gate counted, and it is how the desktop assertion
    // below compares the new fit test against the old rule.
    const n = Number(svg.getAttribute('data-points')) || 0;
    const step = n > 0 && bands.length ? (bands[bands.length - 1].x2 - bands[0].x1) / n : 0;
    for (const b of bands) b.bars = step > 0 ? Math.round(b.units / step) : 0;

    // The spec's own guards: nothing clipped by the svg box either.
    const clipped = texts.filter((t) => t.x < svgBox.left - 1 || t.x + t.w > svgBox.right + 1);

    const heights = texts.map((t) => t.h);
    return {
      svgWidth: svgBox.width,
      count: texts.length,
      minHeight: heights.length ? Math.min(...heights) : 0,
      fontSizes: [...new Set(texts.map((t) => parseFloat(t.fontSize)))],
      overlaps,
      clipped: clipped.map((t) => t.text),
      bands: bands.map((b) => ({ ...b, step: step })),
      escapedBands: bands.filter((b) => b.escapes).length,
      labelledBands: bands.filter((b) => b.label).length,
    };
  });
}

/** D4 — at max scroll the last card must clear the OS gesture bar. */
async function measureD4(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const card = document.querySelector('[data-testid="bill-projection"]');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return {
      state: card.getAttribute('data-state'),
      bottom: r.bottom,
      viewport: window.innerHeight,
      clearance: window.innerHeight - r.bottom,
      fullyVisible: r.bottom <= window.innerHeight && r.top >= 0,
      bodyPadBottom: getComputedStyle(document.body).paddingBottom,
      maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      scrollY: Math.round(window.scrollY),
    };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`mobile defects @ ${vp.width}×${vp.height}`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });

    test(`D2 + D3 + D4 acceptance at ${vp.width}×${vp.height}`, async ({ page }) => {
      test.setTimeout(180_000);
      await seedAndReload(page);

      // --- D2: the blue sliver must keep its 5px of air. ---------------
      const d2 = await measureD2(page);
      expect(d2, 'a selected tab with a neighbour to its right').not.toBeNull();
      // The blue hard shadow is a deliberate language element (toolbar
      // buttons use shadow-hard-blue-4) — spacing, not colour, is the fix.
      expect(d2!.shadow).toContain('37, 99, 235');
      expect(d2!.focusVisible, 'the sliver was never the focus ring').toBe(false);
      expect(d2!.offset, '3px hard offset').toBe(3);
      expect(d2!.pillGap, 'gap-2 = 8px between pills').toBeGreaterThanOrEqual(8);
      // Shadow ends 3px into that gap → ≥5px of clear air (spec: ≥4px).
      expect(d2!.shadowClearance).toBeGreaterThanOrEqual(4);

      // --- D3: legible type, no collisions, labels inside their bands. --
      const d3 = await measureD3(page);
      expect(d3, 'the mini-line renders').not.toBeNull();
      expect(d3!.count, 'the fixture draws bands, axes, ticks and both period ends').toBeGreaterThanOrEqual(7);
      expect(d3!.minHeight, 'every label ≥ 8 CSS px').toBeGreaterThanOrEqual(8);
      expect(d3!.overlaps, 'no two label boxes may intersect').toEqual([]);
      expect(d3!.clipped, 'no label may leave the svg box').toEqual([]);
      expect(d3!.escapedBands, 'a rendered season label stays inside its band').toBe(0);

      // …and the size really is compensated for this width: the expected
      // user-unit size is what the same formula returns for the measured box.
      const expectedFs = Math.max(10, Math.round((9 * 720) / Math.max(1, d3!.svgWidth)));
      expect(d3!.fontSizes, `chart is ${d3!.svgWidth.toFixed(1)}px wide`).toEqual([expectedFs]);
      expect(expectedFs, 'mobile labels are compensated, not the desktop 10').toBeGreaterThan(10);
      // The 3-bar edge seasons are narrower than the word: the guard drops
      // them rather than letting them spill into the y-axis gutter.
      expect(d3!.bands.length).toBeGreaterThanOrEqual(3);
      expect(d3!.labelledBands).toBeGreaterThan(0);

      // --- D4: the last card clears the gesture bar at max scroll. ------
      const d4 = await measureD4(page);
      expect(d4, 'the projection banner renders').not.toBeNull();
      expect(d4!.state, 'fixture must open the projection gate').toBe('ready');
      expect(d4!.bodyPadBottom, 'body floor = max(2.5rem, env())').toBe('40px');
      expect(d4!.fullyVisible, 'the card is whole at max scroll').toBe(true);
      // The OS bar is 108 image px ÷ DPR 3.0 = 36 CSS px on Mark's device;
      // the spec's acceptance bar is ≥33px of clearance.
      expect(d4!.clearance, 'projection card bottom vs viewport bottom').toBeGreaterThanOrEqual(33);
      expect(d4!.scrollY, 'we really were at max scroll').toBe(d4!.maxScroll);
    });
  });
}

test.describe('desktop must not change', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('labels resolve to the pre-D3 literal size at default widths', async ({ page }) => {
    test.setTimeout(180_000);
    await seedAndReload(page);

    const d3 = await measureD3(page);
    expect(d3).not.toBeNull();
    // ≥768px layout measures a chart ≥648px wide → chartLabelFs floors at 10,
    // which is exactly the literal every one of these labels carried before.
    expect(d3!.svgWidth).toBeGreaterThanOrEqual(648);
    expect(d3!.fontSizes).toEqual([10]);
    expect(d3!.overlaps).toEqual([]);
    expect(d3!.escapedBands).toBe(0);
    expect(d3!.minHeight).toBeGreaterThanOrEqual(8);
    // The fixture's edge seasons are narrow (1 bill wide this month) and
    // carry no label — exactly what the pre-D3 `bars >= 3` gate did. What
    // the spec's one-directional bar demands: every band the OLD gate
    // labelled still has its label, and every band that gained one fits it.
    const legacy = d3!.bands.filter((b) => b.bars >= 3);
    expect(legacy.length, 'the fixture must actually exercise the gate').toBeGreaterThanOrEqual(3);
    expect(legacy.filter((b) => !b.label)).toEqual([]);
    expect(d3!.labelledBands).toBeGreaterThanOrEqual(legacy.length);
    // …and any band the fit test drops is genuinely too narrow: < 43 user
    // units is < 4.3 × labelFs at labelFs 10.
    for (const b of d3!.bands.filter((x) => !x.label)) expect(b.units).toBeLessThan(4.3 * 10);
  });
});
