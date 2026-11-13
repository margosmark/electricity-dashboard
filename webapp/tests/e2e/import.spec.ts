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
 *
 * The second describe block is the bill half of that contract (t_05195060):
 * a Green Button feed is TWO halves — readings under `energy_data_v2`, and
 * UsageSummary bills + clock rules under `usage_summaries` /
 * `local_time_parameters`. This page used to write only the first, so an
 * Enbridge gas export imported "successfully" with `isGasFeed` false and not
 * one gas surface rendered. The commodity split (t_8a9038d6) then moved the
 * GAS halves to their own key space — `energy_gas_v2` /
 * `gas_usage_summaries` — so a gas import addresses ONLY those and leaves
 * the electric keys untouched; each half below is read from its own key.
 *
 * FIXTURE POLICY (same as enbridge-gas-journey.spec.ts): SYNTHETIC only. The
 * owner's real EGD export carries his name, home address, account number and
 * meter serial and must never enter this repo, a fixture, or a PR.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/synthetic.xml');
const FIXTURE_READINGS = 68;
/** Commodity 7: 10 UsageSummary periods, 5 IntervalBlocks, no electric rows. */
const GAS_FIXTURE = path.resolve(__dirname, '../fixtures/enbridge-gas-synthetic.xml');
/** Electric feed that ALSO carries a UsageSummary and a LocalTimeParameters. */
const ALLIANCE_FIXTURE = path.resolve(__dirname, '../fixtures/green-button-alliance-sample.xml');

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

type StoredBill = { start: number; _gasInterval?: unknown };

const storedBills = (page: Page): Promise<StoredBill[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('usage_summaries') || '[]'));

/**
 * The GAS half of the split key space (t_8a9038d6, AC1): a gas import writes
 * `gas_usage_summaries` only and never addresses `usage_summaries`, which
 * stays reserved for the electric bill half.
 */
const storedGasBills = (page: Page): Promise<StoredBill[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('gas_usage_summaries') || '[]'));

const storedClock = (page: Page): Promise<{ tzOffset?: number } | null> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('local_time_parameters') || 'null'));

/**
 * Seed UsageSummary bills directly — the shape `readStoredBillFeed` accepts
 * and the shape the app's own `mark-seed.ts` writes (run in the page, so it
 * closes over nothing from Node). Starts sit in 2024, clear of the gas
 * fixture's own 2025-12 → 2026-09 periods, so a union of the two has to
 * keep all of them rather than de-duplicating any away.
 */
const BILL_STARTS = [
  Date.UTC(2024, 0, 1) / 1000,
  Date.UTC(2024, 0, 29) / 1000,
  Date.UTC(2024, 1, 26) / 1000,
];

async function seedBills(page: Page, starts: number[]) {
  await page.evaluate((list) => {
    const ymd = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
    localStorage.setItem(
      'usage_summaries',
      JSON.stringify(
        list.map((start) => ({
          source: 'UsageSummary',
          start,
          duration: 28 * 86400,
          startDate: ymd(start),
          endDate: ymd(start + 28 * 86400),
          days: 28,
          billLastPeriod: 28 * 86400,
          billToDate: 0,
          costAdditionalLastPeriod: 0,
          currency: 124,
          consumption: { scaled: 500, value: 500, powerOfTenMultiplier: 0, uom: 72 },
          volume: null,
          items: [
            {
              note: 'Total Electricity Charges',
              amount: 100,
              rawAmount: 1000000,
              itemKind: null,
              unitCost: null,
              measurement: null,
            },
          ],
        })),
      ),
    );
  }, starts);
}

/** Drop a fixture on /import and wait for the commit that navigates to `/`. */
async function importFile(page: Page, fixture: string): Promise<void> {
  await page.goto('/import');
  await expect(page.getByText('Drop XML Here')).toBeVisible();
  await page.locator('[data-testid="import-file"]').setInputFiles(fixture);
  await page.waitForURL(/\/$/, { timeout: 15_000 });
}

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

  test('a refused document leaves EVERY stored key byte-identical (real browser)', async ({ page }) => {
    // The jsdom suite (src/app/import/ImportPageAtomicity.test.tsx) asserts the
    // whole-store snapshot; this is the same claim on the real engine, where
    // File/TextDecoder/fast-xml-parser are the shipped implementations rather
    // than jsdom's. The profile is seeded with every key an import can reach —
    // readings, a bill list, the feed clock and the provenance flag — so a
    // SECOND write of a refused import (a flag cleared, a bill list replaced)
    // cannot hide behind "the rows are unchanged".
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem(
        'energy_data_v2',
        JSON.stringify({ version: 2, uploadedAt: new Date(0).toISOString(), source: 'e2e-seed', points: [
          { timestamp: Date.UTC(2020, 0, 1, 5) / 1000, usage_kwh: 4.25 },
        ] }),
      );
      localStorage.setItem('usage_summaries', JSON.stringify([
        { source: 'UsageSummary', start: 1577836800, duration: 2678400, startDate: '2020-01-01', endDate: '2020-01-31', days: 31, billLastPeriod: 4100, billToDate: 4100, costAdditionalLastPeriod: null, currency: 124, consumption: null, items: [] },
      ]));
      localStorage.setItem('local_time_parameters', JSON.stringify({ tzOffset: -18000, dstOffset: 3600, dstStartRule: '360E2000', dstEndRule: 'B40E2000' }));
      localStorage.setItem('energy_data_is_example', '1');
      localStorage.setItem('account_sync_rev', '7');
    });
    const snapshot = () =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .sort()
          .map((k) => `${k} = ${localStorage.getItem(k)}`)
          .join('\n'),
      );

    await page.goto('/import');
    // Taken HERE, after any boot-time migration on /import has run: the
    // assertion below is about what the REFUSED payload does, not about boot.
    const before = await snapshot();
    expect(before).toContain('usage_summaries');
    expect(before).toContain('energy_data_is_example');

    // A gas series (commodity 7) with a valid-looking interval block: the
    // parser refuses it, so the document yields no billable reading.
    await page.getByTestId('import-paste').fill(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">\n' +
        '<entry><link rel="self" href="/ReadingType/rt-gas"/><content><espi:ReadingType><espi:uom>72</espi:uom><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:accumulationBehaviour>4</espi:accumulationBehaviour><espi:commodity>7</espi:commodity><espi:flowDirection>1</espi:flowDirection><espi:kind>12</espi:kind></espi:ReadingType></content></entry>\n' +
        '<entry><link rel="self" href="/UsagePoint/up-gas/MeterReading/mr-1"/><link rel="related" href="/ReadingType/rt-gas"/><content><espi:MeterReading/></content></entry>\n' +
        '<entry><link rel="self" href="/UsagePoint/up-gas/MeterReading/mr-1/IntervalBlock/ib-1"/><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>1788523200</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1788523200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>\n' +
        '</feed>',
    );
    await page.getByTestId('import-load').click();
    await expect(page.getByTestId('import-error')).toBeVisible();

    expect(await snapshot(), 'a refused document moved persisted state').toBe(before);
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

/**
 * The BILL half of `/import` (t_05195060).
 *
 * The page used to parse with `parseGreenButtonUsagePoints` (groups only) and
 * commit readings alone, so `usage_summaries` was never written: the import
 * "worked", `isGasFeed()` stayed false, and every gas surface — bill period
 * card, money table, the plan-switcher hiding — stayed off. These tests walk
 * the same file through this page instead of the upload modal.
 */
test.describe('/import — the bill feed', () => {
  test('a gas export writes gas_usage_summaries and every gas surface renders', async ({ page }) => {
    test.setTimeout(180_000);
    await importFile(page, GAS_FIXTURE);

    // AC1: the bill half landed — under the commodity split (t_8a9038d6) the
    // gas UI reads ONLY the gas key space (`gas_usage_summaries` for bills,
    // `energy_gas_v2` for intervals). The electric keys are never addressed
    // by a gas import and are therefore ABSENT (null) on this fresh profile —
    // deliberately `null`, not `[]` / `{"points":[]}`: an electric key
    // holding an empty payload would mean THIS import wrote it. (Measured
    // post-import key set: exactly `energy_gas_v2`, `gas_usage_summaries`,
    // `oeo_commodity`.)
    const bills = await storedGasBills(page);
    expect(bills).toHaveLength(10);
    expect(await page.evaluate(() => localStorage.getItem('usage_summaries'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('energy_gas_v2'))).not.toBeNull();
    // Parse-time enrichment rode along with them: which IntervalBlock belongs
    // to which billing period is decided once, with the whole feed in hand,
    // and stored ON the summaries so the panel can say it after a reload.
    expect(bills.filter((b) => b._gasInterval)).toHaveLength(5);

    // The dashboard booted on summary-only storage: data, not an empty
    // profile (the R1 gate), and no crash on the way.
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // AC2: the surfaces render from what was just written.
    await page.getByTestId('tab-plans').click();
    await expect(page.getByTestId('tab-plans')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid="gas-period"]')).toHaveCount(10, { timeout: 30_000 });
    await expect(page.getByTestId('gas-amount-due').first()).toHaveText('$175.76');
    const states = await page.getByTestId('gas-interval-state').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-state')),
    );
    expect(states).toEqual([
      'present',
      'present',
      'present',
      'present',
      'stub',
      'absent',
      'absent',
      'absent',
      'absent',
      'absent',
    ]);

    // AC5: the designed behaviour is the switcher HIDDEN — it prices
    // electricity, and nothing on a gas feed uses it (Dashboard.tsx).
    await expect(page.locator('[data-testid="plan-switcher"]')).toHaveCount(0);

    await page.getByTestId('tab-money').click();
    await expect(page.getByTestId('gas-money-table')).toBeVisible();
    await expect(page.getByTestId('gas-money-row')).toHaveCount(10);

    // AC6: a reload brings it all back from the keys the boot path reads —
    // the GAS key space carries the dataset back, and the electric keys are
    // still untouched by a gas import (absent here, as before the reload).
    await page.reload();
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tab-plans').click();
    await expect(page.locator('[data-testid="gas-period"]')).toHaveCount(10, { timeout: 30_000 });
    expect(await storedGasBills(page)).toHaveLength(10);
    expect(await page.evaluate(() => localStorage.getItem('usage_summaries'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBeNull();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a feed that declares a clock lands local_time_parameters beside the bills', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importFile(page, ALLIANCE_FIXTURE);

    expect(await storedBills(page)).toHaveLength(1);
    // AC1, second key: the file's own clock rules travel with its bills.
    const clock = await storedClock(page);
    expect(clock?.tzOffset).toBe(-18000);
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
  });

  test('an electric-only file behaves exactly as before: billing-day fallback, no bill key', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await importFile(page, FIXTURE);

    // AC3: no summaries in the file ⇒ nothing is written under the bill keys
    // (and, under merge, nothing that IS there could be touched).
    expect(await page.evaluate(() => localStorage.getItem('usage_summaries'))).toBeNull();
    expect(await storedReadings(page)).toHaveLength(FIXTURE_READINGS);

    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
    // The axis falls back to the billing-day setting — the pre-bill
    // behaviour — and the chrome stays electric.
    await expect(
      page.locator('input[aria-label="Billing day of month"]'),
    ).toHaveAttribute('title', 'Which day of the month your utility bills you on');
    await expect(page.locator('[data-testid="plan-switcher"]')).toBeVisible();
    await expect(page.locator('[data-testid="gas-period"]')).toHaveCount(0);
  });

  test('merge keeps BOTH halves: the existing readings and the existing bills', async ({ page }) => {
    test.setTimeout(120_000);
    await seedStorage(page, SEED);
    await seedBills(page, BILL_STARTS);
    await page.goto('/import');
    await page.locator('[data-testid="import-file"]').setInputFiles(FIXTURE);

    const review = page.getByTestId('import-review');
    await expect(review).toBeVisible();
    // The review is a real gate: neither half has been written yet.
    expect(await storedReadings(page)).toHaveLength(2);
    expect(await storedBills(page)).toHaveLength(3);

    await page.getByTestId('import-merge').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });

    // AC4 (merge): readings unioned…
    expect(await storedReadings(page)).toHaveLength(70);
    // …and AC3: a file with NO summaries must not erase the bills already
    // stored. This is the contract guard — it holds before AND after the
    // fix (the defect was never writing the bill half at all, not clobbering
    // it); the sibling test below pins the half the fix DID change.
    expect(await storedBills(page)).toHaveLength(3);
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
  });

  test('merge folds the file’s own bills into the ones already stored', async ({ page }) => {
    test.setTimeout(120_000);
    await seedStorage(page, SEED);
    await seedBills(page, BILL_STARTS);
    await page.goto('/import');
    await page.locator('[data-testid="import-file"]').setInputFiles(ALLIANCE_FIXTURE);
    await expect(page.getByTestId('import-review')).toBeVisible();
    await page.getByTestId('import-merge').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });

    // AC4 (merge): both feeds survive — the 3 already stored plus the file's
    // own period (1388552400 = 2014-01-01), de-duplicated by start and
    // sorted, never replaced. Before the fix this page wrote no bill key at
    // all, so the stored 3 were all that ever came back.
    expect((await storedBills(page)).map((b) => b.start)).toEqual([1388552400, ...BILL_STARTS]);
    // …and the file's own clock lands beside them (AC1's second key).
    expect((await storedClock(page))?.tzOffset).toBe(-18000);
    expect(await storedReadings(page)).toHaveLength(SEED.length + 216);
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
  });

  test('replace is the path that swaps the bills — and only after the review screen', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await seedStorage(page, SEED);
    await seedBills(page, BILL_STARTS);
    await page.goto('/import');
    await page.locator('[data-testid="import-file"]').setInputFiles(FIXTURE);
    await expect(page.getByTestId('import-review')).toBeVisible();
    // Nothing swapped while the review is still on screen.
    expect(await storedBills(page)).toHaveLength(3);

    await page.getByTestId('import-replace').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });

    expect(await storedReadings(page)).toHaveLength(FIXTURE_READINGS);
    // AC4 (replace): the file parsed no bills, so the stored feed goes with
    // the readings it replaced — the panel becomes exactly what was reviewed.
    expect(await page.evaluate(() => localStorage.getItem('usage_summaries'))).toBeNull();
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
  });

  test('merging a gas export into an existing profile keeps readings AND bills', async ({ page }) => {
    // The path the owner actually walks: he already has an electric
    // dashboard (2 readings + 3 bills stored), then drops in a gas export.
    // That document has NO electric half, so under the commodity split there
    // is nothing on it to review — it commits straight through as a MERGE
    // and both stored halves must come back untouched.
    test.setTimeout(180_000);
    await seedStorage(page, SEED);
    await seedBills(page, BILL_STARTS);
    await page.goto('/import');
    // Byte-for-byte evidence for the electric half: captured after the
    // seeds, re-read after the commit.
    const electricReadings = await page.evaluate(() => localStorage.getItem('energy_data_v2'));
    const electricBills = await page.evaluate(() => localStorage.getItem('usage_summaries'));
    await page.locator('[data-testid="import-file"]').setInputFiles(GAS_FIXTURE);

    // Straight through, NO review screen (unit-pinned in import/page.test.tsx
    // — "a gas document meeting stored electric data" asserts no review and
    // a straight commit; `reviewOrImport()`: nothing to lose → straight
    // through, MERGE never replace — gated by QA t_7acaefd9 incl. E→G order
    // and security t_ba4a0dbc AC1 both orders byte-identical). Waiting for
    // `import-review` here was the stale pre-split flow: that gate only
    // exists for documents WITH an electric half, so the navigation to `/`
    // IS this test's no-review assertion.
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe('/');

    // BOTH halves survive — the test's real point.
    // Electric half: byte-identical to the seeded payload — 2 readings and
    // 3 bills, untouched by the gas write (AC1: a gas import never
    // addresses `energy_data_v2` / `usage_summaries`).
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBe(electricReadings);
    expect(await page.evaluate(() => localStorage.getItem('usage_summaries'))).toBe(electricBills);
    expect(await storedReadings(page)).toHaveLength(2);
    expect(await storedBills(page)).toHaveLength(BILL_STARTS.length);
    // Gas half: 10 periods landed beside them in the gas key space, 5
    // carrying their interval block (parse-time enrichment rode along).
    const gasBills = await storedGasBills(page);
    expect(gasBills).toHaveLength(10);
    expect(gasBills.filter((b) => b._gasInterval)).toHaveLength(5);

    // No review gate and no first-run modal over the merged profile.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('tab-nav')).toBeVisible({ timeout: 30_000 });
    // The gas half renders: the profile carries gas periods, so the app is
    // honest about it — the electricity plan switcher is gone (it renders
    // only when the Gas section is not selected, Dashboard.tsx) and the
    // plans tab shows the ten gas periods.
    await page.getByTestId('tab-plans').click();
    await expect(page.locator('[data-testid="gas-period"]')).toHaveCount(10, { timeout: 30_000 });
    await expect(page.locator('[data-testid="plan-switcher"]')).toHaveCount(0);
  });
});
