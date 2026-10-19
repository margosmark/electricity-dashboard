Plan-Switch synthetic browser fixture

The committed billing-period rows in `plan-switch-browser-periods.json` are derived from the existing public synthetic ESPI fixture `usage-summary-synthetic.xml`; the helper deterministically adjusts only synthetic totals/plan notes and generates hourly readings in memory. No private billing export or customer data is used.

Usage in a Playwright spec/script (from `webapp/`):

  import { seedPlanSwitchFixture } from './tests/e2e/plan-switch-fixture';
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await seedPlanSwitchFixture(page); // before navigation
  await page.goto('http://127.0.0.1:<production-preview-port>/#tab=plans');

The helper seeds app storage and intercepts `/api/rates` with the fixture's explicit deterministic rate schedule, so QA gets the same signed report on a production preview without mutating application code. Run against a fresh browser context. For the genuine empty state, use a separate fresh context and do not call the seed helper. Set `oeo_locale` and the theme control through the app UI or localStorage before navigation for the requested locale/theme matrix.

The supporting unit test is `webapp/src/lib/planSwitchBrowserFixture.test.ts`; it checks generated point count, both signs, the untrusted label state, and populated segment count. It does not replace independent production-browser QA.
