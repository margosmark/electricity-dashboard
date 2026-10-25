import { expect, test, type Page } from '@playwright/test';
import { seedPlanSwitchFixture } from './plan-switch-fixture';

/**
 * Plan-Switch mobile keyboard + focus regression matrix (t_03a6f86f).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * #122 (`fix(plans): publish approved Plan-Switch timeline candidate`) shipped
 * three Plan-Switch fixes with no keyboard guard anywhere in the suite:
 *
 *   1. every timeline segment and every signed saving callout became a real
 *      tab stop (`tabIndex={0}` + a `focus-visible` outline);
 *   2. `revealFocusedBubble` (PlanSwitchTimeline.tsx) scrolls a focused
 *      callout into the horizontally scrollable chart so the focus indicator
 *      is not left clipped behind the scrollport edge;
 *   3. the callout copy was rewritten — the signed direction ("your actual
 *      plan was cheaper" vs "potential amount saved"), the counted /
 *      not-counted verdict, and the footnote that explains them.
 *
 * `journey.spec.ts` and `mobile-defects.spec.ts` assert focus elsewhere on the
 * page (upload control, toolbar, tab pills) — never inside this panel. So a
 * regression here is invisible today: the fixes are unguarded.
 *
 * WHAT THIS FILE PINS
 *   1. populated AND empty layouts (the empty state has its own callout);
 *   2. mobile breakpoints 390×844 and 427×952, EN and FR;
 *   3. the FULL Tab → Shift+Tab round trip through the panel's focus stops,
 *      not just forward;
 *   4. focus across a panel change (tab-strip click and `#tab=` route change);
 *   5. the final copy of the corrected callouts — byte-for-byte where the text
 *      is fixed (money is locale-formatted, so those pins are the exact fixed
 *      phrases around the amount);
 *   6. no clipped focus indicator: the ring's painted extent must stay inside
 *      the scrollport's visible box at mobile widths.
 *
 * Every stop asserts the same contract journey.spec.ts established for the
 * rest of the app: `:focus-visible` matched, a DRAWN outline (solid, ≥2px)
 * and a colour that actually reads on the surface it lands on (≥3:1, WCAG
 * 1.4.11). The measured numbers ride along in every failure message.
 *
 * TEST-ONLY: this file changes no app code. A focus defect found here is the
 * finding — the assertion stays, with the numbers measured today.
 */

/* ------------------------------------------------------------------------ *
 * The matrix.
 * ------------------------------------------------------------------------ */

const VIEWPORTS = [
  { width: 390, height: 844 }, // the iPhone-class viewport the fixes spec'd
  { width: 427, height: 952 }, // Mark's actual device (DPR 3.0, mobile-defects)
] as const;

const LOCALES = ['en', 'fr'] as const;
type Locale = (typeof LOCALES)[number];

/**
 * The corrected copy, pinned. Values are copied verbatim out of
 * `src/i18n/en.json` / `fr.json` as they stand on `origin/main` 128e3fa5 —
 * deliberately literals, NOT read from the catalogs at run time: a test that
 * asserts the catalog against itself can never notice the catalog changed.
 */
const COPY: Record<Locale, {
  /** The empty state's own callout (`switch-timeline-empty`). */
  emptyNote: string;
  /** Heading over the timeline — also the language proof. */
  title: string;
  /** Language proof for the populated layout (substring of the note). */
  noteProof: RegExp;
  /** "N plan switches across M billing periods." — counts are data. */
  noteSwitches: RegExp;
  /** The first sentence of the corrected footnote (the sign contract). */
  footnoteOpening: string;
  /** aria-label period phrase: `{start}` / `{end}` are ISO dates. */
  period: string;
  /** The two signed callout sentences, `{amount}` is the formatted money. */
  actualCheaper: string;
  potentialSaving: string;
  /** The counted / not-counted verdict appended to each callout. */
  counted: string;
  /** Tab-strip names for the route-transition test. */
  tabs: { overview: string; plans: string };
}> = {
  en: {
    emptyNote:
      'Usage-only analysis already works with your readings. To see bill-period history and compare plan costs, upload an export that contains bills.',
    title: 'Plan-switch decision timeline',
    noteProof: /billing periods/,
    noteSwitches: /\d+ plan switches? across \d+ billing periods\./,
    footnoteOpening:
      'A positive amount is the modelled amount potentially saved by switching to this period’s cheapest alternative.',
    period: 'Billing period {start} to {end}',
    actualCheaper: 'Your actual plan was cheaper than the alternative by {amount}',
    potentialSaving: 'Potential amount saved by switching to the cheapest alternative: {amount}',
    counted: 'Counted/modelled in this report (green)',
    tabs: { overview: 'Overview', plans: 'Plans' },
  },
  fr: {
    emptyNote:
      'L’analyse de la consommation fonctionne déjà avec vos relevés. Pour consulter l’historique des périodes de facturation et comparer les coûts des grilles, téléversez un export contenant des factures.',
    title: 'Chronologie des décisions de changement de grille',
    noteProof: /périodes de facturation/,
    noteSwitches: /\d+ changements? de grille au fil de \d+ périodes de facturation\./,
    footnoteOpening:
      'Un montant positif est l’économie potentielle modélisée en passant à la grille de rechange la moins chère pour cette période.',
    period: 'Période de facturation du {start} au {end}',
    actualCheaper: 'Votre grille réelle était moins chère que l’autre de {amount}',
    potentialSaving:
      'Montant potentiellement économisé en passant à la grille de rechange la moins chère : {amount}',
    counted: 'Compté/modélisé dans ce rapport (vert)',
    tabs: { overview: 'Aperçu', plans: 'Grilles' },
  },
};

/** The fixture's two signed callouts: switch date → direction of the saving. */
const BUBBLES = [
  { id: 'switch-bubble-2026-06-23', direction: 'actual' as const },
  { id: 'switch-bubble-2026-07-22', direction: 'potential' as const },
];

/* ------------------------------------------------------------------------ *
 * Measuring: one evaluate that returns everything a focus assertion needs.
 * ------------------------------------------------------------------------ */

type RGB = [number, number, number];
type Box = { left: number; top: number; right: number; bottom: number };

type FocusReading = {
  id: string | null;
  tag: string;
  name: string;
  focusVisible: boolean;
  outlineWidth: number;
  outlineStyle: string;
  outlineColor: RGB;
  gapColor: RGB | null;
  surface: RGB;
  /** Border box grown by the outline's painted extent (offset + width). */
  ring: Box;
  /** The scrollport's visible box (client box), or null outside the chart. */
  clip: Box | null;
  scrollbars: { horizontal: number; vertical: number } | null;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

async function measureFocus(page: Page): Promise<FocusReading | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;

    // Chrome serialises Tailwind v4 colours as lab()/oklch(); a regex for
    // rgb() silently fails to read them, so every colour goes through a 1x1
    // canvas first (same normalisation theme-contrast.spec.ts uses).
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const norm = (css: string): RGB => {
      ctx.fillStyle = '#000';
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };

    const s = getComputedStyle(el);
    const outlineWidth = s.outlineStyle === 'none' || s.outlineStyle === 'hidden'
      ? 0
      : parseFloat(s.outlineWidth) || 0;
    const offset = parseFloat(s.outlineOffset) || 0;
    // The outline occupies [offset, offset + width] outward from the border
    // box; a negative offset draws it INSIDE the box, which no ancestor
    // overflow can clip, hence max(0, …).
    const extent = Math.max(0, offset + outlineWidth);
    const r = el.getBoundingClientRect();
    const ring: Box = {
      left: r.left - extent,
      top: r.top - extent,
      right: r.right + extent,
      bottom: r.bottom + extent,
    };

    // The surface the ring paints against: first ancestor that really paints.
    let surface = getComputedStyle(document.body).backgroundColor;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) {
        surface = bg;
        break;
      }
    }
    // Chrome prints the colour first: "rgb(246, 246, 243) 0px 0px 0px 2px".
    const gapMatch = s.boxShadow.match(/^(rgba?\([^)]*\)|#[0-9a-f]+)/i);
    const gapColor = gapMatch ? norm(gapMatch[1]) : null;

    const chart = el.closest('[data-testid="switch-timeline-bar"]') as HTMLElement | null;
    let clip: Box | null = null;
    let scrollbars: { horizontal: number; vertical: number } | null = null;
    if (chart) {
      const cr = chart.getBoundingClientRect();
      // What is actually PAINTABLE: the client box. Content under a classic
      // scrollbar is not visible to anyone, and this is the same line
      // revealFocusedBubble itself scrolls to (visibleLeft / visibleRight).
      clip = {
        left: cr.left + chart.clientLeft,
        top: cr.top + chart.clientTop,
        right: cr.left + chart.clientLeft + chart.clientWidth,
        bottom: cr.top + chart.clientTop + chart.clientHeight,
      };
      scrollbars = {
        horizontal: chart.offsetHeight - chart.clientHeight,
        vertical: chart.offsetWidth - chart.clientWidth,
      };
    }

    return {
      id: el.getAttribute('data-testid'),
      tag: el.tagName,
      name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 90),
      focusVisible: el.matches(':focus-visible'),
      outlineWidth,
      outlineStyle: s.outlineStyle,
      outlineColor: norm(s.outlineColor),
      gapColor,
      surface: norm(surface),
      ring,
      clip,
      scrollbars,
      scrollLeft: chart ? chart.scrollLeft : 0,
      scrollWidth: chart ? chart.scrollWidth : 0,
      clientWidth: chart ? chart.clientWidth : 0,
    };
  });
}

/** WCAG relative luminance on already-normalised sRGB. */
function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The best contrast ANY layer of the ring achieves against its surface. */
function ringContrast(r: FocusReading): number {
  const layers: RGB[] = [r.outlineColor];
  if (r.gapColor) layers.push(r.gapColor);
  return Math.max(...layers.map((c) => contrastRatio(c, r.surface)));
}

function box(v: Box): string {
  return `[${v.left.toFixed(1)}, ${v.top.toFixed(1)}, ${v.right.toFixed(1)}, ${v.bottom.toFixed(1)}]`;
}

function describeRing(r: FocusReading): string {
  const geometry = r.clip
    ? `ring ${box(r.ring)} vs clip ${box(r.clip)} scrollLeft=${r.scrollLeft.toFixed(0)}/${(r.scrollWidth - r.clientWidth).toFixed(0)} scrollbars h${r.scrollbars?.horizontal} v${r.scrollbars?.vertical}`
    : 'not in the chart scrollport';
  return `${r.tag} "${r.id ?? r.name}": focus-visible=${r.focusVisible} outline=${r.outlineWidth}px ${r.outlineStyle} rgb(${r.outlineColor.join(', ')}) on rgb(${r.surface.join(', ')}) = ${ringContrast(r).toFixed(2)}:1 · ${geometry}`;
}

/**
 * The ring animates in (`transition-colors` covers outline-color), so read it
 * once it has settled — and fail loudly if it never draws at all.
 */
async function settledRing(page: Page, where: string): Promise<FocusReading> {
  await expect
    .poll(
      async () => (await measureFocus(page))?.outlineStyle ?? 'none',
      { timeout: 5_000, intervals: [100], message: `${where}: the focus ring never drew` },
    )
    .toBe('solid');
  const settled = await measureFocus(page);
  expect(settled, `${where}: nothing is focused`).not.toBeNull();
  return settled!;
}

/** What a focus indicator owes the user at every stop. */
function expectReadableRing(r: FocusReading, where: string) {
  expect(r.focusVisible, `${where}: focused without :focus-visible — ${describeRing(r)}`).toBe(true);
  expect(r.outlineStyle, `${where}: the ring is not DRAWN — ${describeRing(r)}`).toBe('solid');
  expect(r.outlineWidth, `${where}: a hairline outline is not an indicator — ${describeRing(r)}`).toBeGreaterThanOrEqual(2);
  expect(
    ringContrast(r),
    `${where}: ring does not read on its surface — ${describeRing(r)}`,
  ).toBeGreaterThanOrEqual(3);
}

/**
 * Requirement 6 — no clipped focus indicator. Returns a violation line when
 * the ring's painted extent leaves the scrollport's visible box (anything
 * outside is clipped by `overflow-x: auto` and invisible to the user), and
 * null when the ring is wholly inside.
 */
function clippedViolation(r: FocusReading, where: string): string | null {
  if (!r.clip) return `${where}: the stop is not inside the plan-switch scrollport (${describeRing(r)})`;
  const c = r.clip;
  const tol = 0.5;
  const over = [
    { edge: 'LEFT', px: c.left - r.ring.left },
    { edge: 'RIGHT', px: r.ring.right - c.right },
    { edge: 'TOP', px: c.top - r.ring.top },
    { edge: 'BOTTOM', px: r.ring.bottom - c.bottom },
  ].filter((o) => o.px > tol);
  if (over.length === 0) return null;
  return `${where}: ${over.map((o) => `${o.edge} by ${o.px.toFixed(1)}px`).join(', ')} — ${describeRing(r)}`;
}

/* ------------------------------------------------------------------------ *
 * Tab-order helpers: the sequential focus order as the browser sees it.
 * ------------------------------------------------------------------------ */

/** Everything the browser will actually stop on, in DOM order. */
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

/** ...minus the disabled, the roving-tabindex(-1) and the not rendered. */
const KEEP = `!el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length > 0`;

async function focusableCount(page: Page, root: string): Promise<number> {
  return page.evaluate(
    ({ root: rootSel, sel, keep }) => {
      const scope = document.querySelector(rootSel);
      if (!scope) return -1;
      const predicate = new Function('el', `return ${keep}`) as (el: Element) => boolean;
      return [...scope.querySelectorAll(sel)].filter(predicate).length;
    },
    { root, sel: FOCUSABLE, keep: KEEP },
  );
}

/** Where the browser thinks focus is, relative to that same list (-1 = outside). */
async function activeIndex(page: Page, root: string): Promise<number> {
  return page.evaluate(
    ({ root: rootSel, sel, keep }) => {
      const scope = document.querySelector(rootSel);
      if (!scope) return -1;
      const predicate = new Function('el', `return ${keep}`) as (el: Element) => boolean;
      const list = [...scope.querySelectorAll(sel)].filter(predicate);
      return list.indexOf(document.activeElement as Element);
    },
    { root, sel: FOCUSABLE, keep: KEEP },
  );
}

async function focusFirstIn(page: Page, root: string): Promise<void> {
  await page.evaluate(
    ({ root: rootSel, sel, keep }) => {
      const scope = document.querySelector(rootSel);
      const predicate = new Function('el', `return ${keep}`) as (el: Element) => boolean;
      const list = [...(scope?.querySelectorAll(sel) ?? [])].filter(predicate);
      (list[0] as HTMLElement | undefined)?.focus();
    },
    { root, sel: FOCUSABLE, keep: KEEP },
  );
}

/**
 * Bounded walk: focus the first stop inside `root` with the keyboard. The
 * bound has to clear the whole toolbar that sits between the tab strip and
 * the panels (plan switcher, locale, theme, floor, …) — 40 is generous.
 */
async function tabInto(page: Page, root: string, presses = 40): Promise<number> {
  for (let i = 0; i < presses; i++) {
    if ((await activeIndex(page, root)) >= 0) return i;
    await page.keyboard.press('Tab');
  }
  return -1;
}

/** Set the locale the app's own storage tag carries (`oeo_locale`: en|fr). */
async function seedLocale(page: Page, locale: Locale) {
  if (locale === 'fr') {
    await page.addInitScript(() => localStorage.setItem('oeo_locale', 'fr'));
  }
}

/**
 * Close the upload modal an empty ledger opens over the dashboard. The modal
 * mounts a beat AFTER the first paint, so wait for it first: escaping before
 * it exists is a no-op and the "closed" assertion then measures nothing.
 */
async function dismissUploadModal(page: Page) {
  const modal = page.getByTestId('upload-modal');
  await expect(modal, 'an empty ledger must open the upload modal').toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 5 && (await modal.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  await expect(modal).toBeHidden();
}

/** A pinned phrase with `{amount}`/`{start}`/`{end}` turned into a pattern. */
function pinned(pattern: string, vars: Record<string, string>): RegExp {
  let out = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`\\{${key}\\}`).join(value);
  }
  return new RegExp(out);
}

/**
 * The full callout sentence, end to end: period phrase · signed direction ·
 * counted verdict. Every fixed word is the pinned literal; only the
 * locale-formatted amount and the ISO dates vary.
 */
function calloutPattern(locale: Locale, direction: 'actual' | 'potential') {
  const c = COPY[locale];
  const saving = direction === 'actual' ? c.actualCheaper : c.potentialSaving;
  const period = pinned(c.period, { start: '\\d{4}-\\d{2}-\\d{2}', end: '\\d{4}-\\d{2}-\\d{2}' }).source;
  const money = pinned(saving, { amount: '.+?' }).source;
  const verdict = c.counted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${period} · ${money} · ${verdict}$`);
}

/** Seed, land on Plans, and prove the parameter under test really applied. */
async function openPopulatedChart(page: Page, locale: Locale) {
  await seedLocale(page, locale);
  await seedPlanSwitchFixture(page);
  await page.goto('/#tab=plans');
  await expect(page.getByTestId('plan-switch-timeline')).toHaveAttribute('data-periods', '3');
  // A locale that silently failed to seed would paint English and measure
  // exactly the same geometry: the language has to be proved, not assumed.
  await expect(
    page.getByTestId('switch-timeline-note'),
    'the strip must render in the requested language',
  ).toContainText(COPY[locale].noteProof);
}

/** The chart's own tab stops, in the order the browser will visit them. */
const CHART = '[data-testid="switch-timeline-bar"]';
const PANEL = '[data-testid="tab-panel-plans"]';

/* ------------------------------------------------------------------------ *
 * 1+2+3+5+6 — populated layout: full round trip, mobile widths, EN and FR.
 * ------------------------------------------------------------------------ */

for (const vp of VIEWPORTS) {
  for (const locale of LOCALES) {
    const c = COPY[locale];
    test.describe(`plan-switch focus @ ${vp.width}×${vp.height} ${locale.toUpperCase()}`, () => {
      test.use({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });

      test('populated: Tab/Shift+Tab round trip, readable rings, pinned callout copy', async ({ page }) => {
        test.setTimeout(120_000);
        await openPopulatedChart(page, locale);
        const note = page.getByTestId('switch-timeline-note');

        // --- 5. the corrected callout copy, pinned. ---------------------
        await expect(note, 'the period-count sentence').toContainText(c.noteSwitches);
        await expect(note, 'the corrected footnote must not regress').toContainText(c.footnoteOpening);
        await expect(page.getByTestId('plan-switch-timeline').locator('h3'), 'the timeline heading').toHaveText(c.title);
        for (const bubble of BUBBLES) {
          const label = await page.getByTestId(bubble.id).getAttribute('aria-label');
          expect(
            label,
            `${bubble.id} (${locale}) callout copy regressed — expected ${calloutPattern(locale, bubble.direction)}`,
          ).toMatch(calloutPattern(locale, bubble.direction));
        }

        // --- 3. the round trip, through the chart's own stops. ----------
        const stops = await focusableCount(page, CHART);
        expect(stops, 'the fixture must render segments AND signed callouts').toBeGreaterThanOrEqual(5);
        expect(
          await page.locator(`${CHART} [data-testid^="switch-bubble-"]`).count(),
          'both signed callouts are tab stops',
        ).toBe(2);

        await focusFirstIn(page, CHART);
        expect(await activeIndex(page, CHART), 'focus must start on the first chart stop').toBe(0);
        expectReadableRing(await settledRing(page, `${locale} stop 0`), `${locale} stop 0`);

        // Forward: every stop, in order, with a readable ring at each one.
        for (let i = 1; i < stops; i++) {
          await page.keyboard.press('Tab');
          await expect
            .poll(() => activeIndex(page, CHART), { message: `Tab stop ${i} did not receive focus` })
            .toBe(i);
          expectReadableRing(await settledRing(page, `${locale} Tab→${i}`), `${locale} Tab→${i}`);
        }

        // Backward: the same stops, in reverse — the half nobody wrote.
        for (let i = stops - 2; i >= 0; i--) {
          await page.keyboard.press('Shift+Tab');
          await expect
            .poll(() => activeIndex(page, CHART), { message: `Shift+Tab stop ${i} did not receive focus` })
            .toBe(i);
          expectReadableRing(await settledRing(page, `${locale} Shift+Tab→${i}`), `${locale} Shift+Tab→${i}`);
        }

        console.log(
          `[plan-switch-focus] populated ${locale} ${vp.width}px — ${stops} stops, round trip complete; last: ${describeRing(
            (await measureFocus(page))!,
          )}`,
        );
      });

      test('populated: the focus ring is never clipped by the chart scrollport', async ({ page }) => {
        test.setTimeout(120_000);
        await openPopulatedChart(page, locale);

        const stops = await focusableCount(page, CHART);
        expect(stops, 'the fixture must render segments AND signed callouts').toBeGreaterThanOrEqual(5);

        const violations: string[] = [];
        const walk: string[] = [];

        await focusFirstIn(page, CHART);
        expect(await activeIndex(page, CHART)).toBe(0);
        for (let i = 0; i < stops; i++) {
          if (i > 0) {
            await page.keyboard.press('Tab');
            await expect
              .poll(() => activeIndex(page, CHART), { message: `Tab stop ${i} did not receive focus` })
              .toBe(i);
          }
          const r = await settledRing(page, `${locale} forward stop ${i}`);
          walk.push(`    forward ${i}: ${describeRing(r)}`);
          const v = clippedViolation(r, `${locale} ${vp.width}px forward stop ${i} (${r.id})`);
          if (v) violations.push(v);
        }
        for (let i = stops - 2; i >= 0; i--) {
          await page.keyboard.press('Shift+Tab');
          await expect
            .poll(() => activeIndex(page, CHART), { message: `Shift+Tab stop ${i} did not receive focus` })
            .toBe(i);
          const r = await settledRing(page, `${locale} backward stop ${i}`);
          const v = clippedViolation(r, `${locale} ${vp.width}px backward stop ${i} (${r.id})`);
          if (v) violations.push(v);
        }

        console.log(
          `[plan-switch-focus] clipping walk ${locale} ${vp.width}px (${stops} stops, chart scrolls 0..${(
            await measureFocus(page)
          )!.scrollWidth}):\n${walk.join('\n')}`,
        );

        // KNOWN-OPEN DEFECT, measured 2026-10-24 on this branch's build of
        // origin/main 128e3fa5 — the assertion below is the whole point of
        // the card, so it stays exactly where it is and rides as an expected
        // failure per the repo's e2e convention: the numbers in `reason` are
        // today's, and when the fix lands Playwright reports "expected to
        // fail but passed", which forces this line's deletion.
        //
        // Two separate holes, both real:
        //   · the global unlayered `:focus-visible { outline-offset: 2px }`
        //     outranks each component's own inset (`focus-visible:
        //     outline-offset-[-2px]` on segments), so the ring is painted 4px
        //     OUTSIDE the element — a flush scroll leaves no room for it and
        //     the scrollport cuts 3.0–3.8px off the first/last stop and off
        //     both signed callouts at 427px;
        //   · `revealFocusedBubble` only handles bubbles, so a partially
        //     visible SEGMENT is never scrolled into view at all (Chrome
        //     scrolls only fully-invisible stops): the middle segment's ring
        //     sits 70.3px past the edge at 390px, 33.3px at 427px, and
        //     walking backward it reaches 68.3px / 166.0px off-view.
        test.fail(
          true,
          vp.width === 390
            ? 'measured 2026-10-24: segment 06-23 ring clipped RIGHT 70.3px (scrollLeft 0/252), segment 05-25 LEFT 3.0px and 07-22 RIGHT 3.0px at the scrollport edge, backward stops up to 68.3px off-view — EN and FR identical'
            : 'measured 2026-10-24: segment 06-23 ring clipped RIGHT 33.3px (scrollLeft 0/215), edge stops 3.0px, callout bubbles 3.6–3.8px, backward stops up to 166.0px off-view — EN and FR identical',
        );
        expect(violations, `clipped focus indicators:\n  ${violations.join('\n  ')}`).toEqual([]);
      });
    });
  }
}

/* ------------------------------------------------------------------------ *
 * 1+2+5 — empty layout: its own callout, pinned, and a keyboard round trip.
 * ------------------------------------------------------------------------ */

for (const vp of VIEWPORTS) {
  for (const locale of LOCALES) {
    const c = COPY[locale];
    test.describe(`plan-switch empty focus @ ${vp.width}×${vp.height} ${locale.toUpperCase()}`, () => {
      test.use({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });

      test('empty: the callout copy is pinned and the panel stays keyboard-reachable', async ({ page }) => {
        test.setTimeout(120_000);
        await seedLocale(page, locale);
        await page.goto('/#tab=plans');
        await dismissUploadModal(page);

        // --- 5. the empty state's own callout, byte for byte. -----------
        const empty = page.getByTestId('switch-timeline-empty');
        await expect(empty, 'the empty callout must render').toBeVisible();
        await expect(empty, `the empty callout copy regressed (${locale})`).toHaveText(c.emptyNote);
        await expect(page.getByTestId('plan-switch-timeline').locator('h3')).toHaveText(c.title);
        // ...and it really is the EMPTY branch: no periods, no chart.
        await expect(page.getByTestId('plan-switch-timeline')).not.toHaveAttribute('data-periods', /.+/);
        await expect(page.getByTestId('switch-timeline-bar')).toHaveCount(0);

        // --- 3. the round trip still works where there is no chart. -----
        const root = PANEL;
        const stops = await focusableCount(page, root);
        expect(stops, 'the empty panel must offer keyboard stops (plan cards do)').toBeGreaterThanOrEqual(2);

        await focusFirstIn(page, root);
        expect(await activeIndex(page, root), 'focus must start on the first panel stop').toBe(0);
        expectReadableRing(await settledRing(page, `${locale} empty stop 0`), `${locale} empty stop 0`);

        for (let i = 1; i < stops; i++) {
          await page.keyboard.press('Tab');
          await expect
            .poll(() => activeIndex(page, root), { message: `Tab stop ${i} did not receive focus` })
            .toBe(i);
          expectReadableRing(await settledRing(page, `${locale} empty Tab→${i}`), `${locale} empty Tab→${i}`);
        }
        for (let i = stops - 2; i >= 0; i--) {
          await page.keyboard.press('Shift+Tab');
          await expect
            .poll(() => activeIndex(page, root), { message: `Shift+Tab stop ${i} did not receive focus` })
            .toBe(i);
          expectReadableRing(await settledRing(page, `${locale} empty Shift+Tab→${i}`), `${locale} empty Shift+Tab→${i}`);
        }

        console.log(`[plan-switch-focus] empty ${locale} ${vp.width}px — ${stops} stops, round trip complete`);
      });
    });
  }
}

/* ------------------------------------------------------------------------ *
 * 4 — route transition: focus across a panel change.
 * ------------------------------------------------------------------------ */

for (const locale of LOCALES) {
  const c = COPY[locale];
  test.describe(`plan-switch route transition ${locale.toUpperCase()}`, () => {
    test.use({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });

    test('panel change keeps focus connected, reachable and readable', async ({ page }) => {
      test.setTimeout(120_000);
      await openPopulatedChart(page, locale);
      const timeline = page.getByTestId('plan-switch-timeline');

      // Focus a signed callout — the stop #122 made real.
      await page.locator('[data-testid="switch-bubble-2026-07-22"]').focus();
      await expect.poll(() => activeIndex(page, CHART)).toBeGreaterThanOrEqual(0);
      expectReadableRing(
        await settledRing(page, `${locale} before the panel change`),
        `${locale} before the panel change`,
      );

      // --- 4a. the tab strip (the app's own route control). -------------
      await page.getByRole('tab', { name: c.tabs.overview, exact: true }).click();
      await expect(page.getByTestId('tab-panel-plans'), 'the plans panel unmounts').toHaveCount(0);
      await expect(page.getByTestId('tab-panel-overview')).toBeVisible();
      const landed = await measureFocus(page);
      expect(landed, 'focus fell to nothing at all after the panel change').not.toBeNull();
      expect(
        await page.evaluate(() => document.activeElement?.isConnected ?? false),
        'focus is stranded on a node the unmount destroyed',
      ).toBe(true);
      expect(
        landed!.tag,
        `focus landed on ${landed!.tag} "${landed!.name}" — expected a live control, not the document body`,
      ).not.toBe('BODY');

      await page.getByRole('tab', { name: c.tabs.plans, exact: true }).click();
      await expect(timeline).toHaveAttribute('data-periods', '3');
      const back = await measureFocus(page);
      expect(back, 'focus fell to nothing at all after returning').not.toBeNull();
      expect(back!.tag, `focus landed on ${back!.tag} after returning`).not.toBe('BODY');
      expect(
        await page.evaluate(() => document.activeElement?.isConnected ?? false),
        'focus is stranded on a detached node after returning',
      ).toBe(true);

      // The re-mounted panel must be reachable by keyboard from where focus
      // actually is — a focus ring nobody can Tab to is not a focus ring.
      const entered = await tabInto(page, PANEL);
      expect(entered, 'the re-mounted plans panel is not reachable by Tab').toBeGreaterThanOrEqual(0);
      expectReadableRing(
        await settledRing(page, `${locale} entering the re-mounted panel`),
        `${locale} entering the re-mounted panel`,
      );

      // ...and the chart's own round trip still works after the remount.
      await focusFirstIn(page, CHART);
      expect(await activeIndex(page, CHART)).toBe(0);
      await page.keyboard.press('Tab');
      await expect.poll(() => activeIndex(page, CHART)).toBe(1);
      expectReadableRing(
        await settledRing(page, `${locale} round trip after remount (Tab)`),
        `${locale} round trip after remount (Tab)`,
      );
      await page.keyboard.press('Shift+Tab');
      await expect.poll(() => activeIndex(page, CHART)).toBe(0);
      expectReadableRing(
        await settledRing(page, `${locale} round trip after remount (Shift+Tab)`),
        `${locale} round trip after remount (Shift+Tab)`,
      );

      // --- 4b. the `#tab=` route change with focus inside the panel. ----
      await page.locator('[data-testid="switch-bubble-2026-07-22"]').focus();
      await page.evaluate(() => {
        window.location.hash = '#tab=overview';
      });
      await expect(page.getByTestId('tab-panel-plans')).toHaveCount(0);
      await expect(page.getByTestId('tab-panel-overview')).toBeVisible();
      await measureFocus(page);
      expect(
        await page.evaluate(() => document.activeElement?.isConnected ?? false),
        'hash navigation stranded focus on a detached node',
      ).toBe(true);
      await page.evaluate(() => {
        window.location.hash = '#tab=plans';
      });
      await expect(timeline).toHaveAttribute('data-periods', '3');
      const enteredAfterHash = await tabInto(page, PANEL);
      expect(enteredAfterHash, 'the panel is not reachable by Tab after a #tab= route change').toBeGreaterThanOrEqual(0);
      expectReadableRing(
        await settledRing(page, `${locale} after #tab= route change`),
        `${locale} after #tab= route change`,
      );

      const panelStops = await focusableCount(page, PANEL);
      console.log(
        `[plan-switch-focus] route ${locale} — tab click landed on ${back!.tag} "${back!.name}", panel reachable in ${entered} Tab(s) of a ${panelStops}-stop panel, hash route reachable in ${enteredAfterHash}`,
      );
    });
  });
}
