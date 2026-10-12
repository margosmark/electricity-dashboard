/**
 * Wave V (corrected) — the HINDSIGHT panel, checked on a RUNNING build against
 * BOTH of Mark's real exports.
 *
 * The scope this harness enforces, one check at a time:
 *   • per-period verdicts exist for EVERY closed bill, each with the plan it
 *     was billed under and a plan chip;
 *   • there is exactly ONE headline figure, it agrees with the audited switch
 *     track record above it, and every per-period chip names a plan other than
 *     the one that row was billed under (the headline is a NET figure, so the
 *     chips are not expected to sum to it);
 *   • the surface is plan-only: no behaviour chip, no move list, no second
 *     headline and no hypothetical-usage wording anywhere in the panel;
 *   • the headline's own SUB-LINE may not contradict it: a net saving says the
 *     alternatives would have cost that much more, at the figure's own
 *     magnitude — never a clamped "$0.00 more" under a negative figure
 *     (t_97f4c904, where `Math.max(0, planMiss)` decided the copy);
 *   • seasonal rates are really per-period: the 2-year file carries summer
 *     bills, winter bills and bills that cross Nov 1, and the straddling ones
 *     say so;
 *   • the honest states are honest: uncovered bills carry their reason and no
 *     number, an unknown plan claims nothing, and nothing anywhere leaks a raw
 *     key, `undefined` or `NaN`;
 *   • the headline figure and the plan chip clear AA against their own painted
 *     backgrounds (colour read through a 1x1 canvas — Chrome serialises
 *     Tailwind v4 colours as lab()/oklch() and a rgb() regex misses them);
 *   • both viewports, no horizontal overflow at 390 px.
 *
 * Numbers are read from the PAINTED DOM, never from the engine: this harness
 * shares no code with `lib/hindsight.ts`, so agreement between the two is
 * evidence rather than a tautology. The two exports themselves are pinned by
 * sha256 before use and never enter the repo.
 *
 * Run:  WAVE_V_XML_LONG=/path/to/2-year.xml WAVE_V_XML_SHORT=/path/to/3-month.xml \
 *         TZ=America/Toronto node evidence/wave-v-verify.cjs
 * Env:  WAVE_V_BASE_URL   (default http://10.10.11.110:3939/ — the deployed stack)
 *       WAVE_V_CHROMIUM   (default /usr/bin/chromium)
 *       WAVE_V_DEPLOY     (commit the stack serves — recorded, not asserted)
 *       WAVE_V_SUFFIX     ('-local' writes wave-v-verification-local.json)
 *       WAVE_V_PREFIX     (default 'wave-v')
 *
 * Writes evidence/wave-v-verification[-suffix].json + wave-v-*.png
 */

process.env.TZ = 'America/Toronto';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

let chromium;
try {
  ({ chromium } = require('@playwright/test'));
} catch {
  ({ chromium } = require(path.resolve(__dirname, '../webapp/node_modules/@playwright/test')));
}

const BASE = process.env.WAVE_V_BASE_URL || 'http://10.10.11.110:3939/';
const CHROMIUM = process.env.WAVE_V_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.WAVE_V_SUFFIX || '';
const PREFIX = process.env.WAVE_V_PREFIX || 'wave-v';
const DEPLOY = process.env.WAVE_V_DEPLOY || null;
const LONG = process.env.WAVE_V_XML_LONG;
const SHORT = process.env.WAVE_V_XML_SHORT;
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

/** Every signed money value in a string: "−$1.23" → -1.23, "$40.00" → 40. */
function moneyValues(text) {
  const re = /([−-]?)\$([\d,]+\.\d{2})/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text))) !== null) {
    out.push((m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '')));
  }
  return out;
}
const oneMoney = (text) => {
  const v = moneyValues(text);
  return v.length === 1 ? v[0] : null;
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* -------------------------------------------------------------------------- *
 * In-page helpers
 * -------------------------------------------------------------------------- */

/** WCAG relative luminance from an rgb()/rgba() triple. */
const LUM_FN = `(rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}`;

/**
 * Contrast of an element's own text against its own (opaque) background,
 * with every colour normalised through a 1x1 canvas first. Chrome serialises
 * Tailwind v4 colours as lab()/oklch(), which a naive rgb() parse misses and
 * silently turns into "read the card behind the chip" (see the dark-mode
 * wave's finding: a chip reported 1.18:1 when it was really 13.7:1).
 */
async function contrastOf(page, testid) {
  return page.evaluate(
    ([id, lumSrc]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const lum = eval(lumSrc);
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      const toRgb = (value) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const parseAlpha = (value) => {
        const m = /rgba?\(([^)]+)\)/.exec(value);
        if (!m) return 1;
        const parts = m[1].split(',').map((p) => p.trim());
        return parts.length === 4 ? Number(parts[3]) : 1;
      };
      const fg = toRgb(getComputedStyle(el).color);
      let node = el;
      let bg = toRgb(getComputedStyle(node).backgroundColor);
      while (node && parseAlpha(getComputedStyle(node).backgroundColor) < 1) {
        node = node.parentElement;
        if (!node) break;
        bg = toRgb(getComputedStyle(node).backgroundColor);
      }
      const l1 = lum(fg.slice(0, 3));
      const l2 = lum(bg.slice(0, 3));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return {
        ratio: Number(ratio.toFixed(2)),
        fg: `rgb(${fg.slice(0, 3).join(',')})`,
        bg: `rgb(${bg.slice(0, 3).join(',')})`,
      };
    },
    [testid, LUM_FN],
  );
}

/* -------------------------------------------------------------------------- *
 * The run
 * -------------------------------------------------------------------------- */

async function loadExposure(page, file) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(file, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Plans' }).waitFor({ state: 'visible', timeout: 180_000 });
}

/** Read the panel's painted state into plain data (no engine code involved). */
async function readPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="hindsight-panel"]');
    if (!panel) return null;
    const txt = (sel, root = panel) => {
      const el = root.querySelector(sel);
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null;
    };
    const rows = Array.from(panel.querySelectorAll('[data-testid^="hindsight-period-"]')).map((row) => ({
      testid: row.getAttribute('data-testid'),
      plan: row.getAttribute('data-plan'),
      origin: row.getAttribute('data-origin'),
      text: (row.textContent || '').replace(/\s+/g, ' ').trim(),
      planChip: txt('[data-testid="hindsight-plan-chip"]', row),
      badge: txt('[data-testid="hindsight-plan-badge"]', row),
      skip: txt('[data-testid="hindsight-skip"]', row),
      // The scope-corrected panel must not carry these at all.
      behaviourChip: txt('[data-testid="hindsight-behaviour-chip"]', row),
      details: row.querySelectorAll('details').length,
      moves: row.querySelectorAll('[data-testid^="hindsight-move-"]').length,
    }));
    return {
      planTotal: txt('[data-testid="hindsight-plan-total"]'),
      headlineText: txt('[data-testid="hindsight-headline"]'),
      behaviourTotal: txt('[data-testid="hindsight-behaviour-total"]'),
      total: txt('[data-testid="hindsight-total"]'),
      lever: txt('[data-testid="hindsight-lever"]'),
      empty: txt('[data-testid="hindsight-empty"]'),
      legend: txt('[data-testid^="hindsight-legend"]') || (panel.textContent || '').replace(/\s+/g, ' ').trim(),
      worst: txt('[data-testid^="hindsight-worst-"]'),
      worstTestid: (() => {
        const el = panel.querySelector('[data-testid^="hindsight-worst-"]');
        return el ? el.getAttribute('data-testid') : null;
      })(),
      rows,
      text: (panel.textContent || '').replace(/\s+/g, ' ').trim(),
      h: panel.getBoundingClientRect().height,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function auditExport({ browser, file, tag, viewport, expectPeriods, full = false }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  await loadExposure(page, file);

  // The panel lives in the PLANS tab (Wave R's structure) and nowhere else.
  const onOverview = await page.locator('[data-testid="hindsight-panel"]').count();
  check(`${tag}: the HINDSIGHT panel is not on the Overview tab`, onOverview === 0, `${onOverview} found`);

  await page.getByRole('tab', { name: 'Plans' }).click();
  const panel = page.getByTestId('hindsight-panel');
  await panel.waitFor({ state: 'visible', timeout: 60_000 });
  check(`${tag}: the panel renders on PLANS & TRACK RECORD`, await panel.isVisible());

  const before = await readPanel(page);
  check(`${tag}: every closed bill has a row`, before.rows.length >= Math.min(expectPeriods, 1), `${before.rows.length} rows (file holds ${expectPeriods})`);
  if (expectPeriods > 1) {
    check(`${tag}: the row count matches the file's bill count`, before.rows.length === expectPeriods, `${before.rows.length} vs ${expectPeriods}`);
  }

  // --- ONE headline number, and it is the plan ----------------------------
  const plan = oneMoney(before.planTotal ?? '');
  check(`${tag}: exactly one headline figure is painted, and it is the plan`, plan !== null, `plan=${before.planTotal}`);
  check(
    `${tag}: no behaviour headline, no summed total and no lever line exist`,
    before.behaviourTotal === null && before.total === null && before.lever === null,
    `behaviour=${before.behaviourTotal} total=${before.total} lever=${before.lever}`,
  );
  if (plan !== null && plan < 0) {
    check(
      `${tag}: a negative figure is labelled as the alternatives costing more`,
      /alternatives would have cost more/i.test(flat(before.text)),
      flat(before.text).slice(0, 120),
    );
  }

  // --- the sub-line may not contradict the headline it sits under ----------
  // The subtitle is the sentence that explains the figure, and it used to be
  // interpolated through `Math.max(0, planMiss)`: on a net SAVING the panel
  // painted "cost you $0.00 more" under the headline "the alternatives would
  // have cost more" (t_97f4c904). Read the painted headline BLOCK — no
  // testid of its own is required, so the same check runs against a build that
  // predates the fix — and hold the two clauses together.
  if (plan !== null) {
    const head = before.headlineText;
    const clamped = plan < 0 ? /\$\s?0\.00\s+more/i.exec(head ?? '') : null;
    check(
      `${tag}: the headline's sub-line never claims "$0.00 more" beside a negative figure`,
      head !== null && clamped === null,
      `plan=${before.planTotal} headline="${(flat(head) ?? '').slice(0, 160)}"`,
    );
    const sentence =
      plan < 0
        ? /would have cost you [−-]?\$[\d,]+\.\d{2} more/i.exec(head ?? '')
        : /cost you [−-]?\$[\d,]+\.\d{2} more/i.exec(head ?? '');
    const clauseAmount = sentence === null ? null : Math.abs(oneMoney(sentence[0]) ?? NaN);
    check(
      `${tag}: the sub-line states the headline's own magnitude in its own direction`,
      sentence !== null && clauseAmount !== null && near(clauseAmount, Math.abs(plan), 0.02),
      `plan=${before.planTotal} clause="${sentence === null ? 'none' : sentence[0]}"`,
    );
  }

  // --- the figure is Wave P's, read off the OTHER panel -------------------
  const switchTotal = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="switch-overpaid-total"]');
    return el ? (el.textContent || '').trim() : null;
  });
  const switchValue = switchTotal === null ? null : oneMoney(switchTotal);
  check(
    `${tag}: the HINDSIGHT figure agrees with the switch track record above it`,
    switchValue !== null && plan !== null && near(switchValue, Math.abs(plan), 0.02),
    `track record=${switchTotal} hindsight=${before.planTotal}`,
  );

  // --- the scope correction, enforced on the painted panel ---------------
  const behaviourChips = before.rows.filter((r) => r.behaviourChip !== null).length;
  const moveLists = before.rows.filter((r) => r.details > 0 || r.moves > 0).length;
  const wording = /\bbehaviour\b|\bhad run in\b|\bmove[ds]?\b|\bshift(ed|ing)?\b/i.exec(before.text);
  check(
    `${tag}: no behaviour chip and no move list anywhere on the panel`,
    behaviourChips === 0 && moveLists === 0,
    `${behaviourChips} chips, ${moveLists} rows with a disclosure`,
  );
  check(
    `${tag}: no hypothetical-usage or load-shift wording anywhere on the panel`,
    wording === null,
    wording ? wording[0] : 'clean',
  );
  check(`${tag}: the panel states it compares the same readings`, /same readings/i.test(before.text), 'legend copy');

  // --- per-period honesty -------------------------------------------------
  const priced = before.rows.filter((r) => r.skip === null);
  const skipped = before.rows.filter((r) => r.skip !== null);
  check(`${tag}: every priced row carries a plan chip`, priced.every((r) => r.planChip && r.planChip.length > 3), `${priced.length} priced, ${priced.filter((r) => !r.planChip).length} missing a chip`);
  check(`${tag}: every priced row is stamped with the plan it was billed under`, priced.every((r) => r.badge && r.badge.length > 3), priced.map((r) => r.badge).slice(0, 3).join(' | '));
  check(`${tag}: an unaudited bill carries its reason instead of a number`, skipped.every((r) => r.skip.length > 10), skipped.map((r) => r.skip).join(' / ') || 'none skipped');
  check(`${tag}: an unaudited bill carries no plan chip`, skipped.every((r) => r.planChip === null), 'no chip on skipped rows');
  check(
    `${tag}: every priced row states the kWh actually metered`,
    priced.every((r) => /[\d.,]+\s*kWh/i.test(r.text)),
    priced[0] ? priced[0].text.slice(0, 120) : 'none',
  );

  // --- the per-period chips are internally consistent ----------------------
  // The headline is a NET figure across every countable period, so the chips
  // (which print money only on a period whose alternative was cheaper) are NOT
  // expected to add up to it: three good periods against twenty-one bad ones is
  // a negative net with real money on the chips. What must hold is the pair of
  // claims themselves: a saving is only ever claimed against a DIFFERENT plan
  // than the one the row says it was billed under, and never with a negative
  // amount.
  const PLAN_OF_LABEL = { 'time-of-use': 'TOU', tiered: 'Tiered', 'ultra-low overnight': 'ULO' };
  const misdirected = [];
  const negativeChips = [];
  for (const r of priced) {
    if (!/WOULD HAVE SAVED/i.test(r.planChip ?? '')) continue;
    const label = (/ ON (.+)$/i.exec(r.planChip ?? '') ?? [])[1];
    const named = PLAN_OF_LABEL[flat(label).toLowerCase()];
    if (named === undefined || named === r.plan) misdirected.push(`${r.plan} → ${label}`);
    const amount = oneMoney(r.planChip ?? '');
    if (amount === null || amount <= 0 || /[−-]\s*\$/.test(r.planChip ?? '')) negativeChips.push(r.planChip);
  }
  check(
    `${tag}: a period only ever claims a saving against a DIFFERENT plan than it was billed under`,
    misdirected.length === 0,
    misdirected.length ? misdirected.join(' | ') : `${priced.filter((r) => /WOULD HAVE SAVED/i.test(r.planChip ?? '')).length} chips checked`,
  );
  check(
    `${tag}: no period prints a negative "would have saved" amount`,
    negativeChips.length === 0,
    negativeChips.join(' | ') || 'none',
  );

  // No raw keys, no undefined, no NaN, no un-replaced placeholder.
  const leaks = [/\bhindsight\.[a-zA-Z]/.exec(before.text), /\bundefined\b/.exec(before.text), /\bNaN\b/.exec(before.text), /\{\w+\}/.exec(before.text)].filter(Boolean);
  check(`${tag}: no raw key, undefined, NaN or {placeholder} leaks into the panel`, leaks.length === 0, leaks.map((l) => l[0]).join(' , '));

  // --- the honest empty state ---------------------------------------------
  if (priced.length > 0) {
    check(`${tag}: a priced file shows the headline instead of the empty state`, before.empty === null, 'no empty note');
  } else {
    check(`${tag}: with nothing countable the panel says so instead of printing a number`, before.empty !== null && plan === null, before.empty);
  }

  // --- seasons and the detected timeline (the long file) ------------------
  if (full) {
    const seasons = {
      summer: before.rows.filter((r) => /Summer/.test(r.text)).length,
      winter: before.rows.filter((r) => /Winter/.test(r.text)).length,
      straddle: before.rows.filter((r) => /crosses the rate-season boundary/.test(r.text)).length,
    };
    check(`${tag}: summer bills are judged on summer rates`, seasons.summer > 0, `${seasons.summer} rows`);
    check(`${tag}: winter bills are judged on winter rates`, seasons.winter > 0, `${seasons.winter} rows`);
    check(`${tag}: a bill that crosses Nov 1 / May 1 says so`, seasons.straddle > 0, `${seasons.straddle} straddling rows`);
    const tiered = before.rows.filter((r) => r.plan === 'Tiered').length;
    const tou = before.rows.filter((r) => r.plan === 'TOU').length;
    check(`${tag}: the detected plan timeline reaches the panel (TOU + Tiered bills)`, tiered > 0 && tou > 0, `${tou} TOU / ${tiered} Tiered`);
    check(`${tag}: a flat-rate (Tiered) bill is still judged on the plan lever`, before.rows.filter((r) => r.plan === 'Tiered').every((r) => r.planChip !== null), `${tiered} Tiered rows with a chip`);
  } else {
    check(`${tag}: the one countable period is priced, the uncovered ones are not`, priced.length === 1 && skipped.length === 2, `${priced.length} priced / ${skipped.length} skipped`);
    check(`${tag}: the uncovered bills name the coverage shortfall`, skipped.every((r) => /readings cover|no readings/i.test(r.skip)), skipped.map((r) => r.skip).join(' / '));
  }

  // --- worst-first ordering ------------------------------------------------
  if (before.worstTestid && before.rows.length > 1) {
    const worstDay = before.worstTestid.replace('hindsight-worst-', '');
    const firstDay = before.rows[0].testid.replace('hindsight-period-', '');
    check(`${tag}: the biggest-loss callout names the first row (worst-first)`, worstDay === firstDay, `${worstDay} vs ${firstDay}`);
    check(
      `${tag}: the callout's amount is the figure the first row's chip names`,
      (() => {
        const vals = moneyValues(before.worst);
        const firstChip = oneMoney(before.rows[0].planChip ?? '');
        if (vals.length === 0 || firstChip === null) return false;
        return vals.some((v) => near(Math.abs(v), Math.abs(firstChip), 0.02));
      })(),
      flat(before.worst),
    );
  }

  // --- painted contrast ---------------------------------------------------
  const planContrast = await contrastOf(page, 'hindsight-plan-total');
  check(
    `${tag}: the headline figure clears AA on its own painted background`,
    planContrast !== null && planContrast.ratio >= 4.5,
    planContrast ? `${planContrast.ratio}:1 (${planContrast.fg} on ${planContrast.bg})` : 'not found',
  );
  const chipRow = priced.find((r) => r.planChip !== null);
  if (chipRow) {
    const c = await page.evaluate(
      ([id, lumSrc]) => {
        const row = document.querySelector(`[data-testid="${id}"]`);
        const el = row && row.querySelector('[data-testid="hindsight-plan-chip"]');
        if (!el) return null;
        const lum = eval(lumSrc);
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const toRgb = (value) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        const fg = toRgb(getComputedStyle(el).color);
        const bg = toRgb(getComputedStyle(el).backgroundColor);
        const l1 = lum(fg);
        const l2 = lum(bg);
        return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
      },
      [chipRow.testid, LUM_FN],
    );
    check(`${tag}: the plan chip clears AA on its own chip colour`, c !== null && c >= 4.5, `${c}:1`);
  }

  // --- layout -------------------------------------------------------------
  check(`${tag}: no horizontal overflow`, before.scrollWidth <= before.innerWidth + 1, `scrollWidth=${before.scrollWidth} viewport=${before.innerWidth}`);

  // --- screenshots --------------------------------------------------------
  const shot = (suffix) => path.join(OUT, `${PREFIX}-${tag}${suffix}.png`);
  await page.screenshot({ path: shot(''), fullPage: true });
  await panel.screenshot({ path: shot('-panel') });
  // The headline sits under the sticky tab strip, so scroll it clear before
  // clipping — an element screenshot re-scrolls it back under the nav and
  // half the numbers come out covered.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="hindsight-headline"]');
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 170);
  });
  await page.waitForTimeout(250);
  const headBox = await page.getByTestId('hindsight-headline').boundingBox();
  if (headBox) {
    await page.screenshot({ path: shot('-headline'), clip: headBox });
  }
  console.log(`shots: ${shot('')}, ${shot('-panel')}, ${shot('-headline')}`);

  await ctx.close();
  return before;
}

async function main() {
  for (const [name, value] of [['WAVE_V_XML_LONG', LONG], ['WAVE_V_XML_SHORT', SHORT]]) {
    if (!value) {
      console.error(`${name} is required (Mark's exports never enter the repo).`);
      process.exit(2);
    }
  }

  const meta = {
    base: BASE,
    deployedCommit: DEPLOY,
    long: { path: path.basename(LONG), sha256: sha256(LONG), bytes: fs.statSync(LONG).size },
    short: { path: path.basename(SHORT), sha256: sha256(SHORT), bytes: fs.statSync(SHORT).size },
    ranAt: new Date().toISOString(),
  };
  console.log(`base=${BASE} long=${meta.long.sha256.slice(0, 16)}… short=${meta.short.sha256.slice(0, 16)}…`);

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    const desktop = { width: 1440, height: 1000 };

    const longDesktop = await auditExport({ browser, file: LONG, tag: 'desktop-long', viewport: desktop, expectPeriods: 24, full: true });
    await auditExport({ browser, file: SHORT, tag: 'desktop-short', viewport: desktop, expectPeriods: 3 });

    const mobile = { width: 390, height: 844 };
    const longMobile = await auditExport({ browser, file: LONG, tag: 'mobile-long', viewport: mobile, expectPeriods: 24, full: true });
    await auditExport({ browser, file: SHORT, tag: 'mobile-short', viewport: mobile, expectPeriods: 3 });

    // The two runs of the SAME file must agree in every number they print.
    check(
      'both viewports print the same headline figure for the 2-year file',
      longDesktop.planTotal === longMobile.planTotal,
      `${longDesktop.planTotal} / ${longMobile.planTotal}`,
    );
    check('both viewports agree on row count', longDesktop.rows.length === longMobile.rows.length, `${longDesktop.rows.length} / ${longMobile.rows.length}`);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  const result = {
    ...meta,
    scope: 'plan comparison only — the same metered readings repriced; no behaviour counterfactual',
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  const outFile = path.join(OUT, `wave-v-verification${SUFFIX}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`\n${result.passed}/${result.total} checks passed — wrote ${path.basename(outFile)}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
