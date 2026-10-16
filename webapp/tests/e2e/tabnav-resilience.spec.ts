import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * TabNav mobile resilience (t_2d4a97e6) — text scaling, safe-area insets and
 * orientation, validated against the geometry the DEPLOYED build (79b7d00)
 * produced. Every number in this docstring was measured, not guessed:
 *
 *   +8px document overflow at every width ≥768px (16px at 200% text): the
 *     #110 redesign narrowed `main` to px-4 md:px-6 but left the strip at
 *     -mx-8/px-8, so the strip overhung the viewport and the whole page
 *     panned sideways when rotation crossed the md breakpoint.
 *   200% text clipped labels: the 4-tab-era `min-w-[76px]` floor overrode
 *     flexbox's automatic min-content minimum, so labels escaped their own
 *     pill box (+14px, en "Overview"; +2px, fr "Aperçu" at 150%) while the
 *     strip reported no overflow.
 *   Rotation stranded the active tab: 844×390 at 200% left the strip
 *     scrolled 186px with the selected money pill entirely outside the
 *     visible box — nothing ever re-anchored it.
 *   Safe-area: env(safe-area-inset-top) appeared nowhere — body's env()
 *     rules cover left/right/bottom only, so the sticky strip slid under
 *     the status bar in the standalone PWA (viewport-fit: cover).
 *
 * What is deliberately NOT asserted: document-level overflow for fr + 200%
 * text. That overflow (measured +112px at 390) comes from Overview panel
 * content (heatmap min-w, heading rows), outside the nav's box — tracked as
 * follow-up card t_82a4dc08. Nav-box containment IS still asserted in every
 * cell, both locales.
 *
 * t_bb120a04 (#113 × #114): the sweep also pins the ROW RULE that the two
 * PRs collided over. #113 moved the date window / scope / theme toolbar into
 * this nav as `shellTools` (an 800px natural row in en, 938.5px in fr) while
 * the strip's flex-basis stayed 0%, so at 1024×768 the toolbar claimed 800px
 * of the 976px row and the strip scrolled 162px — and at 200% text the date
 * inputs' 7rem floors pushed that line to 640px inside a 358px viewport
 * (document scrollWidth 672). The shell caps the row at 1180px at any
 * width (nav 1228px at 1440 and 1536 alike), so #113's `xl:flex-nowrap`
 * sharing rule can only ever fit en: the fr fit cell reads stripScroll 83 at
 * 1280/1440/1536 under it. The rule asserted below, in every cell of the
 * sweep and both locales: the strip owns line 1, the toolbar owns its own
 * full-width line 2, the page never pans, and the strip never scrolls at
 * default text.
 *
 * Every parameter is guarded (locale labels, applied font size, selected
 * tab, seam value), so a silently-unapplied parameter can't produce a vacuous
 * green. This spec does not read the console — nothing here needs it.
 *
 * Run: SMOKE_BASE_URL=http://127.0.0.1:3231 npx playwright test tabnav-resilience
 */

/** Label per locale — the guard that the locale parameter actually landed. */
const LABELS = {
  en: { overview: 'Overview', money: 'Money' },
  fr: { overview: 'Aperçu', money: 'Coûts' },
} as const;

type Locale = keyof typeof LABELS;

/**
 * Locale is read from storage at mount, so it is written by an init script
 * that runs before every document — including seedMarkShaped's own
 * goto/reload pair. The active TAB is deliberately NOT set here: the seed
 * waits for `totals-strip`, which only exists on the overview panel, so the
 * tab is switched (storage + reload) after the seed has landed.
 */
async function landWith(page: Page, locale: Locale, activeTab: 'overview' | 'money') {
  await page.addInitScript((loc) => localStorage.setItem('oeo_locale', loc as string), locale);
  await seedMarkShaped(page);
  if (activeTab !== 'overview') {
    // Deep link, not storage: on subscribe the app rewrites the address bar
    // to `#tab=overview` (useTabs.ts), and the hash beats storage on the
    // next load — setting the key alone would silently resolve back.
    await page.goto('/#tab=money');
    await page.waitForSelector('[data-testid="tab-money"][data-active="true"]', { timeout: 30_000 });
  }
}

/**
 * A big viewport change leaves stale widths for a frame or so — measured:
 * shrinking 1280→360 reads docScroll 1134 at t0 (a recharts wrapper still
 * 1092px wide from the previous layout) and settles to a clean 360 within
 * 300ms. Wait for the settle, then assert. A PERSISTENT overflow never
 * satisfies this and times out red — it hides nothing.
 */
async function waitForLayoutSettle(page: Page, timeout = 5_000) {
  try {
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      undefined,
      { timeout },
    );
  } catch {
    // Self-diagnosing: a settle timeout must report the actual numbers AND
    // name the widest unclipped offender (a vertical scrollbar, a stray
    // 100vw, a real content overflow and a slow chart all look different).
    const diag = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders: string[] = [];
      if (document.documentElement.scrollWidth > vw + 1) {
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
          if (!clipped) {
            offenders.push(
              `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} right=${Math.round(r.right)} cls="${(el.getAttribute('class') || '').slice(0, 50)}"`,
            );
          }
        }
      }
      return {
        scrollW: document.documentElement.scrollWidth,
        clientW: vw,
        innerW: window.innerWidth,
        navRight: Math.round(
          (document.querySelector('[data-testid="tab-nav"]')?.getBoundingClientRect().right ?? -1),
        ),
        topOffenders: offenders.slice(0, 3),
        // Border-box scan came back empty above while scrollW still says
        // 889 — so the extra 45px is in MARGIN boxes or a lazy internal
        // scroller. Name both explicitly.
        marginOffenders: (() => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll('body *'))) {
            const r = el.getBoundingClientRect();
            const mr = parseFloat(getComputedStyle(el).marginRight) || 0;
            if (r.right + Math.max(0, mr) > vw + 1) {
              out.push(
                `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} right=${Math.round(r.right)} mR=${mr}`,
              );
            }
            if (out.length >= 3) break;
          }
          return out;
        })(),
        scrollers: (() => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll('body *'))) {
            if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
              out.push(
                `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''} sw=${el.scrollWidth} cw=${el.clientWidth}`,
              );
            }
            if (out.length >= 5) break;
          }
          return out;
        })(),
        bodyRect: (() => {
          const b = document.body.getBoundingClientRect();
          return { right: Math.round(b.right), w: Math.round(b.width) };
        })(),
      };
    });
    throw new Error(`layout did not settle within ${timeout}ms: ${JSON.stringify(diag)}`);
  }
}

/** Apply a text scale the way a browser would have it at load: on :root. */
async function applyTextScale(page: Page, rootPx: number) {
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  // The pills carry `transition-all`, so their computed font-size EASES to
  // the new root over ~400ms (measured on a 16→24 step: 12.2 → 17.8 → 18px).
  // Wait for the eased value itself: a read mid-transition returns a
  // fractional size (14.7435 was seen), and the pill widths are easing on
  // the same clock, so waiting here also settles the geometry checks.
  await page.waitForFunction(
    (expected) => {
      const pill = document.querySelector('[role="tablist"] [role="tab"]');
      return pill !== null && Math.abs(parseFloat(getComputedStyle(pill).fontSize) - expected) < 0.01;
    },
    0.75 * rootPx,
    { timeout: 5_000 },
  );
}

/** In-page snapshot of every number the checks below assert on. */
async function snapshotStrip(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-testid="tab-nav"]') as HTMLElement | null;
    const list = document.querySelector('[role="tablist"]') as HTMLElement | null;
    if (!nav || !list) return null;
    const pills = [...list.querySelectorAll('[role="tab"]')] as HTMLElement[];
    const active = pills.find((p) => p.dataset.active === 'true');
    const navRect = nav.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    // The row's SECOND child is the shellTools wrapper (the #113 Quiet Meter
    // toolbar: date window + scope + theme). t_bb120a04 asserts the row rule
    // it carries: it always takes its own full-width line and never shares
    // the strip's.
    const row = nav.firstElementChild as HTMLElement | null;
    const shell =
      row && row.children.length > 1 ? (row.lastElementChild as HTMLElement) : null;
    const shellRect = shell ? shell.getBoundingClientRect() : null;
    return {
      vw: document.documentElement.clientWidth,
      docScroll: document.documentElement.scrollWidth,
      navLeft: navRect.left,
      navRight: navRect.right,
      navTop: navRect.top,
      navHeight: nav.offsetHeight,
      paddingTop: getComputedStyle(nav).paddingTop,
      tablistTop: listRect.top,
      tablistBottom: listRect.bottom,
      tablistRight: listRect.right,
      shellTop: shellRect ? shellRect.top : null,
      shellBottom: shellRect ? shellRect.bottom : null,
      shellRight: shellRect ? shellRect.right : null,
      shellWidth: shellRect ? shellRect.width : null,
      stripScroll: list.scrollWidth - list.clientWidth,
      pillCount: pills.length,
      activeId: active?.dataset.testid ?? null,
      activeLabel: active?.querySelector('span')?.textContent ?? '',
      // Label span inside its own pill box (±1px): the no-clip check.
      escapes: pills
        .map((p) => {
          const r = p.getBoundingClientRect();
          const s = p.querySelector('span')?.getBoundingClientRect();
          if (!s) return `${p.dataset.testid}: no label`;
          const out = s.left < r.left - 1 || s.right > r.right + 1;
          return out
            ? `${p.dataset.testid}: label ${s.left.toFixed(1)}..${s.right.toFixed(1)} vs pill ${r.left.toFixed(1)}..${r.right.toFixed(1)}`
            : null;
        })
        .filter(Boolean) as string[],
      // Active pill inside the strip's visible box (±1px): the active-visibility check.
      activeInStrip: (() => {
        if (!active) return false;
        const a = active.getBoundingClientRect();
        return a.left >= listRect.left - 1 && a.right <= listRect.right + 1;
      })(),
      pillMinHeight: Math.min(...pills.map((p) => p.getBoundingClientRect().height)),
      labelFontSize: pills[0] ? parseFloat(getComputedStyle(pills[0]).fontSize) : 0,
    };
  });
}

/** Poll until the active pill is inside the strip (reveal is async: RO/resize). */
async function waitForActiveInStrip(page: Page, timeout = 8_000) {
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
    { timeout },
  );
}

// ---------------------------------------------------------------------------
// 1. Default text: FIT + OVERFLOW across the width sweep, both locales.
//    Pre-fix this failed at 768/1024 (+8px page pan) and on fr labels at
//    150% — the sweep is the regression gate for the margin sync fix.
// ---------------------------------------------------------------------------
for (const locale of ['en', 'fr'] as Locale[]) {
  test(`default text fits one row with no page pan @ ${locale}`, async ({ page }) => {
    test.setTimeout(180_000);
    await landWith(page, locale, 'overview');

    const widths = [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 427, height: 952 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1280, height: 800 },
    ];

    for (const vp of widths) {
      await page.setViewportSize(vp);
      // Document-level overflow is asserted where it is a NAV-scoped claim:
      // always for en, and for fr only ≥768. Below 768 the SEEDED fr page has
      // a persistent panel overflow that is not the strip's: the Overview
      // `best-choice-chip` button carries a whitespace-nowrap span, so its
      // French label runs 431px wide — measured docScroll +100/+70/+33 at
      // 360/390/427 (nav itself spans 0..vw in every one of those cells, and
      // ≥768 is clean: measured ovr 0). Tracked as t_82a4dc08.
      const docAsserted = locale === 'en' || vp.width >= 768;
      // Shrink transients (recharts settling) must not masquerade as — or
      // mask — a real page pan; persistent overflow still times out red.
      if (docAsserted) await waitForLayoutSettle(page);
      const s = await snapshotStrip(page);
      expect(s, `strip rendered at ${vp.width}`).not.toBeNull();
      const at = `${vp.width}×${vp.height} ${locale}`;

      // Parameter guards.
      expect(s!.pillCount, 'three tabs render').toBe(3);
      expect(s!.activeLabel, `locale ${locale} actually applied at ${at}`).toBe(
        LABELS[locale].overview,
      );
      expect(s!.labelFontSize, 'root font not scaled in this test').toBe(12);

      // OVERFLOW: the strip may not make the page pan horizontally (scoped as
      // above — fr <768 is the chip, t_82a4dc08, and its nav box is asserted
      // right below regardless).
      if (docAsserted) {
        expect(s!.docScroll, `${at}: document scrollWidth vs clientWidth`).toBeLessThanOrEqual(
          s!.vw + 1,
        );
      }
      expect(s!.navLeft, `${at}: nav left edge not past the viewport`).toBeGreaterThanOrEqual(-1);
      expect(s!.navRight, `${at}: nav right edge not past the viewport`).toBeLessThanOrEqual(
        s!.vw + 1,
      );

      // FIT: at default text the row fits — strip does not scroll, and no
      // label leaves its pill box.
      expect(s!.stripScroll, `${at}: strip has nothing to scroll`).toBeLessThanOrEqual(1);
      expect(s!.escapes, `${at}: every label inside its pill`).toEqual([]);
      expect(s!.pillMinHeight, `${at}: touch height floor`).toBeGreaterThanOrEqual(44);

      // ROW RULE (t_bb120a04 — #113 × #114): the Quiet Meter shell toolbar
      // NEVER shares the strip's row — not at any width, in either locale.
      // Measured: the toolbar's natural row is 800px in en and 938.5px in
      // fr, while this shell caps the row at 1180px (nav 1228px at 1440 AND
      // at 1536 alike), so under #113's `xl:flex-nowrap` — which makes the
      // two share one row from xl up — the fr fit cell reads stripScroll 83
      // at 1280, 1440 and 1536. The rule this spec pins: strip on line 1,
      // toolbar on its own full-width line 2 (basis-full), in every cell of
      // the sweep, so the strip is never asked to share its row and never
      // scrolls at default text.
      expect(s!.shellTop, `${at}: the shell toolbar renders in the row`).not.toBeNull();
      expect(
        s!.shellTop!,
        `${at}: the toolbar takes its own line, never the strip's`,
      ).toBeGreaterThanOrEqual(s!.tablistBottom - 1);
      // basis-full: the toolbar's line spans the same width as the strip's.
      expect(
        Math.abs(s!.shellRight! - s!.tablistRight!),
        `${at}: the toolbar line spans the full row (basis-full)`,
      ).toBeLessThanOrEqual(2);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Text scaling 150%/200%: labels never clip — pills grow and the STRIP
//    scrolls instead; nav box stays in-viewport; active tab stays visible.
// ---------------------------------------------------------------------------
for (const locale of ['en', 'fr'] as Locale[]) {
  test(`150%/200% text never clips a label and keeps the active pill visible @ ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // Active = money (rightmost): worst case for strip scrolling.
    await landWith(page, locale, 'money');

    for (const vp of [
      { width: 390, height: 844 },
      { width: 427, height: 952 },
    ]) {
      await page.setViewportSize(vp);
      for (const root of [24, 32]) {
        await applyTextScale(page, root);
        // Reveal is driven by ResizeObserver/resize — poll for its effect
        // rather than sleeping a guessed interval.
        await waitForActiveInStrip(page);
        const s = await snapshotStrip(page);
        const at = `${vp.width} ${root / 16.0 === 2 ? 200 : 150}% ${locale}`;

        // Parameter guard: the scale really applied (text-xs = 0.75rem).
        expect(s!.labelFontSize, `${at}: root ${root}px applied`).toBe(0.75 * root);
        expect(s!.activeLabel, `${at}: money tab selected`).toBe(LABELS[locale].money);
        expect(s!.activeId, `${at}: money tab selected`).toBe('tab-money');

        // NO CLIP: every label inside its own pill box.
        expect(s!.escapes, `${at}: labels inside pills`).toEqual([]);
        // ACTIVE VISIBLE: selected pill inside the strip's visible box.
        expect(s!.activeInStrip, `${at}: active pill in view`).toBe(true);
        // Nav-box containment in both locales (document-level for fr is the
        // panel-content follow-up t_82a4dc08, not the nav).
        expect(s!.navLeft, `${at}: nav left edge`).toBeGreaterThanOrEqual(-1);
        expect(s!.navRight, `${at}: nav right edge`).toBeLessThanOrEqual(s!.vw + 1);
        // Touch height still holds as the strip's content grows.
        expect(s!.pillMinHeight, `${at}: touch height floor`).toBeGreaterThanOrEqual(44);
        if (locale === 'en') {
          // (Settle first: a resize/font step can leave a chart a frame wide
          // — measured t0 1134 at 360, clean by +300ms. fr+200% has the known
          // panel-content overflow, t_82a4dc08, and is deliberately not
          // asserted at document level.)
          await waitForLayoutSettle(page);
          const settled = await snapshotStrip(page);
          expect(settled!.docScroll, `${at}: no page pan at scale (en)`).toBeLessThanOrEqual(
            settled!.vw + 1,
          );
        }

        await page.screenshot({ path: test.info().outputPath(`scale-${vp.width}-${root}-${locale}.png`) });
      }
    }
    await applyTextScale(page, 16);
  });
}

// ---------------------------------------------------------------------------
// 3. Orientation: portrait → landscape → back, at default and 200% text.
//    Pre-fix: landscape crossed md into the -mx-8 mismatch (+8px pan) and at
//    200% the selected pill ended up 186px outside the strip.
// ---------------------------------------------------------------------------
test('rotation keeps the page still and the active pill in the strip', async ({ page }) => {
  test.setTimeout(180_000);
  await landWith(page, 'en', 'money');

  const states = [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ];

  for (const root of [16, 32]) {
    await applyTextScale(page, root);
    for (const vp of states) {
      await page.setViewportSize(vp);
      // Doc-level pan asserted on the PORTRAIT states. The 844×390 landscape
      // state carries a known pre-existing money-panel content leak —
      // div[tab-panel-money] content measured 841px inside its 748px box
      // (document scrollWidth 889, nav itself clean at 0..844), and the SAME
      // leak shows on the deployed origin build as div[money-table]
      // sw=1010 vs cw=724 — panel content, tracked as t_82a4dc08. The strip
      // is still gated there through its own box: pre-fix the nav alone made
      // this state read scrollW 852 with navRight 852, and navRight ≤ vw is
      // asserted in every state below.
      const docAsserted = vp.width < 768;
      if (docAsserted) await waitForLayoutSettle(page);
      await waitForActiveInStrip(page);
      const s = await snapshotStrip(page);
      const at = `${vp.width}×${vp.height} @ root ${root}px`;

      expect(s!.labelFontSize, `${at}: root applied`).toBe(0.75 * root);
      expect(s!.activeId, `${at}: money still selected`).toBe('tab-money');
      expect(s!.activeInStrip, `${at}: active pill in view after rotation`).toBe(true);
      expect(s!.navLeft, `${at}: nav left edge`).toBeGreaterThanOrEqual(-1);
      expect(s!.navRight, `${at}: nav right edge`).toBeLessThanOrEqual(s!.vw + 1);
      if (docAsserted) {
        expect(s!.docScroll, `${at}: no page pan`).toBeLessThanOrEqual(s!.vw + 1);
      }
      expect(s!.escapes, `${at}: labels inside pills`).toEqual([]);
    }

    // STICKY: at max scroll the strip is pinned at top 0 with the active
    // pill inside its rect (walk criterion, honoured under both text scales).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const stuck = await snapshotStrip(page);
    expect(stuck!.navTop, `stuck at root ${root}px`).toBeCloseTo(0, 0);
    expect(stuck!.activeInStrip, `active visible while stuck at root ${root}px`).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await applyTextScale(page, 16);
  await page.screenshot({ path: test.info().outputPath('landscape-rotated.png') });
});

// ---------------------------------------------------------------------------
// 4. Safe-area: the env() wiring exists, changes nothing by default, and the
//    --safe-top seam reproduces a notched device's geometry end-to-end.
// ---------------------------------------------------------------------------
test('safe-area top inset reaches the stuck strip', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await landWith(page, 'en', 'overview');

  // Contract: some emitted rule pads the strip with env(safe-area-inset-top,
  // …). Pre-fix this found zero rules — env() covered left/right/bottom only.
  // (Walk children first: with CSS nesting every style rule exposes a
  // cssRules list — often EMPTY but truthy — so a plain `if (rule.cssRules)`
  // would swallow every leaf rule and report nothing.)
  const envRules = await page.evaluate(() => {
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
  expect(envRules.length, 'the strip carries an env(safe-area-inset-top) rule').toBeGreaterThan(0);
  expect(
    envRules.every((r) => r.includes('0px')),
    'every such rule has the 0px fallback env() needs',
  ).toBe(true);

  // Default (env=0 in every automation browser): computed padding identical
  // to the plain pt-2/pt-3 values — zero visual change outside standalone.
  const before = await snapshotStrip(page);
  expect(before!.paddingTop, 'mobile default padding unchanged').toBe('8px');
  await page.setViewportSize({ width: 768, height: 1024 });
  const beforeMd = await snapshotStrip(page);
  expect(beforeMd!.paddingTop, 'md default padding unchanged').toBe('12px');
  await page.setViewportSize({ width: 390, height: 844 });

  // Parameter guard + geometry through the seam: --safe-top is the value a
  // notched iPhone reports (47px here), so paddingTop must grow by exactly it.
  const seamApplied = await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-top', '47px');
    const nav = document.querySelector('[data-testid="tab-nav"]')!;
    return getComputedStyle(nav).paddingTop;
  });
  expect(seamApplied, 'seam applied: 8px base + 47px inset').toBe('55px');

  const withSeam = await snapshotStrip(page);
  expect(withSeam!.navHeight, 'strip grew by exactly the inset').toBe(before!.navHeight + 47);

  // At max scroll the strip still pins at top 0, but its CONTENT clears the
  // simulated status bar (first pill below y=47) and the active pill stays in.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const firstPillTop = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]')!;
    return list.querySelector('[role="tab"]')!.getBoundingClientRect().top;
  });
  const stuck = await snapshotStrip(page);
  expect(stuck!.navTop, 'strip still stuck at top 0 under the inset').toBeCloseTo(0, 0);
  expect(firstPillTop, 'pills clear a 47px status bar').toBeGreaterThanOrEqual(47);
  expect(stuck!.activeInStrip, 'active pill visible under the inset').toBe(true);
  await page.screenshot({ path: test.info().outputPath('safe-area-seam.png') });

  // Remove the seam → back to the default (parameter-removal guard).
  const seamOff = await page.evaluate(() => {
    document.documentElement.style.removeProperty('--safe-top');
    return getComputedStyle(document.querySelector('[data-testid="tab-nav"]')!).paddingTop;
  });
  expect(seamOff, 'default restored when the seam is removed').toBe('8px');
});
