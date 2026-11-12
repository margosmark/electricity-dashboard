/**
 * `/import` — what a REFUSED file leaves behind.
 *
 * The page is the one place a user's whole history is overwritten, so "the
 * refusal is honest" is only half the contract: a document the app will not
 * parse must leave every key it owns exactly as it found them (t_2961ce14).
 * That is asserted here through the REAL page — the real parser, the real
 * storage module, the real localStorage — because a no-write guarantee proven
 * on a stub proves nothing about the app.
 *
 * The last test is the CONTROL: the same harness proves it can SEE a write, so
 * "nothing was written" cannot pass merely because the harness never writes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ImportPage from './page';
import { ENERGY_KEY_V2, ENERGY_GAS_KEY, LEGACY_ENERGY_KEY, saveEnergyData, saveGasData } from '@/lib/storage';
import { EXAMPLE_DATA_KEY, USAGE_SUMMARIES_KEY, GAS_USAGE_SUMMARIES_KEY } from '@/hooks/useDashboard';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push }),
}));

/** Every key the app is allowed to touch, plus the bills key. */
const OWNED = [ENERGY_KEY_V2, LEGACY_ENERGY_KEY, USAGE_SUMMARIES_KEY, 'billing_day', EXAMPLE_DATA_KEY];

/** The WHOLE localStorage, so "nothing was written" is checked literally. */
function snapshot(): string {
  return JSON.stringify(
    Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .sort()
      .map((k) => [k, k === null ? null : localStorage.getItem(k)]),
  );
}

function stored(key: string): string | null {
  return localStorage.getItem(key);
}

/** Paste a payload and press the page's own "Parse and import". */
async function pasteAndImport(text: string, ms = 30_000): Promise<number> {
  const user = userEvent.setup();
  const started = Date.now();
  fireEvent.change(screen.getByTestId('import-paste'), { target: { value: text } });
  await user.click(screen.getByTestId('import-load'));
  await waitFor(() => expect(screen.queryByTestId('import-error')).toBeInTheDocument(), {
    timeout: ms,
  });
  return Date.now() - started;
}

const FEED = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${body}</feed>`;

const READING =
  '<entry><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>1704067200</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>';

const SUMMARY = (fields: string) =>
  `<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>1704067200</espi:start><espi:duration>2678400</espi:duration></espi:billingPeriod>${fields}</espi:UsageSummary></content></entry>`;

describe('/import refuses a hostile document and writes nothing', () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockClear();
  });

  it('a 33 MB payload is refused on its size with the storage untouched', async () => {
    const huge = FEED(`<entry><content><x>${'A'.repeat(33 * 1024 * 1024)}</x></content></entry>`);
    const before = snapshot();
    const user = userEvent.setup();
    render(<ImportPage />);

    const started = Date.now();
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: huge } });
    await user.click(screen.getByTestId('import-load'));
    await waitFor(() => expect(screen.queryByTestId('import-error')).toBeInTheDocument(), {
      timeout: 60_000,
    });
    const elapsed = Date.now() - started;

    // The reason is the SIZE, not "could not read this file".
    expect(screen.getByTestId('import-error')).toHaveTextContent(/beyond the 32 MB/);
    expect(elapsed).toBeLessThan(20_000);
    expect(snapshot()).toBe(before);
    for (const key of OWNED) expect(stored(key), key).toBeNull();
  }, 120_000);

  it('a nesting bomb is refused with the app\'s own sentence, nothing written', async () => {
    const bomb = `<r>${'<a>'.repeat(1000)}${'</a>'.repeat(1000)}</r>`;
    const before = snapshot();
    render(<ImportPage />);
    await pasteAndImport(bomb);

    expect(screen.getByTestId('import-error')).toHaveTextContent(/nests XML elements/);
    expect(screen.getByTestId('import-error')).not.toHaveTextContent(/Maximum nested tags/);
    expect(snapshot()).toBe(before);
  });

  it('a bill figure no bill can hold refuses the file before anything is stored', async () => {
    // Readings AND a poisoned bill in one file: the readings are importable on
    // their own, so this is exactly the case where a partial write would be
    // tempting — and it is the case that must write nothing.
    const xml = FEED(
      READING +
        SUMMARY(
          '<espi:billLastPeriod>1e308</espi:billLastPeriod><espi:costAdditionalDetailLastPeriod><espi:note>Delivery</espi:note><espi:amount>1e308</espi:amount></espi:costAdditionalDetailLastPeriod>',
        ),
    );
    const before = snapshot();
    render(<ImportPage />);
    await pasteAndImport(xml);

    const box = screen.getByTestId('import-error');
    expect(box).toHaveTextContent(/bill figures cannot be trusted/);
    expect(box).toHaveTextContent(/no bill can hold/);
    expect(box).toHaveTextContent(/Nothing from this file was imported/);
    // The poisoned bill never reaches the key the bills land in…
    expect(stored(USAGE_SUMMARIES_KEY)).toBeNull();
    // …and the readings beside it are not persisted either: the file was
    // refused as a whole, so there is no half-import to explain later.
    expect(snapshot()).toBe(before);
    expect(push).not.toHaveBeenCalled();
  });

  it('CONTROL: the same page and harness do write a legitimate export', async () => {
    // Without this, "nothing was written" could pass on a page that can never
    // write at all — and with an impossible clock beside real readings, the
    // file still imports: the clock is metadata, not the data.
    const xml = FEED(
      '<entry><content><espi:LocalTimeParameters><espi:tzOffset>1e308</espi:tzOffset></espi:LocalTimeParameters></content></entry>' +
        READING,
    );
    const user = userEvent.setup();
    render(<ImportPage />);

    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: xml } });
    await user.click(screen.getByTestId('import-load'));

    await waitFor(() => expect(stored(ENERGY_KEY_V2)).not.toBeNull());
    const payload = JSON.parse(stored(ENERGY_KEY_V2)!) as {
      points: { timestamp: number; usage_kwh: number }[];
    };
    expect(payload.points).toEqual([{ timestamp: 1704067200, usage_kwh: 1.5 }]);
    expect(push).toHaveBeenCalledWith('/');
    // The example-data flag is the one key a successful import clears.
    expect(stored(EXAMPLE_DATA_KEY)).toBeNull();
    expect(stored(USAGE_SUMMARIES_KEY)).toBeNull();
  }, 60_000);
});

/* ==========================================================================
 * Commodity isolation (t_8a9038d6): a gas document reaches the gas keys —
 * through the REAL page, the REAL parser, the REAL localStorage.
 * ========================================================================== */

const GAS_XML = readFileSync(
  join(__dirname, '../../../tests/fixtures/enbridge-gas-synthetic.xml'),
  'utf8',
);

/** Paste a payload and press the page's own "Parse and import". */
async function importPayload(text: string): Promise<void> {
  const user = userEvent.setup();
  fireEvent.change(screen.getByTestId('import-paste'), { target: { value: text } });
  await user.click(screen.getByTestId('import-load'));
}

describe('/import routes gas documents to the gas keys', () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockClear();
  });

  it('a gas document lands in the gas keys and never touches the electric keys', async () => {
    render(<ImportPage />);
    await importPayload(GAS_XML);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'), { timeout: 30_000 });

    // The gas half: intervals + bill periods, under their OWN keys.
    const gas = localStorage.getItem(ENERGY_GAS_KEY);
    expect(gas).not.toBeNull();
    expect(JSON.parse(gas as string).points).toHaveLength(5);
    expect(JSON.parse(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY) as string)).toHaveLength(10);

    // The electric keys are not addressed by a gas import at all — that is
    // what keeps both imports alive in one browser, in either order.
    expect(localStorage.getItem(ENERGY_KEY_V2)).toBeNull();
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBeNull();

    // The dashboard will open on the section this import filled.
    expect(localStorage.getItem('oeo_commodity')).toBe('gas');
  }, 60_000);

  it('a gas document leaves an existing electric dataset untouched', async () => {
    expect(
      saveEnergyData([{ timestamp: 1704067200, usage_kwh: 1.5 }], { source: 'seed' }).ok,
    ).toBe(true);

    render(<ImportPage />);
    await importPayload(GAS_XML);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'), { timeout: 30_000 });

    // Electric rows byte-for-byte as seeded…
    const elec = JSON.parse(localStorage.getItem(ENERGY_KEY_V2) as string) as {
      points: { timestamp: number; usage_kwh: number }[];
    };
    expect(elec.points).toEqual([{ timestamp: 1704067200, usage_kwh: 1.5 }]);
    // …and the gas half landed beside them.
    expect(JSON.parse(localStorage.getItem(ENERGY_GAS_KEY) as string).points).toHaveLength(5);
    expect(JSON.parse(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY) as string)).toHaveLength(10);
  }, 60_000);

  it('a gas document meeting stored gas data asks before writing anything', async () => {
    expect(
      saveGasData([{ timestamp: 1_700_000_000, duration_s: null, volume_m3: 9 }], {
        source: 'seed',
      }).ok,
    ).toBe(true);
    const before = snapshot();

    render(<ImportPage />);
    await importPayload(GAS_XML);

    // The review appears instead of a silent overwrite…
    await waitFor(() =>
      expect(screen.getByTestId('gas-import-review')).toBeInTheDocument(),
      { timeout: 30_000 },
    );
    expect(screen.getByTestId('gas-detected')).toHaveTextContent(/natural gas/i);
    // …and NOTHING was written while it is on screen.
    expect(snapshot()).toBe(before);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('gas-import-merge'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'), { timeout: 30_000 });

    // Merge keeps the seeded interval and adds the file's five.
    const points = JSON.parse(localStorage.getItem(ENERGY_GAS_KEY) as string).points as {
      timestamp: number;
      volume_m3: number;
    }[];
    expect(points).toHaveLength(6);
    expect(points.some((g) => g.volume_m3 === 9)).toBe(true);
    // The electric keys are still not in play.
    expect(localStorage.getItem(ENERGY_KEY_V2)).toBeNull();
  }, 60_000);

  it('Replace takes the file\'s gas dataset alone (the choice the review named)', async () => {
    expect(
      saveGasData([{ timestamp: 1_700_000_000, duration_s: null, volume_m3: 9 }], {
        source: 'seed',
      }).ok,
    ).toBe(true);

    render(<ImportPage />);
    await importPayload(GAS_XML);
    await waitFor(() =>
      expect(screen.getByTestId('gas-import-review')).toBeInTheDocument(),
      { timeout: 30_000 },
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId('gas-import-replace'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'), { timeout: 30_000 });

    const points = JSON.parse(localStorage.getItem(ENERGY_GAS_KEY) as string).points as {
      volume_m3: number;
    }[];
    expect(points).toHaveLength(5);
    expect(points.some((g) => g.volume_m3 === 9)).toBe(false);
  }, 60_000);
});
