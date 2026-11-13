import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * Panel content resilience (t_82a4dc08) — the document may never be panned
 * horizontally by what is INSIDE a tab panel or the toolbar, at any text size
 * this app supports, in either locale, with data and without.
 *
 * Every number below was measured on the build this landed on (390x844 unless
 * named), before vs after:
 *
 *   Overview, EMPTY ledger, fr + 200% text:   +112 @390 / +75 @427  -> 0 / 0
 *   Overview, SEEDED,       fr + 200% text:   +122 @390 / +85 @427  -> 0 / 0
 *   Overview, SEEDED,       en + 200% text:   +181 @390 / +144 @427 -> 0 / 0
 *   Overview, SEEDED,       fr @100% text:    +100 @360 / +70 @390 / +33 @427 -> 0
 *   Money tab, rotation 390->844x390->390:    +14 @200% text (text ink only:
 *     no border-box offender existed)          -> 0 at 16px and 32px, en+fr
 *
 * The mechanisms were min-content floors, not bad paddings: `min-width: auto`
 * floors every flex/grid child at its own min-content, and at a 200% root one
 * French word ("consommation", 402px at root 32) is wider than the 222px row
 * it sits in. The money-tab case had NO border-box offender at all — the
 * extra width was text ink painting past its box, which only real line
 * breaking stops. Hence the fix is a document-level `overflow-wrap: anywhere`
 * (globals.css, with tables exempted so wide data surfaces keep scrolling —
 * see the guard in test 4) plus the chip's nowrap removal.
 *
 * What is deliberately NOT measured here: the tab strip's own box, its pill
 * labels, the sticky reveal and the strip's safe-area seam — that is
 * tabnav-resilience.spec.ts, which now asserts document-level overflow in
 * every cell too (this card closed the exemptions it used to carry).
 *
 * Every parameter is guarded (locale label, applied root font, selected tab,
 * seeded-vs-empty state), so a silently-unapplied parameter cannot produce a
 * vacuous green. This spec does not read the console.
 *
 * Run: SMOKE_BASE_URL=http://127.0.0.1:3240 PW_CHROMIUM_PATH=/usr/bin/chromium \
 *      npx playwright test tests/e2e/panel-content-resilience.spec.ts
 */

/** Label per locale — the guard that the locale parameter actually landed. */
const LABELS = {
  en: { overview: 'Overview', money: 'Money' },
  fr: { overview: 'Aperçu', money: 'Coûts' },
} as const;

type Locale = keyof typeof LABELS;
type Tab = 'overview' | 'money';

/** Locale is read from storage at mount, so it is written before any document. */
async function landSeeded(page: Page, locale: Locale, tab: Tab) {
  await page.addInitScript((loc) => localStorage.setItem('oeo_locale', loc as string), locale);
  await seedMarkShaped(page);
  if (tab !== 'overview') {
    // Deep link, not storage: the app rewrites the bar to #tab=<resolved> on
    // subscribe and the hash beats storage on the next load.
    await page.goto('/#tab=money');
    await page.waitForSelector('[data-testid="tab-money"][data-active="true"]', { timeout: 30_000 });
  }
}

/** The empty ledger — the other state the panels must survive. */
async function landEmpty(page: Page, locale: Locale) {
  await page.addInitScript((loc) => localStorage.setItem('oeo_locale', loc as string), locale);
  await page.goto('/');
  await page.waitForSelector('[data-testid="tab-nav"] [role="tab"]', { timeout: 30_000 });
}

/**
 * Apply a text scale the way a browser would have it at load: on :root.
 * The pills carry `transition-all`, so their computed font-size eases over
 * ~400ms — waiting for the eased value is what makes the geometry below a
 * measurement of the settled page rather than of a transition frame.
 */
async function applyTextScale(page: Page, rootPx: number) {
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  // The pills carry `transition-all`, so their BOX eases to the new root over
  // ~400ms. Wait on that box, not on the font: main's four-tab type scale
  // pins the label to a fixed 10px below md (`text-[10px] md:text-xs`), so
  // at phone widths the font never reaches 0.75×root and the old wait timed
  // out every time. Three frames with an unchanged height (<0.01px) means
  // the easing clock has stopped — the same guarantee the font wait gave.
  await page.waitForFunction(
    (root) => {
      const pill = document.querySelector('[role="tablist"] [role="tab"]') as HTMLElement | null;
      if (!pill) return false;
      const rootApplied =
        Math.abs(parseFloat(getComputedStyle(document.documentElement).fontSize) - root) < 0.01;
      if (!rootApplied) return false;
      const w = window as unknown as { __pillH?: number; __pillStable?: number };
      const h = pill.getBoundingClientRect().height;
      if (w.__pillH === undefined) {
        w.__pillH = h;
        w.__pillStable = 0;
        return false;
      }
      w.__pillStable = Math.abs(h - w.__pillH) < 0.01 ? (w.__pillStable ?? 0) + 1 : 0;
      w.__pillH = h;
      return (w.__pillStable ?? 0) >= 2;
    },
    rootPx,
    { timeout: 5_000 },
  );
}

/**
 * The pills carry `transition: all .15s`, so their LABEL font-size eases over
 * ~150ms after a viewport or root step (md crossing: 10px ⇄ 0.75rem). Reading
 * it mid-ease yields a fractional value — QA t_d0f94d7a measured 10.014 /
 * 10.3262 / 11.9373 against the design 10 / 0.75×root, red on Chromium 156
 * and Chrome 155 alike. Wait for the pill to hold STILL (no running
 * transition AND the same computed font-size on three consecutive frames)
 * before the read, so the `pillFont` `toBe` below measures the settled page
 * and a genuinely wrong size still fails it. This hides nothing.
 */
async function waitForPillLabelSettle(page: Page, timeout = 5_000) {
  await page.waitForFunction(
    () => {
      const pill = document.querySelector('[role="tablist"] [role="tab"]') as HTMLElement | null;
      if (!pill) return false;
      if (pill.getAnimations().length > 0) return false;
      const w = window as unknown as { __pillFs?: string; __pillFsStable?: number };
      const fs = getComputedStyle(pill).fontSize;
      if (w.__pillFs === undefined) {
        w.__pillFs = fs;
        w.__pillFsStable = 0;
        return false;
      }
      w.__pillFsStable = fs === w.__pillFs ? (w.__pillFsStable ?? 0) + 1 : 0;
      w.__pillFs = fs;
      return (w.__pillFsStable ?? 0) >= 2;
    },
    undefined,
    { timeout },
  );
}

/** In-page numbers the assertions below read. */
async function pageMetrics(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-testid="tab-nav"]');
    const navRect = nav?.getBoundingClientRect();
    const shell = document.querySelector('[data-testid="page-shell"]') as HTMLElement | null;
    return {
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      bodyOverflowWrap: getComputedStyle(document.body).overflowWrap,
      shellPaddingTop: shell ? getComputedStyle(shell).paddingTop : null,
      navLeft: navRect ? Math.round(navRect.left) : null,
      navRight: navRect ? Math.round(navRect.right) : null,
      activeId: document.querySelector('[role="tab"][data-active="true"]')?.getAttribute('data-testid') ?? null,
      activeLabel: document.querySelector('[role="tab"][data-active="true"] span')?.textContent ?? '',
      pillFont: (() => {
        const pill = document.querySelector('[role="tablist"] [role="tab"]');
        return pill ? parseFloat(getComputedStyle(pill).fontSize) : 0;
      })(),
      hasTotalsStrip: document.querySelector('[data-testid="totals-strip"]') !== null,
      hasOverviewPanel: document.querySelector('[data-testid="tab-panel-overview"]') !== null,
      hasMoneyPanel: document.querySelector('[data-testid="tab-panel-money"]') !== null,
    };
  });
}

/**
 * A big viewport or font step leaves stale widths for a frame or so (measured:
 * 1280->360 reads docScroll 1134 at t0, clean by +300ms). Wait for the settle,
 * then assert — a PERSISTENT overflow never satisfies this and times out red,
 * with the widest unclipped offender named so the failure is self-diagnosing.
 */
async function waitForLayoutSettle(page: Page, timeout = 5_000) {
  try {
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      undefined,
      { timeout },
    );
  } catch {
    const diag = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders: string[] = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.right <= vw + 1) continue;
        let clipped = false;
        let p = el.parentElement;
        while (p && p !== document.documentElement) {
          const cs = getComputedStyle(p);
          if (['hidden', 'auto', 'scroll', 'clip'].includes(cs.overflowX)) {
            clipped = true;
            break;
          }
          p = p.parentElement;
        }
        if (!clipped && offenders.length < 3) {
          offenders.push(
            `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} right=${Math.round(r.right)} "${(el.getAttribute('class') || '').slice(0, 50)}"`,
          );
        }
      }
      return { scrollW: document.documentElement.scrollWidth, clientW: vw, offenders };
    });
    throw new Error(`layout did not settle within ${timeout}ms: ${JSON.stringify(diag)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Seeded panels, both locales, 100% and 200% text, phone widths: the
//    document may not pan. Pre-fix this was red in every fr cell and in the
//    en 200% cells (efficiency strip).
// ---------------------------------------------------------------------------
for (const locale of ['en', 'fr'] as Locale[]) {
  test(`seeded panel content never pans the document @ ${locale}`, async ({ page }) => {
    test.setTimeout(180_000);
    await landSeeded(page, locale, 'overview');
    await page.waitForSelector('[data-testid="totals-strip"]', { timeout: 30_000 });

    for (const root of [16, 32]) {
      await applyTextScale(page, root);
      for (const vp of [
        { width: 360, height: 800 },
        { width: 390, height: 844 },
        { width: 427, height: 952 },
      ]) {
        await page.setViewportSize(vp);
        await waitForLayoutSettle(page);
        // The md crossing re-eases the label; read pillFont settled (below).
        await waitForPillLabelSettle(page);
        const m = await pageMetrics(page);
        const at = `${vp.width} @ root ${root} ${locale} seeded`;

        // Parameter guards: the state, the locale and the scale all applied.
        expect(m.hasTotalsStrip, `${at}: seeded state (totals-strip present)`).toBe(true);
        expect(m.activeId, `${at}: overview selected`).toBe('tab-overview');
        expect(m.activeLabel, `${at}: locale ${locale} actually applied`).toBe(LABELS[locale].overview);
        expect(m.rootFont, `${at}: root font applied`).toBe(`${root}px`);
        // The ROOT font is the parameter; main's four-tab type scale pins the
        // pill label to a fixed 10px below md (`text-[10px] md:text-xs`), so
        // the pill asserts its design size rather than 0.75×root — which only
        // the md+ type has ever followed. Every viewport here is < md.
        expect(m.pillFont, `${at}: pill label at its design size`).toBe(10);
        expect(m.bodyOverflowWrap, `${at}: the no-pan rule is in force`).toBe('anywhere');

        // THE CLAIM: no horizontal page pan, and the strip stays in-viewport.
        expect(m.sw, `${at}: document scrollWidth vs clientWidth`).toBeLessThanOrEqual(m.cw + 1);
        expect(m.navLeft, `${at}: nav left edge`).toBeGreaterThanOrEqual(-1);
        expect(m.navRight, `${at}: nav right edge`).toBeLessThanOrEqual(m.cw + 1);

        // Visual evidence for the worst cell this card fixed: pre-fix this
        // exact page measured documentScroll 512 against a 390px viewport.
        if (locale === 'fr' && root === 32 && vp.width === 390) {
          await page.screenshot({ path: test.info().outputPath('fr-200-overview-390.png') });
        }
      }
    }
    await applyTextScale(page, 16);
  });
}

// ---------------------------------------------------------------------------
// 2. EMPTY ledger, 200% text: the panels that render with no data must
//    contain themselves too (pre-fix fr: +112 @390 / +75 @427 — the anomaly
//    heading row, the plan-summary/attention cards and the temp chart).
// ---------------------------------------------------------------------------
for (const locale of ['en', 'fr'] as Locale[]) {
  test(`empty-ledger panel content never pans the document @ ${locale}`, async ({ page }) => {
    test.setTimeout(180_000);
    await landEmpty(page, locale);
    await applyTextScale(page, 32);

    for (const vp of [
      { width: 390, height: 844 },
      { width: 427, height: 952 },
    ]) {
      await page.setViewportSize(vp);
      await waitForLayoutSettle(page);
      const m = await pageMetrics(page);
      const at = `${vp.width} @ root 32 ${locale} empty`;

      // Parameter guards: this really is the EMPTY state (no seeded totals).
      expect(m.hasTotalsStrip, `${at}: empty ledger has no totals strip`).toBe(false);
      expect(m.hasOverviewPanel, `${at}: overview panel rendered`).toBe(true);
      expect(m.activeLabel, `${at}: locale ${locale} actually applied`).toBe(LABELS[locale].overview);
      expect(m.rootFont, `${at}: root font applied`).toBe('32px');

      expect(m.sw, `${at}: document scrollWidth vs clientWidth`).toBeLessThanOrEqual(m.cw + 1);
    }
    await applyTextScale(page, 16);
  });
}

// ---------------------------------------------------------------------------
// 3. Money tab through rotation (portrait -> landscape -> portrait) at 100%
//    and 200% text. The landscape state used to carry a money-panel content
//    leak (div[tab-panel-money] 841px inside its 748px box, document 889);
//    it is asserted at document level now, in both directions of the hop.
// ---------------------------------------------------------------------------
for (const locale of ['en', 'fr'] as Locale[]) {
  test(`money panel stays inside the page through rotation @ ${locale}`, async ({ page }) => {
    test.setTimeout(180_000);
    await landSeeded(page, locale, 'money');
    await page.waitForSelector('[data-testid="tab-panel-money"]', { timeout: 30_000 });

    for (const root of [16, 32]) {
      await applyTextScale(page, root);
      for (const vp of [
        { width: 390, height: 844 },
        { width: 844, height: 390 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(vp);
        await waitForLayoutSettle(page);
        await page.waitForFunction(
          () => {
            const list = document.querySelector('[role="tablist"]');
            const active = document.querySelector('[role="tab"][data-active="true"]');
            if (!list || !active) return false;
            const l = list.getBoundingClientRect();
            const a = active.getBoundingClientRect();
            return a.left >= l.left - 1 && a.right <= l.right + 1;
          },
          undefined,
          { timeout: 8_000 },
        );
        await waitForPillLabelSettle(page);
        const m = await pageMetrics(page);
        const at = `${vp.width}x${vp.height} @ root ${root} ${locale} money`;

        expect(m.hasMoneyPanel, `${at}: money panel rendered`).toBe(true);
        expect(m.activeId, `${at}: money still selected`).toBe('tab-money');
        expect(m.activeLabel, `${at}: locale ${locale} actually applied`).toBe(LABELS[locale].money);
        expect(m.rootFont, `${at}: root font applied`).toBe(`${root}px`);
        // Design size again: 10px on the two phone states, 0.75rem on the
        // 844×390 landscape state, which is >= md.
        expect(m.pillFont, `${at}: pill label at its design size`).toBe(
          vp.width >= 768 ? 0.75 * root : 10,
        );

        expect(m.sw, `${at}: document scrollWidth vs clientWidth`).toBeLessThanOrEqual(m.cw + 1);
        expect(m.navLeft, `${at}: nav left edge`).toBeGreaterThanOrEqual(-1);
        expect(m.navRight, `${at}: nav right edge`).toBeLessThanOrEqual(m.cw + 1);
      }
    }
    await applyTextScale(page, 16);
  });
}

// ---------------------------------------------------------------------------
// 4. The other half of the contract: wide data surfaces keep their width and
//    SCROLL inside their own overflow-x container instead of collapsing into
//    wrapped columns. Without this the no-pan rule could "pass" by quietly
//    shrinking the money table to its box.
// ---------------------------------------------------------------------------
test('wide data surfaces still scroll instead of wrapping their columns', async ({ page }) => {
  test.setTimeout(180_000);
  await landSeeded(page, 'en', 'money');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('[data-testid="money-table"]', { timeout: 30_000 });

  for (const root of [16, 32]) {
    await applyTextScale(page, root);
    await waitForLayoutSettle(page);
    const table = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="money-table"]') as HTMLElement | null;
      const inner = box?.querySelector('table') as HTMLElement | null;
      const cell = inner?.querySelector('tbody td') as HTMLElement | null;
      if (!box || !inner) return null;
      return {
        boxScroll: box.scrollWidth,
        boxClient: box.clientWidth,
        tableWidth: Math.round(inner.getBoundingClientRect().width),
        boxOverflow: getComputedStyle(box).overflowX,
        tableOverflowWrap: getComputedStyle(inner).overflowWrap,
        cellOverflowWrap: cell ? getComputedStyle(cell).overflowWrap : null,
      };
    });
    const at = `money table @ root ${root}`;
    expect(table, `${at}: the seeded money table rendered`).not.toBeNull();
    // Parameter guard: the exemption is what keeps this surface wide.
    expect(table!.tableOverflowWrap, `${at}: table exempt from word breaking`).toBe('normal');
    expect(table!.cellOverflowWrap, `${at}: cells exempt from word breaking`).toBe('normal');
    expect(table!.boxOverflow, `${at}: the money table scrolls horizontally`).toBe('auto');
    expect(table!.boxScroll, `${at}: table wider than its box (it scrolls, not wraps)`).toBeGreaterThan(
      table!.boxClient + 1,
    );
  }

  // Overview side: the heatmap keeps its 520px floor and scrolls under it.
  // Same context, so the seed is already in storage — deep-link the tab
  // rather than seeding again (seedMarkShaped waits for a first-visit CTA
  // that no longer exists once data is in).
  await page.goto('/#tab=overview');
  await page.waitForSelector('[data-testid="tab-overview"][data-active="true"]', { timeout: 30_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('[data-testid="heatmap-grid-weekday"]', { timeout: 30_000 });
  await waitForLayoutSettle(page);
  const heatmap = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="heatmap-grid-weekday"]') as HTMLElement | null;
    const scroller = grid?.parentElement as HTMLElement | null;
    const hour = document.querySelector('[role="columnheader"]') as HTMLElement | null;
    if (!grid || !scroller) return null;
    return {
      gridWidth: Math.round(grid.getBoundingClientRect().width),
      scrollerClient: scroller.clientWidth,
      scrollerOverflow: getComputedStyle(scroller).overflowX,
      hourRowHeight: hour ? Math.round(hour.parentElement!.getBoundingClientRect().height) : 0,
    };
  });
  expect(heatmap, 'heatmap grid rendered').not.toBeNull();
  expect(heatmap!.gridWidth, 'heatmap keeps its 520px floor').toBeGreaterThanOrEqual(520);
  expect(heatmap!.scrollerClient, 'heatmap is narrower than its grid (it scrolls)').toBeLessThan(
    heatmap!.gridWidth,
  );
  expect(heatmap!.scrollerOverflow, 'the heatmap scrolls horizontally').toBe('auto');
  // The "0h..23h" column headers are single tokens: they must stay one line
  // (breaking them doubled this row, 15px -> 30px, before the nowrap pin).
  expect(heatmap!.hourRowHeight, 'hour header row stays one line').toBeLessThanOrEqual(20);
});

// ---------------------------------------------------------------------------
// 5. Page-shell top safe-area: the inset reaches the shell the same way it
//    reaches the nav (t_2d4a97e6), the header clears a 47px status bar at
//    scroll 0, and with env() reporting 0 the padding is the original 12/20px.
//    env() is 0 in every automation browser, so the seam var is the harness.
// ---------------------------------------------------------------------------
test('page-shell top safe-area inset reaches the header', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await landSeeded(page, 'en', 'overview');
  await page.waitForSelector('[data-testid="page-shell"]', { timeout: 30_000 });

  // Contract: an emitted rule pads the shell with env(safe-area-inset-top)
  // through the --safe-top seam. Walk children first — with CSS nesting every
  // style rule exposes a (often empty but truthy) cssRules list.
  const seamRules = await page.evaluate(() => {
    const hits: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet — not ours anyway
      }
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          const kids = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
          if (kids && kids.length) walk(kids);
          else if (rule.cssText.includes('safe-area-inset-top')) hits.push(rule.cssText);
        }
      };
      walk(rules);
    }
    return hits;
  });
  expect(seamRules.length, 'a rule carries the top inset').toBeGreaterThan(0);
  expect(
    seamRules.some((r) => r.includes('--safe-top')),
    'the shell rule uses the --safe-top test seam',
  ).toBe(true);
  expect(
    seamRules.every((r) => r.includes('0px')),
    'every top-inset rule has the 0px fallback env() needs',
  ).toBe(true);

  // Zero visual change when the inset is 0: the shell keeps the original
  // vertical padding (0.75rem mobile, 1.25rem at md).
  const mobile = await pageMetrics(page);
  expect(mobile.shellPaddingTop, 'mobile default padding unchanged').toBe('12px');
  await page.setViewportSize({ width: 768, height: 1024 });
  const md = await pageMetrics(page);
  expect(md.shellPaddingTop, 'md default padding unchanged').toBe('20px');
  await page.setViewportSize({ width: 390, height: 844 });

  // Seam on: the shell's padding grows by exactly the inset a notched iPhone
  // reports, so at scroll 0 the header (and everything under it) starts below
  // the status bar.
  const seam = await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-top', '47px');
    const shell = document.querySelector('[data-testid="page-shell"]')!;
    const header = document.querySelector('[data-testid="page-header"]')!;
    return {
      paddingTop: getComputedStyle(shell).paddingTop,
      headerTop: Math.round(header.getBoundingClientRect().top),
    };
  });
  expect(seam.paddingTop, 'seam applied: 12px base + 47px inset').toBe('59px');
  expect(seam.headerTop, 'header clears a 47px status bar at scroll 0').toBeGreaterThanOrEqual(47);
  await page.screenshot({ path: test.info().outputPath('page-shell-safe-area-seam.png') });

  // Parameter-removal guard: dropping the seam restores the default exactly.
  const seamOff = await page.evaluate(() => {
    document.documentElement.style.removeProperty('--safe-top');
    return getComputedStyle(document.querySelector('[data-testid="page-shell"]')!).paddingTop;
  });
  expect(seamOff, 'default restored when the seam is removed').toBe('12px');
  await page.screenshot({ path: test.info().outputPath('page-shell-safe-area.png') });
});
