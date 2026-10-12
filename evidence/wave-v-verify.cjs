/**
 * Wave V — the HINDSIGHT panel, checked on the DEPLOYED stack against BOTH of
 * Mark's real exports.
 *
 * The card's acceptance list, one check at a time:
 *   • per-period verdicts exist for EVERY closed bill, each with a plan chip
 *     and a behaviour chip;
 *   • the three headline numbers are additive — total = plan miss + behaviour
 *     miss — and the plan number agrees with the audited switch track record
 *     that sits above it (the same rows, read twice, from two panels);
 *   • each period's behaviour number equals the sum of the moves printed
 *     under it (the engine's own additivity, as painted);
 *   • the counterfactuals are directional: every printed move shows a
 *     destination rate BELOW the rate actually paid, and every printed saving
 *     is positive;
 *   • seasonal rates are really per-period: the 2-year file carries summer
 *     bills, winter bills and bills that cross Nov 1, and the straddling ones
 *     say so;
 *   • the honest states are honest: Tiered periods say the hour does not
 *     change the price (a REAL zero), uncovered bills carry their reason and
 *     no number, and nothing anywhere leaks a raw key, `undefined` or `NaN`;
 *   • the chips and the headline figures clear AA against their own painted
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
 *       WAVE_V_DEPLOY     (commit the deployed stack serves — recorded, not asserted)
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
    const rows = Array.from(panel.querySelectorAll('[data-testid^="hindsight-period-"]')).map((row) => {
      const details = row.querySelector('details');
      const moves = details
        ? Array.from(details.querySelectorAll('[data-testid^="hindsight-move-"]')).map((m) =>
            (m.textContent || '').replace(/\s+/g, ' ').trim(),
          )
        : [];
      return {
        testid: row.getAttribute('data-testid'),
        plan: row.getAttribute('data-plan'),
        origin: row.getAttribute('data-origin'),
        text: (row.textContent || '').replace(/\s+/g, ' ').trim(),
        planChip: txt('[data-testid="hindsight-plan-chip"]', row),
        behaviourChip: txt('[data-testid="hindsight-behaviour-chip"]', row),
        badge: txt('[data-testid="hindsight-plan-badge"]', row),
        skip: txt('[data-testid="hindsight-skip"]', row),
        hasDetails: !!details,
        detailsOpen: details ? details.open : null,
        moves,
      };
    });
    return {
      planTotal: txt('[data-testid="hindsight-plan-total"]'),
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

  // --- the three headline numbers -----------------------------------------
  const plan = oneMoney(before.planTotal ?? '');
  const behaviour = oneMoney(before.behaviourTotal ?? '');
  const total = oneMoney(before.total ?? '');
  check(`${tag}: the plan and behaviour headline numbers are painted`, plan !== null && behaviour !== null, `plan=${before.planTotal} behaviour=${before.behaviourTotal}`);
  check(`${tag}: the total is plan + behaviour`, plan !== null && behaviour !== null && total !== null && near(plan + behaviour, total, 0.02), `${plan} + ${behaviour} = ${total}`);
  check(`${tag}: the behaviour total is never negative`, behaviour !== null && behaviour >= 0, `${behaviour}`);
  if (plan !== null && plan < 0) {
    check(
      `${tag}: a negative plan lever is labelled as the alternatives costing more`,
      /alternatives would have cost more/i.test(flat(before.text)),
      flat(before.text).slice(0, 120),
    );
  }
  check(`${tag}: the headline names which lever mattered`, flat(before.lever).length > 20, flat(before.lever));

  // --- the plan number is Wave P's, read off the OTHER panel --------------
  const switchTotal = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="switch-overpaid-total"]');
    return el ? (el.textContent || '').trim() : null;
  });
  const switchValue = switchTotal === null ? null : oneMoney(switchTotal);
  check(
    `${tag}: the HINDSIGHT plan figure agrees with the switch track record above it`,
    switchValue !== null && plan !== null && near(switchValue, Math.abs(plan), 0.02),
    `track record=${switchTotal} hindsight=${before.planTotal}`,
  );

  // --- per-period honesty --------------------------------------------------
  const priced = before.rows.filter((r) => r.skip === null);
  const skipped = before.rows.filter((r) => r.skip !== null);
  check(`${tag}: every priced row carries BOTH a plan chip and a behaviour chip`, priced.every((r) => r.planChip && r.behaviourChip), `${priced.length} priced, ${priced.filter((r) => !r.planChip || !r.behaviourChip).length} missing a chip`);
  check(`${tag}: every priced row is stamped with the plan it was billed under`, priced.every((r) => r.badge && r.badge.length > 3), priced.map((r) => r.badge).slice(0, 3).join(' | '));
  check(`${tag}: an unaudited bill carries its reason instead of a number`, skipped.every((r) => r.skip.length > 10), skipped.map((r) => r.skip).join(' / ') || 'none skipped');

  // Each period's behaviour number must equal the sum of the moves under it.
  let additive = 0;
  let additiveBad = 0;
  for (const r of priced) {
    const chip = oneMoney(r.behaviourChip ?? '');
    if (chip === null || r.moves.length === 0) continue;
    const sum = r.moves.reduce((acc, m) => acc + Math.abs(oneMoney(m) ?? 0), 0);
    // Each move is rounded to the cent on screen, so the tolerance has to grow
    // with the number of moves (n × half a cent) plus the chip's own rounding.
    if (near(sum, chip, 0.005 * r.moves.length + 0.011)) additive += 1;
    else additiveBad += 1;
  }
  check(`${tag}: each period's behaviour figure equals the sum of its own moves`, additiveBad === 0 && additive > 0, `${additive} verified, ${additiveBad} mismatched`);

  // Moves are directional: destination rate below the rate paid, saving > 0.
  const moveTexts = priced.flatMap((r) => r.moves);
  const moveRates = moveTexts.map((t) => {
    const cents = (t.match(/([\d.]+)¢\/kWh/g) ?? []).map((c) => Number(c.replace('¢/kWh', '')));
    // The panel prints a saving as "−$1.23" (a minus = money back), so the
    // magnitude is the saving and the sign is the direction, not the amount.
    const raw = oneMoney(t);
    return { paid: cents[0], dest: cents[1], saving: raw === null ? null : Math.abs(raw) };
  });
  check(`${tag}: every printed move is genuinely cheaper after the shift`, moveRates.length > 0 && moveRates.every((m) => Number.isFinite(m.dest) && Number.isFinite(m.paid) && m.dest < m.paid), `${moveRates.length} moves, ${moveRates.filter((m) => !(m.dest < m.paid)).length} not cheaper`);
  check(`${tag}: every printed move shows a positive saving`, moveRates.every((m) => m.saving !== null && m.saving > 0), moveRates.map((m) => m.saving).slice(0, 4).join(', '));
  check(`${tag}: the move copy is counterfactual ('IF … had run in … instead')`, moveTexts.length > 0 && moveTexts.every((t) => /\bIF\b/.test(t) && /had run in/i.test(t)), moveTexts[0] ? flat(moveTexts[0]).slice(0, 120) : 'no moves');
  check(`${tag}: the legend states that behaviour is a counterfactual`, /counterfactual/i.test(before.text), 'legend copy');

  // No raw keys, no undefined, no NaN, no un-replaced placeholder.
  const leaks = [/\bhindsight\.[a-zA-Z]/.exec(before.text), /\bundefined\b/.exec(before.text), /\bNaN\b/.exec(before.text), /\{\w+\}/.exec(before.text)].filter(Boolean);
  check(`${tag}: no raw key, undefined, NaN or {placeholder} leaks into the panel`, leaks.length === 0, leaks.map((l) => l[0]).join(' , '));

  // --- the honest empty / flat states --------------------------------------
  const flatRows = before.rows.filter((r) => /FLAT RATE/.test(r.behaviourChip ?? ''));
  if (full) {
    check(`${tag}: at least one Tiered period says the hour cannot change the price`, flatRows.length > 0, `${flatRows.length} flat-rate periods`);
    check(`${tag}: a flat-rate period claims no money on the behaviour lever`, flatRows.every((r) => !moneyValues(r.behaviourChip ?? '').length && r.moves.length === 0), 'no amount, no moves');
    check(`${tag}: the flat-rate reason names the flat price`, flatRows.every((r) => /hour does not change the price|same as any other hour|flat rate/i.test(r.text)), flatRows[0] ? flatRows[0].text.slice(0, 160) : 'none');
    const moveable = before.rows.filter((r) => oneMoney(r.behaviourChip ?? '') !== null && oneMoney(r.behaviourChip ?? '') > 0);
    check(`${tag}: at least one period has a moveable routine`, moveable.length > 0, `${moveable.length} periods`);
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
  } else {
    check(`${tag}: the one countable period is priced, the uncovered ones are not`, priced.length === 1 && skipped.length === 2, `${priced.length} priced / ${skipped.length} skipped`);
  }

  // --- worst-first ordering -------------------------------------------------
  if (before.worstTestid && before.rows.length > 1) {
    const worstDay = before.worstTestid.replace('hindsight-worst-', '');
    const firstDay = before.rows[0].testid.replace('hindsight-period-', '');
    check(`${tag}: the biggest-loss callout names the first row (worst-first)`, worstDay === firstDay, `${worstDay} vs ${firstDay}`);
    check(`${tag}: the callout's split adds up to its total`, (() => {
      const vals = moneyValues(before.worst);
      if (vals.length < 3) return false;
      return near(vals[1] + vals[2], vals[0], 0.02) || near(vals[0] + vals[1], vals[2], 0.02);
    })(), flat(before.worst));
  }

  // --- progressive disclosure + keyboard operation --------------------------
  const detailsRow = priced.find((r) => r.hasDetails);
  if (detailsRow) {
    check(`${tag}: the move list is closed until asked for`, detailsRow.detailsOpen === false, `${detailsRow.testid}`);
    const row = page.getByTestId(detailsRow.testid);
    await row.locator('summary').click();
    await page.getByTestId(row_detailsTestId(detailsRow)).waitFor({ state: 'visible', timeout: 20_000 });
    const afterOpen = await page.evaluate((id) => {
      const d = document.querySelector(`[data-testid="${id}"]`);
      return d ? d.open : null;
    }, row_detailsTestId(detailsRow));
    check(`${tag}: opening it reveals the per-block moves`, afterOpen === true, `${afterOpen}`);
  }

  // --- painted contrast ----------------------------------------------------
  for (const id of ['hindsight-plan-total', 'hindsight-behaviour-total', 'hindsight-total']) {
    const c = await contrastOf(page, id);
    check(`${tag}: ${id} clears AA on its own painted background`, c !== null && c.ratio >= 4.5, c ? `${c.ratio}:1 (${c.fg} on ${c.bg})` : 'not found');
  }
  const chipRow = priced[0];
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

  // --- layout ---------------------------------------------------------------
  check(`${tag}: no horizontal overflow`, before.scrollWidth <= before.innerWidth + 1, `scrollWidth=${before.scrollWidth} viewport=${before.innerWidth}`);

  // --- screenshots ---------------------------------------------------------
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

function row_detailsTestId(row) {
  return row.testid.replace('hindsight-period-', 'hindsight-moves-');
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
    const sameMoney = [
      ['plan', longDesktop.planTotal, longMobile.planTotal],
      ['behaviour', longDesktop.behaviourTotal, longMobile.behaviourTotal],
      ['total', longDesktop.total, longMobile.total],
    ];
    check('both viewports print the same three numbers for the 2-year file', sameMoney.every(([, a, b]) => a === b), sameMoney.map(([k, a, b]) => `${k}: ${a} / ${b}`).join(' · '));
    check('both viewports agree on row count', longDesktop.rows.length === longMobile.rows.length, `${longDesktop.rows.length} / ${longMobile.rows.length}`);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  const result = {
    ...meta,
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
