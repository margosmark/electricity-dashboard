/**
 * The Mark-shaped dashboard seed — the ONE fixture a spec should use when it
 * needs a real dashboard rather than an empty shell.
 *
 * Why it is shared rather than copied: two gate holes in this suite had the
 * same cause. `theme-contrast.spec.ts` walked a data-gated tree (nothing opens
 * `projection.ready`, so BillProjectionBanner never rendered — and the walk
 * reported "0 failures in dark" over a page the defect lived on), and the
 * ChartView header row had no geometry probe at all. A seed that lives in one
 * place is a seed that can be FIXED in one place: the specs that need this
 * shape import it instead of each growing their own.
 *
 * The shape (from t_fcbba376): 24 monthly bills Aug 2024 → Jul 2026 plus the
 * example dataset's readings carried into the current month, so the projection
 * gate opens, the efficiency chart has 24 bills to plot, and the toolbar's
 * second row exists.
 */

import { expect, type Page } from '@playwright/test';

/**
 * Seed 24 UsageSummary bills into localStorage. Runs in the page, so it must
 * be self-contained: no closures over Node values.
 *
 * Bills are anchored 24 months back from LAST month, so the fixture stays
 * "24 closed bills + an open current month" whenever the suite runs.
 */
export function seedBills() {
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
export async function seedMarkShaped(page: Page) {
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

/**
 * Seed the Open-Meteo hourly cache so TempBandCard renders its 7 bars WITHOUT
 * network — same trick as the bills: write the storage the app reads.
 *
 * The series is synthetic but shaped like a Toronto year (-15 °C → +35 °C, one
 * annual sine) so every one of the 7 temperature bands gets hours: a ramp probe
 * that only ever sees three of the seven stops is furniture. It must cover the
 * readings' span exactly as `spanOfRows` computes it, or `readCache` rejects it
 * and the card silently renders "no data" instead of failing.
 */
export function seedTemps() {
  const payload = JSON.parse(localStorage.getItem('energy_data_v2') || 'null');
  const points: { timestamp: number }[] = payload?.points ?? [];
  if (points.length === 0) return { seeded: 0, bands: [] as string[] };
  const hourOf = (ts: number) => Math.floor(ts / 3600);
  const startHour = hourOf(points[0].timestamp);
  const endHour = hourOf(points[points.length - 1].timestamp);
  const values: number[] = [];
  for (let h = startHour; h <= endHour; h++) {
    // A deterministic SWEEP of the card's whole range inside any one-week
    // window — the default window is 7 days, so a fixture with a real
    // temperature SHAPE (an annual sine, or even a monthly one) leaves five of
    // the seven bar stops with zero hours and the ramp probe never sees them.
    // This is a rendering fixture, not weather: -15 °C at the start of each
    // 168-hour cycle, +35 °C at its end, ~24 hours in every band.
    const sweep = ((h % 168) + 168) % 168;
    values.push(Math.round((-15 + 50 * (sweep / 167)) * 10) / 10);
  }
  localStorage.setItem(
    'oeo_openmeteo_v1',
    JSON.stringify({ lat: 43.6532, lon: -79.3832, startHour, values, fetchedAt: Date.now() }),
  );
  const bands = [
    ...new Set(
      values.map((v) =>
        v < -10 ? 'lt-10' : v < 5 ? '-10..5' : v < 12 ? '5..12' : v < 18 ? '12..18' : v < 24 ? '18..24' : v < 30 ? '24..30' : 'gt-30',
      ),
    ),
  ];
  return { seeded: values.length, bands };
}

/**
 * The Mark-shaped dashboard PLUS temperatures — what the thermometer-ramp
 * probe needs, and nothing else needs. Reloads, because the hook reads the
 * cache on mount, and opens the USAGE tab, because the card lives inside the
 * panel: a panel that is not mounted has no bars to measure.
 */
export async function seedMarkShapedWithTemps(page: Page) {
  const seeded = await page.evaluate(seedTemps);
  expect(seeded.seeded, 'hourly temperatures written for the readings span').toBeGreaterThan(0);
  await page.reload();
  await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 });
  await page.getByTestId('tab-usage').click();
  await page.getByTestId('temp-band-bar').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  return seeded;
}
