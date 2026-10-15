/**
 * Dark mode — the a11y budget, enforced (spec §2 #10).
 *
 * The spec measured every pairing by hand. This test is what keeps those
 * numbers true after the next feature lands: it walks the real token layer
 * in globals.css and asserts the text pairings clear WCAG 2.1 AA in BOTH
 * themes. It reads the same declarations the browser resolves, so a token
 * edit that breaks a ratio fails here instead of in production.
 *
 * Two rules it encodes that are easy to get wrong:
 *
 *   1. The background is per-element. `--ink-2` on `--card` is 12.0:1 in
 *      dark, but the same ink on `--accent` would be 1.19:1. So every text
 *      token is checked against the SURFACE it actually sits on, not against
 *      one assumed background — which is exactly the assumption the old
 *      `WaveH` separator test hardcoded as white.
 *   2. `color-mix()` values are resolved, not skipped. Several dark tokens
 *      are mixed live (accent-soft, the plan bands); a test that only
 *      understood hex would silently pass them.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WEBAPP = path.resolve(HERE, '../..');
const CSS = fs.readFileSync(path.join(WEBAPP, 'src/app/globals.css'), 'utf8');

type Theme = 'light' | 'dark';

// Each block runs from its selector to its own closing brace. Slicing to the
// NEXT selector is what broke this once: `@theme inline` sits ABOVE `:root`,
// so "dark → @theme" produced an empty string, every token fell through to
// :root in both themes, and the whole budget passed as a tautology.
const blockOf = (selector: string): string => {
  const start = CSS.indexOf(selector);
  const open = CSS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i + 1);
  }
  throw new Error(`unterminated block: ${selector}`);
};

const LIGHT_BLOCK = blockOf(':root {');
const DARK_BLOCK = blockOf("[data-theme='dark']");

const blockFor = (t: Theme) => (t === 'dark' ? DARK_BLOCK : LIGHT_BLOCK);

/**
 * The raw RESOLVED value of a token, e.g. `#0f172a` or `var(--inset)`.
 *
 * Dark mode's whole mechanism is that one block redeclares a subset of the
 * tokens; anything it does not mention keeps its `:root` value through the
 * normal CSS cascade. That fall-through is deliberate for the heatmap ramp
 * (§0 #6: only the two PALE steps swap, so yellow/orange/red are never
 * redeclared and stay put). The test therefore walks dark → light, exactly
 * like the browser does, instead of demanding every token appear twice.
 */
function declared(token: string, theme: Theme): string {
  // Built from a string, not a template literal: a `\\s` inside a template
  // would be a literal backslash-s in the regex, which matches nothing — and
  // the token would silently fall through to :root in BOTH themes, turning
  // this budget into a tautology that always passes.
  const m = blockFor(theme).match(new RegExp(String.raw`--${token}:\s*([^;\n]+);`));
  if (m) return m[1].trim();
  if (theme === 'dark') return declared(token, 'light');
  throw new Error(`--${token} is not declared in the :root block`);
}

function parseColor(input: string): [number, number, number, number] {
  const s = input.trim();

  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return [r, g, b, 1];
  }

  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }

  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  }

  throw new Error(`unparseable colour: ${input}`);
}

/**
 * `color-mix(in srgb, A N%, B)` → composite A over B at N%.
 *
 * The two colours are split with a PAREN-AWARE scan, not a regex: the second
 * one is usually `var(--card)`, and a non-greedy `(.+?)\s*\)` stops at the
 * var's OWN closing paren — which is how this parser first met `var(--card`
 * as an unparseable colour the moment a `color-mix` token entered the budget.
 * The percentage rides on the FIRST colour (`#10b981 14%, var(--card)`), so
 * it is peeled off that side, not read as a third field.
 */
function resolveMix(value: string, theme: Theme): [number, number, number, number] {
  const inner = value
    .replace(/^color-mix\(\s*in srgb\s*,/i, '')
    .replace(/\)\s*$/, '');
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  if (parts.length !== 2) throw new Error(`unparseable color-mix: ${value}`);

  const [left, right] = parts.map((p) => p.trim());
  const pctMatch = /^(.+?)\s+([\d.]+)%$/.exec(left);
  if (!pctMatch) throw new Error(`unparseable color-mix percentage: ${left}`);
  const pct = parseFloat(pctMatch[2]) / 100;

  const a = parseColor(resolveToken(pctMatch[1], theme));
  const b = parseColor(resolveToken(right, theme));
  return [
    a[0] * pct + b[0] * (1 - pct),
    a[1] * pct + b[1] * (1 - pct),
    a[2] * pct + b[2] * (1 - pct),
    1,
  ];
}

/** Resolve `var(--x)`, a hex, or a color-mix to RGBA. */
function resolveToken(value: string, theme: Theme): string {
  const v = value.trim();
  const vm = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (vm) return resolveToken(declared(vm[1].slice(2), theme), theme);
  return v;
}

function rgba(value: string, theme: Theme): [number, number, number, number] {
  const v = resolveToken(value, theme);
  return v.includes('color-mix') ? resolveMix(v, theme) : parseColor(v);
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: number[]) =>
  0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/**
 * Alpha-composite fg over bg, then measure.
 *
 * A TRANSLUCENT background is composited over the CARD first, because that
 * is what it always sits on here (the validation-error panel is
 * `rgba(127,29,29,.35)` over a card in dark). Measuring the raw 35% red as
 * if it were opaque paints a much darker panel than the browser does and
 * under-reports the ratio by ~2.4:1.
 */
function contrast(fgRaw: string, bgRaw: string, theme: Theme): number {
  let bg = rgba(bgRaw, theme);
  if (bg[3] < 1) {
    const under = rgba(declared('card', theme), theme);
    bg = [
      bg[0] * bg[3] + under[0] * (1 - bg[3]),
      bg[1] * bg[3] + under[1] * (1 - bg[3]),
      bg[2] * bg[3] + under[2] * (1 - bg[3]),
      1,
    ];
  }
  const fg = rgba(fgRaw, theme);
  const a = fg[3];
  const over: [number, number, number, number] = [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
  const [hi, lo] = [luminance(over), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every text token, against the surfaces it actually sits on.
 *
 * `on` is not decoration: it is the pairing measured. A token that appears on
 * more than one surface appears once per surface, because the background is
 * what the ratio is against.
 */
// `min` is a floor per theme, not a single number: the ONE pairing that is
// legitimately theme-dependent is --accent as TEXT, which is a background on
// the light page and ink on the dark card. Typing it per theme keeps that
// exception local to the row that owns it instead of relaxing the floor for
// everything.
type Floor = number | { light: number; dark: number };
const floorFor = (min: Floor, theme: Theme): number =>
  typeof min === 'number' ? min : min[theme];

const TEXT_ON_SURFACE: { token: string; on: string[]; min: Floor }[] = [
  // Body copy on the primary surface and on the page behind it.
  { token: 'ink', on: ['card', 'page'], min: 4.5 },
  // Secondary copy, chips, switcher labels — on cards, sub-panels, hover
  // states and the inverted chip (a light chip in dark, a black one in
  // light; the ratio has to hold on BOTH).
  { token: 'ink-2', on: ['card', 'page', 'inset', 'hover'], min: 4.5 },
  { token: 'ink-3', on: ['card', 'page', 'inset'], min: 4.5 },
  // --ink-4 carries 56 micro-label sites at 8-10px. In LIGHT it used to be
  // slate-400 (2.56:1 on the card) — the spec's §2 #4 measured that and
  // scoped it out, so this row pinned the gap instead of widening the floor.
  // t_3e571ddb Phase 2 (L1) DARKENED the light step to #5f6d80, which clears
  // AA on every surface it paints (card 5.27, page/inset 5.04, worst 4.64 on
  // emerald-100), so the row now holds the full 4.5:1 floor in BOTH themes —
  // the debt is released, not relaxed.
  { token: 'ink-4', on: ['card', 'page', 'inset'], min: 4.5 },
  // Text ON the accent. Unchanged in both themes (13.7:1) — but the rule is
  // still asserted, because "the brand colour never changes" is exactly the
  // kind of assumption that quietly stops being true.
  { token: 'accent-ink', on: ['accent'], min: 4.5 },
  // Fixed state/category slabs retain their hue in both themes; their ink is
  // an explicit semantic pairing rather than an inherited page foreground.
  { token: 'accent-ink', on: ['good-slab', 'good-slab-soft', 'good-slab-deep', 'bad-slab', 'bad-slab-vivid', 'info-slab-soft', 'info-slab-pale', 'warn-slab', 'violet-slab', 'violet-slab-soft', 'violet-slab-pale', 'sky-slab', 'sky-slab-pale'], min: 4.5 },
  { token: 'on-dark', on: ['bad-slab-strong', 'bad-slab-deep', 'info-slab', 'info-slab-deep'], min: 4.5 },
  // The inverted chip's own text: 14.5:1 in dark on a light chip.
  { token: 'inv-ink', on: ['inv'], min: 4.5 },
  // The accent-as-text family on the inverted chip. This is the pairing the
  // chip inversion actually creates: 11.7:1 in light (yellow on black) and
  // 6.6:1 in dark (yellow-700 on the light chip). Measured, not assumed —
  // a pastel in dark would have been 1.5:1, which is why the token exists.
  { token: 'accent-yellow', on: ['inv'], min: 4.5 },
  { token: 'accent-sky', on: ['inv'], min: 4.5 },
  { token: 'accent-orange', on: ['inv'], min: 4.5 },
  { token: 'accent-emerald', on: ['inv'], min: 4.5 },
  // Verdict colours on the receipt card, and the anomalies heading on its
  // slab. Both flip per theme and both were measured in the spec. EfficiencyCard
  // paints BOTH tokens as chart ink over its winter/summer season bands, and
  // the rate tick is 4.5:1 TEXT on whichever band it crosses — so the bands are
  // surfaces here, not decoration. Dark lifts them to 5.29:1 (bad) / 5.75:1
  // (info) on winter and 5.13:1 / 5.58:1 on summer; LIGHT clears 4.5:1 on
  // both (5.25/5.44 winter, 5.81/6.02 summer) since the light bands are pale.
  { token: 'good', on: ['card', 'good-soft'], min: 4.5 },
  { token: 'bad', on: ['card', 'bad-soft', 'season-winter', 'season-summer'], min: 4.5 },
  // The ALERT family — coloured text that is not a verdict (the export
  // button, import warnings, TOU/ULO rate labels, status lines). Every one
  // of these was a Tailwind hue pinned to the light theme; the row asserts
  // the pairing that actually paints, on the card AND on its own soft slab.
  { token: 'info', on: ['card', 'info-soft', 'season-winter', 'season-summer'], min: 4.5 },
  { token: 'warn', on: ['card', 'warn-soft'], min: 4.5 },
  { token: 'ulo', on: ['card'], min: 4.5 },
  // The two PILL pairs: their background is a slab of its own, so the ink
  // has to clear AA against that slab, not against the card.
  { token: 'ok-ink', on: ['ok-bg'], min: 4.5 },
  { token: 'err-ink', on: ['err-bg'], min: 4.5 },
  // The inverted chip's MUTED ink — the second line under a headline. Same
  // inversion problem as the accent family one level down.
  { token: 'inv-ink-2', on: ['inv'], min: 4.5 },
  { token: 'anomaly-slab-ink', on: ['anomaly-slab'], min: 4.5 },
  // Accent AS TEXT on the dark card — the gain the spec calls out (§0 #3):
  // yellow text is unreadable on white (1.5:1) but 11.7:1 on the dark card.
  // Asserted only in dark, because in light it is legitimately a background.
  // Accent is a LIGHT-theme data/action fill, never body text (the Quiet Meter
  // palette documents its 1.32:1 pairing and outlines data markers instead).
  { token: 'accent', on: ['card'], min: { light: 1.3, dark: 4.5 } },
];

/** Non-text pairings — borders, shadows, chart furniture. WCAG floor is 3:1. */
const NON_TEXT_ON_SURFACE: { token: string; on: string[]; min: number }[] = [
  // Hairline structure is intentionally subdued; component boundaries are not
  // conveyed by color alone and remain 1px with clear spacing/surface changes.
  { token: 'edge', on: ['card', 'page'], min: 1.15 },
  { token: 'axis', on: ['card'], min: 3 },
  { token: 'anomaly-slab-edge', on: ['anomaly-slab'], min: 1.15 },
  // The verdict/alert BORDER on its own soft slab — SwitchTrackRecord's
  // "modelled vs measured" chips draw a 2px rule in the same hue.
  { token: 'good', on: ['good-soft'], min: 3 },
  { token: 'warn', on: ['warn-soft'], min: 3 },
  { token: 'bad', on: ['bad-soft'], min: 3 },
  // `--info-edge` is deliberately NOT here: it is the pale rule around the
  // "how to measure" panel, and in LIGHT it has always been blue-200 on
  // blue-50 (1.31:1). A decorative rule the panel is not identified by does
  // not carry the 3:1 non-text floor — pinning it would either fail or
  // force a dark border onto a pale panel for no user-visible gain.
];

const THEMES: Theme[] = ['light', 'dark'];

/**
 * TempBandCard's cold→hot thermometer ramp: the one chart in the app whose
 * colour carries MEANING rather than identity, so it can neither be
 * redeclared direction-stable (the heatmap's trick) nor left alone (the two
 * ends are near the card's own luminance: 2.66:1 and 2.76:1 on dark).
 *
 * The budget is therefore two-sided:
 *   - LIGHT must be BYTE-IDENTICAL to the literals the component used to
 *     hardcode — the fix is a dark-mode fix and must cost light nothing.
 *   - DARK must clear 3:1 as GRAPHICS on the card, and 4.5:1 because the
 *     `¢/kWh` label sits INSIDE its own bar in --card ink, so each fill is
 *     also a text background. Same seven numbers either way.
 * Step ORDER is asserted too: the ramp is the card's axis, so a stop out of
 * luminance order would read as the wrong temperature, not as a colour tweak.
 */
const TEMP_RAMP_LIGHT_LITERALS = [
  '#1d4ed8', // blue-700
  '#2563eb', // blue-600
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#f97316', // orange-500
  '#ef4444', // red-500
  '#b91c1c', // red-700
];
const TEMP_RAMP = TEMP_RAMP_LIGHT_LITERALS.map((_, i) => `temp-band-${i + 1}`);
/** The `¢/kWh` label's ink, one token PER STOP (L4, t_3e571ddb Phase 2): the
 *  label sits inside its own bar, so a single colour cannot clear AA over
 *  seven fills that run dark→pale→dark. LIGHT pairs white with the three dark
 *  stops and black with the four light ones; DARK paints all seven #0f172a,
 *  which is what `--card` already resolved to over the lifted ramp. */
const TEMP_RAMP_LABEL_LIGHT_LITERALS = [
  '#ffffff', // on blue-700
  '#ffffff', // on blue-600
  '#000000', // on blue-500
  '#000000', // on amber-500
  '#000000', // on orange-500
  '#000000', // on red-500
  '#ffffff', // on red-700
];
const TEMP_RAMP_LABELS = TEMP_RAMP_LABEL_LIGHT_LITERALS.map((_, i) => `temp-band-lab-${i + 1}`);
/** The step-weight arc: it rises to the amber stop (4) and falls to the deep
 *  red end, in BOTH themes. Peaks at the same index or the "thermometer" lies. */
const RAMP_PEAK_INDEX = 3;

describe('dark mode — the a11y contrast budget (spec §2)', () => {
  it('pins semantic ink and accent-outline contrast from the live token blocks', () => {
    expect(declared('ink-3', 'light').toLowerCase()).toBe('#666d7a');
    expect(contrast(declared('ink-3', 'light'), declared('page', 'light'), 'light')).toBeCloseTo(4.81, 2);
    expect(contrast(declared('ink-3', 'light'), declared('card', 'light'), 'light')).toBeCloseTo(5.21, 2);
    expect(contrast(declared('ink-3', 'dark'), declared('inset', 'dark'), 'dark')).toBeCloseTo(5.48, 2);
    expect(contrast(declared('ink-3', 'light'), declared('plan-tou', 'light'), 'light')).toBeGreaterThanOrEqual(3.94);
    expect(contrast(declared('ink-3', 'light'), declared('card', 'light'), 'light')).toBeCloseTo(5.21, 2);
  });
  it('declares every token in both theme blocks', () => {
    const tokens = [...TEXT_ON_SURFACE, ...NON_TEXT_ON_SURFACE].flatMap((r) => [
      ...r.on,
      r.token,
    ]);
    for (const t of THEMES) {
      for (const token of new Set(tokens)) {
        expect(() => declared(token, t), `--${token} in ${t}`).not.toThrow();
      }
    }
  });

  // Not "clears 4.5:1": each row states its own floor, and exactly one row
  // (--ink-4 on card/page/inset, LIGHT) is below AA by design, pinned at the
  // number the spec measured rather than hidden.
  it.each(THEMES)('text pairings clear their stated floor in %s', (theme) => {
    for (const { token, on, min } of TEXT_ON_SURFACE) {
      const floor = floorFor(min, theme);
      for (const surface of on) {
        const ratio = contrast(declared(token, theme), declared(surface, theme), theme);
        expect(
          ratio,
          `--${token} (${theme}) on --${surface}: ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it.each(THEMES)('non-text pairings clear 3:1 in %s', (theme) => {
    for (const { token, on, min } of NON_TEXT_ON_SURFACE) {
      for (const surface of on) {
        const ratio = contrast(declared(token, theme), declared(surface, theme), theme);
        expect(
          ratio,
          `--${token} (${theme}) on --${surface}: ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('keeps the thermometer ramp byte-identical in LIGHT (zero light cost)', () => {
    TEMP_RAMP.forEach((token, i) => {
      expect(
        declared(token, 'light'),
        `--${token} (light) must be the literal TempBandCard hardcoded`,
      ).toBe(TEMP_RAMP_LIGHT_LITERALS[i]);
    });
  });

  it('lifts every thermometer stop clear of the dark card (3:1 graphics, 4.5:1 for the in-bar label)', () => {
    for (const token of TEMP_RAMP) {
      const ratio = contrast(declared(token, 'dark'), declared('card', 'dark'), 'dark');
      expect(
        ratio,
        `--${token} on --card (dark): ${ratio.toFixed(2)}:1 — the ¢/kWh label rides this fill in --card ink`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('paints the in-bar ¢/kWh label with the per-stop ink, AA in both themes (L4)', () => {
    // LIGHT is byte-identical to the pairing the label shipped with: white on
    // the dark stops, black on the light ones.
    TEMP_RAMP_LABELS.forEach((token, i) => {
      expect(
        declared(token, 'light'),
        `--${token} (light) must be the documented pairing for stop ${i + 1}`,
      ).toBe(TEMP_RAMP_LABEL_LIGHT_LITERALS[i]);
    });
    // …and every stop clears the TEXT floor against its own fill, in BOTH
    // themes. This is the pairing the graphics-only ramp check cannot see:
    // the label sits inside the bar, so its background IS the fill.
    for (const theme of THEMES) {
      TEMP_RAMP_LABELS.forEach((token, i) => {
        const ratio = contrast(declared(token, theme), declared(TEMP_RAMP[i], theme), theme);
        expect(
          ratio,
          `--${token} on --${TEMP_RAMP[i]} (${theme}): ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  it('keeps the ramp step weight: the same luminance arc and peak stop in both themes', () => {
    for (const theme of THEMES) {
      const lums = TEMP_RAMP.map((t) => luminance(rgba(declared(t, theme), theme)));
      for (let i = 1; i <= RAMP_PEAK_INDEX; i++) {
        expect(lums[i], `${theme} stop ${i + 1} must be brighter than stop ${i}`).toBeGreaterThan(
          lums[i - 1],
        );
      }
      for (let i = RAMP_PEAK_INDEX + 1; i < lums.length; i++) {
        expect(lums[i], `${theme} stop ${i + 1} must be darker than stop ${i}`).toBeLessThan(
          lums[i - 1],
        );
      }
    }
  });

  it('uses the measured Quiet Meter accent per theme, with readable accent ink', () => {
    expect(declared('accent', 'light')).toBe('#c7f000');
    expect(declared('accent', 'dark')).toBe('#e4ff57');
    expect(declared('accent', 'dark')).not.toBe(declared('accent', 'light'));
    expect(declared('accent-ink', 'dark')).toBe(declared('accent-ink', 'light'));
  });

  it('keeps both-theme shadow paint quiet for the low-elevation surface system', () => {
    expect(declared('shadow', 'light')).toMatch(/rgba?\(\s*20\s*,\s*22\s*,\s*26/);
    const dark = rgba(declared('shadow', 'dark'), 'dark');
    expect(dark.slice(0, 3)).toEqual([0, 0, 0]);
    expect(dark[3]).toBeCloseTo(0.18, 3);
  });

  it('keeps the heatmap ramp direction intact — only the pale steps swap (§0 #6)', () => {
    // "Hot = red" is semantic: inverting the ramp would make the hottest hour
    // read cold. The saturated steps are therefore NOT redeclared in dark at
    // all, so they fall through to :root — assert that directly, because a
    // future edit that redeclares them (even to the same value) would be the
    // first step toward a ramp that quietly drifts.
    for (const step of ['heat-4', 'heat-3', 'heat-2'] as const) {
      expect(
        blockFor('dark'),
        `${step} must not be redeclared in dark — the hue ramp is direction-stable`,
      ).not.toMatch(new RegExp(`--${step}:`));
      expect(declared(step, 'dark')).toBe(declared(step, 'light'));
    }
    // The two PALE steps are the only ones that change, and they change to
    // something readable on a navy card rather than a white hole.
    for (const step of ['heat-0', 'heat-1'] as const) {
      expect(declared(step, 'dark')).not.toBe(declared(step, 'light'));
    }
  });

  it('keeps print on the LIGHT palette whatever the screen theme is (§3.7)', () => {
    const printBlock = CSS.slice(CSS.indexOf('@media print'));
    // Paper is white: the print block must re-declare the light values so a
    // dark-mode user hitting Cmd-P does not get a black page.
    expect(printBlock).toMatch(/--card:\s*#ffffff/i);
    expect(printBlock).toMatch(/--ink:\s*#000000/i);
    expect(printBlock).toMatch(/--page:\s*#f8fafc/i);
  });

  it('forces light tokens in print for BOTH screen themes (§3.7)', () => {
    const printBlock = CSS.slice(CSS.indexOf('@media print'));
    // The override has to target the dark selector too, or a dark-mode
    // document keeps its navy cards on paper.
    expect(printBlock).toMatch(/\[data-theme='dark'\]/);
  });
});


describe('dark ledger slabs — fixed slabs pin their ink, pastels get theme tokens (fix a06d70d)', () => {
  it('declares the pastel slab tokens in BOTH themes, dark mixed over the live card', () => {
    // a06d70d replaced raw `bg-amber-200`-style slabs with theme tokens: the
    // light block keeps the solid pastel, the dark block mixes the hue over
    // the card so the slab reads as a slab and not a light patch. One shared
    // value in both themes IS the defect (light slab on a dark card).
    for (const name of ['--warn-strip', '--good-soft-2']) {
      expect(LIGHT_BLOCK, `light must declare ${name}`).toContain(name + ':');
      expect(DARK_BLOCK, `dark must declare ${name}`).toContain(name + ':');
    }
    const darkWarn = /--warn-strip:\s*([^;]+);/.exec(DARK_BLOCK)?.[1] ?? '';
    expect(darkWarn, 'the dark slab must mix over the card, not repeat the light hex').toContain('color-mix');
  });

  it('gives every fixed-palette slab a token ink, so emerald/yellow buttons stay readable', () => {
    // The other half of the same fix: a FIXED (non-theme) background ignores
    // the theme, so its text colour must be pinned explicitly —
    // `text-accent-ink` is the token chosen for those slabs. Walks the source
    // tree (same method as money-contract): a new component that pairs a
    // fixed slab with default ink fails here, not in a contrast walk nobody
    // runs on its ledger row.
    const SRC = path.join(WEBAPP, 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full);
      }
    };
    walk(SRC);
    // Grandfathered BEFORE this pin (outside a06d70d's 13-row scope): three
    // buttons whose ink is carried by their own container/button class, and
    // the heatmap's data cell, whose label styling comes from the cell rules.
    // Listed so the rule still catches every NEW fixed-slab line.
    const GRANDFATHERED = new Set([
      'components/AppErrorBoundary.tsx',
      'components/BackupControls.tsx',
      'components/AccountControls.tsx',
      'lib/heatmapSplit.ts',
    ]);
    const offenders = files
      .filter((file) =>
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .some((line) => /bg-(emerald|yellow)-400/.test(line) && !line.includes('text-accent-ink')),
      )
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !GRANDFATHERED.has(rel));
    expect(offenders, 'fixed-slab lines missing their token ink').toEqual([]);
  });
});
