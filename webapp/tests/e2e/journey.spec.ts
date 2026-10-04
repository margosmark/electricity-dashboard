import { test, expect, type Page, type Locator } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Wave H item 9 — the FULL user journey, not a component smoke.
 *
 * A visitor lands on https://electricity.markarslan.ca/ with no export and no
 * account, and must be able to see the whole product: upload → totals → the
 * Shift Optimizer's answer → download the evidence as CSV.
 *
 * The file selected here is `public/samples/example-usage.xml`: an Oakville-
 * shaped, one-year, hourly Green Button export generated in-repo (see
 * scripts/generate-example-fixture.mjs). The app owner's REAL Oakville export
 * must never enter this repo, so the committed fixture is the stand-in — it
 * goes through the identical upload input, parser and analysis path.
 *
 * Green button path (CI: docker image on :3100 via SMOKE_BASE_URL).
 */

// The real Oakville export cannot be committed, so this is the Oakville-SHAPED
// stand-in: 8 760 hourly readings, EV overnight block, on-peak appliance hits.
const SAMPLE = path.resolve(__dirname, '../../public/samples/example-usage.xml');

/** Repo-root evidence dir (Playwright runs with cwd = webapp/). */
const EVIDENCE = path.resolve(__dirname, '../../../evidence');

test.describe('full journey', () => {
  test('land → upload export → Shift Optimizer headline → totals → CSV download', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    expect(fs.existsSync(SAMPLE), `missing sample fixture at ${SAMPLE}`).toBe(true);

    // --- 1. Land: the app explains itself before anything is uploaded. ----
    const resp = await page.goto('/');
    expect(resp?.status()).toBe(200);
    await expect(page).toHaveTitle(/Ontario Energy Optimizer/);
    await expect(page.getByText('Drop XML Here')).toBeVisible();
    // Wave H item 1: the way in for someone with no export at all.
    await expect(page.getByTestId('try-example-data')).toBeVisible();
    // Wave H item 2: the plan is named before any data exists.
    await expect(page.getByTestId('active-plan-chip')).toHaveAttribute('data-plan', /TOU|Tiered|ULO/);

    // --- 2. Upload: through the same input a real user file takes. --------
    // NOTE the drop zone is NOT the signal: it flips to "ANALYZING..." the
    // moment parsing starts, so it disappears long before the commit. Wait
    // for the dashboard's own evidence that readings are in.
    await page.locator('input[type="file"]').setInputFiles(SAMPLE);
    await expect(page.getByText('Drop XML Here')).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 60_000 });

    // The readings really landed (a silent parse failure would show an
    // empty dashboard here, which is exactly what the assertions catch).
    await expect
      .poll(
        async () =>
          page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]').length),
        { timeout: 30_000 },
      )
      .toBe(8760);

    // --- 3. Totals: real numbers, real dates. ----------------------------
    const strip = page.getByTestId('totals-strip');
    await expect(strip).toBeVisible();
    const kwhText = (await strip.locator('text=/kWh/').first().textContent()) || '';
    const kwh = Number((kwhText.match(/([\d,]+)\s*kWh/) || [])[1]?.replace(/,/g, ''));
    expect(kwh, `totals strip reported: ${kwhText}`).toBeGreaterThan(1000);

    // Wave H item 5: how old the data is, on screen next to the totals.
    const fresh = page.getByTestId('data-freshness-chip');
    await expect(fresh).toBeVisible();
    await expect(fresh).toHaveAttribute('data-last-reading', /^\d{4}-\d{2}-\d{2}$/);

    // Wave H item 7: the same totals switch units without a reload.
    const tou = page.getByTestId('plan-cost-TOU');
    await expect(tou).toHaveAttribute('data-unit', 'yr');
    const yearly = (await tou.textContent()) || '';
    await page.getByTestId('cost-toggle').getByRole('button', { name: '$/day' }).click();
    await expect(tou).toHaveAttribute('data-unit', 'day');
    expect((await tou.textContent()) || '').not.toBe(yearly);

    // --- 4. The answer: Shift Optimizer headline on real usage. ----------
    await page.getByRole('button', { name: 'INSIGHTS' }).click();
    const optimizer = page.getByTestId('shift-optimizer');
    await expect(optimizer).toBeVisible();

    const headline = page.getByTestId('shift-headline');
    await expect(headline).toBeVisible();
    await expect(headline).toContainText('Switch to ULO');
    await expect(page.getByTestId('shift-headline-share')).toContainText('% of the savings');

    // The blocks behind the headline are real, evidenced rows.
    const blocks = page.locator('[data-testid^="shift-block-"]');
    expect(await blocks.count()).toBeGreaterThan(0);
    await expect(page.getByTestId('confidence-badge').first()).toBeVisible();

    // --- 5. Take the evidence away: a real CSV file lands on disk. -------
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByTestId('export-csv').first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^energy_export_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);

    const target = path.join(os.tmpdir(), 'wave-h-journey.csv');
    await download.saveAs(target);
    const csv = fs.readFileSync(target, 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'datetime,usage_kwh,tou_category,ulo_category,costTOU,costTiered,costULO,activeRateSet.effectiveDate',
    );
    // The visible window is a slice of the year, not the whole thing — but it
    // has to be a real table, not a header with one lonely row.
    expect(lines.length).toBeGreaterThan(100);
    const sampleRow = lines[1].split(',');
    expect(sampleRow[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number(sampleRow[1])).toBeGreaterThan(0);
    expect(fs.statSync(target).size).toBeGreaterThan(4_000);
  });

  test('the example-data button itself takes a visitor from empty to a full dashboard', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.goto('/');
    await expect(page.getByText('Drop XML Here')).toBeVisible();

    // Wave H item 1 end to end: one click, no file, no account.
    await page.getByTestId('try-example-data').click();

    // It is labelled as example data everywhere it is shown. The banner is
    // the commit signal (the drop zone hides as soon as parsing starts).
    const banner = page.getByTestId('example-data-banner');
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText('Example data — not real usage');
    expect(
      await page.evaluate(() => localStorage.getItem('energy_data_is_example')),
    ).toBe('1');
    await expect
      .poll(
        async () =>
          page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]').length),
        { timeout: 30_000 },
      )
      .toBe(8760);

    await expect(page.getByTestId('totals-strip')).toBeVisible();

    // Wave H: the demo opens on the WHOLE bundled year — one lonely bar
    // would not be "the full experience".
    await expect(page.locator('input[type="date"]').first()).toHaveValue('2025-10-01');
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue('2026-09-30');
    // ...so the monthly chart has a year of tick labels, not one. Recharts
    // v3 parks tick labels in their own z-layer, so select on the group's
    // own class rather than assuming they sit under the axis <g>.
    await expect
      .poll(
        async () =>
          page.locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label').count(),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(6);

    // The answer lives on the Insights tab.
    await page.getByRole('button', { name: 'INSIGHTS' }).click();
    await expect(page.getByTestId('shift-headline')).toBeVisible();

    // ...and can be handed back to the user's own file.
    await page.getByTestId('replace-example-data').click();
    await expect(page.getByText('Drop XML Here')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('energy_data'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_is_example'))).toBeNull();
  });
});

/**
 * Wave H items 3 + 6 + 8 — the three behaviours a screenshot of the happy
 * path cannot prove: keyboard/Escape, the printed document, and recovery
 * from a crash. Kept as e2e (not unit) because they depend on real CSS
 * cascade (`:focus-visible`, `@media print`) and real event dispatch.
 */
test.describe('keyboard, print and crash', () => {
  /**
   * Escape until the overlay is gone (bounded).
   *
   * The app attaches its Escape listener at mount, so a single press should
   * always do it — this loop only absorbs the frame between "the overlay's
   * DOM node exists" and "the browser delivered the key", which a loaded CI
   * runner can win. It still FAILS if Escape genuinely does nothing: five
   * presses on a broken handler leave the overlay open.
   */
  async function escapeUntilHidden(page: Page, overlay: Locator) {
    for (let i = 0; i < 5 && (await overlay.isVisible()); i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    await expect(overlay).toBeHidden();
  }

  test('focus rings are visible, Escape closes every overlay, tab order works', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await expect(page.getByText('Drop XML Here')).toBeVisible();

    // Wave H item 3: Escape dismisses the upload modal.
    const dropZone = page.getByText('Drop XML Here');
    await escapeUntilHidden(page, dropZone);

    // Tab to the upload control: the ring must be DRAWN (blue halo), not
    // merely a focused element with no visible indicator.
    await page.keyboard.press('Tab');
    let guard = 0;
    while (guard++ < 25) {
      const label = await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') || '',
      );
      if (label === 'Upload XML') break;
      await page.keyboard.press('Tab');
    }
    // The ring ANIMATES in (the app's buttons all carry `transition-all`),
    // so read it once it has settled: 3px outline + a 6px blue halo.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return '';
            const s = getComputedStyle(el);
            return `${s.outlineWidth} ${s.boxShadow}`;
          }),
        { timeout: 5_000 },
      )
      .toMatch(/3px .*0px 0px 0px 6px/);

    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        label: el.getAttribute('aria-label'),
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
        boxShadow: s.boxShadow,
      };
    });
    expect(ring?.label).toBe('Upload XML');
    expect(parseFloat(ring?.outlineWidth || '0')).toBeGreaterThan(0);
    // Blue halo, which is what makes the ring read on white AND on black.
    expect(ring?.boxShadow).toMatch(/rgb\(37,\s*99,\s*235\)/);

    // Enter opens the modal, Escape closes it again.
    await page.keyboard.press('Enter');
    await expect(dropZone).toBeVisible();
    await escapeUntilHidden(page, dropZone);

    // The backup drawer closes on Escape and its aria-expanded tells the truth.
    const toggle = page.getByTestId('backup-toggle');
    await toggle.click();
    await expect(page.getByTestId('backup-drawer')).toBeVisible();
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    await escapeUntilHidden(page, page.getByTestId('backup-drawer'));
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('print layout: nav and controls gone, document intact, fits Letter width', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(SAMPLE);
    await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'INSIGHTS' }).click();
    await expect(page.getByTestId('insights-view')).toBeVisible();

    // Letter portrait at 96 dpi = 816 × 1056 px of content area.
    await page.setViewportSize({ width: 816, height: 1056 });
    await page.emulateMedia({ media: 'print' });

    // Wave H item 6: chrome must not print...
    await expect(page.locator('[data-testid="plan-switcher"]')).toBeHidden();
    await expect(page.getByTestId('export-csv').first()).toBeHidden();
    await expect(page.getByRole('button', { name: 'INSIGHTS' })).toBeHidden();
    // ...the document must.
    const insights = page.getByTestId('insights-view');
    await expect(insights).toBeVisible();
    await expect(page.getByTestId('shift-optimizer')).toBeVisible();
    await expect(page.getByTestId('insights-view')).toBeVisible();

    // No horizontal overflow on a Letter-width page.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: path.join(EVIDENCE, 'wave-h-print-letter.png'),
      fullPage: false,
    });
    await page.emulateMedia({ media: 'screen' });
  });

  test('crash state: an uncaught error shows a recoverable screen, not a blank page', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    // The header is server-rendered; the upload modal only exists once the
    // client's init effect has run. Waiting on IT means the boundary's
    // window listeners are attached before we throw — otherwise the error
    // lands pre-hydration and paints nothing.
    await expect(page.getByText('Drop XML Here')).toBeVisible({ timeout: 60_000 });

    // Wave H item 8: the runtime path — an error thrown where React
    // boundaries never look (an event handler / async callback).
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('wave-h deliberate crash');
      }, 0);
    });

    const crash = page.getByTestId('crash-screen');
    await expect(crash).toBeVisible({ timeout: 15_000 });
    await expect(crash).toContainText('Something broke');
    await expect(crash).toContainText('were not touched');
    const incidentId = await page.getByTestId('crash-id').textContent();
    expect(incidentId).toMatch(/^ERR-[0-9A-F]+/);
    expect(await page.getByTestId('crash-detail').textContent()).toContain('wave-h deliberate crash');
    await page.screenshot({ path: path.join(EVIDENCE, 'wave-h-crash.png') });

    // ...and recovery works: Try again re-mounts the app.
    await page.getByTestId('crash-reset').click();
    await expect(page.getByTestId('crash-screen')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('Ontario Energy Optimizer').first()).toBeVisible();
  });
});
