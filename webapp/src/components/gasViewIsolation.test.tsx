/**
 * AC2 regression (t_a775c2a3 — security gate t_ba4a0dbc F1): a browser that
 * holds BOTH commodities and sits on the Gas section must render NO electric
 * figure on ANY tab, in either shipped skin — and the Electricity section
 * must be exactly as electric as it was (its own controls present, no gas
 * figures).
 *
 * WHY THIS FILE EXISTS: QA's A11a scan walked Overview body text with a
 * `¢/kWh`-joined regex, so the toolbar floor ($/yr + kWh/day), the
 * best-choice chip (`Best: … -$8/mo`) and the Money tab's OEB banner,
 * accrual curve and true-bill estimate were structurally outside its window —
 * the gate's Playwright probe found them on every one of those surfaces at
 * d5ef71b. This test visits EVERY tab in BOTH skins — the quiet `/` route
 * (components/Dashboard) and the `/classic` route's own dashboard
 * (components/classic/Dashboard) — and sweeps the whole painted text plus the
 * electric surfaces' own test ids.
 *
 * TABS BY ROLE, NOT BY TESTID: the skins spell their strip differently
 * (`tab-analytics` on `/`, `tab-usage` on `/classic`, `classic-tab-*` in the
 * variant shell), so the click goes through `role=tab` + the visible label —
 * one spelling that cannot silently stop matching a surface.
 *
 * VACUITY GUARD: every sweep is anchored — the tab must be showing its OWN
 * panel (`gas-overview-panel`, `gas-analytics-panel` + the `gas-chart` it
 * contains, `tab-panel-plans`, `tab-panel-money`) and its gas content must
 * really be there (10 gas period cards, the gas money rows, the chart's
 * sr-only table with the stored m³ readings) — so a render that paints
 * nothing cannot pass the scan. The mirror test flips back to Electricity and requires the
 * electric controls (totals strip, best-choice chip, floor, true-bill
 * estimate) to be THERE, which is what proves the seeds loaded and the
 * needles had something to catch.
 *
 * FIXTURES: SYNTHETIC only (tests/fixtures/). Real localStorage, not a mock,
 * so the `extra_charges` write the true-bill prefill performs is observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Dashboard from './Dashboard';
import ClassicDashboard from './classic/Dashboard';
import ClassicPlanChip from './classic/ActivePlanChip';
import { parseGreenButtonFeed } from '@/lib/energy';
import { extractGasPoints } from '@/lib/commodity';
import {
  ENERGY_KEY_V2,
  ENERGY_GAS_KEY,
  GAS_SCHEMA_VERSION,
  BILLING_DAY_KEY,
} from '@/lib/storage';
import {
  USAGE_SUMMARIES_KEY,
  LOCAL_TIME_KEY,
  GAS_USAGE_SUMMARIES_KEY,
  GAS_LOCAL_TIME_KEY,
  COMMODITY_STORAGE_KEY,
  EXTRA_CHARGES_KEY,
} from '@/hooks/useDashboard';
import { TAB_STORAGE_KEY } from '@/lib/tabs';
import { setLocale } from '@/i18n';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);
const ELECTRIC_FEED = parseGreenButtonFeed(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-open-tail.xml'), 'utf8'),
);
const GAS_FEED = parseGreenButtonFeed(
  fs.readFileSync(path.join(FIXTURES, 'enbridge-gas-synthetic.xml'), 'utf8'),
);

const RATES = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    },
  ],
};

/* ------------------------------------------------------------------ *
 * What may never appear while the Gas section is selected
 * ------------------------------------------------------------------ */

/** [name, pattern] — every class the gate found under Gas at d5ef71b. */
const ELECTRIC_FIGURES: ReadonlyArray<readonly [string, RegExp]> = [
  ['toolbar always-on floor (kWh/day + $/yr)', /\balways-on floor\b|kwh\/day|\/yr\b/i],
  ['best-choice chip verdict', /\bbest:/i],
  ['electric rate pricing (¢/$ per kWh)', /\/\s*kWh|per kWh/i],
  ['OEB electricity-rate banner', /ontario electricity rates have changed|sample impact/i],
  ['true-bill estimate + add-ons', /estimate · |your estimate|true bill/i],
  ['plan priced as an option', /\bTiered\b|Time-of-Use|\bULO\b/i],
  ['EV scenario', /ev charg/i],
  ['plan-gap verdict prose', /winning economic plan|per month less than/i],
];

/** Electric-only surfaces, by their own test ids. */
const ELECTRIC_TESTIDS = [
  'best-choice-chip',
  'plan-switcher',
  'active-plan-chip',
  'totals-strip',
  'best-choice-banner',
  'money-rate-alert',
  'money-pace-slot',
  'money-true-bill-slot',
  'money-ev-slot',
  'bill-estimate',
  'variable-estimate',
  'charge-delivery-per-kwh',
] as const;

/** What the GAS section must keep showing (the vacuity guard). */
const GAS_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['gas amounts from the bill', /175\.76|72\.47/],
  ['volumes in m³', /m³/i],
];

/** What must never appear on the ELECTRICITY section (the mirror direction). */
const GAS_FIGURES: ReadonlyArray<readonly [string, RegExp]> = [
  ['gas volumes priced as data', /\d[\d.,]*\s*m³/i],
  ['gas bill amounts', /175\.76|72\.47|153\.06/],
  ['gas refusal phrasing', /price gas|natural-gas bill/i],
];

type TabSpec = { label: string; panel: string; anchor?: string };

const QUIET_GAS_TABS: readonly TabSpec[] = [
  { label: 'Overview', panel: 'gas-overview-panel' },
  { label: 'Analytics', panel: 'gas-analytics-panel', anchor: 'gas-chart' },
  { label: 'Plans', panel: 'tab-panel-plans', anchor: 'gas-amount-due' },
  { label: 'Money', panel: 'tab-panel-money', anchor: 'gas-money-row' },
];

const CLASSIC_GAS_TABS: readonly TabSpec[] = [
  { label: 'Overview', panel: 'gas-overview-panel' },
  { label: 'Usage', panel: 'gas-analytics-panel', anchor: 'gas-chart' },
  { label: 'Plans', panel: 'tab-panel-plans', anchor: 'gas-amount-due' },
  { label: 'Money', panel: 'tab-panel-money', anchor: 'gas-money-row' },
];

const QUIET_ELEC_TABS: readonly TabSpec[] = [
  { label: 'Overview', panel: 'tab-panel-overview' },
  { label: 'Analytics', panel: 'tab-panel-analytics' },
  { label: 'Plans', panel: 'tab-panel-plans' },
  { label: 'Money', panel: 'tab-panel-money', anchor: 'bill-estimate' },
];

const CLASSIC_ELEC_TABS: readonly TabSpec[] = [
  { label: 'Overview', panel: 'tab-panel-overview' },
  { label: 'Usage', panel: 'tab-panel-usage' },
  { label: 'Plans', panel: 'tab-panel-plans' },
  { label: 'Money', panel: 'tab-panel-money', anchor: 'bill-estimate' },
];

/* ------------------------------------------------------------------ *
 * Seed: BOTH commodities in one browser (the dual-upload state)
 * ------------------------------------------------------------------ */

function seed(commodity: 'gas' | 'electricity'): void {
  localStorage.clear();
  localStorage.setItem(
    ENERGY_KEY_V2,
    JSON.stringify({
      version: 2,
      uploadedAt: '2026-01-01T00:00:00Z',
      source: 'usage-summary-open-tail.xml',
      points: ELECTRIC_FEED.groups.flatMap((g) => g.readings),
    }),
  );
  localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(ELECTRIC_FEED.summaries));
  if (ELECTRIC_FEED.localTime) {
    localStorage.setItem(LOCAL_TIME_KEY, JSON.stringify(ELECTRIC_FEED.localTime));
  }
  localStorage.setItem(
    ENERGY_GAS_KEY,
    JSON.stringify({
      version: GAS_SCHEMA_VERSION,
      uploadedAt: '2026-01-01T00:00:00Z',
      source: 'enbridge-gas-synthetic.xml',
      points: extractGasPoints(GAS_FEED.groups),
    }),
  );
  localStorage.setItem(GAS_USAGE_SUMMARIES_KEY, JSON.stringify(GAS_FEED.summaries));
  if (GAS_FEED.localTime) {
    localStorage.setItem(GAS_LOCAL_TIME_KEY, JSON.stringify(GAS_FEED.localTime));
  }
  localStorage.setItem(BILLING_DAY_KEY, '1');
  localStorage.setItem(COMMODITY_STORAGE_KEY, commodity);
  localStorage.setItem(TAB_STORAGE_KEY, 'overview');
  localStorage.setItem('oeo_locale', 'en');
}

/** The dashboard finished loading — never sweep a skeleton. */
async function ready(probe: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (
      document.querySelector(`[data-testid="${probe}"]`) &&
      !document.querySelector('[data-testid="upload-modal"]') &&
      !document.querySelector('[data-testid="preparing-optimizer"]')
    ) {
      return;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`the dashboard never painted (${probe}) — the scan would be vacuous`);
}

/**
 * Click a tab by its VISIBLE label and require its OWN panel to be on screen
 * before anything is asserted about it. A missing anchor fails the test
 * rather than letting an empty tab scan clean.
 */
async function openTab(
  user: ReturnType<typeof userEvent.setup>,
  spec: TabSpec,
): Promise<void> {
  await user.click(screen.getByRole('tab', { name: spec.label }));
  await waitFor(
    () => {
      expect(
        document.querySelector(`[data-testid="${spec.panel}"]`),
        `${spec.label} did not paint its panel ${spec.panel}`,
      ).not.toBeNull();
      if (spec.anchor) {
        expect(
          document.querySelector(`[data-testid="${spec.anchor}"]`),
          `${spec.label} painted ${spec.panel} without ${spec.anchor}`,
        ).not.toBeNull();
      }
    },
    { timeout: 8000 },
  );
}

/** Sweep whatever is painted now. Returns every violation, for one message. */
function sweepElectric(
  label: string,
  figures: ReadonlyArray<readonly [string, RegExp]>,
  testids: ReadonlyArray<string> = [],
): string[] {
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const [name, re] of figures) {
    const m = text.match(re);
    if (m) {
      const at = m.index ?? 0;
      hits.push(
        `${label}: [${name}] ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 60))}`,
      );
    }
  }
  for (const id of testids) {
    if (document.querySelector(`[data-testid="${id}"]`)) {
      hits.push(`${label}: electric surface rendered (#${id})`);
    }
  }
  return hits;
}

function sweepGas(label: string): string[] {
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const [name, re] of GAS_FIGURES) {
    const m = text.match(re);
    if (m) hits.push(`${label}: [${name}] ${JSON.stringify(m[0])}`);
  }
  return hits;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(RATES) }),
  );
  setLocale('en');
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

/* ================================================================== *
 * The Gas section, every tab, both shipped skins
 * ================================================================== */

describe('Gas section carries no electric figure on any tab (AC2 / t_a775c2a3)', () => {
  async function scanGasEveryTab(tabs: readonly TabSpec[]): Promise<void> {
    const user = userEvent.setup();
    const failures: string[] = [];

    for (const spec of tabs) {
      await openTab(user, spec);
      failures.push(...sweepElectric(spec.label, ELECTRIC_FIGURES, ELECTRIC_TESTIDS));
    }

    // Vacuity guards: the section really is showing gas on its own tabs.
    await openTab(user, tabs[0]);
    const gasText = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    for (const [name, re] of GAS_MARKERS) {
      expect(gasText, `Gas Overview must keep its own ${name}`).toMatch(re);
    }

    // …and the Analytics tab really painted the CHART (t_78f788b3): its
    // sr-only table must carry the stored readings — 427 is the fixture's
    // first interval volume — so the sweep above cannot have passed over an
    // empty chart frame.
    const analytics = tabs.find((s) => s.panel === 'gas-analytics-panel');
    if (analytics) {
      await openTab(user, analytics);
      const table = document.querySelector('[data-testid="gas-chart-data-table"]');
      expect(table, 'gas Analytics must paint its sr-only chart table').not.toBeNull();
      expect(table?.textContent ?? '').toMatch(/427/);
    }

    // The true-bill prefill is a WRITE to extra_charges (a gas bill fitted
    // against electric rows) — a gas visit must not touch it.
    expect(localStorage.getItem(EXTRA_CHARGES_KEY)).toBeNull();

    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
  }

  it('quiet route (/): Overview, Analytics, Plans, Money — clean on all four', async () => {
    seed('gas');
    render(<Dashboard />);
    await ready('dashboard-toolbar');
    await scanGasEveryTab(QUIET_GAS_TABS);
  }, 60_000);

  it('classic route (/classic): Overview, Usage, Plans, Money — clean on all four', async () => {
    seed('gas');
    render(<ClassicDashboard />);
    await ready('tab-nav');
    await scanGasEveryTab(CLASSIC_GAS_TABS);
  }, 60_000);
});

/* ================================================================== *
 * The mirror: Electricity unchanged, still gas-free
 * ================================================================== */

describe('Electricity section unchanged (and still free of gas figures)', () => {
  async function expectElectricSurface(
    tabs: readonly TabSpec[],
    /** The quiet MoneyPanel wraps its cards in slots; the classic one does not. */
    paceSlot: string | null,
  ): Promise<void> {
    const user = userEvent.setup();

    // Controls that only exist when the electric dataset is live — their
    // ABSENCE under Gas is what the first block proves, so they must be
    // present here or that absence means nothing.
    expect(document.querySelector('[data-testid="totals-strip"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="best-choice-chip"]')).not.toBeNull();
    expect(document.body.textContent ?? '').toMatch(/always-on floor/i);

    const failures: string[] = [];
    for (const spec of tabs) {
      await openTab(user, spec);
      failures.push(...sweepGas(spec.label));
    }
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);

    // And the electric money surface still mounts its electric cards.
    await openTab(user, tabs[tabs.length - 1]);
    if (paceSlot) {
      expect(document.querySelector(`[data-testid="${paceSlot}"]`)).not.toBeNull();
    }
    expect(document.querySelector('[data-testid="bill-estimate"]')).not.toBeNull();
  }

  it('quiet route (/): controls present; no gas figures on any tab', async () => {
    seed('electricity');
    render(<Dashboard />);
    await ready('dashboard-toolbar');
    await expectElectricSurface(QUIET_ELEC_TABS, 'money-pace-slot');
  }, 60_000);

  it('classic route (/classic): controls present; no gas figures on any tab', async () => {
    seed('electricity');
    render(<ClassicDashboard />);
    await ready('tab-nav');
    await expectElectricSurface(CLASSIC_ELEC_TABS, null);
  }, 60_000);
});

/* ================================================================== *
 * Switching INTO Gas at runtime (the user's own path)
 * ================================================================== */

describe('flipping the commodity switcher', () => {
  it('quiet: Gas removes the electric chrome the Electricity tab shows', async () => {
    seed('electricity');
    const user = userEvent.setup();
    render(<Dashboard />);
    await ready('dashboard-toolbar');

    expect(document.querySelector('[data-testid="best-choice-chip"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="plan-switcher"]')).not.toBeNull();

    await user.click(screen.getByTestId('commodity-gas'));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="gas-overview-panel"]')).not.toBeNull();
    });
    await openTab(user, QUIET_GAS_TABS[0]);

    const failures = sweepElectric('after flip to Gas', ELECTRIC_FIGURES, ELECTRIC_TESTIDS);
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
    expect(document.querySelector('[data-testid="best-choice-chip"]')).toBeNull();
    expect(document.querySelector('[data-testid="plan-switcher"]')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/always-on floor/i);
  }, 60_000);

  it('classic: Gas removes the electric chrome the Electricity tab shows', async () => {
    seed('electricity');
    const user = userEvent.setup();
    render(<ClassicDashboard />);
    await ready('tab-nav');

    expect(document.querySelector('[data-testid="best-choice-chip"]')).not.toBeNull();

    await user.click(screen.getByTestId('commodity-gas'));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="gas-overview-panel"]')).not.toBeNull();
    });
    await openTab(user, CLASSIC_GAS_TABS[0]);

    const failures = sweepElectric('classic after flip', ELECTRIC_FIGURES, ELECTRIC_TESTIDS);
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
    expect(document.body.textContent ?? '').not.toMatch(/always-on floor/i);
  }, 60_000);
});

/* ================================================================== *
 * Chrome ABOVE the dashboard: the classic header's active-plan chip
 * ================================================================== */

describe('header chrome follows the section (active-plan chip)', () => {
  it('boots hidden when the stored section is Gas', () => {
    seed('gas');
    render(<ClassicPlanChip />);
    expect(document.querySelector('[data-testid="active-plan-chip"]')).toBeNull();
  });

  it('follows the switcher with the dashboard beside it: Gas drops it, Electricity brings it back', async () => {
    seed('electricity');
    const user = userEvent.setup();
    render(
      <>
        <ClassicPlanChip />
        <ClassicDashboard />
      </>,
    );
    await ready('tab-nav');
    expect(document.querySelector('[data-testid="active-plan-chip"]')).not.toBeNull();

    await user.click(screen.getByTestId('commodity-gas'));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="active-plan-chip"]')).toBeNull();
    });

    await user.click(screen.getByTestId('commodity-electricity'));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="active-plan-chip"]')).not.toBeNull();
    });
  }, 60_000);
});
