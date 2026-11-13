Plan-Switch synthetic browser fixture

The helper preserves the fixture periods' declared kWh, distributes that synthetic usage deterministically over hourly readings, and reconciles synthetic charge/tax/credit lines to the same readings and explicit fixture rate schedule. The resulting report must classify all three known periods as modeled and counted within the $1 model tolerance; the two switch bubbles remain signed (the middle switch is negative, the final switch positive). No private billing export or customer data is used.

Usage in a Playwright spec/script (from `webapp/`):

  import { seedPlanSwitchFixture } from './tests/e2e/plan-switch-fixture';
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await seedPlanSwitchFixture(page); // before navigation
  await page.goto('http://127.0.0.1:<production-preview-port>/#tab=plans');

The helper seeds app storage and intercepts `/api/rates` with the fixture's explicit deterministic rate schedule, so QA gets the same signed report on a production preview without mutating application code. Run against a fresh browser context. For the genuine empty state, use a separate fresh context and do not call the seed helper. Set `oeo_locale` and the theme control through the app UI or localStorage before navigation for the requested locale/theme matrix.

The supporting unit test is `webapp/src/lib/planSwitchBrowserFixture.test.ts`; it checks generated point count and kWh, both signed bubbles, trust/count totals and populated segment count. It does not replace independent production-browser QA.
