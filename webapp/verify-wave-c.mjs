/* One-off: independent verification of the trend chart on the deployed stack. */
import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('https://electricity.markarslan.ca/', { waitUntil: 'networkidle' });

  // Seed 22 months of daily readings (Jan 2025 → Oct 2026), winter/summer split.
  await page.evaluate(() => {
    const pts = [];
    const start = new Date(2025, 0, 1).getTime() / 1000;
    const end = new Date(2026, 9, 1).getTime() / 1000;
    for (let ts = start; ts <= end; ts += 86400) {
      const m = new Date(ts * 1000).getMonth();
      const seasonal = m >= 10 || m <= 3 ? 1.4 : 0.8;
      pts.push({ timestamp: ts + 43200, usage_kwh: Math.round(seasonal * 24 * 100) / 100 });
    }
    localStorage.setItem('energy_data', JSON.stringify(pts));
    localStorage.setItem('billing_day', '1');
    sessionStorage.setItem('oeb_staleness_check', JSON.stringify({ stale: null }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'INSIGHTS' }).click();
  await page.waitForSelector('[data-testid="trend-chart"]', { timeout: 10000 });
  await page.waitForTimeout(2500); // let recharts mount + animate

  const chart = page.locator('[data-testid="trend-chart"]');
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await chart.screenshot({ path: 'evidence/wave-c-trend-chart.png' });

  const panel = page.locator('[data-testid="trend-panel"]');
  await panel.screenshot({ path: 'evidence/wave-c-trend-panel.png' });

  // Also capture the staleness banner in its stale state.
  await page.evaluate(() => {
    sessionStorage.setItem('oeb_staleness_check', JSON.stringify({
      stale: {
        oebEffectiveDate: '2026-11-01',
        shippedEffectiveDate: '2025-11-01',
        newSet: {
          effectiveDate: '2026-11-01',
          tou: { offPeak: 10.5, midPeak: 16.5, onPeak: 22.5 },
          tiered: { tier1: 12.8, tier2: 15.1, thresholdWinter: 1000, thresholdSummer: 600 },
          ulo: { overnight: 4.2, weekendOffPeak: 10.5, midPeak: 16.5, onPeak: 41.0 },
        },
        deltas: [
          { plan: 'TOU', label: 'Off-Peak', current: 9.8, next: 10.5 },
          { plan: 'TOU', label: 'On-Peak', current: 20.3, next: 22.5 },
          { plan: 'Tiered', label: 'Tier 1', current: 12.0, next: 12.8 },
        ],
      },
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="rate-staleness-banner"]', { timeout: 10000 });
  const banner = page.locator('[data-testid="rate-staleness-banner"]');
  await banner.screenshot({ path: 'evidence/wave-c-staleness-banner.png' });

  // DOM facts for the record.
  await page.getByRole('button', { name: 'INSIGHTS' }).click();
  await page.waitForSelector('[data-testid="trend-chart"]', { timeout: 10000 });
  await page.waitForTimeout(2500);
  const facts = await page.evaluate(() => {
    const rc = document.querySelector('[data-testid="trend-chart"] .recharts-responsive-container');
    const svg = rc ? [...rc.querySelectorAll('svg.recharts-surface')].find(s => +s.getAttribute('width') > 100) : null;
    const bars = svg ? [...svg.querySelectorAll('path[fill="#2563EB"], path[fill="#F97316"]')] : [];
    return {
      svg: svg ? `${svg.getAttribute('width')}x${svg.getAttribute('height')}` : null,
      bars: bars.length,
      sampleBar: bars[0] ? bars[0].getAttribute('d') : null,
      legend: rc?.querySelector('.recharts-legend-wrapper')?.textContent ?? null,
      deltas: document.querySelector('[data-testid="trend-deltas"]')?.textContent.slice(0, 120) ?? null,
      boundaries: document.querySelector('[data-testid="trend-boundaries"]')?.textContent.slice(0, 160) ?? null,
      banner: !!document.querySelector('[data-testid="rate-staleness-banner"]'),
      sessionCheck: sessionStorage.getItem('oeb_staleness_check'),
    };
  });
  console.log(JSON.stringify(facts, null, 2));
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
