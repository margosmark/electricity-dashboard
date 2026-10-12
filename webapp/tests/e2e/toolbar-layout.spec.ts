import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import {
  VIEWPORT_SWEEP,
  CHART_HEADER_SWEEP,
  bandFor,
  measureToolbarGeometry,
  measureChartHeaderGeometry,
  toolbarChecks,
  chartHeaderChecks,
  layoutSummary,
} from './toolbar-geometry.js';
import { seedMarkShaped } from './mark-seed';

/**
 * Layout-regression gate for the toolbar (t_7228c195).
 *
 * The bug this exists to prevent: at >=1024px the toolbar card's two clusters
 * could not fit side by side, so the plan cluster wrapped and `lg:ml-auto`
 * right-aligned it — a 640x176px (112,640px²) painted-void in the bottom-left
 * of the card, 40% of the face white. t_7f224ead made the card a column of two
 * deliberate full-width rows; this spec makes that measurable on every PR.
 *
 * It is the SAME measurement and the SAME budgets as the probe that settled
 * the fix (evidence/toolbar-verify.cjs) — both import
 * tests/e2e/toolbar-geometry.js, so the gate and the evidence cannot drift.
 *
 * What "breakpoint probe" means here: every Tailwind breakpoint is swept at
 * both sides of its vw boundary (and a couple of short vh heights), because
 * the void only appeared where the clusters stopped fitting — a check that
 * tested a single comfortable width would have passed on the broken build.
 *
 * Runs in CI inside the smoke job's `npx playwright test` step (the booted
 * production container, SMOKE_BASE_URL). Locally:
 *   SMOKE_BASE_URL=http://localhost:3107 npx playwright test toolbar-layout
 * Set TOOLBAR_GATE_EVIDENCE=1 to also write evidence/toolbar-layout-gate.json.
 */

/** The file the probe's budgets were calibrated on
 *  (evidence/toolbar-verification.json), so this gate measures the identical
 *  toolbar those numbers came from. setInputFiles reads it off the runner's
 *  own checkout, so it does not need to be inside the booted container. */
const FIXTURE = path.resolve(__dirname, '../fixtures/green-button-alliance-sample.xml');
const EVIDENCE = path.resolve(__dirname, '../../../evidence');

test.describe('toolbar layout gate', () => {
  test('no dead band at any vw/vh breakpoint', async ({ page }) => {
    test.setTimeout(240_000);
    expect(fs.existsSync(FIXTURE), `missing fixture at ${FIXTURE}`).toBe(true);

    // --- load a real dashboard: the toolbar's second row (billing day, plan
    // switcher, always-on floor) only exists once there is data to plan. ----
    await page.goto('/');
    await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(FIXTURE);
    await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () =>
          page.evaluate(() => (JSON.parse(localStorage.getItem('energy_data_v2') || '{"points":[]}')?.points || []).length),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByTitle('Always-on floor')).toBeVisible();

    // --- sweep ------------------------------------------------------------
    const failures: string[] = [];
    const layouts: Record<string, ReturnType<typeof layoutSummary> | null> = {};
    let total = 0;

    for (const vp of VIEWPORT_SWEEP) {
      const label = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      // Two frames: one for the resize, one so React/Tailwind have applied
      // the new media queries before anything is measured.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );

      const m = await page.evaluate(measureToolbarGeometry);
      const checks = toolbarChecks(label, m, bandFor(vp.width));
      layouts[label] = layoutSummary(m);
      total += checks.length;
      for (const c of checks) {
        if (!c.ok) failures.push(`${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
      console.log(`      ${layoutSummary(m)}`);
    }

    if (process.env.TOOLBAR_GATE_EVIDENCE) {
      fs.writeFileSync(
        path.join(EVIDENCE, 'toolbar-layout-gate.json'),
        `${JSON.stringify(
          {
            wave: 'toolbar-gate',
            fixture: path.basename(FIXTURE),
            at: new Date().toISOString(),
            sweep: VIEWPORT_SWEEP,
            budgets: { note: 'see webapp/tests/e2e/toolbar-geometry.js TOOLBAR_BUDGETS' },
            total,
            failed: failures.length,
            failures,
            layouts,
          },
          null,
          2,
        )}\n`,
      );
    }

    expect(
      failures,
      `${failures.length}/${total} toolbar layout checks FAILED — the dead band is back (or a new one opened):\n${failures.join('\n')}`,
    ).toEqual([]);
  });
});


/**
 * The USAGE card's header row (t_fbf590fa addendum 2) — the same class of bug
 * as the toolbar's dead band, one card down: a flex row whose trailing element
 * absorbed a deficit it could not shrink into, clipped by the card's own
 * `overflow-hidden`.
 *
 * It rides THIS spec because the sweep machinery already exists, but its
 * fixtures are different on purpose: the toolbar gate measures the default tab
 * with the small sample, this measures the USAGE tab with the Mark-shaped seed
 * (24 bills ⇒ a real selection cost string) at the five widths the clip was
 * reproduced at. Green-on-the-buggy-build is the failure mode to avoid here:
 * `scrollWidth > clientWidth` on the row IS the clip, and the cost block's
 * right edge vs the card's content edge is the same statement about the one
 * element that must never clip.
 */
test.describe('USAGE card header row (t_fbf590fa)', () => {
  test('the header row never clips its cost block', async ({ page }) => {
    test.setTimeout(240_000);
    await seedMarkShaped(page);
    await page.getByTestId('tab-usage').click();
    await page.getByTestId('chart-header-row').waitFor({ timeout: 30_000 });

    const failures: string[] = [];
    const layouts: Record<string, unknown> = {};
    let total = 0;

    for (const vp of CHART_HEADER_SWEEP) {
      const label = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      // Two frames: one for the resize, one so React/Tailwind have applied the
      // new media queries before anything is measured.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );

      const m = await page.evaluate(measureChartHeaderGeometry);
      const checks = chartHeaderChecks(label, m);
      layouts[label] = m;
      total += checks.length;
      for (const c of checks) {
        if (!c.ok) failures.push(`${c.name} — ${c.detail}`);
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
      }
    }

    // --- anti-furniture: the SAME row with the two utilities removed must FAIL
    // these checks. A sweep row that is green on the buggy build is decoration,
    // and this reconstructs the buggy build in the live DOM: `min-w-0` on the
    // title group is what lets the h2's `truncate` shrink, `shrink-0` on the
    // cost block is what stops it absorbing the deficit. Measured at every
    // sweep width so the log says WHERE the clip appears, not just that it can.
    const brokenAt: string[] = [];
    for (const vp of CHART_HEADER_SWEEP) {
      const label = `${vp.width}x${vp.height} pre-fix`;
      await page.setViewportSize(vp);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            // Re-assert every iteration: the mutation must survive a resize.
            document.querySelector('[data-testid="chart-title-group"]')?.classList.remove('min-w-0');
            document.querySelector('[data-testid="chart-cost-block"]')?.classList.remove('shrink-0');
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const pre = chartHeaderChecks(label, await page.evaluate(measureChartHeaderGeometry));
      for (const c of pre) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
        if (!c.ok) brokenAt.push(`${c.name} — ${c.detail}`);
      }
    }
    expect(
      brokenAt.length,
      'this gate cannot see the defect it exists for: with min-w-0/shrink-0 removed from the live DOM the row still measures clean at every width',
    ).toBeGreaterThan(0);

    if (process.env.TOOLBAR_GATE_EVIDENCE) {
      fs.writeFileSync(
        path.join(EVIDENCE, 'chart-header-gate.json'),
        `${JSON.stringify(
          { wave: 'chart-header-gate', sweep: CHART_HEADER_SWEEP, total, failed: failures.length, failures, layouts },
          null,
          2,
        )}\n`,
      );
    }

    expect(
      failures,
      `${failures.length}/${total} USAGE-header checks FAILED — the cost block is being clipped again:\n${failures.join('\n')}`,
    ).toEqual([]);
  });
});
