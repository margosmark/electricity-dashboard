import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Wave J — `/import`, the client-only landing place for a refreshed export.
 *
 * The contract under test is the one OPERATIONS.md states: a fresh profile
 * imports immediately, and an existing one is NEVER overwritten without the
 * merge review. Both paths finish by writing `energy_data` and hard-navigating
 * to `/`, exactly as the upload modal's commit does.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/synthetic.xml');
const FIXTURE_READINGS = 68;

async function storedReadings(page: Page): Promise<Array<{ timestamp: number; usage_kwh: number }>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('energy_data_v2') || 'null')?.points || []);
}

/**
 * Seed an EXISTING profile with the versioned payload — the key `storedReadings`
 * reads and the shape `saveEnergyData` writes.
 *
 * This used to seed the legacy v1 `energy_data` array instead, which made every
 * assertion below depend on the v1 -> v2 migration having run *on this page*.
 * On `/import` that migration is reached only via `loadStored()`, which is
 * called only from `reviewOrImport()` — i.e. only after a parse SUCCEEDS. The
 * garbage-payload test dies earlier in `decodeImportPayload()`, so nothing ever
 * wrote `energy_data_v2` and the assertion read an absent key while reporting it
 * as data loss. (The v1 rows were intact the whole time; see the legacy test
 * below, which pins the migration path these seeds used to cover by accident.)
 */
async function seedStorage(page: Page, rows: Array<{ timestamp: number; usage_kwh: number }>) {
  await page.goto('/');
  await page.evaluate((value) => {
    localStorage.setItem(
      'energy_data_v2',
      JSON.stringify({
        version: 2,
        uploadedAt: new Date(0).toISOString(),
        source: 'e2e-seed',
        points: value,
      }),
    );
    localStorage.setItem('energy_data_is_example', '1');
  }, rows);
}

const SEED = [
  { timestamp: Date.UTC(2020, 0, 1, 5) / 1000, usage_kwh: 4.25 },
  { timestamp: Date.UTC(2020, 0, 1, 6) / 1000, usage_kwh: 3.5 },
];

test.describe('/import', () => {
  test('empty profile: drops in the XML, imports immediately, opens the dashboard', async ({ page }) => {
    await page.goto('/import');
    await expect(page.getByText('Drop XML Here')).toBeVisible();

    await page.locator('[data-testid="import-file"]').setInputFiles(FIXTURE);

    // No prompt when there is nothing to lose — straight to the dashboard.
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    const rows = await storedReadings(page);
    expect(rows).toHaveLength(FIXTURE_READINGS);

    // The import is a real dataset, not the example set any more.
    expect(await page.evaluate(() => localStorage.getItem('energy_data_is_example'))).toBeNull();
    // Wave R: the dashboard opens on Overview — the verdict first, then the
    // whole-dataset totals. (The chart itself is one tab over, on Usage.)
    await expect(page.getByTestId('tab-nav')).toBeVisible();
    await expect(page.getByTestId('best-choice-banner')).toBeVisible();
    await expect(page.getByTestId('totals-strip')).toBeVisible();
  });

  test('existing readings: the merge review appears and Merge unions the two sets', async ({ page }) => {
    await seedStorage(page, SEED);
    await page.goto('/import');
    await page.locator('[data-testid="import-file"]').setInputFiles(FIXTURE);

    const review = page.getByTestId('import-review');
    await expect(review).toBeVisible();
    await expect(page.getByTestId('import-stat-In this browser')).toHaveText('2');
    await expect(page.getByTestId('import-stat-In the file')).toHaveText('68');
    await expect(page.getByTestId('import-stat-Already have')).toHaveText('0');
    await expect(page.getByTestId('import-stat-New rows')).toHaveText('68');
    await expect(page.getByTestId('import-merge')).toHaveText(/Merge \(70 rows\)/);

    // Nothing has been written yet — the review is a real gate.
    let rows = await storedReadings(page);
    expect(rows).toHaveLength(2);

    await page.getByTestId('import-merge').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    rows = await storedReadings(page);
    expect(rows).toHaveLength(70);
    expect(rows[0].usage_kwh).toBe(4.25);
    expect(await page.evaluate(() => localStorage.getItem('energy_data_is_example'))).toBeNull();
  });

  test('existing readings: Replace discards what the file does not cover', async ({ page }) => {
    await seedStorage(page, SEED);
    await page.goto('/import');
    await page.locator('[data-testid="import-file"]').setInputFiles(FIXTURE);
    await expect(page.getByTestId('import-review')).toBeVisible();

    await page.getByTestId('import-replace').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    const rows = await storedReadings(page);
    expect(rows).toHaveLength(FIXTURE_READINGS);
    expect(rows.some((r) => r.timestamp === SEED[0].timestamp)).toBe(false);
  });

  test('the review can be cancelled without touching storage', async ({ page }) => {
    await seedStorage(page, SEED);
    await page.goto('/import');
    await page.locator('[data-testid="import-file"]').setInputFiles(FIXTURE);
    await expect(page.getByTestId('import-review')).toBeVisible();

    await page.getByTestId('import-cancel').click();
    await expect(page.getByTestId('import-review')).toBeHidden();
    await expect(page.getByTestId('import-drop')).toBeVisible();

    const rows = await storedReadings(page);
    expect(rows).toEqual(SEED);
  });

  test('pasted base64 (the dmd_export_b64.py hand-off) imports the same document', async ({ page }) => {
    const xml = fs.readFileSync(FIXTURE, 'utf8');
    const b64 = Buffer.from(xml, 'utf8').toString('base64');

    await page.goto('/import');
    await page.getByTestId('import-paste').fill(b64);
    await page.getByTestId('import-load').click();

    await page.waitForURL(/\/$/, { timeout: 15_000 });
    expect(await storedReadings(page)).toHaveLength(FIXTURE_READINGS);
  });

  test('?d=<base64> deep link imports without any click', async ({ page }) => {
    // `?d=` is documented as the SMALL-payload hand-off (import/page.tsx,
    // OPERATIONS.md, dmd_export_b64.py --url): the whole document travels in
    // the URL, so a full export can never fit one. The deployed edge is
    // nginx, whose default `large_client_header_buffers 4 8k` caps the request
    // line at 8192 bytes total — measured 2026-10-10 against the deployed
    // router AND the public domain, both accepting 8167 chars of query and
    // returning 414 one char later. This used to deep-link the whole
    // synthetic.xml (14 844 base64 chars), which passed against the bare Node
    // server (its own ceiling is 16 289) and 414'd on every deployed hop.
    //
    // So the deep link carries a genuinely small document, and the size is
    // asserted: the budget is part of the contract, not an accident.
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://schemas.opengroup.org/espi/1.0">',
      '  <entry><IntervalBlock>',
      '    <IntervalReading><timePeriod><start>1788523200</start><duration>3600</duration></timePeriod><value>500</value></IntervalReading>',
      '    <IntervalReading><timePeriod><start>1788537600</start><duration>3600</duration></timePeriod><value>2400</value></IntervalReading>',
      '  </IntervalBlock></entry>',
      '</feed>',
    ].join('\n');
    const b64 = Buffer.from(xml, 'utf8').toString('base64');
    // What nginx sees is the ENCODED query, not the raw base64: '+' -> '%2B'
    // inflates it (612 raw -> 628 encoded here), and the whole request line
    // must fit 8192. Assert the real bytes on the wire, with headroom.
    const query = encodeURIComponent(b64);
    expect(
      query.length,
      'a ?d= payload must fit the deployed edge’s 8 KB request line',
    ).toBeLessThan(8_000);

    await page.goto(`/import?d=${query}`);

    await page.waitForURL(/\/$/, { timeout: 15_000 });
    expect(await storedReadings(page)).toHaveLength(2);
  });

  test('garbage payload fails loudly and writes nothing', async ({ page }) => {
    await seedStorage(page, SEED);
    await page.goto('/import');
    await page.getByTestId('import-paste').fill('this is not base64 or xml at all!!');
    await page.getByTestId('import-load').click();

    await expect(page.getByTestId('import-error')).toBeVisible();
    await expect(page.getByTestId('import-error')).toContainText(/neither an XML export nor base64/i);

    // Stays on the page: a failed import never redirects or mutates storage.
    expect(new URL(page.url()).pathname).toBe('/import');
    expect(await storedReadings(page)).toEqual(SEED);
  });

  test('an HTML error page saved as XML is diagnosed, not imported', async ({ page }) => {
    await page.goto('/import');
    await page.getByTestId('import-paste').fill('<!doctype html><html><body>Sign in failed</body></html>');
    await page.getByTestId('import-load').click();

    await expect(page.getByTestId('import-error')).toBeVisible();
    await expect(page.getByTestId('import-error')).toContainText(/web page, not an export/i);
    expect(await storedReadings(page)).toEqual([]);
  });

  test('a legacy (v1) profile survives a failed import — the migration path the seeds used to cover by accident', async ({ page }) => {
    // seedStorage() writes the v2 payload because that is what the assertions
    // here read. That left the v1 -> v2 migration exercised only by accident:
    // the sibling tests fed a valid file, so `reviewOrImport` -> `loadStored`
    // ran the migration for them. Pin it deliberately, on the path that
    // actually matters — a legacy user whose import FAILS.
    await page.goto('/');
    await page.evaluate((value) => {
      localStorage.setItem('energy_data', JSON.stringify(value));
      localStorage.setItem('energy_data_is_example', '1');
    }, SEED);

    // Loading the dashboard migrates v1 -> v2 and drops the legacy key.
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('energy_data_v2')))
      .not.toBeNull();
    expect(await storedReadings(page)).toEqual(SEED);
    expect(
      await page.evaluate(() => localStorage.getItem('energy_data')),
      'the legacy key is dropped once the v2 write succeeded',
    ).toBeNull();

    // Now the failure path that used to report this as data loss.
    await page.goto('/import');
    await page.getByTestId('import-paste').fill('this is not base64 or xml at all!!');
    await page.getByTestId('import-load').click();
    await expect(page.getByTestId('import-error')).toBeVisible();

    expect(new URL(page.url()).pathname).toBe('/import');
    expect(await storedReadings(page), 'a failed import leaves the migrated profile intact').toEqual(SEED);
  });
});
