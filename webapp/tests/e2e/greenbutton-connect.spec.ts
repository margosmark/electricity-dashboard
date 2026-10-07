import { test, expect, type Page } from '@playwright/test';

/**
 * Wave K / t_500e6614 — the browser half of the Green Button connect flow.
 *
 * The HTTP gate (`webapp/scripts/e2e-greenbutton-loop.sh`) proves the shim's
 * routes; this spec proves the part that only a real browser can: that the
 * toolbar button hands the user to the custodian, that the custodian hands
 * them back through the registered redirect_uri, that the piped feed is
 * ingested by the EXISTING localStorage path, and that nothing token-shaped
 * survives anywhere the browser can read.
 *
 * It needs a shim that is actually configured (GB_CLIENT_ID/GB_CLIENT_SECRET
 * + a custodian to authorise against), so it drives the stack booted by
 * `scripts/e2e-greenbutton-browser.sh`. Against an unconfigured server — the
 * production default, and the CI container — it skips with that reason, unless
 * GB_E2E_REQUIRED=1 says a skip would be a lie.
 */

/** Anything token-shaped that must never appear in browser-readable storage. */
const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/refresh[-_]?token/i, 'refresh token'],
  [/refresh-[a-z0-9]/i, 'mock refresh token value'],
  [/access[-_]?token/i, 'access token'],
  [/access-[a-z0-9]/i, 'mock access token value'],
  [/client_secret/i, 'client secret field'],
  [/mock-client-secret/, 'client secret value'],
  [/authorization_code/, 'authorization_code grant'],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/, 'bearer credential'],
];

/** Two hand-made rows from 2020 — a browser that already has a profile. */
const SEED = [
  { timestamp: Date.UTC(2020, 0, 1, 5) / 1000, usage_kwh: 4.25 },
  { timestamp: Date.UTC(2020, 0, 1, 6) / 1000, usage_kwh: 3.5 },
];

/** The mock custodian pipes 48 hourly IntervalReadings (mock-custodian.mjs). */
const MOCK_READINGS = 48;

type Snapshot = {
  storage: Record<string, Record<string, string>>;
  cookies: string[];
  documentCookie: string;
};

async function snapshot(page: Page): Promise<Snapshot> {
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(
      Array.from({ length: localStorage.length }).map((_, i) => {
        const k = localStorage.key(i)!;
        return [k, localStorage.getItem(k) ?? ''];
      }),
    ),
    session: Object.fromEntries(
      Array.from({ length: sessionStorage.length }).map((_, i) => {
        const k = sessionStorage.key(i)!;
        return [k, sessionStorage.getItem(k) ?? ''];
      }),
    ),
  }));
  const cookies = await page.context().cookies();
  const documentCookie = await page.evaluate(() => document.cookie);
  return {
    storage,
    cookies: cookies.map((c) => `${c.name}=${c.value}`),
    documentCookie,
  };
}

function tokenMaterialIn(snap: Snapshot): string[] {
  const hay = [
    ...Object.entries(snap.storage).flatMap(([store, kv]) =>
      Object.entries(kv).map(([k, v]) => `${store}.${k}=${v}`),
    ),
    ...snap.cookies,
    snap.documentCookie,
  ].join('\n');
  return TOKEN_PATTERNS.filter(([re]) => re.test(hay)).map(([, label]) => label);
}

async function storedReadings(page: Page): Promise<Array<{ timestamp: number }>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]'));
}

test.describe('Green Button connect flow (browser)', () => {
  test('authorise → callback → fetch → localStorage, with no token material left behind', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // ---- 0. is this shim configured at all? ---------------------------
    const status0 = await (await page.request.get('/greenbutton/status')).json();
    if (!status0.configured && process.env.GB_E2E_REQUIRED !== '1') {
      test.skip(
        true,
        'shim is not configured on this server (no GB_CLIENT_ID/GB_CLIENT_SECRET) — ' +
          'run scripts/e2e-greenbutton-browser.sh to gate the connect flow',
      );
    }
    expect(
      status0.configured,
      'GB_E2E_REQUIRED=1 but /greenbutton/status reports configured:false — the ' +
        'driver booted a server without credentials, so this gate would be vacuous',
    ).toBe(true);
    expect(status0.redirectUri).toMatch(/\/greenbutton\/callback$/);
    expect(status0.connected, 'a fresh browser must start disconnected').toBe(false);

    // Everything the custodian is asked for, captured off the wire.
    const authorizeUrls: URL[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/oauth/authorize') authorizeUrls.push(u);
    });

    // ---- 1. a browser that already has a profile ----------------------
    await page.goto('/');
    await page.evaluate((rows) => {
      localStorage.setItem('energy_data', JSON.stringify(rows));
    }, SEED);
    await page.reload();

    // ---- 2. disconnected ----------------------------------------------
    const chip = page.getByTestId('gb-chip');
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-gb-state', 'disconnected');
    const connect = page.getByTestId('gb-connect');
    await expect(connect).toHaveText('Authorise with Oakville Hydro');
    expect((await storedReadings(page)).length, 'seed intact before the flow').toBe(SEED.length);

    // ---- 3. authorise: off to the custodian with the registered params -
    await connect.click();

    await expect
      .poll(async () => authorizeUrls.length, {
        message: 'the button never reached the custodian authorize endpoint',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const authorize = authorizeUrls[0];
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('client_id'), 'registered client_id sent').toBeTruthy();
    expect(authorize.searchParams.get('redirect_uri')).toBe(status0.redirectUri);
    expect(authorize.searchParams.get('state'), 'CSRF state sent').toBeTruthy();
    expect(authorize.searchParams.get('scope')).toBeTruthy();

    // ---- 4. back through the callback, into the app --------------------
    // /greenbutton/callback exchanges the code and lands on /?gb=connected,
    // which the dashboard strips before it can be replayed by a reload.
    await expect
      .poll(async () => new URL(page.url()).pathname, {
        message: 'the callback never returned to the dashboard',
        timeout: 20_000,
      })
      .toBe('/');
    await expect(chip).toHaveAttribute('data-gb-state', 'synced', { timeout: 30_000 });
    expect(new URL(page.url()).search, 'the gb flag is stripped, not replayable').toBe('');

    // ---- 5. the feed landed through the EXISTING ingestion path --------
    const rows = await storedReadings(page);
    expect(rows.length, `${MOCK_READINGS} piped + ${SEED.length} seeded`).toBe(
      MOCK_READINGS + SEED.length,
    );
    const now = Math.floor(Date.now() / 1000);
    const newest = Math.max(...rows.map((r) => r.timestamp));
    expect(newest, 'the piped rows are the recent ones, merged not replaced').toBeGreaterThan(
      now - 72 * 3600,
    );
    expect(rows.some((r) => r.timestamp === SEED[0].timestamp), 'history preserved').toBe(true);

    // The toolbar now reads as data-synced, not merely authorised.
    await expect(page.getByTestId('gb-sync')).toHaveText('Live');

    // ---- 6. no token material anywhere the browser can read ------------
    const snap = await snapshot(page);
    expect(tokenMaterialIn(snap), 'browser storage must hold no OAuth material').toEqual([]);
    // The only cookie this flow may leave is the HttpOnly session: the CSRF
    // state cookie is cleared by the callback, and no OAuth token may ride
    // in any cookie at all.
    const cookieNames = snap.cookies.map((c) => c.split('=')[0]);
    expect(cookieNames, `cookies left behind: ${snap.cookies.join(', ')}`).toEqual(['gb_session']);
    expect(snap.documentCookie, 'the session cookie is HttpOnly, invisible to JS').toBe('');
    const html = await page.content();
    expect(html).not.toContain('mock-client-secret');
    expect(html).not.toMatch(/"refreshToken"|"refresh_token"/);

    // ---- 7. revoke from the UI, and the data stays ---------------------
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('gb-disconnect').click();
    await expect(chip).toHaveAttribute('data-gb-state', 'disconnected', { timeout: 20_000 });
    await expect(page.getByTestId('gb-connect')).toHaveText('Authorise with Oakville Hydro');
    expect((await storedReadings(page)).length, 'disconnect never touches readings').toBe(
      MOCK_READINGS + SEED.length,
    );

    const statusAfter = await (await page.request.get('/greenbutton/status')).json();
    expect(statusAfter.connected).toBe(false);
    expect(tokenMaterialIn(await snapshot(page))).toEqual([]);
  });

  test('a browser with no profile can still authorise from a cold start', async ({ page }) => {
    test.setTimeout(120_000);

    const status0 = await (await page.request.get('/greenbutton/status')).json();
    if (!status0.configured && process.env.GB_E2E_REQUIRED !== '1') {
      test.skip(true, 'shim is not configured on this server');
    }
    expect(status0.configured).toBe(true);

    await page.goto('/');
    const chip = page.getByTestId('gb-chip');
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-gb-state', 'disconnected');

    // With nothing stored, the Link Data dialog opens first — that is where
    // the explanatory copy lives, and it offers the same authorise action.
    const dialogConnect = page.getByTestId('gb-connect-card').getByTestId('gb-connect');
    await expect(dialogConnect).toHaveText('Authorise with Oakville Hydro');
    await expect(page.getByTestId('gb-connect-card')).toHaveAttribute(
      'data-gb-state',
      'disconnected',
    );
    await dialogConnect.click();

    await expect
      .poll(async () => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe('/');
    await expect(chip).toHaveAttribute('data-gb-state', 'synced', { timeout: 30_000 });
    expect((await storedReadings(page)).length).toBe(MOCK_READINGS);
    expect(tokenMaterialIn(await snapshot(page))).toEqual([]);
  });
});
