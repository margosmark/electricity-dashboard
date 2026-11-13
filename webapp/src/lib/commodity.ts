/**
 * Commodity isolation (t_8a9038d6) — one document in, two honest buckets out.
 *
 * A Green Button / ESPI document can carry electricity, natural gas, or both.
 * The dashboard prices `DataPoint.usage_kwh` as electricity everywhere, so
 * the ONE thing that must never happen is a cubic metre landing in that
 * stream. This module is the single place that decides what a parsed feed
 * contains, and it answers with two disjoint shapes rather than a flag:
 *
 *   - `electric` — `DataPoint[]` (`usage_kwh`), for `energy_data_v2`
 *   - `gas`      — `GasPoint[]`  (`volume_m3`), for `energy_gas_v2`
 *
 * Neither type can be built from the other (storage.ts enforces both with
 * `isDataPoint` / `isGasPoint`), so "gas priced as electricity" is not a
 * branch anyone can write — it is unrepresentable.
 *
 * Rules (covered by commodity.test.ts):
 *  - Classification is by DATA, not by a document-level label: a feed that
 *    carries both commodities fills both buckets, and a feed that carries
 *    only one never produces an empty write for the other (an empty write
 *    is how the electric dataset used to get wiped by a gas upload).
 *  - `isGasSummary` — not `volume != null` — decides which bucket a billing
 *    period belongs to. The electric fixture's summaries carry a `volume`
 *    field too; only uom 42 / the Enbridge note markers mean gas.
 *  - Nothing is dropped. Rows that belong to a commodity with no data of
 *    its own simply do not create a bucket.
 */

import type { DataPoint, GreenButtonFeed, UsagePointGroup, UsageSummary } from './energy';
import { isGasFeed, isGasSummary } from './gasBillUi';
import type { GasPoint } from './storage';

export type Commodity = 'electricity' | 'gas';

/** A parsed document, split into the two buckets each commodity persists. */
export type FeedSplit = {
  /** Electric intervals across every group — `usage_kwh`, never m³. */
  electric: DataPoint[];
  /** Gas intervals across every group — `volume_m3`, never kWh. */
  gas: GasPoint[];
  /** Billing periods that describe an electricity bill. */
  electricSummaries: UsageSummary[];
  /** Billing periods that describe a gas bill. */
  gasSummaries: UsageSummary[];
};

/** Which buckets a document actually carries data for. */
export type CommodityPresence = {
  electricity: boolean;
  gas: boolean;
  /** Neither — nothing about this document is importable. */
  none: boolean;
};

/**
 * Every gas interval in the document, in document order.
 *
 * Only `status === 'volume'` series carry `m3`, and the parser guarantees a
 * volume series reading has one (a reading that would not scale is dropped
 * and counted there instead). A reading without `m3` is skipped rather than
 * defaulted to 0 — inventing a zero-volume interval would understate the
 * bill.
 */
export function extractGasPoints(groups: readonly UsagePointGroup[]): GasPoint[] {
  const out: GasPoint[] = [];
  for (const group of groups) {
    for (const series of group.series ?? []) {
      if (series.status !== 'volume') continue;
      for (const r of series.readings) {
        if (r.m3 === undefined || !Number.isFinite(r.m3)) continue;
        out.push({ timestamp: r.timestamp, duration_s: r.duration_s, volume_m3: r.m3 });
      }
    }
  }
  return out;
}

/**
 * Every electricity interval in the document.
 *
 * `group.readings` is the priced stream only — volume series never reach it
 * (series.ts keeps them on their own list), so this cannot contain m³.
 */
export function extractElectricPoints(groups: readonly UsagePointGroup[]): DataPoint[] {
  const out: DataPoint[] = [];
  for (const group of groups) {
    for (const p of group.readings) out.push(p);
  }
  return out;
}

/** Partition billing periods: gas periods left, electricity periods right. */
export function splitSummaries(summaries: readonly UsageSummary[]): {
  electric: UsageSummary[];
  gas: UsageSummary[];
} {
  const electric: UsageSummary[] = [];
  const gas: UsageSummary[] = [];
  for (const s of summaries) (isGasSummary(s) ? gas : electric).push(s);
  return { electric, gas };
}

/**
 * Split a parsed feed. `summaries` defaults to the feed's own, so callers
 * that already enriched the gas surfaces (`enrichGasSummaries`) pass them
 * through unchanged.
 */
export function splitFeed(feed: Pick<GreenButtonFeed, 'groups' | 'summaries'>): FeedSplit {
  const { electric, gas } = splitSummaries(feed.summaries);
  return {
    electric: extractElectricPoints(feed.groups),
    gas: extractGasPoints(feed.groups),
    electricSummaries: electric,
    gasSummaries: gas,
  };
}

/**
 * What a document carries, for routing an upload.
 *
 * `none` is the honest refusal: a file that parses but yields neither kind
 * of row must say so instead of committing an empty dataset to whichever
 * bucket happens to be checked first.
 */
export function commodityPresence(split: FeedSplit): CommodityPresence {
  const electricity = split.electric.length > 0 || split.electricSummaries.length > 0;
  const gas = split.gas.length > 0 || split.gasSummaries.length > 0;
  return { electricity, gas, none: !electricity && !gas };
}

/**
 * The commodity an upload should open on.
 *
 * A document that carries both is not ambiguous — it just has a primary
 * half, and gas wins the tie because a mixed feed that leads with volume is
 * the Enbridge shape users complained about. Callers use this only to pick
 * which section to show; the data itself always lands in BOTH buckets it
 * qualifies for.
 */
export function primaryCommodity(split: FeedSplit): Commodity | null {
  const presence = commodityPresence(split);
  if (presence.none) return null;
  if (presence.gas && !presence.electricity) return 'gas';
  if (presence.electricity && !presence.gas) return 'electricity';
  return isGasFeed(split.gasSummaries) || split.gas.length >= split.electric.length ? 'gas' : 'electricity';
}

/**
 * Same-commodity update: a fresh upload of one commodity replaces that
 * bucket's intervals (union when the caller says so, e.g. a live sync).
 *
 * Timestamps are only ever compared WITHIN a bucket — an electricity
 * timestamp equal to a gas timestamp is two different measurements of two
 * different quantities, so the two lists never see each other's keys.
 */
export function unionGasPoints(base: readonly GasPoint[], incoming: readonly GasPoint[]): GasPoint[] {
  const byTs = new Map<number, GasPoint>();
  for (const p of base) byTs.set(p.timestamp, p);
  for (const p of incoming) byTs.set(p.timestamp, p);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Sort gas intervals ascending — the order `energy_gas_v2` is documented to hold. */
export function sortGasPoints(points: readonly GasPoint[]): GasPoint[] {
  return [...points].sort((a, b) => a.timestamp - b.timestamp);
}
