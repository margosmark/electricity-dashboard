/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Link Data — first-run / no-data upload modal, browser evidence.
 * Card: t_69a51490 (Quiet Meter Link Data empty-state surface).
 *
 * ─────────────────────────── how to reproduce ───────────────────────────
 *   cd webapp
 *   npm ci                       # a worktree needs a real node_modules
 *   npm run build
 *   npx next start -p 3210 &     # or reuse an already-running instance
 *   node evidence/link-data-verify.cjs
 *
 * Environment overrides:
 *   QUIET_METER_BASE_URL   base URL of the app   (default http://127.0.0.1:3210/)
 *   QUIET_METER_CHROMIUM   Chromium binary       (default /usr/bin/chromium)
 *
 * ─────────────────────────── what it writes ─────────────────────────────
 * Exactly four screenshots and one JSON record, all under
 * `evidence/quiet-meter/link-data/` (PNGs are gitignored repo-wide — the
 * JSON record is the tracked evidence, see evidence/ASSETS.md):
 *
 *   link-data-1440-light.png   link-data-1440-dark.png
 *   link-data-390-light.png    link-data-390-dark.png
 *   link-data-verification.json
 *
 * Every state boots a brand-new browser context, so localStorage is empty
 * and the dialog captured is the one a first-time visitor gets. The script
 * exits non-zero when any state breaks a contract line.
 *
 * Known, recorded-but-allowed noise: `GET /account/session` answers 404 in a
 * local build with no ACCT_* env — that 404 IS the account feature flag
 * (src/app/account/session/route.ts:7-9). Everything else is a failure.
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const BASE = process.env.QUIET_METER_BASE_URL || 'http://127.0.0.1:3210/';
const OUT = path.resolve(__dirname, 'quiet-meter/link-data');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const THEMES = ['light', 'dark'];
const DIALOG_LABEL = 'Link your Green Button data';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QUIET_METER_CHROMIUM || '/usr/bin/chromium',
  });

  const report = {
    card: 't_69a51490',
    subject: 'fresh Link Data upload modal (empty localStorage)',
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    repro: {
      install: 'cd webapp && npm ci',
      build: 'cd webapp && npm run build',
      serve: 'cd webapp && npx next start -p 3210 &',
      run: 'cd webapp && node evidence/link-data-verify.cjs',
      env: {
        QUIET_METER_BASE_URL: BASE,
        QUIET_METER_CHROMIUM: process.env.QUIET_METER_CHROMIUM || '/usr/bin/chromium (default)',
      },
    },
    states: [],
  };

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      // Fresh context per state: no storage, no service worker, no cache.
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
      });
      await context.addInitScript((mode) => {
        try {
          window.localStorage.clear();
          window.localStorage.setItem('theme', mode);
        } catch {
          /* storage denied — the app falls back to its own default */
        }
      }, theme);

      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const failedResponses = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push({ text: message.text(), source: message.location().url || null });
        }
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400) {
          failedResponses.push({ status: response.status(), url: response.url() });
        }
      });

      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      const modal = page.getByTestId('upload-modal');
      await modal.waitFor({ state: 'visible', timeout: 20_000 });

      const observed = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="upload-modal"]');
        const card = dialog ? dialog.firstElementChild : null;
        const html = document.documentElement;
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { width: Math.round(r.width), height: Math.round(r.height) };
        };
        const boxIsPainted = (el) => {
          const b = box(el);
          return Boolean(b && b.width > 0 && b.height > 0);
        };
        const xml = dialog ? dialog.querySelector('input[type="file"][accept=".xml"]') : null;
        const json = dialog ? dialog.querySelector('input[type="file"][accept^="application/json"]') : null;
        const jsonRow = json && json.closest('label');
        const jsonFace = jsonRow ? jsonRow.querySelector('span') : null;
        const example = document.querySelector('[data-testid="try-example-data"]');
        const cancel = dialog
          ? [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Cancel')
          : null;
        const cardStyle = card ? getComputedStyle(card) : null;
        const shadowAlpha = cardStyle
          ? [...cardStyle.boxShadow.matchAll(/rgba?\([^)]*,\s*([0-9.]+)\)/g)].map((m) => Number(m[1]))
          : [];

        return {
          theme: html.dataset.theme || null,
          dialogRole: dialog ? dialog.getAttribute('role') : null,
          dialogAriaModal: dialog ? dialog.getAttribute('aria-modal') : null,
          dialogLabel: dialog ? dialog.getAttribute('aria-label') : null,
          heading: dialog ? (dialog.querySelector('h2')?.textContent || '').trim() : null,
          documentViewportWidth: html.clientWidth,
          documentScrollWidth: html.scrollWidth,
          documentOverflow: html.scrollWidth - html.clientWidth,
          dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : null,
          cardBox: box(card),
          cardSurface: cardStyle
            ? {
                background: cardStyle.backgroundColor,
                borderWidth: cardStyle.borderTopWidth,
                borderColor: cardStyle.borderTopColor,
                borderRadius: cardStyle.borderTopLeftRadius,
                boxShadow: cardStyle.boxShadow,
                hasVisibleShadow: shadowAlpha.some((alpha) => alpha > 0),
                classNames: card ? card.className : '',
              }
            : null,
          controls: {
            xmlPresent: Boolean(xml),
            xmlAccept: xml ? xml.getAttribute('accept') : null,
            xmlMultiple: xml ? xml.hasAttribute('multiple') : null,
            xmlLabel: xml ? xml.getAttribute('aria-label') : null,
            xmlHitArea: boxIsPainted(xml),
            xmlDisabled: xml ? xml.disabled : null,
            jsonPresent: Boolean(json),
            jsonAccept: json ? json.getAttribute('accept') : null,
            jsonLabel: json ? json.getAttribute('aria-label') : null,
            jsonFaceVisible: boxIsPainted(jsonFace),
            exampleVisible: boxIsPainted(example),
            exampleEnabled: example ? !example.disabled : false,
            exampleText: example ? (example.textContent || '').trim() : null,
            cancelVisible: boxIsPainted(cancel),
            greenButtonSlot: dialog
              ? Boolean(
                  dialog.querySelector('[data-testid="gb-connect-card"], [data-testid="gb-unconfigured"]'),
                )
              : false,
          },
        };
      });

      const file = `link-data-${viewport.width}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: false });

      // Escape must still dismiss the first-run dialog (functional invariant).
      await page.keyboard.press('Escape');
      const escapeCloses = (await page.getByTestId('upload-modal').count()) === 0;

      const c = observed.controls;
      const surface = observed.cardSurface;
      // `GET /account/session` answers 404 ON PURPOSE in a build with no
      // ACCT_* env: it is the feature flag that hides account controls
      // (src/app/account/session/route.ts:7-9). A local `next start` is
      // exactly that build, so the browser probe's 404 is documented noise —
      // recorded below, excluded from the pass/fail gate.
      const isSessionProbe = (entry) => (entry.source || entry.url || '').replace(/\/$/, '').endsWith('/account/session');
      const expectedNoise = {
        reason: 'GET /account/session 404 = account feature flag off in a local build with no ACCT_* env (documented in src/app/account/session/route.ts)',
        console: consoleErrors.filter(isSessionProbe),
        responses: failedResponses.filter(isSessionProbe),
      };
      const unexpectedConsole = consoleErrors.filter((entry) => !isSessionProbe(entry));
      const unexpectedResponses = failedResponses.filter((entry) => !isSessionProbe(entry));
      const checks = {
        dialogLabelled:
          observed.dialogRole === 'dialog' &&
          observed.dialogAriaModal === 'true' &&
          observed.dialogLabel === DIALOG_LABEL,
        noHorizontalOverflow: observed.documentOverflow <= 1 && (observed.dialogOverflow ?? 0) <= 1,
        xmlWired:
          c.xmlPresent &&
          c.xmlAccept === '.xml' &&
          c.xmlMultiple === true &&
          c.xmlLabel === 'Upload Green Button XML' &&
          c.xmlHitArea &&
          c.xmlDisabled === false,
        jsonWired: c.jsonPresent && c.jsonAccept === 'application/json,.json' && c.jsonLabel === 'Import JSON backup',
        jsonQuietSecondary: c.jsonFaceVisible,
        exampleUsable: c.exampleVisible && c.exampleEnabled && c.exampleText === 'Try with example data',
        cancelUsable: c.cancelVisible,
        greenButtonSlot: c.greenButtonSlot,
        quietSurface:
          Boolean(surface) &&
          surface.borderWidth === '1px' &&
          surface.borderRadius === '8px' &&
          surface.hasVisibleShadow === false,
        cleanConsole:
          unexpectedConsole.length === 0 &&
          unexpectedResponses.length === 0 &&
          pageErrors.length === 0,
        escapeCloses,
      };

      report.states.push({
        viewport: `${viewport.width}x${viewport.height}`,
        theme,
        screenshot: file,
        ...observed,
        consoleErrors,
        pageErrors,
        failedResponses,
        expectedNoise,
        unexpected: { console: unexpectedConsole, responses: unexpectedResponses, pageErrors },
        checks,
        ok: Object.values(checks).every(Boolean),
      });

      await context.close();
    }
  }

  report.ok =
    report.states.length === 4 &&
    report.states.every((state) => state.ok) &&
    fs.readdirSync(OUT).filter((name) => name.endsWith('.png')).length === 4;

  fs.writeFileSync(path.join(OUT, 'link-data-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.ok, states: report.states.map((s) => ({ viewport: s.viewport, theme: s.theme, ok: s.ok, documentOverflow: s.documentOverflow, cardSurface: s.cardSurface, failed: Object.entries(s.checks).filter(([, v]) => !v).map(([k]) => k) })) }, null, 2));
  await browser.close();
  if (!report.ok) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
