/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const BASE = process.env.QUIET_METER_BASE_URL || 'http://127.0.0.1:3210/';
const OUT = path.resolve(__dirname, 'quiet-meter');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QUIET_METER_CHROMIUM || '/usr/bin/chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The dashboard can hold its own long-lived browser requests. The page's
  // interactive readiness is the tab navigation below, not network idleness.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('tab-nav').waitFor();
  if (!(await page.getByTestId('upload-modal').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Upload XML' }).click();
  }
  await page.getByTestId('try-example-data').click();
  await page.getByTestId('example-data-banner').waitFor();
  await page.getByTestId('tab-panel-overview').waitFor();
  const report = { screenshots: [], interactions: [], errors };

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.getByRole('radio', { name: new RegExp(`^${theme}`, 'i') }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        bars: document.querySelectorAll('[data-testid="rate-chart-bar"]').length,
        metrics: document.querySelectorAll('[data-testid="overview-key-figures"] > div').length,
        theme: document.documentElement.dataset.theme,
        activePanel: document.querySelector('[role="tabpanel"]')?.id,
        controlsBelow44: [...document.querySelectorAll('button,a,input,summary')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); })
          .map((el) => ({ tag: el.tagName, text: el.textContent?.trim().slice(0, 40), width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }))
      }));
      const file = `overview-${viewport.width}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: false });
      report.screenshots.push({ file, ...dimensions });
    }
  }

  const rateBar = page.getByTestId('rate-chart-bar').first();
  await rateBar.focus();
  const focusedReadout = await page.getByTestId('rate-chart-readout').innerText();
  report.interactions.push({ action: 'keyboard-focus-rate-bar', focusedReadout, accessibleName: await rateBar.getAttribute('aria-label') });
  await page.getByText(/View accessible data table/i).click();
  report.interactions.push({ action: 'open-rate-data-table', rows: await page.locator('[data-testid="rate-chart-table"] tbody tr').count() });
  await page.getByRole('tab', { name: 'Plans' }).click();
  report.interactions.push({ action: 'select-plans-tab', selected: await page.getByRole('tab', { name: 'Plans' }).getAttribute('aria-selected') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('radio', { name: /^dark/i }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, 'plans-1440-dark.png'), fullPage: false });
  report.screenshots.push({ file: 'plans-1440-dark.png', viewport: 1440, scroll: await page.evaluate(() => document.documentElement.scrollWidth), activePanel: await page.locator('[role="tabpanel"]').getAttribute('id') });
  await page.getByRole('tab', { name: 'Money' }).click();
  report.interactions.push({ action: 'select-money-tab', selected: await page.getByRole('tab', { name: 'Money' }).getAttribute('aria-selected') });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, 'money-1440-dark.png'), fullPage: false });
  report.screenshots.push({ file: 'money-1440-dark.png', viewport: 1440, scroll: await page.evaluate(() => document.documentElement.scrollWidth), activePanel: await page.locator('[role="tabpanel"]').getAttribute('id') });
  report.ok = report.screenshots.length === 6 && report.screenshots.every((shot) => shot.scroll <= shot.viewport) && report.screenshots.slice(0, 4).every((shot) => shot.metrics === 4 && shot.bars > 0) && report.errors.length === 0;
  fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (!report.ok) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
