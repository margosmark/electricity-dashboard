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
// stand-in: 8 904 hourly readings, EV overnight block, on-peak appliance hits.
const SAMPLE = path.resolve(__dirname, '../../public/samples/example-usage.xml');

/** Repo-root evidence dir (Playwright runs with cwd = webapp/). */
const EVIDENCE = path.resolve(__dirname, '../../../evidence');

/* ------------------------------------------------------------------------ *
 * The focus ring is a MEASURED contract, not one era's colour constants.
 *
 * Wave H pinned it as "3px white outline + 6px blue halo" in globals.css;
 * the Quiet Meter redesign (#110) replaced that with a 2px `--focus-ring`
 * outline at a 2px offset (the 2px `--page` ring inside it is the gap), and
 * made the ink a per-theme token — the accent (#c7f000) is 1.22:1 on the
 * light canvas, i.e. an invisible indicator, which is exactly what the
 * redesign shipped and this file used to wave through on a stale geometry
 * match (t_5f6b2315). So the gate below asserts what a focus indicator owes
 * the user — DRAWN, and readable against the surface it lands on (WCAG
 * 1.4.11's 3:1 non-text floor) — and lets the design keep its own tokens.
 * ------------------------------------------------------------------------ */

type RingReading = {
  label: string;
  tag: string;
  focusVisible: boolean;
  outlineWidth: number;
  outlineStyle: string;
  outlineColor: [number, number, number];
  gapColor: [number, number, number] | null;
  surface: [number, number, number];
};

/** WCAG relative luminance on already-normalised sRGB. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Read the settled ring on the focused element. Every colour goes through a
 * 1x1 canvas first: Chrome serialises Tailwind v4 colours as lab()/oklch(),
 * which a regex for rgb() silently fails to read (see theme-contrast.spec).
 */
async function readRing(page: Page): Promise<RingReading | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const norm = (css: string): [number, number, number] => {
      ctx.fillStyle = '#000';
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const s = getComputedStyle(el);
    // The surface the ring is painted against: the first ancestor that
    // actually paints a background (toolbar, card, slab, the page itself).
    let surface = getComputedStyle(document.body).backgroundColor;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) {
        surface = bg;
        break;
      }
    }
    // Chrome prints the colour first: "rgb(246, 246, 243) 0px 0px 0px 2px".
    const gap = s.boxShadow.match(/^(rgba?\([^)]*\)|#[0-9a-f]+)/i);
    return {
      label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 40),
      tag: el.tagName,
      focusVisible: el.matches(':focus-visible'),
      outlineWidth: parseFloat(s.outlineWidth),
      outlineStyle: s.outlineStyle,
      outlineColor: norm(s.outlineColor),
      gapColor: gap ? norm(gap[1]) : null,
      surface: norm(surface),
    };
  });
}

/**
 * The best contrast ANY layer of the ring achieves against the surface it
 * lands on. Two layers, two jobs: the `--page` gap reads against a dark
 * slab the outline cannot see, the outline reads against the page/card.
 */
function ringContrast(r: RingReading): number {
  const layers: [number, number, number][] = [r.outlineColor];
  if (r.gapColor) layers.push(r.gapColor);
  return Math.max(...layers.map((c) => contrastRatio(c, r.surface)));
}

function describeRing(r: RingReading): string {
  return `${r.tag} "${r.label}": outline ${r.outlineWidth}px ${r.outlineStyle} rgb(${r.outlineColor.join(', ')}) on rgb(${r.surface.join(', ')}) = ${ringContrast(r).toFixed(2)}:1`;
}

/**
 * Tab through the page and measure the ring on every keyboard stop that
 * matches :focus-visible — cards, chips, slabs and the page itself, so the
 * budget is checked on the surfaces the app really paints.
 */
async function walkRings(page: Page, stops: number): Promise<RingReading[]> {
  const readings: RingReading[] = [];
  await page.keyboard.press('Tab');
  for (let i = 0; i < stops; i++) {
    // The controls carry `transition-colors` and outline-color is one of
    // its properties, so the ring animates in: read it once it settles.
    await page.waitForTimeout(250);
    const r = await readRing(page);
    if (r?.focusVisible) readings.push(r);
    await page.keyboard.press('Tab');
  }
  return readings;
}

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
    // Wave H item 2: the plan is named before any data exists. The Quiet
    // Meter redesign (#110) retired the header chip — `ActivePlanChip` is
    // no longer rendered — for the toolbar's own switcher, which reads the
    // same `useSelectedPlan` store the chip did: exactly one plan is pressed
    // and its canonical id is on screen before a byte has been uploaded.
    const switcher = page.getByTestId('plan-switcher');
    await expect(switcher).toBeVisible();
    const pressedPlan = switcher.locator('button[data-plan][aria-pressed="true"]');
    await expect(pressedPlan, 'exactly one plan is the active one').toHaveCount(1);
    await expect(pressedPlan).toHaveAttribute('data-plan', /TOU|Tiered|ULO/);
    // The visible label IS the accessible name (no aria-label to hide it).
    await expect(pressedPlan).toHaveText(/TOU|Tiered|ULO/);

    // --- 2. Upload: through the same input a real user file takes. --------
    // NOTE the drop zone is NOT the signal: it flips to "ANALYZING..." the
    // moment parsing starts, so it disappears long before the commit. Wait
    // for the dashboard's own evidence that readings are in.
    await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(SAMPLE);
    await expect(page.getByText('Drop XML Here')).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 60_000 });

    // The readings really landed (a silent parse failure would show an
    // empty dashboard here, which is exactly what the assertions catch).
    await expect
      .poll(
        async () =>
          page.evaluate(() => (JSON.parse(localStorage.getItem('energy_data_v2') || '{"points":[]}')?.points || []).length),
        { timeout: 30_000 },
      )
      .toBe(8904);

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
    // Wave R: the advice moved to Plans & Track Record with its evidence.
    await page.getByRole('tab', { name: 'Plans' }).click();
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
    // The window's CSV belongs to the chart, now retained in Overview.
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByTestId('chart-view')).toBeVisible();
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
          page.evaluate(() => (JSON.parse(localStorage.getItem('energy_data_v2') || '{"points":[]}')?.points || []).length),
        { timeout: 30_000 },
      )
      .toBe(8904);

    await expect(page.getByTestId('totals-strip')).toBeVisible();

    // Wave H: the demo opens on the WHOLE bundled year — one lonely bar
    // would not be "the full experience".
    await expect(page.locator('input[type="date"]').first()).toHaveValue('2025-10-01');
    await expect(page.locator('input[type="date"]').nth(1)).toHaveValue('2026-10-06');
    // The chart remains on the decision-first Overview.
    await page.getByRole('tab', { name: 'Overview' }).click();
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

    // The answer lives on Plans & Track Record.
    await page.getByRole('tab', { name: 'Plans' }).click();
    await expect(page.getByTestId('shift-headline')).toBeVisible();

    // ...and can be handed back to the user's own file.
    await page.getByTestId('replace-example-data').click();
    await expect(page.getByText('Drop XML Here')).toBeVisible();
    // Neither key may hold rows: the versioned one and the legacy copy.
    expect(
      await page.evaluate(() => localStorage.getItem('energy_data_v2') ?? localStorage.getItem('energy_data')),
    ).toBeNull();
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
    // The ring ANIMATES in (the controls carry `transition-colors`, and
    // outline-color is one of its properties), so read it once it has
    // settled. What is pinned here is the CONTRACT, not one era's
    // geometry: a DRAWN ring (solid outline, at least 2px) with the 2px
    // `--page` gap inside it, whose colour actually reads on the surface
    // it lands on. Both themes — and every surface, chips and slabs
    // included — are walked in the test below.
    await expect
      .poll(async () => (await readRing(page))?.label ?? '', { timeout: 5_000 })
      .toBe('Upload XML');
    await page.waitForTimeout(300);
    const ring = await readRing(page);
    expect(ring, 'the upload control must be focusable').not.toBeNull();
    expect(ring!.label).toBe('Upload XML');
    expect(ring!.focusVisible).toBe(true);
    expect(ring!.outlineStyle, 'the ring must be DRAWN, not merely a focused element').toBe('solid');
    expect(ring!.outlineWidth, 'a hairline outline is not an indicator').toBeGreaterThanOrEqual(2);
    expect(ring!.gapColor, 'the 2px --page gap is part of the ring').not.toBeNull();
    expect(ringContrast(ring!), `ring does not read on its surface — ${describeRing(ring!)}`).toBeGreaterThanOrEqual(3);

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

  test('the focus ring reads on every surface it lands on, in both themes', async ({ page }) => {
    test.setTimeout(180_000);

    // One ring rule paints the whole app, so ONE surface passing proves
    // nothing: the design language is white chips, yellow chips AND black
    // slabs, and #110's ring token (the accent, 1.22:1 on the light page)
    // passed a colour-blind gate for exactly that reason. Walk the tab
    // order and check the budget on every stop, in each theme.
    for (const theme of ['light', 'dark'] as const) {
      // localStorage needs an origin first: set the tag, then reload with it.
      await page.goto('/');
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.reload();
      await expect(page.getByText('Drop XML Here')).toBeVisible({ timeout: 60_000 });

      const readings = await walkRings(page, 30);
      // A walk that measured nothing must never read as green.
      expect(readings.length, `${theme}: the walk measured no focusable ring`).toBeGreaterThanOrEqual(6);
      for (const r of readings) {
        expect(r.outlineStyle, `${theme}: ${r.label} has no drawn ring`).toBe('solid');
        expect(r.outlineWidth, `${theme}: ${r.label}'s ring is a hairline`).toBeGreaterThanOrEqual(2);
        expect(
          ringContrast(r),
          `${theme}: ${describeRing(r)} — no ring layer reads on the surface it lands on`,
        ).toBeGreaterThanOrEqual(3);
      }
      // Evidence: what was actually measured, per stop, per theme.
      console.log(`focus-ring walk — ${theme} (${readings.length} stops)\n  ${readings.map(describeRing).join('\n  ')}`);
    }
  });

  test('print layout: nav and controls gone, document intact, fits Letter width', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(SAMPLE);
    await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Plans' }).click();
    await expect(page.getByTestId('tab-panel-plans')).toBeVisible();

    // Letter portrait at 96 dpi = 816 × 1056 px of content area.
    await page.setViewportSize({ width: 816, height: 1056 });
    await page.emulateMedia({ media: 'print' });

    // Wave H item 6: chrome must not print...
    await expect(page.locator('[data-testid="plan-switcher"]')).toBeHidden();
    await expect(page.getByTestId('tab-nav')).toBeHidden();
    await expect(page.getByTestId('export-csv').first()).toBeHidden();
    // ...the document must.
    const printedPanel = page.getByTestId('tab-panel-plans');
    await expect(printedPanel).toBeVisible();
    await expect(page.getByTestId('shift-optimizer')).toBeVisible();
    await expect(page.getByTestId('verdict-line')).toBeVisible();

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
