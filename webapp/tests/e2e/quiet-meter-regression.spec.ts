/**
 * QUIET METER — real-app behavioural regression (t_f6c32622).
 *
 * This spec validates the RUNNING production build, never the static design
 * artifact: every assertion reads the live DOM of the app booted by
 * `webapp/scripts/e2e-quiet-meter-regression.sh`. It is deliberately
 * independent of `webapp/evidence/quiet-meter-verify.cjs` (the implementation
 * run's own harness): different code, different assertions, same app.
 *
 * What it holds the redesign to, and HOW each claim is made:
 *
 *  - Tab contract        — exactly Overview / Analytics / Plans / Money exist
 *                          as tabs; no Usage tab; selecting one swaps exactly
 *                          its panel; arrow/Home/End keys move focus AND
 *                          selection; the Overview analytics door routes to
 *                          the Analytics panel; the retired `#tab=usage`
 *                          deep link lands on Analytics.
 *  - Themes              — the radiogroup repaints html[data-theme], the page
 *                          background actually changes, the choice survives a
 *                          reload, and NO console/page error is raised.
 *  - Overview figures    — the four summary figures are asserted as RELATION-
 *                          SHIPS against the app's own source/model outputs
 *                          (identical to the dataset strip / efficiency strip /
 *                          projection banner / plan cards), never against
 *                          Designer sample literals. The plan figure is
 *                          checked as an argmin: cheapest alternative ==
 *                          argmin of the window costs, saving == current −
 *                          argmin and never negative.
 *  - Projection honesty  — two data states: the seeded full-data state (gate
 *                          open → amount + inline PROVISIONAL marker) and a
 *                          truncated-readings state (gate closed → gate note,
 *                          no fabricated amount).
 *  - Rate-by-month chart 0,2,…,14 — gridline labels, keyboard-focusable named
 *                          marks, focus/hover driving the live readout, and a
 *                          semantic <table> whose rows correspond 1:1 with the
 *                          marks in order.
 *  - Attention surface   — no attention item in a clean state; the conditional
 *                          rate alert state renders exactly one item carrying
 *                          both effective dates. Neither surface offers a fix
 *                          action by design (rate publication is maintained
 *                          separately, and the unit suite forbids external
 *                          rates URLs) — the Money alert keeps the ordering
 *                          decomposition → alert → pace.
 *  - Money ordering      — when the rate alert state exists, the alert sits
 *                          AFTER the bill decomposition and BEFORE the pace.
 *  - 390×844 geometry    — no document horizontal overflow and no interactive
 *                          target under 44px, dark and light, plus the four
 *                          durable screenshots (1440×900 / 390×844 × light/dark).
 *
 * Data: the app's own example Green Button dataset (public/samples/
 * example-usage.xml, taken through the app's real "Try example data" path) plus
 * the shared Mark-shaped bill overlay from `./mark-seed` — real fixture data,
 * written through the app's own storage contract. No production file is touched
 * to make any of this pass.
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { seedMarkShaped } from './mark-seed';

const EVIDENCE_DIR =
  process.env.QM_EVIDENCE_DIR || path.resolve(__dirname, '../../evidence/quiet-meter-regression');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

/** en-CA currency: "$1,234.56" → 1234.56 */
const money = (text: string): number => Number(text.replace(/[^0-9.]/g, ''));
const moneyLike = /^\$[\d,]+\.\d{2}$/;

const PLAN_BY_CARD_NAME: Record<string, 'TOU' | 'Tiered' | 'ULO'> = {
  'Use the Time-of-Use plan': 'TOU',
  'Use the Tiered Pricing plan': 'Tiered',
  'Use the Ultra-Low Overnight plan': 'ULO',
};

/* ------------------------------------------------------------------ errors */

/** Every exemption the whole run relied on, printed into the evidence report. */
const EXEMPTED = new Set<string>();

type Watched = { pageErrors: string[]; consoleErrors: string[]; exempted: string[] };

function isLocalUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Uncaught exceptions always count. Console errors count too — the ONLY
 * exemption is a resource-load failure pointing OUTSIDE the app, because a
 * third-party feed (Open-Meteo) going away must not masquerade as a UI defect.
 * Everything exempted is still printed into the evidence report.
 */
function watchErrors(page: Page): Watched {
  const watched: Watched = { pageErrors: [], consoleErrors: [], exempted: [] };
  page.on('pageerror', (error) => watched.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location()?.url ?? '';
    const text = message.text();
    // Third-party feed outage: not this app's regression, but recorded.
    if (/Failed to load resource|net::ERR|fetch failed|Load failed|AbortError/i.test(text) && !isLocalUrl(url)) {
      watched.exempted.push(`external: ${text} @ ${url}`);
      return;
    }
    // `next start` serves no account backend, so the account feature's session
    // and notification probes answer 404 on every load. That is deployment
    // topology, not a UI defect — but ONLY a 404 on those two probe paths is
    // exempt, and every exemption is printed into the evidence report.
    if (/status of 404 \(Not Found\)/.test(text) && /\/account\/(session|notify)/.test(url)) {
      watched.exempted.push(`no-account-backend: ${text} @ ${url}`);
      return;
    }
    watched.consoleErrors.push(`${text} @ ${url}`);
  });
  return watched;
}

function expectNoAppErrors(watched: Watched, where: string) {
  for (const entry of watched.exempted) EXEMPTED.add(entry);
  expect(watched.pageErrors, `${where}: uncaught page errors`).toEqual([]);
  expect(watched.consoleErrors, `${where}: console errors`).toEqual([]);
}

/* ------------------------------------------------------------------- state */

/** Full data state: example readings + 24 closed bills + a live current month. */
async function loadSeededDashboard(page: Page) {
  await seedMarkShaped(page);
}

/** The four Overview summary tiles, addressed by their label. */
function keyFigure(page: Page, label: RegExp) {
  return page.locator('[data-testid="overview-key-figures"] > div').filter({ hasText: label }).first();
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('radio', { name: new RegExp(`^${theme}$`, 'i') }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Paint the new theme before anything reads geometry or a screenshot.
  await page.waitForTimeout(200);
}

async function selectTab(page: Page, name: 'Overview' | 'Analytics' | 'Plans' | 'Money') {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId(`tab-panel-${name.toLowerCase()}`).waitFor();
}

/* ============================================================ 1. tab strip */

test('tab strip offers exactly Overview / Analytics / Plans / Money, and no Usage tab', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);

  const tabs = page.getByTestId('tab-nav').getByRole('tab');
  await expect(tabs).toHaveCount(4);
  expect(await tabs.allInnerTexts()).toEqual(['Overview', 'Analytics', 'Plans', 'Money']);

  // "No Usage tab" is a DOM claim, not a copy claim: nothing in the strip
  // offers it, and the element id the old tab used to own does not exist —
  // the analysis destination is now called Analytics.
  await expect(page.getByTestId('tab-nav').getByRole('tab', { name: /^usage$/i })).toHaveCount(0);
  expect(await page.locator('#tab-usage, #panel-usage').count()).toBe(0);

  // A deep link that still speaks the retired name must land on its
  // successor — Analytics — never resurrect the old tab or fall back to
  // Overview. Cold load (reload, not a same-document hash change) — that is
  // the shape a shared link actually arrives in.
  await page.goto('/#tab=usage');
  await page.reload();
  await page.getByTestId('tab-panel-analytics').waitFor();
  await expect(page.getByTestId('tab-panel-overview')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => location.hash)).toBe('#tab=analytics');

  expectNoAppErrors(watched, 'tab strip');
});

test('selecting a tab swaps exactly its panel, and keys walk the strip', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);

  for (const name of ['Overview', 'Analytics', 'Plans', 'Money'] as const) {
    const id = name.toLowerCase();
    await selectTab(page, name);
    const tab = page.getByTestId(`tab-${id}`);
    const panel = page.getByTestId(`tab-panel-${id}`);

    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', `tab-${id}`);
    await expect(tab).toHaveAttribute('aria-controls', `panel-${id}`);
    // Only one panel exists at a time — an inactive tab is not in the DOM.
    expect(await page.locator('[role="tabpanel"]').count()).toBe(1);
    expect(await page.locator('[role="tabpanel"]').first().getAttribute('id')).toBe(`panel-${id}`);
    // Roving tabindex: one stop for the whole strip.
    expect(await page.getByTestId('tab-nav').getByRole('tab').evaluateAll((els) =>
      els.filter((el) => el.getAttribute('tabindex') === '0').length,
    )).toBe(1);
  }

  // Keyboard: arrows move focus AND selection (WAI-ARIA tabs pattern).
  await selectTab(page, 'Overview');
  await page.getByTestId('tab-overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tab-analytics')).toBeFocused();
  await expect(page.getByTestId('tab-analytics')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tab-plans')).toBeFocused();
  await expect(page.getByTestId('tab-plans')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tab-money')).toBeFocused();
  await expect(page.getByTestId('tab-money')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('tab-plans')).toBeFocused();
  await expect(page.getByTestId('tab-plans')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByTestId('tab-money')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('tab-overview')).toBeFocused();
  await expect(page.getByTestId('tab-overview')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-panel-overview')).toBeVisible();

  expectNoAppErrors(watched, 'tab keyboard');
});

test('the Overview analytics door routes to the Analytics panel and back', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);

  // The door is on Overview itself, in the decision flow — always visible,
  // because that is how you reach the analysis from the answer screen.
  const cta = page.getByTestId('overview-analytics-cta');
  await expect(cta).toBeVisible();
  await cta.click();

  await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('tab-panel-analytics');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('#tab=analytics');
  // Exactly one panel: the door swaps Overview out, it does not stack.
  expect(await page.locator('[role="tabpanel"]').count()).toBe(1);

  // The destination is the real analysis, framed by its own questions —
  // not an empty chart shell.
  await expect(panel.getByText('When do you use power?')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Usage Anomalies' })).toBeVisible();
  await expect(page.getByTestId('chart-view')).toBeVisible();

  expectNoAppErrors(watched, 'analytics door');
});

/* ============================================================== 2. themes */

test('light and dark both paint the dashboard, persist, and raise no errors', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);
  await page.setViewportSize(DESKTOP);

  const painted = async () => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
    ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
  }));

  const light = await painted();
  expect(light.theme).toBe('light');
  const darkBefore = light;

  await setTheme(page, 'dark');
  const dark = await painted();
  expect(dark.theme).toBe('dark');
  expect(dark.background, 'dark repaints a different page background').not.toBe(darkBefore.background);
  expect(dark.ink, 'the ink token flips with the theme').not.toBe(darkBefore.ink);
  // The dashboard itself is on screen in dark, not just the chrome.
  await expect(page.getByTestId('overview-key-figures')).toBeVisible();
  await expect(page.getByTestId('rate-by-month')).toBeVisible();

  // The choice survives a reload (localStorage contract).
  await page.reload();
  await page.getByTestId('tab-panel-overview').waitFor();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await setTheme(page, 'light');
  const lightAgain = await painted();
  expect(lightAgain.theme).toBe('light');
  expect(lightAgain.background).not.toBe(dark.background);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  expectNoAppErrors(watched, 'theme toggle');
});

/* ============================================================ 3. overview */

test('Overview: period heading and four source-derived figures agree with their sources', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);
  await page.setViewportSize(DESKTOP);

  // Period heading
  const heading = page.getByTestId('overview-period-heading');
  await expect(heading).toBeVisible();
  await expect(heading.locator('h1')).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
  await expect(heading.locator('p').first()).toContainText(/Billing period|Whole dataset/);

  // Exactly four figures
  const figures = page.locator('[data-testid="overview-key-figures"] > div');
  await expect(figures).toHaveCount(4);
  for (const label of [/Usage to date/, /Average rate/, /This month/, /Current plan cost/]) {
    await expect(keyFigure(page, label)).toBeVisible();
  }

  // 1. Usage to date — the SAME source total the dataset strip prints.
  const usageTile = keyFigure(page, /Usage to date/).locator('.quiet-overview-value');
  const stripKwh = page.locator('[data-testid="totals-strip"] .quiet-data-stat').first().locator('div').nth(1);
  expect(await usageTile.innerText()).toBe(await stripKwh.innerText());
  expect(await usageTile.innerText()).toMatch(/^[\d,]+ kWh$/);

  // 2. Average rate — the same ¢/kWh the efficiency strip publishes.
  const rateTile = keyFigure(page, /Average rate/).locator('.quiet-overview-value');
  const efficiencyStrip = page.getByTestId('efficiency-all-time-strip');
  const stripCents = await efficiencyStrip.getAttribute('data-cents');
  expect(stripCents, 'efficiency strip carries its measured value').toBeTruthy();
  expect(await rateTile.innerText()).toBe(`${Number(stripCents).toFixed(1)}¢`);

  // 3. This month's bill — the projection banner's own amount, gate permitting.
  const billTile = keyFigure(page, /This month/);
  const billValue = billTile.locator('.quiet-overview-value');
  const banner = page.getByTestId('bill-projection');
  await expect(banner).toHaveAttribute('data-state', 'ready');
  const amount = await page.getByTestId('bill-projection-amount').innerText();
  expect(amount).toMatch(moneyLike);
  expect(await billValue.innerText(), 'tile restates the banner amount').toBe(amount);

  // The projection is never dressed as a settled bill: the provisional marker
  // sits inline with the amount, in the same container.
  const provisional = page.getByTestId('bill-projection-provisional');
  await expect(provisional).toBeVisible();
  expect(
    await page.evaluate(() => {
      const amountEl = document.querySelector('[data-testid="bill-projection-amount"]');
      const badge = document.querySelector('[data-testid="bill-projection-provisional"]');
      return Boolean(amountEl && badge && amountEl.parentElement === badge.parentElement);
    }),
    'the provisional marker is inline with the projected amount',
  ).toBe(true);
  // "days measured" is a real fraction of the month, never more than the month.
  const measured = await banner
    .locator('div', { hasText: /^\d+\/\d+$/ })
    .first()
    .innerText();
  const [covered, daysInMonth] = measured.replace(/[^0-9/]/g, '').split('/').map(Number);
  expect(covered).toBeGreaterThan(0);
  expect(covered).toBeLessThanOrEqual(daysInMonth);

  // 4. Current plan cost — the plan card's own window cost for the active plan.
  const planTileValue = keyFigure(page, /Current plan cost/).locator('.quiet-overview-value');
  const planCost = await planTileValue.innerText();
  expect(planCost).toMatch(moneyLike);
  await selectTab(page, 'Plans');
  const activeCard = page
    .locator('[role="button"][aria-pressed="true"]')
    .filter({ hasText: /YOUR PLAN|ACTIVE/ })
    .first();
  expect(await activeCard.locator('div.tabular-nums').first().innerText()).toBe(planCost);

  expectNoAppErrors(watched, 'overview figures');
});

test('Overview: rate-by-month 0…14 grid, focusable marks, live readout, semantic table', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);
  await page.setViewportSize(DESKTOP);

  const chart = page.getByTestId('rate-by-month');
  await expect(chart).toBeVisible();

  // The axis: eight gridlines labelled 0,2,…,14 cents per kWh.
  const gridLabels = await page.getByTestId('rate-chart-svg').locator('text').evaluateAll((nodes) =>
    nodes
      .filter((node) => node.getAttribute('x') === '48' && /^\d+$/.test(node.textContent ?? ''))
      .map((node) => Number(node.textContent)),
  );
  expect(gridLabels).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);

  // Every mark is keyboard-focusable and names its own month, rate and kWh.
  const bars = page.getByTestId('rate-chart-bar');
  const count = await bars.count();
  expect(count, 'the chart plots the months in the window').toBeGreaterThan(0);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const bar = bars.nth(i);
    await expect(bar).toHaveAttribute('tabindex', '0');
    await expect(bar).toHaveAttribute('role', 'img');
    const label = await bar.getAttribute('aria-label');
    expect(label, `mark ${i} names itself`).toMatch(/^[A-Z]{3} \d{2}: [\d.]+¢ average rate across \d+ kilowatt-hours$/);
    names.push(label!);
  }

  // The subtitle's month count is the mark count.
  await expect(chart).toContainText(`${count} months`);

  // Focus and hover both drive the live readout.
  const readout = page.getByTestId('rate-chart-readout');
  const readoutOf = (label: string) => {
    const [, month, rate] = /^([^:]+): ([\d.]+¢)/.exec(label)!;
    return { month, rate };
  };

  await bars.first().focus();
  const first = readoutOf(names[0]);
  await expect(readout).toContainText(first.month);
  await expect(readout).toContainText(first.rate);
  const focusedReadout = await readout.innerText();

  const middle = Math.floor(count / 2);
  await bars.nth(middle).hover();
  const hovered = readoutOf(names[middle]);
  await expect(readout).toContainText(hovered.month);
  await expect(readout).toContainText(hovered.rate);
  const hoveredReadout = await readout.innerText();
  expect(hoveredReadout, 'hover changes the readout').not.toBe(focusedReadout);

  // The semantic companion table corresponds to the series, mark for mark.
  await chart.getByText('View accessible data table').click();
  const rows = page.getByTestId('rate-chart-table').locator('tbody tr');
  await expect(rows).toHaveCount(count);
  for (let i = 0; i < count; i++) {
    const { month, rate } = readoutOf(names[i]);
    await expect(rows.nth(i).locator('th')).toHaveText(month);
    expect(await rows.nth(i).locator('td').first().innerText()).toBe(rate);
    expect(await rows.nth(i).locator('td').nth(1).innerText()).toMatch(/^[\d,]+$/);
  }

  expectNoAppErrors(watched, 'rate by month');
});

test('Overview: Your plan / Needs attention — argmin verdict, remedies only when real', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);
  await page.setViewportSize(DESKTOP);

  const planSummary = page.getByTestId('overview-plan-summary');
  const attention = page.getByTestId('overview-attention');
  await expect(planSummary).toBeVisible();
  await expect(planSummary.getByRole('heading', { name: 'Your plan' })).toBeVisible();
  await expect(attention).toBeVisible();
  await expect(attention.getByRole('heading', { name: 'Needs attention' })).toBeVisible();

  // Clean state: nothing is rendered as needing attention, and it says so.
  await expect(attention.locator('li')).toHaveCount(0);
  await expect(attention).toContainText('No items need attention right now.');

  // The verdict, as a MODEL relationship — cheapest alternative is the argmin
  // of the window costs the Plans tab shows, and the saving is current − argmin.
  const banner = page.getByTestId('best-choice-banner');
  const currentPlan = (await banner.getAttribute('data-current-plan')) as keyof typeof PLAN_BY_CARD_NAME;
  const bestPlan = (await banner.getAttribute('data-best-plan')) as 'TOU' | 'Tiered' | 'ULO';
  const alreadyBest = (await banner.getAttribute('data-already-best')) === 'true';

  await selectTab(page, 'Plans');
  const costs = new Map<string, number>();
  for (const [ariaLabel, plan] of Object.entries(PLAN_BY_CARD_NAME)) {
    const card = page.getByRole('button', { name: ariaLabel });
    const value = await card.locator('div.tabular-nums').first().innerText();
    expect(value, `plan card ${plan} states a window cost`).toMatch(moneyLike);
    costs.set(plan, money(value));
  }
  const argmin = [...costs.entries()].sort((a, b) => a[1] - b[1])[0];
  expect(argmin[0], 'cheapest alternative is the argmin of the window costs').toBe(bestPlan);
  const currentCost = costs.get(currentPlan)!;
  const expectedSaving = Math.max(0, currentCost - argmin[1]);

  await selectTab(page, 'Overview');
  const alternative = planSummary.locator('dt:text-is("Cheapest alternative") + dd');
  const saving = planSummary.locator('dt:text-is("Potential saving on this range") + dd');
  expect(await alternative.innerText()).not.toBe('—');
  expect(await saving.innerText()).toMatch(moneyLike);
  expect(
    Math.abs(money(await saving.innerText()) - expectedSaving),
    'saving is current − argmin',
  ).toBeLessThan(0.011);
  expect(money(await saving.innerText()), 'saving is never negative').toBeGreaterThanOrEqual(0);
  if (alreadyBest) {
    expect(money(await saving.innerText()), 'already on the winner → nothing to save').toBe(0);
    await expect(saving).toHaveText('$0.00');
  }

  // Whole-dataset chips carry the same argmin property, in their own scope.
  const chips = { TOU: 'plan-cost-TOU', Tiered: 'plan-cost-Tiered', ULO: 'plan-cost-ULO' } as const;
  const totalsStrip = page.getByTestId('totals-strip');
  const chipCosts = new Map<string, number>();
  for (const [plan, testid] of Object.entries(chips)) {
    const chip = totalsStrip.getByTestId(testid);
    // Direct children only: the chip's value div wraps a unit span, and a
    // descendant-wide `div` walk would drift as soon as a chip nests.
    chipCosts.set(plan, money(await chip.locator(':scope > div').nth(1).innerText()));
  }
  const ranked = [...chipCosts.entries()].sort((a, b) => a[1] - b[1]);
  expect(await totalsStrip.getAttribute('data-best-plan'), 'strip names the argmin plan').toBe(ranked[0][0]);
  // `.quiet-data-stat` is the outer stat only — a plain `div` + hasText walk
  // also matches the label div INSIDE it (both contain the phrase), and the
  // "last" of those has no children to read.
  const bestVsWorstBlock = totalsStrip
    .locator(':scope > .quiet-data-stat')
    .filter({ hasText: 'Best vs worst plan' });
  await expect(bestVsWorstBlock, 'the stat block exists exactly once').toHaveCount(1);
  const bestVsWorst = money(await bestVsWorstBlock.locator(':scope > div').nth(1).innerText());
  expect(
    Math.abs(bestVsWorst - (ranked[ranked.length - 1][1] - ranked[0][1])),
    'best-vs-worst figure is argmax − argmin',
  ).toBeLessThan(0.06);
  const subtitle = await bestVsWorstBlock.locator(':scope > div').nth(2).innerText();
  const [worstLabel, bestLabel] = subtitle.split('−').map((part) => part.trim());
  const NAMES = { TOU: 'Time-of-Use', Tiered: 'Tiered Pricing', ULO: 'Ultra-Low Overnight' } as const;
  expect(worstLabel).toBe(NAMES[ranked[ranked.length - 1][0] as 'TOU' | 'Tiered' | 'ULO']);
  expect(bestLabel).toBe(NAMES[ranked[0][0] as 'TOU' | 'Tiered' | 'ULO']);

  // Every rendered attention item is held to its contract in the rate-alert
  // test below (the clean state here renders none, so this loop is vacuous —
  // but stays as the guard for whichever items ARE rendered, e.g. imports,
  // which must keep their /import remedy).
  const items = attention.locator('li');
  for (let i = 0; i < (await items.count()); i++) {
    expect(await items.nth(i).locator('a[href], button').count()).toBeGreaterThan(0);
  }

  expectNoAppErrors(watched, 'plan and attention');
});

/* ================================================= 4. alert state + Money */

test('rate-alert state: exactly one attention item with both rate dates, and Money orders it correctly', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);
  await page.setViewportSize(DESKTOP);

  // Clean Money tab first: the slots exist in decomposition → pace order and
  // no alert is manufactured when the state does not call for one.
  await selectTab(page, 'Money');
  await expect(page.getByTestId('money-decomposition-slot')).toBeVisible();
  await expect(page.getByTestId('money-pace-slot')).toBeVisible();
  expect(await page.getByTestId('money-rate-alert').count()).toBe(0);
  const cleanOrder = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="tab-panel-money"] [data-testid]')]
      .map((el) => el.getAttribute('data-testid')!),
  );
  expect(cleanOrder.indexOf('money-decomposition-slot')).toBeLessThan(cleanOrder.indexOf('money-pace-slot'));

  // Now put the app into the conditional-alert state through its OWN session
  // contract (src/hooks/useRateStaleness.ts reads this key back).
  await page.evaluate(() => {
    sessionStorage.setItem(
      'oeb_staleness_check',
      JSON.stringify({
        stale: {
          oebEffectiveDate: '2099-01-01',
          shippedEffectiveDate: '2026-05-01',
          newSet: null,
          deltas: [],
        },
      }),
    );
  });
  await page.reload();
  // The reload restores whichever tab was on screen (the app's own contract),
  // which is Money here — so wait for that panel, then walk back.
  await page.getByTestId('tab-panel-money').waitFor({ timeout: 60_000 });
  await selectTab(page, 'Overview');

  // Overview attention: exactly one real condition, stated with BOTH dates —
  // the fix-it link was deliberately removed (#124; the unit suite fails any
  // external rates URL here), so this item is informational and the remedy
  // for the same condition is Money's alert, asserted below.
  const attention = page.getByTestId('overview-attention');
  await expect(attention.locator('li')).toHaveCount(1);
  const dates = attention.getByTestId('overview-rate-dates');
  await expect(dates).toBeVisible();
  expect(await dates.innerText()).toContain('2099-01-01');
  expect(await dates.innerText()).toContain('2026-05-01');
  expect(
    await attention.locator('a[href*="github"], a[href*="/api/rates"]').count(),
    'no external rates URL on the attention surface',
  ).toBe(0);

  // Money: the alert renders, is announced, states both dates — and by
  // design carries no fix action of its own (see RateStalenessBanner) —
  // and it is ordered decomposition → alert → pace.
  await selectTab(page, 'Money');
  const alert = page.getByTestId('money-rate-alert');
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('alert')).toBeVisible();
  await expect(alert.getByTestId('banner-dates')).toContainText('2099-01-01');
  await expect(alert.getByTestId('banner-dates')).toContainText('2026-05-01');
  expect(
    await alert.locator('a[href], button').count(),
    'the banner offers no fix action (rate publication is maintained separately)',
  ).toBe(0);

  const order = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="tab-panel-money"] [data-testid]')]
      .map((el) => el.getAttribute('data-testid')!),
  );
  expect(order.indexOf('money-decomposition-slot'), 'alert comes after the decomposition').toBeLessThan(
    order.indexOf('money-rate-alert'),
  );
  expect(order.indexOf('money-rate-alert'), 'alert comes before the pace').toBeLessThan(
    order.indexOf('money-pace-slot'),
  );

  expectNoAppErrors(watched, 'rate alert state');
});

/* ======================================================= 5. projection gate */

test('projection gate closed: gate note instead of a fabricated number', async ({ page }) => {
  test.setTimeout(120_000);
  const watched = watchErrors(page);

  // The closed gate is exercised through the app's REAL upload path with a
  // utility fixture whose readings end months before the current month
  // (tests/fixtures/utility-hydro-one.xml: 2025-12-09 → 2025-12-10). No
  // storage surgery, no clock faking: the model sees a month it has no
  // readings for and must refuse to project.
  await page.goto('/');
  await page.getByTestId('tab-nav').waitFor();
  await expect(page.getByTestId('upload-modal')).toBeVisible();
  await page
    .getByLabel('Upload Green Button XML')
    .setInputFiles(path.resolve(__dirname, '../fixtures/utility-hydro-one.xml'));
  await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 });
  await page.getByTestId('bill-projection').waitFor({ timeout: 60_000 });

  // The premise, measured: the newest reading really is in an earlier month.
  const lastReading = await page.getByTestId('data-freshness-chip').getAttribute('data-last-reading');
  expect(lastReading).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(
    await page.evaluate((day) => new Date(`${day}T00:00:00`) < new Date(new Date().getFullYear(), new Date().getMonth(), 1), lastReading!),
    `newest reading ${lastReading} predates the current month`,
  ).toBe(true);

  const banner = page.getByTestId('bill-projection');
  await expect(banner).toHaveAttribute('data-state', 'gated');
  expect(await page.getByTestId('bill-projection-amount').count(), 'no amount is invented').toBe(0);
  expect(await page.getByTestId('bill-projection-provisional').count()).toBe(0);

  const gateNote = (await banner.locator('span').last().innerText()).trim();
  expect(gateNote.length, 'the gate states why').toBeGreaterThan(10);

  // The summary tile follows the model: an em-dash, plus the same reason.
  const billTile = keyFigure(page, /This month/);
  expect((await billTile.locator('.quiet-overview-value').innerText()).trim()).toBe('\u2014');
  expect((await billTile.locator('.quiet-overview-meta').innerText()).trim()).toBe(gateNote);

  expectNoAppErrors(watched, 'projection gate');
});

/* ==================================================== 6. geometry + evidence */

test('390×844 dark/light: no horizontal overflow, every target ≥44px, four screenshots', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const watched = watchErrors(page);
  await loadSeededDashboard(page);

  const geometry: Record<string, unknown> = {};
  const shots: string[] = [];

  for (const viewport of [DESKTOP, MOBILE]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByTestId('tab-panel-overview').waitFor();

      const measured = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        tabs: document.querySelectorAll('[data-testid="tab-nav"] [role="tab"]').length,
        undersized: [...document.querySelectorAll('button, a[href], input, summary, [role="button"], [role="tab"], [role="radio"]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            return rect.width < 44 || rect.height < 44;
          })
          .map((el) => ({
            tag: el.tagName,
            role: el.getAttribute('role'),
            text: (el.textContent ?? '').trim().slice(0, 48),
            width: Math.round(el.getBoundingClientRect().width),
            height: Math.round(el.getBoundingClientRect().height),
          })),
      }));

      expect(
        measured.scrollWidth,
        `${viewport.width} ${theme}: document overflow`,
      ).toBeLessThanOrEqual(measured.clientWidth + 1);
      expect(measured.tabs, `${viewport.width} ${theme}: four tabs in the strip`).toBe(4);
      expect(measured.undersized, `${viewport.width} ${theme}: targets under 44px`).toEqual([]);

      geometry[`${viewport.width}x${viewport.height}-${theme}`] = {
        clientWidth: measured.clientWidth,
        scrollWidth: measured.scrollWidth,
        targetsUnder44: measured.undersized.length,
      };

      const file = `overview-${viewport.width}-${theme}.png`;
      await page.screenshot({ path: path.join(EVIDENCE_DIR, file), fullPage: false });
      shots.push(path.join(EVIDENCE_DIR, file));
      testInfo.attach(file, { path: path.join(EVIDENCE_DIR, file), contentType: 'image/png' });
    }
  }

  const report = {
    task: 't_f6c32622',
    generatedAt: new Date().toISOString(),
    // The identity of the build these screenshots came from — recorded, never
    // assumed, because `.next` in a shared worktree can be rebuilt under you.
    servedBuild: await page.evaluate(async () => {
      try {
        const res = await fetch('/api/version');
        return await res.json();
      } catch {
        return { sha: 'unknown', buildId: 'unknown' };
      }
    }),
    gitHead: process.env.QM_GIT_SHA || 'unknown',
    screenshots: shots,
    geometry,
    // Auditable: exactly what the error policy chose NOT to fail on.
    consoleErrorExemptions: [...EXEMPTED],
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'geometry.json'), JSON.stringify(report, null, 2));

  for (const shot of shots) {
    expect(fs.existsSync(shot), `${shot} written`).toBe(true);
    expect(fs.statSync(shot).size, `${shot} is a real capture`).toBeGreaterThan(10_000);
  }

  expectNoAppErrors(watched, 'geometry and evidence');
});
