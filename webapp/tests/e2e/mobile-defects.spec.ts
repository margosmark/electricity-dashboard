import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * Mark's four mobile defects (t_fcbba376, built in t_c58f1459) — the
 * MECHANICAL acceptance checks, run at both viewports the evidence covers:
 *
 *   390×844   the iPhone-class viewport ux spec'd against;
 *   427×952   Mark's actual device (DPR 3.0, 1280×2856 screenshot — six
 *             independent anchors all give exactly 3.0). The width
 *             compensation in D3a is what makes the SAME code pass both.
 *
 * D1 (the sticky rule under the pills) uses the authoritative black/dark-slate
 * `border-edge` token. Its rendered colour, spacing, opaque surface, and shadow
 * boundary are asserted below at both viewports and in both themes.
 *
 * The seed is Mark-shaped: 24 monthly bills (Aug 2024 → Jul 2026) plus
 * readings running into the current month so the projection gate opens — the
 * same fixture the spec's screenshots were taken against.
 */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 427, height: 952 },
];

/**
 * The seed moved to mark-seed.ts: theme-contrast.spec.ts needs the SAME
 * dashboard shape (its walk was passing over a page BillProjectionBanner
 * never rendered on), and two copies of a fixture is two fixtures. Behaviour
 * is unchanged — 24 bills, readings carried into the current month, the
 * projection gate open — so every measurement below still starts from the
 * page the spec screenshots were taken against.
 */
const seedAndReload = seedMarkShaped;

/** D2 — clearance between the selected pill's hard blue shadow and its neighbour. */
async function measureD2(page: Page) {
  return page.evaluate(() => {
    const active = document.querySelector('[role="tab"][data-active="true"]');
    const list = active?.parentElement;
    if (!active || !list) return null;
    const pills = [...list.querySelectorAll('[role="tab"]')];
    const index = pills.indexOf(active as HTMLButtonElement);
    const next = pills[index + 1];
    if (!next) return null;
    const cs = getComputedStyle(active as Element);
    const shadow = /rgb\(37,\s*99,\s*235\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(cs.boxShadow);
    const offset = shadow ? Math.abs(parseFloat(shadow[1])) : 0;
    const a = active.getBoundingClientRect();
    const n = next.getBoundingClientRect();
    return {
      shadow: cs.boxShadow,
      pillGap: n.left - a.right,
      shadowClearance: n.left - (a.right + offset),
      focusVisible: (active as HTMLElement).matches(':focus-visible'),
      offset,
    };
  });
}

/** D3 — every label legible, none overlapping, each season word inside its band. */
async function measureD3(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="efficiency-chart"]') as SVGSVGElement | null;
    if (!svg) return null;
    const svgBox = svg.getBoundingClientRect();
    const texts = [...svg.querySelectorAll('text')].map((t) => {
      const r = t.getBoundingClientRect();
      return {
        text: t.textContent || '',
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        fontSize: getComputedStyle(t).fontSize,
        anchor: t.getAttribute('text-anchor'),
      };
    });

    const overlaps: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const b = texts[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) overlaps.push(`"${a.text}" × "${b.text}" (${ox.toFixed(1)}×${oy.toFixed(1)}px)`);
      }
    }

    const bands = [...svg.querySelectorAll('[data-testid="efficiency-season-band"]')].map((rect) => {
      const rb = rect.getBoundingClientRect();
      const label = (rect.closest('g') as Element | null)?.querySelector('text') || null;
      const lb = label?.getBoundingClientRect() || null;
      return {
        season: rect.getAttribute('data-season'),
        width: rb.width,
        units: Number(rect.getAttribute('width')),
        x1: Number(rect.getAttribute('x')),
        bars: 0,
        x2: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')),
        label: label?.textContent || null,
        escapes: lb
          ? lb.left < rb.left - 1 ||
            lb.right > rb.right + 1 ||
            lb.top < rb.top - 1 ||
            lb.bottom > rb.bottom + 1
          : false,
      };
    });
    // Bill count per band: the bands tile the plot, so one bill's worth of
    // width is the span divided by the number of periods. That is what the
    // pre-D3 `bars >= 3` gate counted, and it is how the desktop assertion
    // below compares the new fit test against the old rule.
    const n = Number(svg.getAttribute('data-points')) || 0;
    const step = n > 0 && bands.length ? (bands[bands.length - 1].x2 - bands[0].x1) / n : 0;
    for (const b of bands) b.bars = step > 0 ? Math.round(b.units / step) : 0;

    // The spec's own guards: nothing clipped by the svg box either.
    const clipped = texts.filter((t) => t.x < svgBox.left - 1 || t.x + t.w > svgBox.right + 1);

    const heights = texts.map((t) => t.h);
    return {
      svgWidth: svgBox.width,
      count: texts.length,
      minHeight: heights.length ? Math.min(...heights) : 0,
      fontSizes: [...new Set(texts.map((t) => parseFloat(t.fontSize)))],
      overlaps,
      clipped: clipped.map((t) => t.text),
      bands: bands.map((b) => ({ ...b, step: step })),
      escapedBands: bands.filter((b) => b.escapes).length,
      labelledBands: bands.filter((b) => b.label).length,
    };
  });
}

/** D4 — at max scroll the last card must clear the OS gesture bar. */
async function measureD4(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const card = document.querySelector('[data-testid="bill-projection"]');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return {
      state: card.getAttribute('data-state'),
      bottom: r.bottom,
      viewport: window.innerHeight,
      clearance: window.innerHeight - r.bottom,
      fullyVisible: r.bottom <= window.innerHeight && r.top >= 0,
      bodyPadBottom: getComputedStyle(document.body).paddingBottom,
      maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      scrollY: Math.round(window.scrollY),
    };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`mobile defects @ ${vp.width}×${vp.height}`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });

    test(`D2 + D3 + D4 acceptance at ${vp.width}×${vp.height}`, async ({ page }) => {
      test.setTimeout(180_000);
      await seedAndReload(page);

      // --- D2: the blue sliver must keep its 5px of air. ---------------
      const d2 = await measureD2(page);
      expect(d2, 'a selected tab with a neighbour to its right').not.toBeNull();
      // The blue hard shadow is a deliberate language element (toolbar
      // buttons use shadow-hard-blue-4) — spacing, not colour, is the fix.
      expect(d2!.shadow).toContain('37, 99, 235');
      expect(d2!.focusVisible, 'the sliver was never the focus ring').toBe(false);
      expect(d2!.offset, '3px hard offset').toBe(3);
      expect(d2!.pillGap, 'gap-2 = 8px between pills').toBeGreaterThanOrEqual(8);
      // Shadow ends 3px into that gap → ≥5px of clear air (spec: ≥4px).
      expect(d2!.shadowClearance).toBeGreaterThanOrEqual(4);

      // --- D3: legible type, no collisions, labels inside their bands. --
      const d3 = await measureD3(page);
      expect(d3, 'the mini-line renders').not.toBeNull();
      expect(d3!.count, 'the fixture draws bands, axes, ticks and both period ends').toBeGreaterThanOrEqual(7);
      expect(d3!.minHeight, 'every label ≥ 8 CSS px').toBeGreaterThanOrEqual(8);
      expect(d3!.overlaps, 'no two label boxes may intersect').toEqual([]);
      expect(d3!.clipped, 'no label may leave the svg box').toEqual([]);
      expect(d3!.escapedBands, 'a rendered season label stays inside its band').toBe(0);

      // …and the size really is compensated for this width: the expected
      // user-unit size is what the same formula returns for the measured box.
      const expectedFs = Math.max(10, Math.round((9 * 720) / Math.max(1, d3!.svgWidth)));
      expect(d3!.fontSizes, `chart is ${d3!.svgWidth.toFixed(1)}px wide`).toEqual([expectedFs]);
      expect(expectedFs, 'mobile labels are compensated, not the desktop 10').toBeGreaterThan(10);
      // The 3-bar edge seasons are narrower than the word: the guard drops
      // them rather than letting them spill into the y-axis gutter.
      expect(d3!.bands.length).toBeGreaterThanOrEqual(3);
      expect(d3!.labelledBands).toBeGreaterThan(0);

      // --- D4: the last card clears the gesture bar at max scroll. ------
      const d4 = await measureD4(page);
      expect(d4, 'the projection banner renders').not.toBeNull();
      expect(d4!.state, 'fixture must open the projection gate').toBe('ready');
      expect(d4!.bodyPadBottom, 'body floor = max(2.5rem, env())').toBe('40px');
      expect(d4!.fullyVisible, 'the card is whole at max scroll').toBe(true);
      // The OS bar is 108 image px ÷ DPR 3.0 = 36 CSS px on Mark's device;
      // the spec's acceptance bar is ≥33px of clearance.
      expect(d4!.clearance, 'projection card bottom vs viewport bottom').toBeGreaterThanOrEqual(33);
      expect(d4!.scrollY, 'we really were at max scroll').toBe(d4!.maxScroll);
    });

    for (const theme of ['light', 'dark'] as const) {
      test(`D1 sticky rule in ${theme} at ${vp.width}×${vp.height}`, async ({ page }) => {
        await page.context().addInitScript((value) => localStorage.setItem('theme', value), theme);
        await seedAndReload(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const d1 = await page.getByTestId('tab-nav').evaluate((nav) => {
          const style = getComputedStyle(nav);
          const navRect = nav.getBoundingClientRect();
          // #109 cut this against a nav whose LAST row was the pill row. Main's
          // #113 moved the date / scope / theme shell tools into this nav as
          // `shellTools`, and they own their own full-width line — so they,
          // not the tablist, sit directly above the rule now. Measuring from
          // the tablist reads the whole toolbar's height (181px at 390x844,
          // measured) instead of the 3px surface this contract is about. The
          // bound and the intent (the rule hangs off the nav's last content
          // row) are unchanged; only the reference element follows the shell.
          const lastRowBottom = [...nav.children].reduce(
            (max, el) => Math.max(max, el.getBoundingClientRect().bottom),
            Number.NEGATIVE_INFINITY,
          );
          const active = nav.querySelector('[role="tab"][data-active="true"]')!;
          const activeRect = active.getBoundingClientRect();
          const shadow = getComputedStyle(active).boxShadow;
          const shadowOffset = /rgb\(37,\s*99,\s*235\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(shadow);
          const shadowBottom = activeRect.bottom + (shadowOffset ? parseFloat(shadowOffset[2]) : 0);
          // Resolve BOTH tokens through probe elements: #109 pinned
          // rgb(0,0,0)/rgb(203,213,225), which was this palette's --edge at
          // the time the branch was cut; main's redesign moved the tokens
          // (#e5e5e0 light / #242a35 dark), so a literal would assert a
          // colour the strip is no longer shipped with. The criterion the
          // comment above names — "resolves from --edge, not --edge-muted"
          // (the regression 8868a43 replaced) — is what is checked, in both
          // themes, plus an explicit edge-muted discriminator so a token
          // swap still fails.
          const probe = (token: string) => {
            const el = document.createElement('span');
            el.style.color = `var(${token})`;
            document.body.append(el);
            const value = getComputedStyle(el).color;
            el.remove();
            return value;
          };
          return {
            borderWidth: style.borderBottomWidth,
            borderColor: style.borderBottomColor,
            edge: probe('--edge'),
            edgeMuted: probe('--edge-muted'),
            background: style.backgroundColor,
            backdrop: style.backdropFilter,
            rowToRuleGap: navRect.bottom - parseFloat(style.borderBottomWidth) - lastRowBottom,
            shadowBottom,
            navBottom: navRect.bottom,
          };
        });

        expect(d1.borderWidth).toBe('2px');
        expect(d1.borderColor, 'the rule resolves from --edge, not --edge-muted').toBe(d1.edge);
        expect(d1.borderColor, '…and --edge is not the muted token').not.toBe(d1.edgeMuted);
        expect(d1.background, 'the inset surface is opaque').not.toBe('rgba(0, 0, 0, 0)');
        expect(d1.backdrop).toBe('none');
        expect(d1.rowToRuleGap, "the nav's last content row to the rule's top").toBeGreaterThanOrEqual(0);
        expect(d1.rowToRuleGap, "1px surface + 2px rule: last row hugs the rule").toBeLessThanOrEqual(3);
        expect(d1.shadowBottom, 'blue shadow ends at or above the nav bottom edge').toBeLessThanOrEqual(d1.navBottom);
      });
    }
  });
}

test.describe('desktop must not change', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('labels resolve to the pre-D3 literal size at default widths', async ({ page }) => {
    test.setTimeout(180_000);
    await seedAndReload(page);

    const d3 = await measureD3(page);
    expect(d3).not.toBeNull();
    // ≥768px layout measures a chart ≥648px wide → chartLabelFs floors at 10,
    // which is exactly the literal every one of these labels carried before.
    expect(d3!.svgWidth).toBeGreaterThanOrEqual(648);
    expect(d3!.fontSizes).toEqual([10]);
    expect(d3!.overlaps).toEqual([]);
    expect(d3!.escapedBands).toBe(0);
    expect(d3!.minHeight).toBeGreaterThanOrEqual(8);
    // The fixture's edge seasons are narrow (1 bill wide this month) and
    // carry no label — exactly what the pre-D3 `bars >= 3` gate did. What
    // the spec's one-directional bar demands: every band the OLD gate
    // labelled still has its label, and every band that gained one fits it.
    const legacy = d3!.bands.filter((b) => b.bars >= 3);
    expect(legacy.length, 'the fixture must actually exercise the gate').toBeGreaterThanOrEqual(3);
    expect(legacy.filter((b) => !b.label)).toEqual([]);
    expect(d3!.labelledBands).toBeGreaterThanOrEqual(legacy.length);
    // …and any band the fit test drops is genuinely too narrow: < 43 user
    // units is < 4.3 × labelFs at labelFs 10.
    for (const b of d3!.bands.filter((x) => !x.label)) expect(b.units).toBeLessThan(4.3 * 10);
  });
});
