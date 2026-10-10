/**
 * Tier-split browser verification — the TIER 1 / TIER 2 commodity split on a
 * running stack, against the real 2-year Oakville export.
 *
 * The whole point of this card was that a classifier existed and the TABLE
 * never got it, so every assertion here reads the RENDERED DOM (never the
 * lib) and compares it with the figures the bill states:
 *
 *   1. the stacked chart's legend and raw-numbers table carry one column per
 *      tier, and the Tiered rows print the bill's own dollars:
 *        Nov 25, 2024 → Tier 1 $85.69 · Tier 2 —   (BLOCK 1 only)
 *        Sep 25, 2025 → Tier 1  $58.68 · Tier 2 $91.14
 *                       9.3¢ × 631 kWh = $58.68, 11.0¢ × 828.6 kWh = $91.14
 *        Oct 27, 2025 → Tier 1 $100.55 · Tier 2  $6.47
 *                       (BLOCK 1 - Winter $91.44 + BLOCK 1- Summer $9.11,
 *                        plus BLOCK 2 - Summer $6.47)
 *   2. a TOU period keeps its off/mid/on-peak columns and prints a DASH
 *      under both tiers — never "$0.00", which would read as a tier charge;
 *   3. the PeriodDeltaTable has a "Tier 1" and a "Tier 2" row, and the OPEN
 *      column (badged Estimate) is a dash in both: no "TIER 1 ~$41.00" over
 *      days the utility has not billed;
 *   4. the unbilled tail's estimate stays where it honestly lives — the
 *      commodity line, one blended figure — and the row is badged.
 *
 * Run:  TIER_SPLIT_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/tier-split-verify.cjs
 * Env:  TIER_SPLIT_BASE_URL (default http://127.0.0.1:3100/), TIER_SPLIT_CHROMIUM,
 *       TIER_SPLIT_SUFFIX ('-local' writes tier-split-verification-local.json)
 *
 * TIER_SPLIT_XML is REQUIRED: the committed fixtures carry no Tiered bill, so
 * a run without Mark's export would check nothing. The file itself is never
 * committed — only its sha256 lands in the evidence JSON.
 *
 * Writes evidence/tier-split-verification[-suffix].json + tier-split-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const BASE = process.env.TIER_SPLIT_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.TIER_SPLIT_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.TIER_SPLIT_SUFFIX || '';
const FIXTURE = process.env.TIER_SPLIT_XML;
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function selectTab(page, name) {
  await page.getByRole('tab', { name }).click();
  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector(`#tab-${expected}`);
      return !!el && el.getAttribute('aria-selected') === 'true';
    },
    name.toLowerCase(),
    { timeout: 5_000 },
  );
}

/** The chart's raw-numbers table: one row per period, one column per slice. */
async function readMoneyTable(page) {
  return page.evaluate(() => {
    const t = document.querySelector('[data-testid="money-table"]');
    if (!t) return null;
    const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return {
      headers: [...t.querySelectorAll('thead th')].map((th) => clean(th.textContent)),
      rows: [...t.querySelectorAll('tbody tr')].map((tr) => ({
        label: clean(tr.querySelector('td')?.textContent),
        cells: [...tr.querySelectorAll('td')].map((td) => clean(td.textContent)),
      })),
    };
  });
}

/** The period → period table, keyed by its own row testids. */
async function readDeltaTable(page) {
  return page.evaluate(() => {
    const t = document.querySelector('[data-testid="money-deltas-table"]');
    if (!t) return null;
    const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return {
      heads: [...t.querySelectorAll('thead th')].map((th) => clean(th.textContent)),
      rows: [...t.querySelectorAll('tbody tr')].map((tr) => ({
        key: tr.getAttribute('data-testid'),
        cells: [...tr.querySelectorAll('td')].map((td) => clean(td.textContent)),
      })),
    };
  });
}

async function main() {
  if (!FIXTURE || !fs.existsSync(FIXTURE)) {
    console.error(
      'Set TIER_SPLIT_XML to the real Oakville Hydro 2-year export (never committed) — ' +
        'the committed fixtures carry no Tiered bill, so there would be nothing to check.',
    );
    process.exit(2);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');
  console.log(`base ${BASE} · fixture ${path.basename(FIXTURE)} · sha256 ${sha.slice(0, 16)}…`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      timezoneId: 'America/Toronto',
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
    check('upload produced a totals strip', await shown(page.getByTestId('totals-strip'), 90_000));

    await selectTab(page, 'Money');
    check('Money tab opens the money section', await shown(page.getByTestId('money-section')));

    /* --- 1. the chart's legend and raw-numbers table -------------------- */
    const legend = flat(await page.getByTestId('money-legend').innerText());
    check('legend names Tier 1', /tier 1/i.test(legend), legend.slice(0, 200));
    check('legend names Tier 2', /tier 2/i.test(legend), legend.slice(0, 200));

    const money = await readMoneyTable(page);
    check('money table rendered', !!money, money ? `${money.rows.length} rows` : 'missing');
    const col = (name) => (money ? money.headers.indexOf(name) : -1);
    const t1 = col('Tier 1');
    const t2 = col('Tier 2');
    check('money table has a Tier 1 column', t1 > -1, JSON.stringify(money.headers));
    check('money table has a Tier 2 column', t2 > -1, JSON.stringify(money.headers));
    const row = (label) => (money ? money.rows.find((r) => r.label.startsWith(label)) : null);

    /** label → [Tier 1 cell, Tier 2 cell] */
    const tierCells = (label) => {
      const r = row(label);
      if (!r || t1 < 0 || t2 < 0) return [null, null];
      return [r.cells[t1], r.cells[t2]];
    };

    // Nov 2024 — one BLOCK line: the cheap tier, and an honest dash for the
    // tier the bill never charged.
    const nov = tierCells('Nov 25, 2024');
    check('Nov 25, 2024 → Tier 1 $85.69', nov[0] === '$85.69', String(nov[0]));
    check('Nov 25, 2024 → Tier 2 —', nov[1] === '—', String(nov[1]));

    // Sep 2025 — both blocks. BLOCK 1 is the CHEAP tier (9.3¢ × 631 kWh),
    // so $58.68 is Tier 1; 11.0¢ × 828.6 kWh = $91.14 is Tier 2.
    const sep = tierCells('Sep 25, 2025');
    check('Sep 25, 2025 → Tier 1 $58.68', sep[0] === '$58.68', String(sep[0]));
    check('Sep 25, 2025 → Tier 2 $91.14', sep[1] === '$91.14', String(sep[1]));

    // Oct 2025 — BOTH BLOCK 1 lines are tier 1 ($91.44 winter + $9.11
    // summer = $100.55); dropping the summer one would lose $9.11 of the
    // bill's own commodity.
    const oct = tierCells('Oct 27, 2025');
    check('Oct 27, 2025 → Tier 1 $100.55', oct[0] === '$100.55', String(oct[0]));
    check('Oct 27, 2025 → Tier 2 $6.47', oct[1] === '$6.47', String(oct[1]));

    // The split must be a SPLIT: the two tier cells add to the commodity the
    // bill itself states for those periods (Wave P's audit: $149.82 and
    // $107.02). Losing a line in the split would show up right here.
    const n = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
    check(
      'Sep 25, 2025: the two tiers add up to the bill’s own $149.82 commodity',
      (n(sep[0]) + n(sep[1])).toFixed(2) === '149.82',
      `${sep[0]} + ${sep[1]} = ${(n(sep[0]) + n(sep[1])).toFixed(2)}`,
    );
    check(
      'Oct 27, 2025: the two tiers add up to the bill’s own $107.02 commodity',
      (n(oct[0]) + n(oct[1])).toFixed(2) === '107.02',
      `${oct[0]} + ${oct[1]} = ${(n(oct[0]) + n(oct[1])).toFixed(2)}`,
    );

    // A TOU period: no tiers, so a dash — never "$0.00" reading as a charge.
    const tou = tierCells('Aug 26, 2025');
    check('Aug 26, 2025 (TOU) → Tier 1 —', tou[0] === '—', String(tou[0]));
    check('Aug 26, 2025 (TOU) → Tier 2 —', tou[1] === '—', String(tou[1]));
    check(
      'the TOU period keeps its own windows instead',
      Number(col('Off-peak')) > -1 && row('Aug 26, 2025').cells[col('Off-peak')].startsWith('$'),
      row('Aug 26, 2025') ? row('Aug 26, 2025').cells[col('Off-peak')] : 'missing',
    );

    // The OPEN tail: estimate-only. Its commodity is ONE blended figure, so
    // both tier cells must be dashes and the row must be badged.
    const openLabel = money ? money.rows[money.rows.length - 1] : null;
    const openTier = openLabel ? [openLabel.cells[t1], openLabel.cells[t2]] : [null, null];
    check('OPEN row → Tier 1 —', openTier[0] === '—', `${openLabel?.label}: ${openTier[0]}`);
    check('OPEN row → Tier 2 —', openTier[1] === '—', `${openLabel?.label}: ${openTier[1]}`);
    check(
      'OPEN row is badged as an estimate',
      !!openLabel && /Estimate/i.test(openLabel.label),
      openLabel ? openLabel.label : 'missing',
    );
    const openCells = openLabel ? openLabel.cells.join(' | ') : '';
    check(
      'OPEN row still states its estimate as an ESTIMATE (not as a tier)',
      /Est\. commodity/.test(openCells) && /~\$/.test(openCells),
      openCells.slice(0, 220),
    );

    await page.screenshot({ path: path.join(OUT, 'tier-split-money-desktop.png'), fullPage: true });
    await page.getByTestId('money-table').screenshot({
      path: path.join(OUT, 'tier-split-money-table.png'),
    });

    /* --- 2. the PeriodDeltaTable --------------------------------------- */
    const deltas = await readDeltaTable(page);
    check('period delta table rendered', !!deltas, deltas ? `${deltas.rows.length} rows` : 'missing');
    const drow = (key) => (deltas ? deltas.rows.find((r) => r.key === `money-delta-${key}`) : null);
    const tier1Row = drow('tier1');
    const tier2Row = drow('tier2');
    check('delta table has a Tier 1 row', !!tier1Row, tier1Row ? tier1Row.cells[0] : 'missing');
    check('delta table has a Tier 2 row', !!tier2Row, tier2Row ? tier2Row.cells[0] : 'missing');
    check(
      'the row is labelled Tier 1 / Tier 2',
      !!tier1Row && !!tier2Row && /tier 1/i.test(tier1Row.cells[0]) && /tier 2/i.test(tier2Row.cells[0]),
      tier1Row ? `${tier1Row.cells[0]} / ${tier2Row.cells[0]}` : 'missing',
    );

    const openCol = deltas ? deltas.heads.findIndex((h) => /Estimate/.test(h)) : -1;
    check('the OPEN column is badged Estimate', openCol > -1, deltas ? deltas.heads.join(' | ') : '');
    if (openCol > -1 && tier1Row && tier2Row) {
      check(
        'delta table: OPEN column Tier 1 is a dash (never a paid tier)',
        tier1Row.cells[openCol] === '—',
        JSON.stringify(tier1Row.cells[openCol]),
      );
      check(
        'delta table: OPEN column Tier 2 is a dash (never a paid tier)',
        tier2Row.cells[openCol] === '—',
        JSON.stringify(tier2Row.cells[openCol]),
      );
    }

    // A TOU period inside the delta table: the tier cell is a dash there too
    // (the money-delta-no-tier testid is what the UI renders for it).
    const noTier = await page.getByTestId('money-delta-no-tier').count();
    check('delta table renders dashes where a tier does not apply', noTier >= 2, `${noTier} dashes`);

    // Every Tiered period's dollars ride in the two tier rows — the same
    // figures the raw-numbers table prints as values (there, as deltas).
    check(
      'the delta table carries each Tiered period’s tier dollars',
      !!tier1Row && !!tier2Row &&
        tier1Row.cells.slice(1).some((c) => c.includes('$85.69')) &&
        tier1Row.cells.slice(1).some((c) => c.includes('$58.68')) &&
        tier2Row.cells.slice(1).some((c) => c.includes('$91.14')),
      tier1Row ? tier1Row.cells.slice(1).join(' ') : 'missing',
    );

    await page.getByTestId('money-deltas').screenshot({
      path: path.join(OUT, 'tier-split-deltas-desktop.png'),
    });

    /* --- 3. the pace-chart tier marker is still there ------------------- */
    // Switch the plan on screen to Tiered: the accrual curve draws its
    // tier-1-allowance marker ONLY on a Tiered plan (the regression test for
    // "no marker off-Tiered" lives in WaveR.test.tsx), so the marker's
    // presence is a real assertion, not a count of zero pretending to be one.
    await page.getByTestId('plan-switcher').getByRole('button', { name: 'Tiered' }).click();
    const pressed = await page
      .getByTestId('plan-switcher')
      .getByRole('button', { name: 'Tiered' })
      .getAttribute('aria-pressed');
    check('plan switcher selects Tiered', pressed === 'true', `aria-pressed=${pressed}`);
    const marker = await page.getByTestId('accrual-tier-marker').count();
    check('pace-chart tier marker draws on Tiered', marker >= 1, `${marker} marker(s) on screen`);
    const accrualNote = flat(await page.getByTestId('accrual-note').innerText().catch(() => ''));
    check('the accrual card still explains its tier marker', /tier-2 rate|tier/i.test(accrualNote),
      accrualNote.slice(0, 160));

    /* --- 4. the same guarantees hold with Tiered selected on screen ------ */
    // A billed tier comes off the BILL, not off the plan selector: the Tiered
    // columns must be byte-identical after the switch. And the unbilled
    // tail's estimate — which under Tiered now lands in the "not split by
    // window" bucket — must STILL not be claimed by a tier row.
    const money2 = await readMoneyTable(page);
    const t1b = money2.headers.indexOf('Tier 1');
    const t2b = money2.headers.indexOf('Tier 2');
    const row2 = (label) => money2.rows.find((r) => r.label.startsWith(label));
    const sep2 = row2('Sep 25, 2025');
    check('Tiered selected: Sep 25, 2025 figures are unchanged',
      !!sep2 && sep2.cells[t1b] === '$58.68' && sep2.cells[t2b] === '$91.14',
      sep2 ? `${sep2.cells[t1b]} / ${sep2.cells[t2b]}` : 'missing');
    const open2 = money2.rows[money2.rows.length - 1];
    check('Tiered selected: OPEN row Tier 1 is still a dash',
      open2.cells[t1b] === '—', `${open2.label} → ${open2.cells[t1b]}`);
    check('Tiered selected: OPEN row Tier 2 is still a dash',
      open2.cells[t2b] === '—', `${open2.label} → ${open2.cells[t2b]}`);

    const deltas2 = await readDeltaTable(page);
    const openCol2 = deltas2.heads.findIndex((h) => /Estimate/.test(h));
    const d1b = deltas2.rows.find((r) => r.key === 'money-delta-tier1');
    const d2b = deltas2.rows.find((r) => r.key === 'money-delta-tier2');
    check(
      'Tiered selected: delta table OPEN column stays dashes in both tier rows',
      openCol2 > -1 && d1b.cells[openCol2] === '—' && d2b.cells[openCol2] === '—',
      d1b ? `${d1b.cells[openCol2]} / ${d2b.cells[openCol2]}` : 'missing',
    );

    await ctx.close();
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'tier-split',
    base: BASE,
    fixture: path.basename(FIXTURE),
    fixtureSha256: sha,
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  const file = path.join(OUT, `tier-split-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
