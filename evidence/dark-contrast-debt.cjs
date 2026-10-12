/**
 * Dark-mode contrast debt — the TOKEN math, re-run from source (t_fbf590fa).
 *
 * This is the arithmetic behind the dark-mode fix, kept in the repo so the
 * numbers in the card, the commit message and the QA re-verification all come
 * from ONE place that anyone can re-run. It parses the real `globals.css`
 * blocks (:root / [data-theme='dark'] / @media print), resolves `var()` and
 * `color-mix()` the way the browser does, and applies WCAG 2.1.
 *
 * What it checks, and why each floor is what it is:
 *
 *   1. THERMOMETER RAMP (TempBandCard's 7 bar fills). Graphics floor 3:1
 *      against the card it is painted on. The card's `¢/kWh` label sits INSIDE
 *      its own bar in --card ink, so each fill is also a TEXT background: 4.5:1.
 *      LIGHT must be byte-identical to the literal list the component used to
 *      hardcode (this is a dark fix; light pays nothing). The step-weight arc
 *      must survive the lift — the ramp is the temperature axis, so a stop out
 *      of luminance order reads as the wrong temperature.
 *   2. EFFICIENCYCARD pairings. `var(--bad)` paints a 4.5:1 TEXT label (the
 *      "RATES CHANGE" tick word) and a dashed rule; `var(--info)` a 3:1 rule.
 *      Both sit over the season bands, so the bands are surfaces here.
 *   3. BILLPROJECTIONBANNER. `--ink` on `--card` for the two mini-cards
 *      (the box's ink follows its OWN surface), and `--accent-ink` on the
 *      emerald-400 flood for the caption (a fixed slab carries fixed ink).
 *   4. PRINT IS LIGHT. `@media print` re-declares the ramp to the light values,
 *      or a dark-mode print carries lifted fills onto paper.
 *
 * Run:  node evidence/dark-contrast-debt.cjs
 * Writes evidence/dark-contrast-debt.json; exits 1 on any violated floor.
 */

const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.resolve(__dirname, '../webapp/src/app/globals.css'),
  'utf8',
);

/* ---------------------------------------------------------------- parsing */

/** The { ... } body of a selector, matched to its OWN closing brace. */
function blockOf(selector) {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = CSS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i + 1);
  }
  throw new Error(`unterminated block: ${selector}`);
}

const LIGHT = blockOf(':root {');
const DARK = blockOf("[data-theme='dark']");
const PRINT = CSS.slice(CSS.indexOf('@media print {'));

const blockFor = (theme) => (theme === 'dark' ? DARK : LIGHT);

/** Raw declared value, or null — the caller decides what a fall-through means. */
function rawDeclared(token, theme) {
  const m = blockFor(theme).match(new RegExp(String.raw`--${token}:\s*([^;\n]+);`));
  return m ? m[1].trim() : null;
}

/** The value the browser resolves: this theme's, else :root's (the cascade). */
function declared(token, theme) {
  const own = rawDeclared(token, theme);
  if (own) return own;
  if (theme === 'dark') {
    const light = rawDeclared(token, 'light');
    if (light) return light;
  }
  throw new Error(`--${token} is not declared`);
}

function hexToRgb(s) {
  const h = s.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`unparseable hex: ${s}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

function parseColor(value) {
  const s = value.trim();
  if (s.startsWith('#')) return hexToRgb(s);
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i.exec(s);
  if (!m) throw new Error(`unparseable colour: ${value}`);
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
}

/** `color-mix(in srgb, A N%, B)` → A composited over B at N%. Paren-aware. */
function resolveMix(value, theme) {
  const inner = value.replace(/^color-mix\(\s*in srgb\s*,/i, '').replace(/\)\s*$/, '');
  const parts = [];
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
  const pctMatch = /^(.+?)\s+([\d.]+)%$/.exec(parts[0].trim());
  if (!pctMatch) throw new Error(`unparseable color-mix: ${value}`);
  const pct = parseFloat(pctMatch[2]) / 100;
  const a = rgba(pctMatch[1], theme);
  const b = rgba(parts[1].trim(), theme);
  return [
    a[0] * pct + b[0] * (1 - pct),
    a[1] * pct + b[1] * (1 - pct),
    a[2] * pct + b[2] * (1 - pct),
    1,
  ];
}

/** Any token reference, hex or color-mix → RGBA in the given theme. */
function rgba(input, theme) {
  const v = String(input).trim();
  const vm = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (vm) return rgba(declared(vm[1].slice(2), theme), theme);
  return v.includes('color-mix') ? resolveMix(v, theme) : parseColor(v);
}

const lin = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** Alpha-composite fg over bg, then WCAG 2.1. */
function contrast(fgRaw, bgRaw, theme) {
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
  const over = [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
  const [hi, lo] = [luminance(over), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const r2 = (n) => Math.round(n * 100) / 100;
const hexOf = (rgbaArr) =>
  `#${rgbaArr
    .slice(0, 3)
    .map((c) => Math.round(c).toString(16).padStart(2, '0'))
    .join('')}`;

/* ------------------------------------------------------------- the budgets */

/** The literals TempBandCard hardcoded before the tokens existed. */
const RAMP_LIGHT_LITERALS = [
  '#1d4ed8',
  '#2563eb',
  '#3b82f6',
  '#f59e0b',
  '#f97316',
  '#ef4444',
  '#b91c1c',
];
const RAMP = RAMP_LIGHT_LITERALS.map((_, i) => `temp-band-${i + 1}`);

const results = { at: new Date().toISOString(), checks: [], notes: [], failures: [] };

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  if (!ok) results.failures.push(`${name} — ${detail}`);
  return ok;
}

/**
 * A measured FACT that is not a floor. Two kinds live here: a pre-existing
 * number this card deliberately does not change (the LIGHT ramp is frozen by
 * byte-identity, and its amber/orange steps have been under 3:1 on paper-white
 * since the card shipped), and a BEFORE row that documents the defect the
 * change removes. Neither may fail the run — a gate that fails on a defect it
 * was explicitly scoped not to fix is a gate someone deletes.
 */
function info(name, detail) {
  results.notes.push({ name, detail });
}

/* --- 1. the thermometer ramp ------------------------------------------- */
for (const theme of ['light', 'dark']) {
  const cardSurface = theme === 'light' ? '#ffffff' : declared('card', 'dark');
  RAMP.forEach((token, i) => {
    const value = declared(token, theme);
    const ratio = contrast(value, cardSurface, theme);
    const measure = `${value} on ${hexOf(rgba(cardSurface, theme))} = ${r2(ratio)}:1`;
    if (theme === 'dark') {
      // 3:1 is the graphics floor; 4.5:1 is the in-bar ¢/kWh label's floor.
      check(
        `ramp ${token} (dark) on the dark card`,
        ratio >= 4.5,
        `${measure} (graphics floor 3:1, in-bar label 4.5:1; was ${r2(contrast(RAMP_LIGHT_LITERALS[i], declared('card', 'dark'), 'dark'))}:1)`,
      );
    } else {
      // LIGHT is FROZEN: byte-identity is the real assertion. The ratios are
      // recorded, not gated — see the pre-existing-debt note below.
      check(
        `ramp ${token} (light) is byte-identical to the hardcoded literal`,
        value.toLowerCase() === RAMP_LIGHT_LITERALS[i],
        `${value} vs ${RAMP_LIGHT_LITERALS[i]}`,
      );
      info(`ramp ${token} (light) measures ${r2(ratio)}:1 on white`, measure);
    }
  });
  // The step-weight arc: rises into the amber stop, falls to the deep red end.
  const lums = RAMP.map((t) => luminance(rgba(declared(t, theme), theme)));
  const peak = lums.indexOf(Math.max(...lums));
  check(
    `ramp step weight (${theme}) keeps its arc`,
    peak === 3 && lums.slice(0, 4).every((v, i, a) => i === 0 || v > a[i - 1]) && lums.slice(3).every((v, i, a) => i === 0 || v < a[i - 1]),
    `luminance ${lums.map((v) => r2(v)).join(' / ')} — peak at stop ${peak + 1} (expected 4)`,
  );
}
// Newly measured, pre-existing, NOT fixed here (it would change LIGHT, which
// this card is scoped out of): the light ramp's warm middle is under the 3:1
// non-text floor on a white card. Surfaced so it cannot stay invisible.
const lightUnderFloor = RAMP.filter(
  (t) => contrast(declared(t, 'light'), '#ffffff', 'light') < 3,
);
info(
  'PRE-EXISTING (light, untouched): light ramp steps under the 3:1 graphics floor',
  lightUnderFloor.length
    ? lightUnderFloor
        .map((t) => `${t} ${declared(t, 'light')} = ${r2(contrast(declared(t, 'light'), '#ffffff', 'light'))}:1 on white`)
        .join(' · ') + ' — dark-mode-only card; needs a light-side decision (Mark sign-off), filed as a follow-up'
    : 'none',
);

/* --- 2. EfficiencyCard pairings ---------------------------------------- */
// The three pairings: rate-tick line (--bad), rate-tick word (--bad, TEXT),
// regression line (--info). Measured on the card and on BOTH season bands.
for (const theme of ['light', 'dark']) {
  for (const token of ['bad', 'info']) {
    for (const surface of ['card', 'season-winter', 'season-summer']) {
      const ratio = contrast(declared(token, theme), declared(surface, theme), theme);
      check(
        `EfficiencyCard --${token} (${theme}) on --${surface}`,
        ratio >= 4.5,
        `${declared(token, theme)} on ${declared(surface, theme)} = ${r2(ratio)}:1`,
      );
    }
  }
}

/* --- 3. BillProjectionBanner ------------------------------------------- */
for (const theme of ['light', 'dark']) {
  // The two mini-cards: --ink on --card (the box follows its own surface).
  const box = contrast(declared('ink', theme), declared('card', theme), theme);
  check(
    `projection boxes --ink on --card (${theme})`,
    box >= 4.5,
    `${declared('ink', theme)} on ${declared('card', theme)} = ${r2(box)}:1`,
  );
  // The caption rides the emerald-400 flood, a FIXED slab: fixed ink.
  const caption = contrast(declared('accent-ink', theme), '#34d399', theme);
  check(
    `projection caption --accent-ink on emerald-400 (${theme})`,
    caption >= 4.5,
    `${declared('accent-ink', theme)} on #34d399 = ${r2(caption)}:1`,
  );
  // The defect this replaced, recorded so the delta is auditable.
  const before = contrast(declared('ink-2', theme), '#34d399', theme);
  info(
    `projection caption BEFORE (--ink-2 on emerald-400, ${theme}) — the defect`,
    `${declared('ink-2', theme)} on #34d399 = ${r2(before)}:1 (now ${r2(caption)}:1)`,
  );
  const boxBefore = contrast(declared('accent-ink', theme), declared('card', theme), theme);
  info(
    `projection boxes BEFORE (inherited --accent-ink on --card, ${theme}) — the defect`,
    `${declared('accent-ink', theme)} on ${declared('card', theme)} = ${r2(boxBefore)}:1 (now ${r2(box)}:1)`,
  );
}

/* --- 4. print is light -------------------------------------------------- */
RAMP.forEach((token, i) => {
  const m = PRINT.match(new RegExp(String.raw`--${token}:\s*([^;\n]+);`));
  check(
    `@media print declares ${token}`,
    !!m && m[1].trim().toLowerCase() === RAMP_LIGHT_LITERALS[i],
    m ? `${m[1].trim()} vs light literal ${RAMP_LIGHT_LITERALS[i]}` : 'not declared — a dark print would ink the lifted fills',
  );
});

/* --- 5. the DELTA table: what the dark card used to measure ------------- */
const beforeAfter = RAMP.map((token, i) => ({
  token,
  light: declared(token, 'light'),
  dark: declared(token, 'dark'),
  darkBefore: RAMP_LIGHT_LITERALS[i],
  lightRatioOnWhite: r2(contrast(declared(token, 'light'), '#ffffff', 'light')),
  darkBeforeRatio: r2(contrast(RAMP_LIGHT_LITERALS[i], declared('card', 'dark'), 'dark')),
  darkRatio: r2(contrast(declared(token, 'dark'), declared('card', 'dark'), 'dark')),
}));

results.ramp = beforeAfter;
results.efficiencyCard = {
  dark: {
    bad: {
      onCard: r2(contrast(declared('bad', 'dark'), declared('card', 'dark'), 'dark')),
      onWinterBand: r2(contrast(declared('bad', 'dark'), declared('season-winter', 'dark'), 'dark')),
      onSummerBand: r2(contrast(declared('bad', 'dark'), declared('season-summer', 'dark'), 'dark')),
    },
    info: {
      onCard: r2(contrast(declared('info', 'dark'), declared('card', 'dark'), 'dark')),
      onWinterBand: r2(contrast(declared('info', 'dark'), declared('season-winter', 'dark'), 'dark')),
      onSummerBand: r2(contrast(declared('info', 'dark'), declared('season-summer', 'dark'), 'dark')),
    },
  },
  light: {
    bad: {
      onCard: r2(contrast(declared('bad', 'light'), declared('card', 'light'), 'light')),
      onWinterBand: r2(contrast(declared('bad', 'light'), declared('season-winter', 'light'), 'light')),
      onSummerBand: r2(contrast(declared('bad', 'light'), declared('season-summer', 'light'), 'light')),
    },
    info: {
      onCard: r2(contrast(declared('info', 'light'), declared('card', 'light'), 'light')),
      onWinterBand: r2(contrast(declared('info', 'light'), declared('season-winter', 'light'), 'light')),
      onSummerBand: r2(contrast(declared('info', 'light'), declared('season-summer', 'light'), 'light')),
    },
  },
};
results.printRampLight = RAMP.every(
  (t, i) => (PRINT.match(new RegExp(String.raw`--${t}:\s*([^;\n]+);`)) || [, ''])[1].trim().toLowerCase() === RAMP_LIGHT_LITERALS[i],
);

const out = path.join(__dirname, 'dark-contrast-debt.json');
fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

/* ------------------------------------------------------------- the report */
console.log('Thermometer ramp — TempBandCard BAR_FILL on --card');
console.log('stop  light              light:1  dark               before:1  dark:1');
for (const row of beforeAfter) {
  console.log(
    `  ${row.token.slice(-1)}   ${row.light.padEnd(18)} ${String(row.lightRatioOnWhite).padStart(6)}  ${row.dark.padEnd(18)} ${String(row.darkBeforeRatio).padStart(7)} ${String(row.darkRatio).padStart(7)}`,
  );
}
console.log('\nEfficiencyCard pairings (text floor 4.5:1 on the bands it crosses)');
for (const theme of ['light', 'dark']) {
  for (const token of ['bad', 'info']) {
    const r = results.efficiencyCard[theme][token];
    console.log(
      `  --${token.padEnd(5)} ${theme.padEnd(5)} card ${String(r.onCard).padStart(5)}  winter ${String(r.onWinterBand).padStart(5)}  summer ${String(r.onSummerBand).padStart(5)}`,
    );
  }
}
console.log('\nBillProjectionBanner');
for (const c of results.checks.filter((c) => c.name.startsWith('projection'))) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
}

console.log('\nRecorded (not gated) — pre-existing numbers and BEFORE rows');
for (const n of results.notes) console.log(`  · ${n.name}: ${n.detail}`);

console.log(
  `\n${results.checks.length} checks, ${results.failures.length} failures, ${results.notes.length} recorded facts → ${path.relative(process.cwd(), out)}`,
);
if (results.failures.length) {
  console.error(`\nFAILURES:\n${results.failures.join('\n')}`);
  process.exit(1);
}
