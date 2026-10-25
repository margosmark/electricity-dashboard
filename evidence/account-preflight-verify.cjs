/**
 * account-preflight-verify — the preflight page, on a REAL browser, in both
 * languages.
 *
 * What it proves, and why each part is here:
 *
 *   1. `/account/preflight` RENDERS from the account process while the
 *      feature is off (this is the state the card is about: today the
 *      disabled feature is invisible, so nobody can see why activation is
 *      not happening).
 *   2. all three prerequisites are on screen with an explicit pass/pending
 *      state — never a silent failure,
 *   3. the fail-closed sentence is painted, in English AND in French,
 *   4. the seven-item activation checklist is complete,
 *   5. the painted page carries no SMTP detail: no address, no host, no
 *      connection string, no raw catalog key.
 *
 * Screenshots (the deliverable): evidence/account-preflight-en.png and
 * evidence/account-preflight-fr.png.
 * Report:        evidence/account-preflight-verification.json
 *
 * Run (from the repo root, against a build of THIS worktree):
 *   PREFLIGHT_BASE_URL=http://127.0.0.1:3219/ node evidence/account-preflight-verify.cjs
 *
 * The server must be started with the flags set the way compose sets them:
 *   ACCT_ENABLED=false ACCT_EMAIL_VERIFICATION_ENABLED=false npx next start -p 3219
 */

const path = require('node:path');
const fs = require('node:fs');

const { chromium } = require('@playwright/test');

const BASE = process.env.PREFLIGHT_BASE_URL || 'http://127.0.0.1:3219/';
const CHROMIUM = process.env.PREFLIGHT_CHROMIUM || '/usr/bin/chromium';
const OUT = __dirname;

const CHECK_IDS = ['smtp', 'accountEnabled', 'emailVerification'];

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}

const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Painted text only: the RSC payload inside <script> carries the server's
 *  English render and would make a French page look untranslated. */
function paintedText() {
  const PAINTED = (el) => !/^(script|style|template|noscript)$/i.test(el.tagName || '');
  const parts = [];
  for (const el of [document.body, ...document.body.querySelectorAll('*')].filter(PAINTED)) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) parts.push(node.textContent);
    }
  }
  return parts.join(' ');
}

/** Read the preflight's own facts out of the DOM. */
function readState() {
  const rows = [...document.querySelectorAll('[data-testid^="preflight-check-"][data-state]')];
  return {
    checks: rows.map((row) => ({
      id: row.getAttribute('data-testid').replace('preflight-check-', ''),
      state: row.getAttribute('data-state'),
      label: flat(row.querySelector('span span') ? row.querySelector('span span').textContent : ''),
      badge: flat(
        row.querySelector('[data-testid^="preflight-state-"]')
          ? row.querySelector('[data-testid^="preflight-state-"]').textContent
          : '',
      ),
      detail: flat(row.querySelectorAll('span span')[1] ? row.querySelectorAll('span span')[1].textContent : ''),
    })),
    verdict: flat(document.querySelector('[data-testid="preflight-verdict"]')?.textContent || ''),
    verdictRole: document.querySelector('[data-testid="preflight-verdict"]')?.getAttribute('role') || '',
    dataReady: document.querySelector('[data-testid="preflight-verdict"]')?.getAttribute('data-ready') || '',
    checklistItems: [...document.querySelectorAll('[data-testid^="preflight-item-"]')].map((li) =>
      flat(li.textContent),
    ),
    readOnly: flat(document.querySelector('[data-testid="preflight-readonly"]')?.textContent || ''),
    painted: paintedText(),
  };
}

async function shot(browser, locale) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1400 },
    timezoneId: 'America/Toronto',
  });
  // Seed the app's own storage tag BEFORE any page script runs — the initial
  // client render is English by design and the stored locale is applied in an
  // effect, so the wait below is what proves French actually painted.
  await ctx.addInitScript((value) => {
    try {
      window.localStorage.setItem('oeo_locale', value);
    } catch {
      /* storage disabled — the page still renders, the wait will catch it */
    }
  }, locale);

  const page = await ctx.newPage();
  await page.goto(new URL('account/preflight', BASE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="preflight-checklist"]', { timeout: 30_000 });

  if (locale === 'fr') {
    await page.waitForFunction(
      () => (document.body.textContent || '').includes("L'activation du compte reste bloquée"),
      undefined,
      { timeout: 30_000 },
    );
  } else {
    await page.waitForFunction(
      () => (document.body.textContent || '').includes('Account activation stays fail-closed'),
      undefined,
      { timeout: 30_000 },
    );
  }
  await page.waitForFunction((l) => document.documentElement.lang === l, locale, { timeout: 30_000 });

  const state = await page.evaluate(readState);
  const shotPath = path.join(OUT, `account-preflight-${locale}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  await ctx.close();
  return { state, screenshot: shotPath };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const report = { base: BASE, url: new URL('account/preflight', BASE).href, locales: {} };

  try {
    for (const locale of ['en', 'fr']) {
      const { state, screenshot } = await shot(browser, locale);
      report.locales[locale] = {
        ...state,
        screenshot: path.basename(screenshot),
        paintedChars: state.painted.length,
      };
      delete report.locales[locale].painted;

      const ids = state.checks.map((c) => c.id).join(',');
      check(`${locale}: exactly the three prerequisites are on screen`, ids === CHECK_IDS.join(','), ids);
      check(
        `${locale}: every prerequisite states pass/pending (no silent failure)`,
        state.checks.every((c) => c.state === 'pass' || c.state === 'pending') &&
          state.checks.every((c) => c.badge.length > 0),
        state.checks.map((c) => `${c.id}=${c.state}/${c.badge}`).join(' '),
      );
      check(
        `${locale}: the deployment's own state reads pending on all three`,
        state.checks.every((c) => c.state === 'pending'),
        state.dataReady,
      );
      check(`${locale}: verdict is a role=status banner`, state.verdictRole === 'status', state.verdictRole);
      check(
        `${locale}: fail-closed statement is painted`,
        locale === 'fr'
          ? state.verdict.includes("reste bloquée tant que le courriel SMTP n'est pas en service")
          : state.verdict.includes('Account activation stays fail-closed until SMTP is live'),
        state.verdict.slice(0, 90),
      );
      check(`${locale}: 7 checklist items`, state.checklistItems.length === 7, `${state.checklistItems.length}`);
      check(
        `${locale}: read-only statement present`,
        locale === 'fr'
          ? state.readOnly.startsWith('Lecture seule')
          : state.readOnly.startsWith('Read-only'),
        state.readOnly.slice(0, 70),
      );
      check(`${locale}: painted real content`, state.painted.length > 800, `${state.painted.length} chars`);

      // Secrecy: no SMTP detail may reach a human, in either language.
      const painted = state.painted;
      check(`${locale}: no email address painted`, !/@/.test(painted), '');
      check(`${locale}: no connection string / URL painted`, !/:\/\//.test(painted), '');
      check(`${locale}: no SMTP host painted`, !/smtp\.[a-z]/i.test(painted), '');
      check(
        `${locale}: no SMTP field name painted`,
        !/ACCT_SMTP_(HOST|PORT|FROM|REPLY_TO|HELO|USERNAME|PASSWORD|TLS_MODE)/.test(painted),
        '',
      );
      check(`${locale}: no raw catalog key painted`, !/preflight\./.test(painted), '');
      check(
        `${locale}: screenshot written`,
        fs.existsSync(screenshot) && fs.statSync(screenshot).size > 10_000,
        `${path.basename(screenshot)} ${fs.existsSync(screenshot) ? fs.statSync(screenshot).size : 0} bytes`,
      );
    }

    // The French page must not be the English page wearing a different tab title.
    const en = report.locales.en;
    const fr = report.locales.fr;
    check(
      'fr verdict differs from en verdict',
      fr.verdict !== en.verdict && fr.verdict.length > 80,
      `${en.verdict.length} vs ${fr.verdict.length} chars`,
    );
    check(
      'fr checklist differs from en checklist',
      fr.checklistItems.every((item, i) => item !== en.checklistItems[i]),
      '7/7 differ',
    );
    check(
      'both states are identically pending across locales',
      JSON.stringify(fr.checks.map((c) => [c.id, c.state])) ===
        JSON.stringify(en.checks.map((c) => [c.id, c.state])),
      en.checks.map((c) => `${c.id}=${c.state}`).join(' '),
    );
  } finally {
    await browser.close();
  }

  report.counts = {
    locales: Object.keys(report.locales).length,
    checksPerLocale: CHECK_IDS.length,
    checklistItemsPerLocale: report.locales.en ? report.locales.en.checklistItems.length : 0,
    assertions: checks.length,
    failures: checks.filter((c) => !c.ok).length,
    screenshots: Object.values(report.locales).map((l) => l.screenshot),
  };
  report.checks = checks;

  const outFile = path.join(OUT, 'account-preflight-verification.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `\n${report.counts.assertions - report.counts.failures}/${report.counts.assertions} assertions passed — ` +
      `${report.counts.screenshots.join(', ')}\nreport: ${outFile}`,
  );
  process.exit(report.counts.failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('account-preflight-verify crashed:', err);
  process.exit(2);
});
