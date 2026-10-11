/**
 * Truth-in-UI sweep (PR #53 / commit 6bb7b2f, merged as 2c822ac) — the
 * plan-alternative and EV counterfactual surfaces, checked on the DEPLOYED
 * stack and on a local production build, in EN **and** FR.
 *
 * The two labeling risks this sweep closes are only visible with a bill that
 * states no money at all, so the fixture is the committed Green Button
 * Alliance reference sample (a bare ElectricPowerUsageSummary: usage, no
 * charge lines, no rates). Every assertion below is about what the card
 * CLAIMS, not about what it renders:
 *
 *   1. "Your actual bill" — the payable cell is a dash, the label under it
 *      says the bill states no charge lines, and NOTHING on the card prints
 *      $0.00 (0,00 $ in fr-CA) or the words "you paid". The commodity check
 *      refuses instead of comparing our rate against a zero.
 *   2. Switch track record — the row skips with the reason, and the payment
 *      line the skip used to carry ("You paid $0.00.") is gone in both
 *      languages.
 *   3. Plan cards — every card declares the scope of its 6xl headline:
 *      "commodity only · <window> on screen".
 *   4. EV card — the three-plan baseline reads Baseline / Référence (never
 *      "Today"), and BOTH peak-exposure blocks — the priced one and the empty
 *      state a household without a car sees first — carry the run-rate
 *      disclosure: commodity only, scaled to 30.4 days from N days of data.
 *
 * Run:  TUI_XML=… (defaults to the committed fixture) TZ=America/Toronto \
 *         node evidence/truth-in-ui-verify.cjs
 * Env:  TUI_BASE_URL (default http://10.10.11.110:3939/ — deployed),
 *       TUI_CHROMIUM (default /usr/bin/chromium),
 *       TUI_XML (the file to import; defaults to the committed fixture),
 *       TUI_SHA (the commit the stack under test is serving),
 *       TUI_SUFFIX ('-local' writes -verification-local.json + -local PNGs).
 *
 * Writes evidence/truth-in-ui-verification[-suffix].json
 *            + truth-in-ui-plans-<locale>[-suffix].png
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

const BASE = process.env.TUI_BASE_URL || 'http://10.10.11.110:3939/';
const CHROMIUM = process.env.TUI_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.TUI_SUFFIX || '';
const SHA = process.env.TUI_SHA || '';
const FIXTURE =
  process.env.TUI_XML || path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;
/** Phone / desktop in one gate: TUI_VIEWPORT=390x844 (default 1440x900). */
const [VP_W, VP_H] = (process.env.TUI_VIEWPORT || '1440x900')
  .split('x')
  .map((n) => Number.parseInt(n, 10));

/**
 * The strings this card ships, per locale — read straight out of the
 * catalogs (src/i18n/{en,fr}.json) rather than retyped, so a catalog edit
 * cannot silently drift the gate.
 */
const CATALOG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../webapp/src/i18n/en.json'), 'utf8'));
const CATALOG_FR = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../webapp/src/i18n/fr.json'), 'utf8'));

const LOCALES = {
  en: {
    catalog: CATALOG,
    tab: 'Plans',
    paidWords: ['you paid'],
  },
  fr: {
    catalog: CATALOG_FR,
    tab: 'Grilles',
    paidWords: ['vous avez payé'],
  },
};

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}

/** Collapse every space flavour fr-CA uses (NBSP, NNBSP, thin) to one. */
const flat = (s) =>
  String(s == null ? '' : s)
    .replace(/[\s   ]+/g, ' ')
    .trim();
const lower = (s) => flat(s).toLowerCase();

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Click a tab by its LOCALIZED label and wait on its stable id — the id is
 * the tab key (`#tab-plans`), which the French label "Grilles" does not
 * become, so label and id have to travel together.
 */
async function selectTab(page, name, id) {
  await page.getByRole('tab', { name }).click();
  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector(`#tab-${expected}`);
      return !!el && el.getAttribute('aria-selected') === 'true';
    },
    id,
    { timeout: 10_000 },
  );
}

/** Flip the app to the requested locale and wait for the tab strip to follow. */
async function setLocale(page, target, label) {
  const toggle = page.getByTestId('locale-toggle');
  for (let i = 0; i < 3; i += 1) {
    const now = await toggle.getAttribute('data-locale');
    if (now === target) return true;
    await toggle.click();
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="locale-toggle"]')?.getAttribute('data-locale') === want,
      target,
      { timeout: 10_000 },
    );
  }
  check(`${label}: locale toggle reached ${target}`, false, `still ${(await toggle.getAttribute('data-locale')) ?? '?'}`);
  return false;
}

/** Everything the plans tab says about money, scope and the EV card. */
function readPlansTab(page) {
  return page.evaluate(() => {
    const flat = (s) => String(s == null ? '' : s).replace(/[\s   ]+/g, ' ').trim();
    const all = (sel) => [...document.querySelectorAll(sel)];
    const one = (sel) => document.querySelector(sel);
    const attrs = (el, names) => {
      const out = {};
      for (const n of names) out[n] = el ? el.getAttribute(n) : null;
      return out;
    };

    const billPeriod = one('[data-testid="actual-bill-period"]');
    const payable = one('[data-testid="actual-payable"]');
    const ev = one('[data-testid="ev-scenario"]');

    return {
      tabText: flat((one('#tab-plans') || document.body).textContent),
      bill: {
        period: attrs(billPeriod, ['data-period-start']),
        payable: payable ? flat(payable.textContent) : null,
        // The label under the payable figure — "you paid" vs the new disclosure.
        payableLabel: payable && payable.nextElementSibling ? flat(payable.nextElementSibling.textContent) : null,
        text: billPeriod ? flat(billPeriod.textContent) : null,
        commoditySkip: all('[data-testid="commodity-skip"]').map((el) => flat(el.textContent)),
        mismatch: all('[data-testid="commodity-mismatch"]').length,
        lines: all('[data-testid="actual-bill-period"] [data-testid^="bill-line-"]').map((el) => ({
          testid: el.getAttribute('data-testid'),
          text: flat(el.textContent),
        })),
      },
      track: {
        text: one('[data-testid="switch-track-record"]')
          ? flat(one('[data-testid="switch-track-record"]').textContent)
          : null,
        rows: all('[data-testid^="switch-row-"]').map((row) => ({
          testid: row.getAttribute('data-testid'),
          plan: row.getAttribute('data-plan'),
          skip: row.querySelector('[data-testid="switch-skip"]')
            ? flat(row.querySelector('[data-testid="switch-skip"]').textContent)
            : null,
          actualLabel: row.querySelector('[data-testid="switch-actual"]')
            ? flat(row.querySelector('[data-testid="switch-actual"]').previousElementSibling?.textContent)
            : null,
          actual: row.querySelector('[data-testid="switch-actual"]')
            ? flat(row.querySelector('[data-testid="switch-actual"]').textContent)
            : null,
        })),
      },
      cards: all('[data-testid="plan-card-scope"]').map((el) => flat(el.textContent)),
      ev: ev
        ? {
            text: flat(ev.textContent),
            empty: !!one('[data-testid="ev-scenario-empty"]'),
            comparison: !!one('[data-testid="ev-plan-comparison"]'),
            baselines: all('[data-testid^="ev-plan-baseline-"]').map((el) => ({
              testid: el.getAttribute('data-testid'),
              text: flat(el.textContent),
            })),
            deltas: one('[data-testid="ev-plan-comparison"]')
              ? flat(one('[data-testid="ev-plan-comparison"]').textContent)
              : null,
            exposures: all('[data-testid="ev-exposure-basis"]').map((el) => flat(el.textContent)),
            peakBlocks: all('[data-testid="ev-peak-exposure"]').length,
          }
        : null,
      /** A missing fr key falls back to its own key text on screen. */
      leaks: flat(document.body.innerText).match(/\b(?:actualBill|track|planCard|planTimeline|ev)\.[a-zA-Z_]+/g) || [],
      /** Anything on the tab that reads like a zero the utility never quoted. */
      zeroMoneyHits: (() => {
        const t = flat(document.body.innerText);
        const hits = ['$0.00', '0,00 $'].filter((z) => t.includes(z));
        if (hits.length === 0) return [];
        const at = t.indexOf(hits[0]);
        return [{ zero: hits[0], context: t.slice(Math.max(0, at - 90), at + 40) }];
      })(),
    };
  });
}

/** Run the whole sweep once in one language against one stack. */
async function runLocale(browser, key, label) {
  const cfg = LOCALES[key];
  const t = (k) => cfg.catalog[k];
  const ctx = await browser.newContext({
    viewport: { width: VP_W, height: VP_H },
    timezoneId: 'America/Toronto',
  });
  /**
   * The toggle persists to `oeo_locale`, so FR boots French with no click —
   * necessary here because the upload modal covers the toolbar on a fresh
   * page, which is exactly where the toggle lives. The toggle itself is
   * exercised for real afterwards, in both directions.
   */
  await ctx.addInitScript(
    (locale) => {
      try {
        window.localStorage.setItem('oeo_locale', locale);
      } catch {
        /* private mode — setLocale() clicks instead */
      }
    },
    key,
  );
  const page = await ctx.newPage();
  const facts = { locale: key, viewport: `${VP_W}x${VP_H}` };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await setLocale(page, key, label);
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
  check(`${label}: import produced a totals strip`, await shown(page.getByTestId('totals-strip'), 90_000));

  await selectTab(page, cfg.tab, 'plans');
  check(`${label}: ${cfg.tab} tab opens the plan surface`, await shown(page.getByTestId('actual-bill'), 20_000));

  /* --- 1. "Your actual bill" ------------------------------------------- */
  let data = await readPlansTab(page);
  facts.bill = data.bill;
  check(`${label}: payable cell is a dash, not a number`, data.bill.payable === '—', JSON.stringify(data.bill.payable));
  check(
    `${label}: the label under it says the bill states no charge lines`,
    lower(data.bill.payableLabel ?? '').includes(lower(t('actualBill.noChargeLines'))),
    (data.bill.payableLabel ?? '').slice(0, 120),
  );
  check(
    `${label}: commodity check refuses instead of comparing against the zero`,
    data.bill.commoditySkip.some((s) => lower(s).includes(lower(t('actualBill.commoditySkip')).slice(0, 46))),
    data.bill.commoditySkip[0]?.slice(0, 120) ?? 'none',
  );
  check(`${label}: no commodity mismatch is raised against a zero`, data.bill.mismatch === 0, `${data.bill.mismatch}`);
  check(
    `${label}: "Your actual bill" prints no zero money in either currency style`,
    data.zeroMoneyHits.length === 0,
    JSON.stringify(data.zeroMoneyHits),
  );
  check(
    `${label}: "Your actual bill" never says you paid`,
    !cfg.paidWords.some((w) => lower(data.bill.text ?? '').includes(w)),
    (data.bill.text ?? '').slice(0, 160),
  );

  /* --- 2. switch track record ------------------------------------------ */
  facts.track = data.track;
  const skipped = data.track.rows.filter((r) => r.skip !== null);
  check(`${label}: track record has the no-charge-lines row`, skipped.length > 0, `${skipped.length} skipped row(s)`);
  check(
    `${label}: the skip states the reason with no payment in it`,
    skipped.length > 0 &&
      lower(skipped[0].skip).includes(lower(t('planTimeline.skipNoChargeLines'))) &&
      !cfg.paidWords.some((w) => lower(skipped[0].skip).includes(w)),
    skipped[0]?.skip ?? 'none',
  );
  check(
    `${label}: track record carries no "You paid" and no $0.00`,
    !cfg.paidWords.some((w) => lower(data.track.text ?? '').includes(w)) &&
      !['$0.00', '0,00 $'].some((z) => (data.track.text ?? '').includes(z)),
    (data.track.text ?? '').slice(0, 200),
  );

  /* --- 3. plan cards declare their scope -------------------------------- */
  facts.cards = data.cards;
  const scopeHead = key === 'fr' ? t('planCard.scope').split('{range}')[0] : 'commodity only';
  const scopeTail = key === 'fr' ? 'à l’écran' : 'on screen';
  check(`${label}: every plan card declares its scope`, data.cards.length >= 2, `${data.cards.length} cards`);
  check(
    `${label}: each scope reads "<commodity only> · <window> on screen"`,
    data.cards.length >= 2 &&
      data.cards.every(
        (c) => lower(c).startsWith(lower(scopeHead)) && c.includes('·') && lower(c).endsWith(lower(scopeTail)),
      ),
    data.cards.join(' | ').slice(0, 200),
  );
  check(
    `${label}: the scope's window is a real date range`,
    data.cards.every((c) => {
      const mid = c.replace(scopeHead, '').replace(scopeTail, '').trim();
      return /\d/.test(mid) && mid.includes('–');
    }),
    data.cards[0] ?? 'none',
  );

  check(
    `${label}: no catalog key leaks to the screen on the plans tab`,
    data.leaks.length === 0,
    data.leaks.join(', '),
  );
  check(
    `${label}: the plans tab prints no zero the utility never quoted`,
    data.zeroMoneyHits.length === 0,
    JSON.stringify(data.zeroMoneyHits),
  );

  /* --- 4. EV card (Money tab): Baseline, and the run-rate disclosure ---- */
  await selectTab(page, key === 'fr' ? 'Coûts' : 'Money', 'money');
  check(`${label}: Money tab holds the EV card`, await shown(page.getByTestId('ev-scenario'), 20_000));
  data = await readPlansTab(page);
  facts.evEmptyBefore = data.ev;
  await page.getByTestId('ev-kwh-input').fill('12.5');
  await page.waitForTimeout(1_500);
  data = await readPlansTab(page);
  facts.ev = data.ev;

  check(`${label}: EV card prices a comparison once kWh is typed`, data.ev && data.ev.comparison, JSON.stringify(data.ev && { empty: data.ev.empty, comparison: data.ev.comparison }));
  check(
    `${label}: the three-plan baseline reads "${t('ev.baseline')}", never "Today"`,
    !!data.ev &&
      data.ev.baselines.length >= 3 &&
      data.ev.baselines.every((b) => lower(b.text).startsWith(lower(t('ev.baseline')))),
    JSON.stringify(data.ev ? data.ev.baselines.map((b) => b.text) : []),
  );
  check(
    `${label}: the comparison never says "vs today"`,
    !!data.ev && !/\bvs today\b/i.test(data.ev.deltas ?? ''),
    (data.ev?.deltas ?? '').slice(0, 160),
  );
  const basis = key === 'fr' ? 'électricité seulement' : 'commodity only';
  const runRate = key === 'fr' ? 'rythme annualisé' : 'run-rate';
  const daysOfData = key === 'fr' ? 'de vos données' : 'of your data';
  check(
    `${label}: priced peak exposure declares the run-rate basis`,
    !!data.ev &&
      data.ev.exposures.length >= 1 &&
      data.ev.exposures.every((e) => lower(e).includes(basis) && lower(e).includes(runRate) && lower(e).includes(daysOfData)),
    JSON.stringify(data.ev ? data.ev.exposures.map((e) => e.slice(0, 90)) : []),
  );

  /* --- 4b. the same card with nothing typed — the empty state ---------- */
  await page.getByTestId('ev-kwh-input').fill('');
  await page.waitForTimeout(1_500);
  data = await readPlansTab(page);
  facts.evEmpty = data.ev;
  check(`${label}: EV card drops to its empty state`, !!data.ev && data.ev.empty, JSON.stringify(data.ev && { empty: data.ev.empty, comparison: data.ev.comparison }));
  check(
    `${label}: the EMPTY state's peak exposure carries the same disclosure`,
    !!data.ev &&
      data.ev.peakBlocks >= 1 &&
      data.ev.exposures.length >= 1 &&
      data.ev.exposures.every((e) => lower(e).includes(basis) && lower(e).includes(runRate) && lower(e).includes(daysOfData)),
    JSON.stringify(data.ev ? { blocks: data.ev.peakBlocks, exposures: data.ev.exposures.map((e) => e.slice(0, 90)) } : []),
  );
  check(
    `${label}: no "vs today" survives in the empty state either`,
    !!data.ev && !/\bvs today\b/i.test(data.ev.text ?? ''),
    (data.ev?.text ?? '').slice(0, 160),
  );

  /* --- cross-cutting ---------------------------------------------------- */
  check(`${label}: no catalog key leaks to the screen`, data.leaks.length === 0, data.leaks.join(', '));
  /**
   * Scoped to the EV card, not the whole Money tab: the chart below it has
   * its own bill-accrual contract (unbilled rows badged ESTIMATE), which is
   * this sweep's sibling card, not this one. Any zero the tab does print is
   * recorded so the notes can say where it came from.
   */
  check(
    `${label}: the EV card prints no zero the utility never quoted`,
    !['$0.00', '0,00 $'].some((z) => (data.ev?.text ?? '').includes(z)),
    JSON.stringify((data.ev?.text ?? '').match(/.{0,60}(?:\$0\.00|0,00 \$).{0,40}/) ?? []),
  );
  facts.moneyTabZeroHits = data.zeroMoneyHits;
  if (data.zeroMoneyHits.length > 0) {
    console.log(`note  ${label}: $0.00 elsewhere on the Money tab — ${JSON.stringify(data.zeroMoneyHits)}`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label}: no horizontal overflow at ${VP_W}px`, overflow <= 0, `${overflow}px`);

  /* --- the locale toggle itself, both directions ------------------------ */
  const toggle = page.getByTestId('locale-toggle');
  check(
    `${label}: the app booted in ${key.toUpperCase()} (oeo_locale honoured)`,
    (await toggle.getAttribute('data-locale')) === key,
    (await toggle.getAttribute('data-locale')) ?? '?',
  );
  if (key === 'fr') {
    await toggle.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="locale-toggle"]')?.getAttribute('data-locale') === 'en',
      null,
      { timeout: 10_000 },
    );
    check('toggle flips the live tab strip to English', (await page.getByRole('tab', { name: 'Money' }).count()) > 0);
    await toggle.click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="locale-toggle"]')?.getAttribute('data-locale') === 'fr',
      null,
      { timeout: 10_000 },
    );
    check('toggle flips the live tab strip back to French', (await page.getByRole('tab', { name: 'Coûts' }).count()) > 0);
  }

  /* Two shots per locale: the surface this card fixed, and the EV card. */
  await selectTab(page, cfg.tab, 'plans');
  await page.waitForTimeout(500);
  const shot = path.join(OUT, `truth-in-ui-plans-${key}${SUFFIX}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  facts.shot = shot;
  console.log(`shot  ${shot}`);

  await selectTab(page, key === 'fr' ? 'Coûts' : 'Money', 'money');
  await page.waitForTimeout(500);
  const evShot = path.join(OUT, `truth-in-ui-ev-${key}${SUFFIX}.png`);
  await page.screenshot({ path: evShot, fullPage: true });
  facts.evShot = evShot;
  console.log(`shot  ${evShot}`);

  await ctx.close();
  return facts;
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture not found: ${FIXTURE}`);
    process.exit(2);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');
  console.log(
    `base ${BASE} · serving ${SHA || '(unknown sha)'} · viewport ${VP_W}x${VP_H} · ` +
      `fixture ${path.basename(FIXTURE)} · sha256 ${sha.slice(0, 16)}…`,
  );

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const facts = {
    base: BASE,
    serving: SHA,
    viewport: `${VP_W}x${VP_H}`,
    fixture: path.basename(FIXTURE),
    fixtureSha256: sha,
    locales: {},
  };
  try {
    for (const key of Object.keys(LOCALES)) {
      facts.locales[key] = await runLocale(browser, key, key.toUpperCase());
    }
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  facts.checks = checks;
  facts.passed = passed;
  facts.total = checks.length;
  const out = path.join(OUT, `truth-in-ui-verification${SUFFIX}.json`);
  fs.writeFileSync(out, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed · ${out}`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
