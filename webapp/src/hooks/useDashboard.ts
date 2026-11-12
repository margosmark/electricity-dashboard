/**
 * Ontario Energy Optimizer — component hooks.
 *
 * All interactive Dashboard state lives here so Dashboard.tsx stays a thin
 * render shell. Pure math remains in lib/energy.ts (tested separately);
 * these hooks only own localStorage, fetch, and state coordination.
 */

"use client";

/* Wave U — upload/connect copy translates; hooks read the module locale. */
import { t, useTranslation } from "@/i18n";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useSyncExternalStore, ChangeEvent } from "react";
import { format, addMonths, subMonths, addDays, startOfMonth, lastDayOfMonth } from "date-fns";
import {
  type DataPoint, type RateSet, type UsagePointGroup,
  type UsageSummary, type LocalTimeParams, type GreenButtonFeed,
  type ExtraCharges, type ExtraChargeField, type ExtraChargesSource,
  getBillingPeriod, parseGreenButtonFeed, selectInitialWindow,
  MIN_WINDOW_COVERAGE,
  EMPTY_EXTRA_CHARGES, EXTRA_CHARGE_FIELDS, chargesArePristine,
} from "@/lib/energy";
// Commodity 7: gas enrichment rides the summaries themselves (interval block
// per period + supplier label) so backup/restore needs no second channel.
import { enrichGasSummaries, isGasFeed, isGasSummary } from "@/lib/gasBillUi";
// The billing axis — the file's OWN periods as the view's timeline (this
// wave's whole idea), with billing_day as the fallback when it has none.
import { buildBillingAxis, dateWindowOf, periodAt, stepPeriod, type BillingAxis } from "@/lib/billingAxis";
// Wave J owns the merge arithmetic; live sync must not be a second opinion
// about what a union means (union, incoming wins — see importPlan.ts).
import { mergeForWrite, planImport } from "@/lib/importPlan";
import {
  fetchGbStatus, fetchGbUsage, disconnectGb, describeGbError,
  type GbStatus,
} from "@/lib/greenbutton/client";
// The ingestion's own refusals, in the shape the notice renders verbatim
// (t_880370e6 — presentation only; nothing here changes what was priced).
import type { SeriesNote } from "@/lib/greenbutton/series";
// A document-level refusal names the number it judged (greenbutton/limits.ts),
// so its sentence is shown as-is instead of a generic "unparseable".
import { isGreenButtonRefusal } from "@/lib/greenbutton/limits";
import {
  buildBackupDocument, serializeBackup, parseBackup, backupFilename, storageValuesFromBackup,
  EXAMPLE_DATA_KEY,
} from "@/lib/backup";
// Durable storage (t_a8a54e33): versioned `energy_data_v2` + legacy-key
// migration, quota failures surfaced instead of swallowed, and a reset that
// removes THIS app's keys only. Every energy_data / billing_day read and
// write in src goes through this module — nothing else touches those keys.
import {
  type StorageResult,
  loadEnergyData, saveEnergyData, clearEnergyData,
  loadGasData, saveGasData,
  type GasPoint,
  loadBillingDay, saveBillingDay,
  parseImport, resetStoredData, listOurStoredKeys, writeStoredKey,
} from "@/lib/storage";
// Commodity isolation (t_8a9038d6): one parsed feed → two disjoint buckets.
// The split lives in lib/commodity.ts so /import and this hook cannot
// disagree about what a gas document is.
import {
  type Commodity,
  commodityPresence, extractGasPoints, primaryCommodity, sortGasPoints,
  splitFeed, splitSummaries, unionGasPoints,
} from "@/lib/commodity";
// Wave P — the plan timeline travels with the backup, next to billing_day.
import { readStoredTimeline } from "@/hooks/usePlanTimeline";
import { PLAN_TIMELINE_KEY } from "@/lib/planTimeline";
import { PLAN_STORAGE_KEY, readStoredPlan } from "@/hooks/useSelectedPlan";
import { TAB_STORAGE_KEY } from "@/lib/tabs";
import { ESTIMATE_LEDGER_KEY } from "@/lib/estimateLedger";
import { diagnoseGreenButtonDocument, type ParseDiagnostic } from "@/lib/parseDiagnostic";
import { loadExampleReadings } from "@/lib/exampleData";
// Wave M — one gated entry point for every background refresh, plus the
// page⇄service-worker names that public/sw.js mirrors (asserted by a test).
import {
  backgroundRefreshMinMs, shouldBackgroundRefresh,
  GB_CURSOR_CACHE, GB_CURSOR_URL, GB_STAGED_CACHE, GB_STAGED_URL, GB_STAGED_MESSAGE,
  // Wave M's persisted facts — named constants, listed by the scoped reset.
  PLAN_ACK_KEY, RATE_ACK_KEY, NOTIFIED_KEY, NOTIFICATIONS_ENABLED_KEY,
  type RefreshTrigger,
} from "@/lib/backgroundRefresh";
import {
  registerGreenButtonPeriodicSync, unregisterGreenButtonPeriodicSync,
  type BackgroundSyncState,
} from "@/lib/periodicSync";

/** Narrow a rejected FileReader promise back to a rendered failure diagnostic. */
function isParseDiagnostic(value: unknown): value is Extract<ParseDiagnostic, { ok: false }> {
  return !!value && typeof value === "object" && typeof (value as { headline?: unknown }).headline === "string";
}

/**
 * Set while the loaded readings are the bundled example dataset (Wave H item
 * 1). It is a separate key from `energy_data` so a user's own upload always
 * wins, and so clearing it never has to guess what else to delete.
 *
 * Declared in `lib/backup.ts` (a restore has to write it, and importing this
 * hook from there would be a cycle) and re-exported here so every existing
 * `import { EXAMPLE_DATA_KEY } from "@/hooks/useDashboard"` keeps working.
 */
export { EXAMPLE_DATA_KEY };

/* -------------------------------------------------------------------------
 * Wave L — the bill half of the feed, kept beside the readings.
 *
 * The XML carries UsageSummary bills and LocalTimeParameters; both are
 * parsed client-side with the readings and land in localStorage, so the
 * panel and the auto-filled True Bill inputs survive a reload without ever
 * re-uploading or asking the server anything.
 * ------------------------------------------------------------------------- */

export const USAGE_SUMMARIES_KEY = "usage_summaries";
export const LOCAL_TIME_KEY = "local_time_parameters";

/**
 * The gas half of the bill feed (t_8a9038d6).
 *
 * Before this split a single `usage_summaries` array held both commodities,
 * and `commitBillFeed("replace")` rewrote it wholesale — so uploading gas
 * replaced every electricity bill and vice versa. The two keys are written
 * by their own commit path and are never addressed by the other's.
 */
export const GAS_USAGE_SUMMARIES_KEY = "gas_usage_summaries";
export const GAS_LOCAL_TIME_KEY = "gas_local_time_parameters";

/**
 * Which commodity section the dashboard is showing (t_8a9038d6).
 *
 * Selection is per-browser and survives a reload, because the two datasets
 * both live in this browser: coming back to an electric chart after a gas
 * upload would hide the file the user just imported. It is a VIEW choice
 * only — it never decides what a parsed document writes to.
 */
export const COMMODITY_STORAGE_KEY = "oeo_commodity";

/**
 * Broadcast for chrome OUTSIDE <Dashboard> (t_a775c2a3 — AC2).
 *
 * The classic header's active-plan chip sits ABOVE the dashboard, so the
 * dashboard's own `commodity` state cannot reach it: a section switch must be
 * a signal every subscriber can read, not a fact only the component that
 * wrote it knows. One dispatch point — `commoditySelection.write` — covers
 * the switcher and /import's own writes; same-tab, so the browser's
 * cross-document `storage` event is no use here.
 */
export const COMMODITY_CHANGE_EVENT = "oeo-commodity-change";

export type CommoditySelection = {
  /** The stored (or default) commodity for a fresh mount. */
  read: () => Commodity;
  /** Persist a selection; storage being unavailable must not break the toggle. */
  write: (next: Commodity) => void;
};

export const commoditySelection: CommoditySelection = {
  read: () => {
    try {
      return localStorage.getItem(COMMODITY_STORAGE_KEY) === "gas" ? "gas" : "electricity";
    } catch {
      return "electricity";
    }
  },
  write: (next) => {
    try {
      localStorage.setItem(COMMODITY_STORAGE_KEY, next);
    } catch {
      /* quota/blocked storage: the in-memory selection still holds */
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(COMMODITY_CHANGE_EVENT));
    }
  },
};

/**
 * The section on screen, reactive for any component (header chrome above the
 * dashboard included): `commoditySelection.read` re-run whenever a write
 * broadcasts `COMMODITY_CHANGE_EVENT`. Same value the dashboard's
 * `commodity` state holds — an electric-plan label must follow the section
 * it describes (AC2: no electric chrome on a gas surface).
 */
export function useSectionCommodity(): Commodity {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(COMMODITY_CHANGE_EVENT, onChange);
      return () => window.removeEventListener(COMMODITY_CHANGE_EVENT, onChange);
    },
    commoditySelection.read,
    // Hydration must replay EXACTLY what the server painted: localStorage
    // does not exist up there, so a prerender always renders the default
    // section. Serving a live read here instead is what turned a
    // gas-stored browser into hydration error #418 on /classic (the static
    // HTML carries the chip, the first client pass then dropped it).
    () => "electricity" as Commodity,
  );
}

export type BillFeed = {
  /** Every billing period the parse found, oldest first. */
  summaries: UsageSummary[];
  /** The feed's own clock rules, or null when it declared none. */
  localTime: LocalTimeParams | null;
  /** File/sync the values came from, for the "sourced from" caption. */
  source: string | null;
};

export const EMPTY_BILL_FEED: BillFeed = { summaries: [], localTime: null, source: null };

/**
 * Read ONE summary/clock key pair, dropping whatever is unreadable or of the
 * wrong shape. Shared by both commodities so a malformed gas key cannot be
 * tolerated where a malformed electric one is not (and vice versa).
 */
function readStoredRows(
  summaryKey: string,
  clockKey: string,
): { summaries: UsageSummary[]; localTime: LocalTimeParams | null } {
  try {
    const raw = localStorage.getItem(summaryKey);
    const clock = localStorage.getItem(clockKey);
    const summaries = raw ? (JSON.parse(raw) as UsageSummary[]) : [];
    const localTime = clock ? (JSON.parse(clock) as LocalTimeParams) : null;
    if (!Array.isArray(summaries)) return { summaries: [], localTime: null };
    // `volume` was added to UsageSummary by the Enbridge wave: anything
    // stored earlier has NO key for it, and the type says `volume: BillMeasurement
    // | null`. Default it on read so a missing key reads as null, never
    // undefined — `undefined !== null` is the trap that crashed isGasSummary
    // on every pre-wave dashboard (ERR-4887C2).
    const clean = summaries
      .filter(
        (s) => s && typeof s.start === "number" && typeof s.duration === "number" && Array.isArray(s.items),
      )
      .map((s) => ({ ...s, volume: s.volume ?? null }));
    const okClock = localTime && typeof localTime.tzOffset === "number" ? localTime : null;
    return { summaries: clean, localTime: okClock };
  } catch {
    return { summaries: [], localTime: null };
  }
}

/**
 * Whitelisted read of the ELECTRICITY bill feed.
 *
 * A key written before the commodity split can still hold gas periods — the
 * split is a write-side migration (ensureBillPartition), so this partitions
 * ON READ and never depends on the migration having run. Gas periods are
 * handed to `readStoredGasBillFeed`, not dropped.
 */
export function readStoredBillFeed(): BillFeed {
  const rows = readStoredRows(USAGE_SUMMARIES_KEY, LOCAL_TIME_KEY);
  const { electric } = splitSummaries(rows.summaries);
  if (electric.length === 0 && !rows.localTime) return EMPTY_BILL_FEED;
  return { summaries: electric, localTime: rows.localTime, source: null };
}

/**
 * Whitelisted read of the NATURAL GAS bill feed.
 *
 * Sums the migrated key with whatever gas periods are still sitting in the
 * legacy key (a browser that has not written since the split), keyed by
 * `start` so a period present in both counts once. The migrated copy wins a
 * conflict: it is the one the gas write path maintains.
 *
 * The clock falls back to the electric key read-only. Duplicating it would
 * be safe, but deleting or rewriting the electric copy from a gas read is
 * not this function's business.
 */
export function readStoredGasBillFeed(): BillFeed {
  const migrated = readStoredRows(GAS_USAGE_SUMMARIES_KEY, GAS_LOCAL_TIME_KEY);
  const legacy = readStoredRows(USAGE_SUMMARIES_KEY, LOCAL_TIME_KEY);
  const { gas } = splitSummaries(legacy.summaries);
  const byStart = new Map<number, UsageSummary>();
  for (const s of gas) byStart.set(s.start, s);
  for (const s of migrated.summaries) byStart.set(s.start, s);
  const summaries = [...byStart.values()].sort((a, b) => a.start - b.start);
  const localTime = migrated.localTime ?? legacy.localTime;
  if (summaries.length === 0 && !localTime) return EMPTY_BILL_FEED;
  return { summaries, localTime, source: null };
}

/**
 * Rows a document actually gave us, for the import gate.
 *
 * An Enbridge gas extract carries no electric `DataPoint`s at all — its data
 * lives in commodity-7 `volume` series (the five IntervalBlocks) and in the
 * billing summaries — so gating on `g.readings` alone rejects every gas file
 * with "produced no readable rows" even though the parse succeeded. Electric
 * feeds are unaffected: their series are not `volume`, so this counts exactly
 * what `g.readings` counts for them.
 */
export const countUsableRows = (gs: UsagePointGroup[]): number =>
  gs.reduce(
    (n, g) =>
      n +
      g.readings.length +
      (g.series ?? []).reduce(
        (m, s) => m + (s.status === "volume" ? s.readings.length : 0),
        0,
      ),
    0,
  );

/**
 * Move every gas period out of the legacy `usage_summaries` array and into
 * the gas key — the non-destructive half of the commodity split.
 *
 * Order is the whole safety property:
 *   1. the gas copy is written FIRST (unioned with anything already there,
 *      so re-running never duplicates a period and never loses one);
 *   2. only after that write succeeds is the legacy array rewritten without
 *      the gas rows.
 * If step 1 fails (quota) nothing is touched and the caller gets the
 * failure: the browser still holds every period exactly where it found it.
 * If step 2 fails, the gas copy already exists, so the leftover rows in the
 * electric key are a harmless duplicate that `readStoredBillFeed`'s
 * on-read partition keeps on the correct side anyway.
 *
 * Idempotent: after the first successful run `gas.length === 0` and this is
 * a read-only no-op.
 */
export function ensureBillPartition(): StorageResult<true> {
  const legacy = readStoredRows(USAGE_SUMMARIES_KEY, LOCAL_TIME_KEY);
  const { gas } = splitSummaries(legacy.summaries);
  if (gas.length === 0) return { ok: true, value: true, warnings: [] };

  const parked = mergeGasBillRows(gas, legacy.localTime);
  if (!parked.ok) return parked;

  const { electric } = splitSummaries(legacy.summaries);
  const stripped = writeStoredKey(
    USAGE_SUMMARIES_KEY,
    electric.length > 0 ? JSON.stringify(electric) : null,
  );
  return stripped.ok ? { ok: true, value: true, warnings: [] } : stripped;
}

/**
 * Union `extra` into the gas bill key. Rows already migrated win a conflict
 * on the same `start` — the migrated copy is the one this build maintains,
 * so a re-run of the partition can only ever add periods it does not have.
 *
 * The clock is copied across only when the gas key has none: a stale clock
 * beside the right periods beats a missing one, and the electric key's copy
 * is never removed from here.
 */
function mergeGasBillRows(extra: readonly UsageSummary[], clock: LocalTimeParams | null): StorageResult<true> {
  const existing = readStoredRows(GAS_USAGE_SUMMARIES_KEY, GAS_LOCAL_TIME_KEY);
  const byStart = new Map<number, UsageSummary>();
  for (const s of existing.summaries) byStart.set(s.start, s);
  for (const s of extra) if (!byStart.has(s.start)) byStart.set(s.start, s);
  const merged = [...byStart.values()].sort((a, b) => a.start - b.start);

  let payload: string | null;
  try {
    payload = merged.length > 0 ? JSON.stringify(merged) : null;
  } catch (err) {
    return { ok: false, reason: "corrupt", detail: `Gas bill feed is not serializable: ${(err as Error)?.message ?? String(err)}` };
  }
  const written = writeStoredKey(GAS_USAGE_SUMMARIES_KEY, payload);
  if (!written.ok) return written;
  const nextClock = existing.localTime ?? clock;
  return writeStoredKey(GAS_LOCAL_TIME_KEY, nextClock ? JSON.stringify(nextClock) : null);
}

/**
 * Persist the ELECTRICITY bill half — and SAY when it does not land.
 *
 * Two writes go through storage.ts's `writeStoredKey`, so a quota failure
 * comes back classified exactly like the readings write, and the caller
 * raises it through `reportStorage` (the same notice row). The old version
 * swallowed the failure in an empty catch, which looked like a successful
 * import until the reload that found 0 periods.
 *
 * The commodity split runs first (see ensureBillPartition) and the incoming
 * feed is partitioned too, so a gas period can never be written to the
 * electric key — and a failure in the split aborts this write rather than
 * proceeding on a half-migrated store.
 *
 * Returns the verdict instead of throwing: a storage failure must never break
 * the UI (the in-memory value is still the truth on screen), it must only be
 * visible.
 */
export function writeStoredBillFeed(feed: BillFeed): StorageResult<true> {
  const split = splitSummaries(feed.summaries);

  const migrated = ensureBillPartition();
  if (!migrated.ok) return migrated;
  // A caller that handed us a gas period (an unpartitioned legacy read, say)
  // parks it in the gas key instead of dropping it — then the electric write
  // below only ever sees electricity.
  if (split.gas.length > 0) {
    const parked = mergeGasBillRows(split.gas, feed.localTime);
    if (!parked.ok) return parked;
  }

  let summaries: string | null;
  let clock: string | null;
  try {
    summaries = split.electric.length > 0 ? JSON.stringify(split.electric) : null;
    clock = feed.localTime ? JSON.stringify(feed.localTime) : null;
  } catch (err) {
    return {
      ok: false,
      reason: "corrupt",
      detail: `Bill feed is not serializable: ${(err as Error)?.message ?? String(err)}`,
    };
  }
  // Both writes are ATTEMPTED even if the first fails (a stale clock beside
  // new bills is still better than neither), and the first failure wins —
  // one notice, naming the key that failed.
  const written = writeStoredKey(USAGE_SUMMARIES_KEY, summaries);
  const timed = writeStoredKey(LOCAL_TIME_KEY, clock);
  return written.ok ? timed : written;
}

/**
 * Persist the NATURAL GAS bill half under the gas keys.
 *
 * Mirrors `writeStoredBillFeed` exactly — same error classification, same
 * "attempt both, first failure wins" rule — but addresses only
 * `gas_usage_summaries` / `gas_local_time_parameters`, so a gas commit can
 * neither read nor rewrite the electricity feed.
 *
 * `mode` follows the readings: an upload replaces (the file the user just
 * chose is what they asked to see), a live sync unions (one more source of
 * truth must not delete bills the feed no longer repeats).
 */
export function writeStoredGasBillFeed(feed: BillFeed, mode: "replace" | "union"): StorageResult<true> {
  const migrated = ensureBillPartition();
  if (!migrated.ok) return migrated;

  const split = splitSummaries(feed.summaries);
  // `union` folds the incoming periods into what is stored; `replace` is the
  // file alone. Both are normalised through the same de-dupe/sort so a period
  // two files describe differently counts once.
  const target: BillFeed =
    mode === "replace"
      ? unionBillFeeds(EMPTY_BILL_FEED, { ...feed, summaries: split.gas })
      : unionBillFeeds(
          { ...readStoredGasBillFeed(), source: feed.source },
          { ...feed, summaries: split.gas },
        );

  let payload: string | null;
  let clock: string | null;
  try {
    payload = target.summaries.length > 0 ? JSON.stringify(target.summaries) : null;
    clock = target.localTime ? JSON.stringify(target.localTime) : null;
  } catch (err) {
    return {
      ok: false,
      reason: "corrupt",
      detail: `Gas bill feed is not serializable: ${(err as Error)?.message ?? String(err)}`,
    };
  }
  const written = writeStoredKey(GAS_USAGE_SUMMARIES_KEY, payload);
  const timed = writeStoredKey(GAS_LOCAL_TIME_KEY, clock);
  return written.ok ? timed : written;
}

/**
 * Several parses into one dataset: one row per billing period (a re-upload
 * of the same export must not duplicate a period), newest clock wins, and a
 * file that declares no clock never erases the one we already had.
 */
export function unionBillFeeds(base: BillFeed, ...incoming: BillFeed[]): BillFeed {
  const byStart = new Map<number, UsageSummary>();
  let localTime = base.localTime;
  let source = base.source;
  let newest = -1;
  for (const feed of [base, ...incoming]) {
    for (const s of feed.summaries) {
      byStart.set(s.start, s);
      if (s.start >= newest) {
        newest = s.start;
        localTime = feed.localTime ?? localTime;
        source = feed.source ?? source;
      }
    }
    if (feed.localTime && localTime === null) localTime = feed.localTime;
  }
  const summaries = [...byStart.values()].sort((a, b) => a.start - b.start);
  if (summaries.length === 0 && base.localTime && incoming.every((f) => !f.localTime)) {
    localTime = base.localTime;
  }
  return { summaries, localTime, source };
}

/** What an Export click downloads: a versioned JSON document + its filename. */
export type BackupExport = { filename: string; text: string };

/** Outcome of an Import: ok carries the filename, failure carries the reason. */
export type BackupImportResult = { ok: boolean; filename?: string; error?: string };

/**
 * Outcome of one Green Button live sync (Wave K).
 * `incoming` = rows the feed carried; `added` = rows this browser did not
 * have; `picker` = the feed had several meters and is waiting for a choice.
 */
export type GbSyncOutcome =
  | {
      ok: true;
      /** Rows the feed carried. */
      incoming: number;
      /** Rows this browser did not already have. */
      added?: number;
      /** The feed had several meters; a picker is waiting. */
      picker?: boolean;
      /** Nothing changed — storage and view were left alone. */
      unchanged?: boolean;
    }
  | { ok: false; code: string; detail?: string };

export type { ExtraCharges };

/**
 * One file inside a 2+ file upload, waiting on the merge review screen.
 * `chosen` stays null for a multi-meter file until the user picks — a meter
 * is never merged silently.
 */
export type MergeFileChoice = {
  name: string;
  groups: UsagePointGroup[];
  chosen: number | "combine" | null;
  /** Set when this file produced no readings: what to tell the user. */
  issue?: ParseDiagnostic;
  /**
   * The feed's refusal notes — what this file carried that was NOT priced.
   * They ride with the rows so the dashboard can say it after the import
   * commits (a single-UsagePoint file never renders the picker).
   */
  notes?: SeriesNote[];
  /**
   * The UsageSummary bills parsed out of this same file. They ride along with
   * the readings so the first-load window can be cut on the FILE's periods —
   * the window is chosen in the same call that imports the rows, before any
   * stored state has caught up.
   */
  summaries?: UsageSummary[];
};

/**
 * Which scope button the current startDate/endDate window belongs to.
 * `Custom` = a window that is neither a billing period nor a calendar month
 * (either the user typed dates, or first load picked a data-anchored window).
 */
export type ViewScope = "Month" | "YTD" | "BillingPeriod" | "Custom";

/**
 * The RateSet in force on the newest processed reading — plan cards and any
 * "current rate" display should reflect today's schedule, not historical ones.
 */
export function useActiveRateSet(
  processedData: { timestamp: number; activeRateSet: RateSet }[],
): RateSet | null {
  return useMemo(() => {
    if (processedData.length === 0) return null;
    // processRawData preserves the input (already sorted) order; pick the max
    // timestamp defensively rather than assuming sort order.
    let newest = processedData[0];
    for (const d of processedData) if (d.timestamp > newest.timestamp) newest = d;
    return newest.activeRateSet;
  }, [processedData]);
}

/**
 * A storage operation that did not land cleanly, in the shape the UI renders.
 *
 * `quota` and `cleanup` can ride on an otherwise-successful write (the data is
 * in memory but not on disk); `corrupt` means a read could not be trusted.
 * Every one of them is shown — a failed write must never look like a saved one.
 */
export type StorageNoticeKind = "quota" | "corrupt" | "cleanup";
export type StorageNotice = { kind: StorageNoticeKind; detail: string };

/**
 * Energy data lifecycle: localStorage restore, /api/rates fetch, upload,
 * emergency reset, billing-day editing, view-scope re-anchoring, and
 * backup/restore (Wave G: the browser profile is the only storage there is).
 *
 * `options.onBackupApplied` runs after a successful import writes storage.
 * Dashboard passes `() => window.location.reload()` so every hook that seeds
 * itself lazily from localStorage (useExtraCharges in particular) re-reads the
 * restored values instead of keeping pre-import state.
 */
export function useEnergyData(options: { onBackupApplied?: () => void } = {}) {
  const { onBackupApplied } = options;
  // Wave U rule: the billing axis is built by a lib function that writes its
  // labels with the module `t()` at call time, so this hook has to re-derive
  // it when the language changes — a module-function `t` has a stable
  // identity and would never do that as a dep. `locale` moves.
  const { locale } = useTranslation();
  const [rawData, setRawData] = useState<DataPoint[]>([]);
  const [rateHistory, setRateHistory] = useState<RateSet[]>([]);
  const rateRequestStartedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [billingDay, setBillingDayState] = useState<number>(1);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [viewScope, setViewScope] = useState<ViewScope>("BillingPeriod");

  /**
   * True when the stored readings are the synthetic example set — drives the
   * "example data, not real usage" banner so nobody mistakes it for a bill.
   */
  const [exampleData, setExampleData] = useState(false);

  /**
   * Multi-meter upload waiting for the user to pick which point to load.
   *
   * `origin` says where the rows came from. A file upload REPLACES the
   * dataset (the file is the user's stated truth); a live sync MERGES into
   * it, because the feed is additive and dropping months of history to
   * satisfy a picker would be a silent data loss.
   */
  const [pendingUpload, setPendingUpload] = useState<{
    fileName: string;
    groups: UsagePointGroup[];
    origin?: "upload" | "greenbutton";
    /** Bills from the same file — see MergeFileChoice.summaries. */
    summaries?: UsageSummary[];
    /** The feed's refusals — see MergeFileChoice.notes. Held until the pick
     *  actually commits, so cancelling raises no notice. */
    notes?: SeriesNote[];
  } | null>(null);

  /** 2+ files waiting on the merge review screen (range + rows before import). */
  const [pendingMerge, setPendingMerge] = useState<MergeFileChoice[] | null>(null);

  /**
   * Why the last upload produced nothing. Rendered inside the upload modal —
   * "invalid XML" tells a first-time user nothing, so the diagnostic names
   * what was missing instead (see lib/parseDiagnostic.ts).
   */
  const [parseIssue, setParseIssue] = useState<ParseDiagnostic | null>(null);

  /**
   * The last storage operation that did not land cleanly (see StorageNotice).
   * Held in the hook rather than the component because every writer lives
   * here: a write that fails during upload, import, migration or reset has to
   * reach one place that Dashboard renders.
   */
  const [storageNotice, setStorageNotice] = useState<StorageNotice | null>(null);

  /**
   * Reset is two-step (open the confirm dialog, then confirm) instead of
   * wiping on the first click: it used to be a single `localStorage.clear()`
   * behind one toolbar button.
   */
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  /** The keys the open dialog will remove — read at open time, not guessed. */
  const [resetKeys, setResetKeys] = useState<string[]>([]);

  /**
   * Unwrap a StorageResult for the UI: failures and non-clean writes become
   * the visible notice row; clean reads/writes clear it.
   *
   * Returns the value so a caller can keep going after a *warning*, and null
   * when the operation genuinely failed (the caller decides whether the
   * in-memory data is still usable — a quota failure is).
   */
  const reportStorage = <T,>(res: StorageResult<T>): T | null => {
    if (!res.ok) {
      setStorageNotice({ kind: res.reason, detail: res.detail });
      return null;
    }
    const warning = res.warnings[0];
    if (warning) setStorageNotice({ kind: warning.kind, detail: warning.detail });
    return res.value;
  };

  /** The notice row's dismiss button. The failure stays true; the user moves on. */
  const dismissStorageNotice = () => setStorageNotice(null);

  /**
   * The refusal notes the last COMMITTED import carried: readings the
   * ingestion parsed and preserved but did not price (t_880370e6).
   *
   * Presentation only. It is set from the same `feed.notes` the picker and
   * the diagnostics panels read, so it can only ever repeat a refusal the
   * parser actually made, and dismissing it clears THIS row — never the
   * readings, never the notes themselves. A commit with no refusals clears
   * it, so the row always describes the dataset on screen.
   */
  const [refusalNotes, setRefusalNotes] = useState<SeriesNote[]>([]);

  /** Clear (or refresh) the refusal row for a just-committed import. */
  const publishRefusalNotes = (notes: SeriesNote[] | undefined | null) => {
    setRefusalNotes(notes && notes.length > 0 ? notes : []);
  };

  /** The refusal row's dismiss button. Nothing is deleted or altered. */
  const dismissRefusalNotes = () => setRefusalNotes([]);

  /**
   * Raise (or, with null, clear) the notice from a caller outside this hook —
   * the component's own export path, which fails in storage.ts the same way
   * every other write does.
   */
  const raiseStorageNotice = (notice: StorageNotice | null) => setStorageNotice(notice);

  /**
   * The bill half of the dataset (Wave L): UsageSummary periods + the
   * feed's clock rules, seeded from localStorage so a reload keeps the
   * actual-bill panel without re-parsing the export.
   */
  const [billFeed, setBillFeed] = useState<BillFeed>(() => readStoredBillFeed());
  /**
   * The same value, readable synchronously. `commitBillFeed` unions from the
   * LAST commit, so two commits landing in one tick (a network pull and a
   * staged service-worker feed, say) cannot both union against the render
   * before the first one — which is what reading the `billFeed` closure would
   * do now that the write happens outside the state updater.
   */
  const billFeedRef = useRef<BillFeed>(billFeed);

  /* ---------------------------------------------------------------------
   * The NATURAL GAS half (t_8a9038d6) — deliberately a parallel copy of the
   * four pieces above rather than a `commodity` field on them. Sharing state
   * between the two commodities is exactly the coupling that let one upload
   * overwrite the other's data; keeping two feeds means the only code that
   * can touch gas storage is the gas commit, and vice versa.
   * --------------------------------------------------------------------- */

  /** Gas billing periods, seeded from storage so a reload keeps the gas panel. */
  const [gasBillFeed, setGasBillFeed] = useState<BillFeed>(() => readStoredGasBillFeed());
  /** Synchronous mirror of `gasBillFeed` — same reason as `billFeedRef`. */
  const gasBillFeedRef = useRef<BillFeed>(gasBillFeed);
  /** Gas intervals the file(s) waiting to import carry (mirror of rawData). */
  const [gasData, setGasData] = useState<GasPoint[]>(() => {
    const stored = loadGasData();
    return stored.ok && stored.value ? stored.value.points : [];
  });
  const gasDataRef = useRef<GasPoint[]>(gasData);
  /** Bills parsed out of the files waiting on a picker/merge screen. */
  const gasBillFeedsRef = useRef<BillFeed[]>([]);
  /** Gas intervals parsed out of the same waiting files. */
  const gasPointsRef = useRef<GasPoint[]>([]);

  /**
   * Which commodity section is on screen. A VIEW choice only: it never
   * routes a write (see commoditySelection), it only decides which dataset
   * the panels read and which section an import opens on.
   */
  const [commodity, setCommodityState] = useState<Commodity>(() => commoditySelection.read());

  /**
   * What the last import was DETECTED as (t_8a9038d6) — the truthful answer
   * to "did my file import, and as what?". The section switch already opens
   * on the commodity that got data; this says it out loud, including the
   * ambiguous case: a document carrying BOTH halves reports both instead of
   * pretending it was one commodity. Cleared by the next upload.
   */
  const [commodityNotice, setCommodityNotice] = useState<Commodity | 'both' | null>(null);
  const reportDetection = (electricity: boolean, gas: boolean) => {
    setCommodityNotice(
      electricity && gas ? 'both' : gas ? 'gas' : electricity ? 'electricity' : null,
    );
  };
  const dismissCommodityNotice = useCallback(() => setCommodityNotice(null), []);
  const commodityRef = useRef<Commodity>(commodity);
  const setCommodity = useCallback((next: Commodity) => {
    commodityRef.current = next;
    setCommodityState(next);
    commoditySelection.write(next);
  }, []);

  /**
   * Run the commodity split once on boot (t_8a9038d6).
   *
   * Reads already partition on see (readStoredBillFeed / readStoredGasBillFeed),
   * so this is not needed for correctness of what is DISPLAYED — it exists so
   * the browser's stored bytes become truthful without waiting for the next
   * upload to write something. The write-side order inside
   * `ensureBillPartition` is what makes it non-destructive, and it is
   * idempotent, so a double mount in dev costs one extra read.
   *
   * A failure is raised through the same notice row every other storage
   * failure uses: a quota error here means the split did not happen, and
   * hiding that would leave two accounts of the same periods alive at once.
   */
  useEffect(() => {
    const res = ensureBillPartition();
    if (res.ok && res.warnings.length === 0) return;
    // Deferred a tick: the rule (and React) forbid a synchronous setState in
    // an effect body — the notice must still surface, just not as a cascading
    // render of this very mount.
    const id = window.setTimeout(() => reportStorage(res), 0);
    return () => window.clearTimeout(id);
    // Mount only: `ensureBillPartition` is module-scope and `reportStorage`
    // is this hook's own stable setter, so there is nothing to re-subscribe.
  }, []);

  /**
   * The timeline THIS FILE defines: its own `billingPeriod` entries (de-duped
   * when several exports describe the same bill), the holes between them, and
   * the unbilled tail after the last one. It drives which window the view
   * opens on, where the BillingPeriod scope buttons land and how prev/next
   * step — instead of the calendar rules the app used before.
   *
   * With no UsageSummary in the file, the same builder cuts periods on
   * `billingDay`, which is exactly the behavior older exports got.
   */
  const axis = useMemo(
    () => buildBillingAxis({ summaries: billFeed.summaries, rows: rawData, billingDay }),
    // buildBillingAxis writes every period label and axis note in the active
    // language (t() reads the module singleton at call time), so this memo —
    // and the whole money tab built on it — must re-derive on a toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [billFeed.summaries, rawData, billingDay, locale],
  );

  /**
   * Where the timeline should anchor: the newest reading, clamped to the
   * clock (a feed timestamped ahead of us must not open a future window).
   */
  const anchorTimestamp = (points: DataPoint[]): number | null => {
    if (points.length === 0) return null;
    let last = points[0].timestamp;
    for (const p of points) if (p.timestamp > last) last = p.timestamp;
    const now = Math.floor(Date.now() / 1000);
    return Math.min(last, now);
  };

  /**
   * Bills parsed by the file(s) waiting to be imported, held until the user
   * actually commits them — a picker or merge screen that is cancelled must
   * not have already swapped the panel over to a bill nobody loaded.
   */
  const billFeedsRef = useRef<BillFeed[]>([]);

  /**
   * `replace` = the dataset is now exactly what was parsed (an upload is the
   * user's stated truth, same as the readings); `union` = one more source of
   * truth folded in (a live sync must not delete bills either).
   */
  const commitBillFeed = (mode: "replace" | "union") => {
    const incoming = billFeedsRef.current;
    billFeedsRef.current = [];
    const next =
      mode === "replace"
        ? incoming.reduce((acc, f) => unionBillFeeds(EMPTY_BILL_FEED, f), EMPTY_BILL_FEED)
        : // `incoming` holds one feed per FILE the user selected (one entry for a
          // live sync) — not one per bill in the file — and the batch is cleared
          // on commit. `unionBillFeeds`'s variadic tail is therefore file-count-sized.
          // eslint-disable-next-line no-restricted-syntax -- one feed per selected file, cleared on commit
          unionBillFeeds(billFeedRef.current, ...incoming);
    // Written OUTSIDE the state updater (updaters must stay pure) and BEFORE
    // the state lands, so a failed write raises the same notice row the
    // readings write raises — never a silent one. Deliberately reports only:
    // commitReadings may have just raised ITS OWN notice for the same commit,
    // and clearing here would erase a quota failure the user must still see.
    reportStorage(writeStoredBillFeed(next));
    billFeedRef.current = next;
    setBillFeed(next);
  };

  /**
   * The gas twin of `commitBillFeed`. Same rules, different keys: it reads
   * and writes only `gas_usage_summaries` / `gas_local_time_parameters`, so
   * folding gas bills in can never rewrite the electricity feed.
   */
  const commitGasBillFeed = (mode: "replace" | "union") => {
    const incoming = gasBillFeedsRef.current;
    gasBillFeedsRef.current = [];
    const next =
      mode === "replace"
        ? incoming.reduce((acc, f) => unionBillFeeds(EMPTY_BILL_FEED, f), EMPTY_BILL_FEED)
        : // eslint-disable-next-line no-restricted-syntax -- one feed per selected file, cleared on commit
          unionBillFeeds(gasBillFeedRef.current, ...incoming);
    reportStorage(writeStoredGasBillFeed(next, mode));
    gasBillFeedRef.current = next;
    setGasBillFeed(next);
  };

  /**
   * Import gas intervals: persist to the gas key, open the gas section.
   *
   * Deliberately NOT routed through `commitReadings`: that function writes
   * `energy_data_v2` and re-anchors the ELECTRICITY window, and a gas
   * document reaching it is precisely the defect this card exists to close
   * (an Enbridge upload committed `[]` and wiped the electric dataset).
   *
   * `mode` mirrors the readings semantics — an upload replaces the gas
   * bucket, a live sync unions into it — and only ever within the bucket:
   * `energy_data_v2` is not addressed here at all.
   */
  const commitGasReadings = (
    points: GasPoint[],
    mode: "replace" | "union" = "replace",
    bills?: UsageSummary[],
    notes?: SeriesNote[],
  ) => {
    const sorted = sortGasPoints(points);
    const next = mode === "replace" ? sorted : unionGasPoints(gasDataRef.current, sorted);
    gasDataRef.current = next;
    setGasData(next);

    const saved = saveGasData(next, { source: "upload" });
    if (saved.ok && saved.warnings.length === 0) setStorageNotice(null);
    else reportStorage(saved);

    // The section this import actually filled is chosen by the CALLER, not
    // here: a background live sync must not yank the view to gas the way an
    // upload opens the section it just filled (see handleFileUpload).
    setParseIssue(null);
    publishRefusalNotes(notes);
    setShowUploadModal(false);
    // Consumed: the pending batch is committed, so the next upload starts
    // from its own files instead of folding these intervals in again.
    gasPointsRef.current = [];
    // Gas has no billing-day-anchored window to re-cut (the gas panel shows
    // the whole stored span), so only an electric commit re-anchors.
    if (bills && bills.length > 0 && gasBillFeedsRef.current.length === 0) {
      gasBillFeedsRef.current = [{ summaries: bills, localTime: null, source: null }];
    }
  };

  /** Drop every pending (not yet committed) bill/reading from BOTH commodities. */
  const clearPendingFeeds = () => {
    billFeedsRef.current = [];
    gasBillFeedsRef.current = [];
    gasPointsRef.current = [];
  };

  /* ---------------------------------------------------------------------
   * Green Button live sync (Wave K).
   *
   * The shim pipes ESPI straight through; every byte is parsed HERE and
   * lands in localStorage exactly like a manual upload, so the server keeps
   * nothing. These four pieces of state are the whole client footprint.
   * --------------------------------------------------------------------- */
  const [gbStatus, setGbStatus] = useState<GbStatus | null>(null);
  const [gbSyncing, setGbSyncing] = useState(false);
  const [gbMessage, setGbMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  /* ---------------------------------------------------------------------
   * Wave M — background refresh.
   *
   * `gbRefreshTick` is the only thing the notice hook needs to know that a
   * refresh just ran; `backgroundSync` is what the settings drawer prints
   * about Periodic Background Sync; `lastRefreshAtRef` is the shared throttle
   * so interval, focus and visibilitychange can never stack requests.
   * --------------------------------------------------------------------- */
  const [gbRefreshTick, setGbRefreshTick] = useState(0);
  const [backgroundSync, setBackgroundSync] = useState<BackgroundSyncState>("unknown");
  const lastRefreshAtRef = useRef(0);

  /** Live-view refs: the sync path is called from effects whose closures
   *  were built before the data existed, so they read these instead. */
  const rawDataRef = useRef<DataPoint[]>([]);
  const gbStatusRef = useRef<GbStatus | null>(null);
  const syncingRef = useRef(false);
  /**
   * The visible window, mirrored for the sync path. commitReadings anchors a
   * fresh data-full window — correct for an upload, wrong for a background
   * poll that must not yank the view back while someone is exploring.
   */
  const windowRef = useRef<{ start: string; end: string; scope: ViewScope }>({
    start: "", end: "", scope: "BillingPeriod",
  });
  useLayoutEffect(() => {
    windowRef.current = { start: startDate, end: endDate, scope: viewScope };
  });
  const writeRows = (rows: DataPoint[]) => {
    rawDataRef.current = rows;
    setRawData(rows);
  };

  /**
   * Open a freshly loaded dataset in a window that is actually full of data.
   * (Anchoring the billing period straight on the last data day used to open a
   * mostly-future window — data ending Oct 1 with billing_day=1 showed Oct 1-31
   * for ~12h of data. selectInitialWindow clamps the anchor and falls back
   * through Month → data-anchored trailing window, and reports which scope the
   * resulting window belongs to.)
   */
  const applyInitialWindow = (
    points: DataPoint[],
    day: number,
    /** The bills these readings came WITH. Callers pass the ones just parsed;
     *  the restore path passes what is already in state. */
    bills?: UsageSummary[],
  ) => {
    // The file's own period containing the anchor wins — same coverage gate
    // selectInitialWindow applies, so an almost-empty bill period still falls
    // through to the data-anchored window below instead of opening on
    // nothing. A file with no periods never reaches this branch.
    const summaries = bills ?? billFeed.summaries;
    const anchor = anchorTimestamp(points);
    if (summaries.length > 0 && anchor !== null) {
      const fileAxis = buildBillingAxis({ summaries, rows: points, billingDay: day });
      const period = periodAt(fileAxis, anchor);
      if (period && period.coverage >= MIN_WINDOW_COVERAGE) {
        const w = dateWindowOf(period);
        setStartDate(w.start);
        setEndDate(w.end);
        setViewScope('BillingPeriod');
        return;
      }
    }
    const w = selectInitialWindow(points, day, new Date());
    if (!w) return;
    setStartDate(w.start);
    setEndDate(w.end);
    setViewScope(w.scope);
  };

  /**
   * Import rows: persist, open a data-full window, close the upload modal.
   * (Used by the single-meter path, the UsagePoint picker AND the example
   * button, so the first-load fix applies however the user got readings in.)
   *
   * `source` records whether what just landed is the synthetic example set —
   * one flag, written or cleared atomically with the readings themselves.
   *
   * The example set ALSO opens on its whole span instead of the current
   * billing period. selectInitialWindow (Wave A) deliberately anchors a real
   * upload on a data-FULL current period, which for a fresh export means one
   * month — one lonely bar. For a dataset whose entire job is to show a
   * visitor the product, one bar is the wrong first screen, so the demo
   * opens on every reading it just loaded (12 monthly bars) and the scope
   * buttons still zoom in from there. Real uploads are untouched.
   */
  const commitReadings = (
    data: DataPoint[],
    source: "upload" | "example" = "upload",
    bills?: UsageSummary[],
    /**
     * The refusals this dataset came with (t_880370e6). Every import path
     * passes its own `feed.notes`; a path with none (the bundled example set)
     * clears the row instead of leaving a stale one over other data.
     */
    notes?: SeriesNote[],
  ) => {
    writeRows(data);
    // Persist through the storage layer: versioned key, quota surfaced. The
    // rows below land in memory either way — a full disk must not silently
    // pretend the upload was saved, and it must not throw the upload away.
    const saved = saveEnergyData(data, { source });
    if (saved.ok && saved.warnings.length === 0) setStorageNotice(null);
    else reportStorage(saved);
    try {
      if (source === "example") localStorage.setItem(EXAMPLE_DATA_KEY, "1");
      else localStorage.removeItem(EXAMPLE_DATA_KEY);
    } catch { /* storage blocked: the in-memory flag below still holds */ }
    setExampleData(source === "example");
    if (source === "example" && data.length > 0) {
      let first = data[0];
      let last = data[0];
      for (const d of data) {
        if (d.timestamp < first.timestamp) first = d;
        if (d.timestamp > last.timestamp) last = d;
      }
      setStartDate(format(new Date(first.timestamp * 1000), "yyyy-MM-dd"));
      setEndDate(format(new Date(last.timestamp * 1000), "yyyy-MM-dd"));
      setViewScope("Custom");
    } else {
      applyInitialWindow(data, billingDay, bills ?? billFeed.summaries);
    }
    setParseIssue(null);
    // The refusal row describes THIS dataset: a clean commit clears whatever
    // the previous file raised (see refusalNotes above).
    publishRefusalNotes(notes);
    setShowUploadModal(false);
  };

  /**
   * Parse + merge one ESPI document.
   *
   * Split out of `syncFromGreenButton` so the service worker's staged feed
   * goes through EXACTLY the same path as the network pull — same merge
   * semantics, same multi-meter picker, same "nothing new ⇒ touch nothing".
   * A second ingestion path would be a second opinion about what a union
   * means, which is the one thing Wave J's importPlan already owns.
   */
  const ingestFeedXml = (xml: string): GbSyncOutcome => {
    const base = rawDataRef.current;
    // One pass, everything the bytes carry: readings, UsageSummary bills and
    // the feed's own clock rules (Wave L).
    let feed: GreenButtonFeed;
    try {
      feed = parseGreenButtonFeed(xml);
    } catch (e) {
      // A refusal (over budget, or a bill figure no bill can hold) carries its
      // own translated sentence — the toolbar shows that instead of guessing.
      return isGreenButtonRefusal(e)
        ? { ok: false, code: "unparseable", detail: e.detail }
        : { ok: false, code: "unparseable" };
    }
    const groups = feed.groups;
    // Commodity 7 enrichment (the gas bill surfaces): which IntervalBlock
    // belongs to which billing period — and whether a paired Account Details
    // file stated the supplier — is decidable only with the whole feed in
    // hand. Computed once, here, and stored ON the summaries so it survives
    // the localStorage round trip with them (backup/restore then needs no
    // second storage channel). Non-gas feeds pass through untouched.
    const summaries = isGasFeed(feed.summaries) ? enrichGasSummaries(feed) : feed.summaries;
    const incoming = groups.reduce((n, g) => n + g.readings.length, 0);
    if (countUsableRows(groups) === 0) return { ok: false, code: "no_readings" };

    // Commodity split (t_8a9038d6). A document whose rows are all volume
    // must never reach the electric merge below: `mergeForWrite` on an empty
    // electric list leaves the readings alone but the bill union would still
    // park gas periods in `usage_summaries`.
    const gasPoints = extractGasPoints(groups);
    const split = splitSummaries(summaries);
    const holdPendingFeeds = () => {
      if (incoming > 0) {
        billFeedsRef.current = [
          { summaries: split.electric, localTime: feed.localTime, source: "your Green Button feed" },
        ];
      }
      if (gasPoints.length > 0) {
        gasBillFeedsRef.current = [
          { summaries: split.gas, localTime: feed.localTime, source: "your Green Button feed" },
        ];
        gasPointsRef.current = gasPoints;
      }
    };
    holdPendingFeeds();
    const commitGasHalf = (mode: "replace" | "union") => {
      if (gasPointsRef.current.length === 0 && gasBillFeedsRef.current.length === 0) return;
      if (gasPointsRef.current.length > 0) commitGasReadings(gasPointsRef.current, mode, undefined, feed.notes);
      commitGasBillFeed(mode);
    };

    if (incoming === 0 && gasPoints.length > 0) {
      // Gas-only on the live-sync path: union into the gas bucket, say what
      // was found, and stop — there is no electric row here to merge.
      commitGasHalf("union");
      return { ok: true, incoming: gasPoints.length, added: gasPoints.length };
    }

    if (groups.length > 1) {
      setPendingUpload({
        fileName: "Oakville Hydro (live sync)",
        groups,
        origin: "greenbutton",
        summaries,
        // Held until the pick commits (see chooseUsagePoint).
        notes: feed.notes,
      });
      setShowUploadModal(false);
      return { ok: true, incoming, picker: true };
    }

    const plan = planImport(base, groups[0].readings);
    // Nothing new: skip the write AND the re-anchor. A 15-minute poll must
    // not touch storage or move a window the user has panned to. The bill
    // half still lands: a summary can arrive while the readings look
    // identical, and unioning the same bill twice is a no-op anyway.
    if (plan.identical) {
      commitBillFeed("union");
      commitGasHalf("union");
      return { ok: true, incoming, added: 0, unchanged: true };
    }

    const merged = mergeForWrite(base, groups[0].readings);
    const keep = windowRef.current;
    const hadWindow = keep.start !== "" && keep.end !== "";
    commitReadings(merged, "upload", split.electric, feed.notes);
    commitBillFeed("union");
    commitGasHalf("union");
    if (hadWindow) {
      setStartDate(keep.start);
      setEndDate(keep.end);
      setViewScope(keep.scope);
    }
    return { ok: true, incoming, added: plan.addedRows };
  };

  /**
   * Publish this browser's cursor where the SERVICE WORKER can read it.
   *
   * `localStorage` is invisible to a service worker, so the newest timestamp
   * goes into a fixed-name Cache Storage entry instead — the one channel both
   * contexts share. Without it a periodic background sync would pull the
   * whole feed every time. Failures are silent: a missing cursor only makes
   * the next background pull wider, never wrong.
   */
  const storeGbCursor = async (): Promise<void> => {
    try {
      if (typeof caches === "undefined") return;
      let newest = 0;
      for (const r of rawDataRef.current) if (r.timestamp > newest) newest = r.timestamp;
      if (newest <= 0) return;
      const cache = await caches.open(GB_CURSOR_CACHE);
      await cache.put(GB_CURSOR_URL, new Response(String(newest)));
    } catch {
      /* no Cache Storage (private mode / insecure origin): full pull next time */
    }
  };

  /**
   * Merge a feed the service worker already fetched — either just now (it
   * messaged an open window) or while the app was closed. Deleted once read,
   * so a staged feed can never be applied twice or linger across deploys.
   *
   * It does NOT replace the network pull that follows on load: a staged body
   * may be older than what the custodian would answer with today, and
   * freshness is never assumed from a cache. Both merge idempotently by
   * timestamp, so applying the same rows twice costs one parse.
   */
  const drainStagedFeed = async (): Promise<GbSyncOutcome | null> => {
    try {
      if (typeof caches === "undefined") return null;
      const cache = await caches.open(GB_STAGED_CACHE);
      const staged = await cache.match(GB_STAGED_URL);
      if (!staged) return null;
      const xml = await staged.text();
      await cache.delete(GB_STAGED_URL);
      if (!xml) return null;
      const outcome = ingestFeedXml(xml);
      if (outcome.ok) void storeGbCursor();
      return outcome;
    } catch {
      return null;
    }
  };

  /**
   * Pull the piped ESPI feed and MERGE it into what this browser already
   * holds.
   *
   * Merge, never replace: the feed is additive (a cursor fetch returns only
   * new rows; an unfiltered one returns everything), so union-by-timestamp
   * is correct for both, and a narrow response can never silently delete
   * history. Incoming rows win on a timestamp collision — the custodian is
   * the authority for its own readings.
   *
   * Multi-meter feeds go to the existing UsagePoint picker instead of being
   * merged here: a meter is never combined silently, same as an upload.
   */
  const syncFromGreenButton = async (): Promise<GbSyncOutcome> => {
    if (syncingRef.current) return { ok: false, code: "busy" };
    syncingRef.current = true;
    setGbSyncing(true);
    // Stamp at START (including the load-time pull): restoring a window fires
    // visibilitychange and focus together, and only an immediately-written
    // timestamp lets `shouldBackgroundRefresh` refuse the second one.
    lastRefreshAtRef.current = Date.now();
    try {
      let status = gbStatusRef.current;
      if (!status) {
        status = await fetchGbStatus();
        if (status) {
          gbStatusRef.current = status;
          setGbStatus(status);
        }
      }
      if (!status) return { ok: false, code: "unreachable" };
      if (!status.configured) return { ok: false, code: "not_configured" };
      if (!status.connected) return { ok: false, code: "not_connected" };

      const base = rawDataRef.current;
      let newest = 0;
      for (const r of base) if (r.timestamp > newest) newest = r.timestamp;
      // One hour of overlap: the newest interval may have been incomplete
      // when it was last seen, and rows are deduped by timestamp anyway.
      const res = await fetchGbUsage(newest > 0 ? newest - 3600 : undefined);
      if (!res.ok) return { ok: false, code: res.code, detail: res.detail };

      // The pipe-through itself is what stamps lastSyncAt/lastSyncBytes on
      // the shim, so re-read status right after a successful pull. Without
      // this the toolbar would sit on "Authorised" until the next full page
      // load even though the feed just landed — one cheap scalar request,
      // only after a pull that actually answered.
      const fresh = await fetchGbStatus();
      if (fresh) {
        gbStatusRef.current = fresh;
        setGbStatus(fresh);
      }

      const outcome = ingestFeedXml(res.xml);
      // Publish the cursor even when nothing was added: the next pull — this
      // page's next refresh OR the service worker's — should start from what
      // this browser already holds rather than re-reading the whole feed.
      if (outcome.ok) void storeGbCursor();
      return outcome;
    } catch (e) {
      return { ok: false, code: "unreachable", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      syncingRef.current = false;
      setGbSyncing(false);
    }
  };

  // --- Start sequence ---
  useEffect(() => {
    let mounted = true;
    let poller: ReturnType<typeof setInterval> | null = null;
    // Wave M listeners: declared here (not inside `init`) so the cleanup can
    // detach them — an unauthorised browser never assigns them at all.
    let onVisibilityChange: (() => void) | null = null;
    let onFocus: (() => void) | null = null;
    let onSwMessage: ((event: MessageEvent) => void) | null = null;

    /**
     * The single gated entry point every background refresh goes through.
     *
     * Four triggers — the 15-minute visible-tab interval, `visibilitychange`,
     * `focus`, and a message from the service worker — sharing ONE throttle,
     * so restoring a window (which fires BOTH visibilitychange and focus in
     * the same instant) produces exactly one request. Returns whether it
     * fired; that boolean is what the e2e asserts.
     *
     * `connected` is checked inside `shouldBackgroundRefresh`, so a browser
     * with no `gb_session` never reaches `fetch` no matter what fires.
     *
     * Declared inside this effect, not in the component body: it is only ever
     * called from event handlers and the interval, and keeping it out of the
     * render scope is what lets React's purity rule see that the `Date.now()`
     * below can never run during render.
     */
    const runBackgroundRefresh = (trigger: RefreshTrigger): boolean => {
      const fire = shouldBackgroundRefresh({
        trigger,
        now: Date.now(),
        lastRefreshAt: lastRefreshAtRef.current,
        minIntervalMs: backgroundRefreshMinMs(),
        connected: gbStatusRef.current?.connected === true,
        syncing: syncingRef.current,
        visibility: typeof document === "undefined" ? "visible" : document.visibilityState,
      });
      if (!fire) return false;
      // Stamp on START, not on completion: visibilitychange and focus land in
      // the same tick, and only an immediately-written stamp guarantees the
      // second one is refused. The 15-minute interval is the retry safety net.
      lastRefreshAtRef.current = Date.now();
      void syncFromGreenButton().then((outcome) => {
        if (outcome.ok) setGbRefreshTick((t) => t + 1);
      });
      return true;
    };

    async function init() {
      // localStorage FIRST: it decides both the visible window and whether
      // there is anything at all to show, and neither answer needs the network.
      let loadedReadings = false;
      try {
        // Reads go through the storage layer: it migrates a legacy
        // `energy_data` payload to `energy_data_v2` on the way in, and hands
        // back a failure instead of throwing, so a corrupt value becomes a
        // visible notice rather than a silently empty dashboard.
        const dayRes = loadBillingDay();
        const savedDay = dayRes.ok ? dayRes.value : null;
        const day = savedDay ?? 1;
        if (savedDay !== null && mounted) setBillingDayState(day);
        else if (!dayRes.ok) reportStorage(dayRes);

        const stored = loadEnergyData();
        // The bills live under their OWN key, and a gas extract commits ZERO
        // electric DataPoints — its whole dataset is the billing summaries.
        // "Is there anything to show?" therefore has to ask BOTH halves of
        // storage, or every reload of a summary-only dashboard claims to be
        // empty and blocks the screen with the first-run modal over data that
        // is already stored (defect R1: gas import → reload → false-empty).
        const bills = readStoredBillFeed().summaries;
        // The GAS half lives under its own keys (t_8a9038d6): a gas-only
        // browser has ZERO electric points and ZERO electric periods, so
        // asking only the electric halves would reopen the first-run modal
        // over stored data — defect R1 in the new key space. Unreadable gas
        // storage is treated exactly like unreadable electric storage: say
        // so, and prompt, rather than claim empty when we cannot tell.
        const gasStored = loadGasData();
        const gasPoints = gasStored.ok && gasStored.value ? gasStored.value.points.length : 0;
        const gasBills = readStoredGasBillFeed().summaries;
        if (!gasStored.ok) reportStorage(gasStored);
        if (!stored.ok) {
          // Unreadable storage: say so, and open the upload prompt — the
          // dashboard must not claim to be empty when it cannot tell.
          reportStorage(stored);
          if (mounted) setShowUploadModal(true);
        } else if (!gasStored.ok) {
          if (mounted) setShowUploadModal(true);
        } else if (
          (stored.value?.points.length ?? 0) > 0 ||
          bills.length > 0 ||
          gasPoints > 0 ||
          gasBills.length > 0
        ) {
          // No electric data but a gas dataset in storage ⇒ the section this
          // browser actually has data for is Gas: open on it instead of an
          // empty Electricity section (the stored selection, if any, wins
          // only when it still has data to show).
          if (
            (stored.value?.points.length ?? 0) === 0 &&
            bills.length === 0 &&
            (gasPoints > 0 || gasBills.length > 0) &&
            commodityRef.current === 'electricity'
          ) {
            setCommodity('gas');
          }
          if (mounted) {
            const parsed = stored.value?.points ?? [];
            // Summary-only storage restores the BILLS half only: there are no
            // rows to ref, no window to anchor (a file with no periods never
            // reaches applyInitialWindow), and no rates fetch — exactly the
            // state a Cancel left the user in, minus the modal.
            if (parsed.length > 0) {
              loadedReadings = true;
              // Ref first: the Green Button sync runs later in THIS same init
              // pass and must see what was just restored.
              rawDataRef.current = parsed;
              setRawData(parsed);
              // A reload must keep saying "this is example data" if it is.
              if (localStorage.getItem(EXAMPLE_DATA_KEY) === "1") setExampleData(true);
              applyInitialWindow(parsed, day, bills);
            }
          }
          // Migration warnings (quota / cleanup) still surface.
          reportStorage(stored);
        } else if (mounted) {
          setShowUploadModal(true);
        }
      } catch (err) {
        // Nothing the storage layer classified: still a visible failure —
        // never a crash, and never a silently empty dashboard.
        if (mounted) {
          setStorageNotice({ kind: "corrupt", detail: `Storage read failed: ${String(err)}` });
          setShowUploadModal(true);
        }
      }

      // Wave I item 4 — with no readings the rate schedule has nothing to
      // price and the dashboard renders identically with or without it, so
      // leave the loading shell BEFORE the network round trip instead of
      // after it. Under Lighthouse's mobile throttling that round trip was the
      // LCP critical path: the first large paint was the upload modal's
      // paragraph, which only existed once /api/rates had answered. With
      // readings we still wait, so a plan card can never paint a price
      // computed from an empty rate set.
      if (mounted && !loadedReadings) setLoading(false);

      if (loadedReadings) {
        rateRequestStartedRef.current = true;
        try {
          const res = await fetch("/api/rates");
          const json = await res.json();
          if (mounted) setRateHistory(json.historicalRates || []);
        } catch { /* rate fetch failure degrades to empty history; math returns [] */ }
      }

      if (mounted && loadedReadings) setLoading(false);

      /* --- Wave K: Green Button live sync -----------------------------
       * Status first (one cheap request), then a pull if this browser is
       * authorised. Runs whether or not the OAuth callback just landed, so
       * an ordinary page load is also a refresh — that is the whole point
       * of the feature. The `?gb=` flags come from /greenbutton/callback
       * and are stripped before they can be replayed by a reload.
       */
      const params = new URLSearchParams(window.location.search);
      const gbFlag = params.get("gb");
      if (gbFlag) window.history.replaceState({}, "", window.location.pathname);

      const status = await fetchGbStatus();
      if (!mounted || !status) return;
      gbStatusRef.current = status;
      setGbStatus(status);

      if (gbFlag === "connected") {
        setGbMessage({ tone: "ok", text: t('gb.connectedOk') });
      } else if (gbFlag?.startsWith("error:")) {
        const copy = describeGbError(gbFlag.slice("error:".length));
        setGbMessage({ tone: "error", text: `${copy.headline} — ${copy.detail}` });
      }

      /* --- Wave M: the background loop exists ONLY for an authorised browser.
       * A manual-DMD-only profile (no `gb_session`) leaves here with no timer,
       * no listeners and no periodic sync — scope 4 of the card, enforced at
       * the source rather than by every callback re-checking it.
       */
      if (!status.connected) return;

      // A feed the service worker already fetched (periodic background sync
      // while the app was closed): merge it FIRST, so the pull below can ask
      // for as little as possible.
      const staged = await drainStagedFeed();
      if (staged?.ok && mounted) setGbRefreshTick((t) => t + 1);

      const outcome = await syncFromGreenButton();
      if (outcome.ok && mounted) setGbRefreshTick((t) => t + 1);
      if (mounted && gbFlag === "connected") {
        setGbMessage(
          outcome.ok
            ? {
                tone: "ok",
                text: outcome.picker
                  ? t('gb.connectedPicker')
                  : t('gb.syncCounts', {
                      incoming: outcome.incoming,
                      added: outcome.added ?? 0,
                    }),
              }
            : { tone: "error", text: outcome.detail ?? describeGbError(outcome.code).detail },
        );
      }

      // Wave K's 15-minute visible-tab poll, unchanged in cadence but now
      // routed through the shared gate so interval/focus/visibility cannot
      // stack requests on top of each other.
      poller = setInterval(() => {
        if (!mounted) return;
        runBackgroundRefresh("interval");
      }, 15 * 60 * 1000);

      // Wave M: the tab came back — refresh now rather than after up to 15
      // minutes. A restored window fires BOTH of these; the throttle written
      // at the start of a refresh is what makes that one request, not two.
      onVisibilityChange = () => {
        if (!mounted || document.visibilityState !== "visible") return;
        runBackgroundRefresh("visibility");
      };
      onFocus = () => {
        if (!mounted) return;
        runBackgroundRefresh("focus");
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("focus", onFocus);

      // The service worker staged a feed while this window was open.
      onSwMessage = (event: MessageEvent) => {
        // Only OUR service worker may drive a refresh. Without this, any
        // window that can reach this origin (an embedded frame, a `window.open`
        // handle it kept) could post this message and force repeated cache
        // reads and XML parses of a multi-megabyte feed — and make the app
        // claim a refresh happened when it did not. `drainStagedFeed` returns
        // nothing to the sender, so this is a work-amplification and
        // trust-boundary bug, not an exfiltration one.
        const fromWorker = event.source as unknown;
        if (fromWorker !== (navigator.serviceWorker as unknown)) return;
        if (event.origin !== self.location.origin) return;
        if (!mounted || event.data?.type !== GB_STAGED_MESSAGE) return;
        void drainStagedFeed().then((got) => {
          if (got?.ok) setGbRefreshTick((t) => t + 1);
        });
      };
      if (typeof navigator !== "undefined" && navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener("message", onSwMessage);
      }

      // Chromium + installed app only; never prompts, never throws, and the
      // settings drawer prints whichever state comes back (see lib/periodicSync).
      void registerGreenButtonPeriodicSync().then((state) => {
        if (mounted) setBackgroundSync(state);
      });
    }
    init();
    return () => {
      mounted = false;
      if (poller) clearInterval(poller);
      if (onVisibilityChange) document.removeEventListener("visibilitychange", onVisibilityChange);
      if (onFocus) window.removeEventListener("focus", onFocus);
      if (onSwMessage && typeof navigator !== "undefined" && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener("message", onSwMessage);
      }
    };
    // One-shot bootstrap by design: it reads live state through refs, so
    // re-running it on every render would double-sync instead of fixing
    // staleness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A first-time visitor needs no rate schedule. If they later load readings,
  // request it then; stored readings are fetched by the bootstrap above.
  useEffect(() => {
    if (rawData.length === 0 || rateRequestStartedRef.current) return;
    rateRequestStartedRef.current = true;
    let active = true;
    void fetch("/api/rates")
      .then((res) => res.json())
      .then((json) => {
        if (active) setRateHistory(json.historicalRates || []);
      })
      .catch(() => { /* rate fetch failure degrades to empty history; math returns [] */ });
    return () => { active = false; };
  }, [rawData]);

  /**
   * Accept ONE file (the historical path, unchanged) or 2+ files at once.
   *
   * Multi-file never merges on the spot: the readings go to the merge review
   * screen first, which shows the merged range, the row count and how many
   * timestamps were dropped before anything touches localStorage.
   */
  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setParsing(true);

    const parseOne = (file: File): Promise<MergeFileChoice> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () =>
          reject({
            ok: false,
            headline: t('upload.couldNotRead', { name: file.name }),
            detail: t('upload.readFailedDetail'),
            hints: [t('upload.readFailedHint')],
          } satisfies ParseDiagnostic);
        reader.onload = (ev) => {
          const text = (ev.target?.result as string) ?? "";
          let feed: GreenButtonFeed;
          try {
            feed = parseGreenButtonFeed(text);
          } catch (e) {
            // A document-level refusal already carries its own headline,
            // reason and hints (greenbutton/limits.ts) — showing it as itself
            // is the one thing better than explaining the raw text.
            if (isGreenButtonRefusal(e)) {
              reject({
                ok: false,
                headline: e.headline,
                detail: e.detail,
                hints: e.hints,
              } satisfies ParseDiagnostic);
              return;
            }
            // Security refusals (external entities) and malformed markup land
            // here: explain the document instead of repeating the exception.
            const diag = diagnoseGreenButtonDocument(text, 0);
            reject(
              diag.ok
                ? ({
                    ok: false,
                    headline: t('upload.couldNotRead', { name: file.name }),
                    detail: String((e as Error)?.message ?? e),
                    hints: [t('upload.redownloadHint')],
                  } satisfies ParseDiagnostic)
                : diag,
            );
            return;
          }
          const groups = feed.groups;
          // The gate counts gas volume rows too — see countUsableRows.
          const readings = countUsableRows(groups);
          // Commodity 7 enrichment (gas bill surfaces) — same one-pass rule
          // as ingestFeedXml: decide interval-block ownership and supplier
          // labels with the whole file in hand, store them ON the summaries.
          const summaries = isGasFeed(feed.summaries) ? enrichGasSummaries(feed) : feed.summaries;
          // Commodity split (t_8a9038d6): the bill half rides along with the
          // readings and is held until the user actually imports — but each
          // half goes to ITS commodity's pending list. A file that carries no
          // electric rows contributes NOTHING to `billFeedsRef`, which is what
          // stops a gas upload from handing the electricity commit an empty
          // (or worse, a gas) feed to replace with.
          const split = splitSummaries(summaries);
          const electricRows = groups.reduce((n, g) => n + g.readings.length, 0);
          const gasPoints = extractGasPoints(groups);
          if (electricRows > 0) {
            billFeedsRef.current.push({
              summaries: split.electric,
              localTime: feed.localTime,
              source: file.name,
            });
          }
          if (gasPoints.length > 0) {
            gasBillFeedsRef.current.push({
              summaries: split.gas,
              localTime: feed.localTime,
              source: file.name,
            });
            for (const gp of gasPoints) gasPointsRef.current.push(gp);
          }
          // A single-meter file is pre-picked; a multi-meter one stays null
          // until the review screen asks.
          resolve({
            name: file.name,
            groups,
            chosen: groups.length === 1 ? 0 : null,
            // The refusals ride with the rows, the same way the bills do: the
            // notice is raised by the commit that actually imports them.
            notes: feed.notes,
            // The bills ride with the readings: the first-load window is
            // chosen in the same call that imports them.
            summaries,
            ...(readings === 0 ? { issue: diagnoseGreenButtonDocument(text, 0) } : {}),
          });
        };
        reader.readAsText(file);
      });

    setParseIssue(null);
    clearPendingFeeds();
    Promise.all(files.map(parseOne))
      .then((results) => {
        const total = results.reduce((n, r) => n + countUsableRows(r.groups), 0);
        if (total === 0) {
          // Nothing readable: keep the modal open and say exactly why, and
          // drop the bills parsed out of the same unreadable batch.
          clearPendingFeeds();
          reportDetection(false, false);
          setParseIssue(
            results.map((r) => r.issue).find(Boolean) ?? {
              ok: false,
              headline: t('upload.noReadingsHeadline'),
              detail: t('upload.noReadingsDetail'),
              hints: [t('upload.noReadingsHint')],
            },
          );
          return;
        }

        if (results.length === 1) {
          const only = results[0];
          if (only.groups.length > 1) {
            // Held until the picker commits: cancelling must leave the bills
            // the user already had alone (and raise no refusal row).
            setPendingUpload({
              fileName: only.name,
              groups: only.groups,
              summaries: only.summaries,
              notes: only.notes,
            });
            setShowUploadModal(false);
            return;
          }
          // ONE document, possibly TWO commodities. Each half is committed
          // only when the document actually carries rows for it — an empty
          // commit is a wipe, and wiping the other commodity's bucket with an
          // upload that never contained it is the defect this card closes.
          const split = splitFeed({ groups: only.groups, summaries: only.summaries ?? [] });
          if (split.gas.length > 0) {
            commitGasReadings(split.gas, 'replace', split.gasSummaries, only.notes);
            commitGasBillFeed('replace');
          }
          if (split.electric.length > 0) {
            // An upload REPLACES: this file is what the user asked to see, so
            // an unrelated upload also replaces the panel (to nothing, if it
            // carried no bills) instead of leaving a stranger's bill on screen.
            commitReadings(split.electric, 'upload', split.electricSummaries, only.notes);
            commitBillFeed('replace');
          }
          // Open the section the file actually filled — and say which one it
          // was, rather than leaving the user on the other dataset wondering
          // whether the upload worked.
          const presence = commodityPresence(split);
          reportDetection(presence.electricity, presence.gas);
          const primary = primaryCommodity(split);
          if (primary) setCommodity(primary);
          clearPendingFeeds();
          return;
        }
        const hasElectricRows = results.some((r) => r.groups.some((g) => g.readings.length > 0));
        if (!hasElectricRows) {
          // Every file in the batch is gas: there is no electric range for
          // the merge review to show, so an empty review screen would be a
          // dead end. Commit the gas bucket directly — the user still
          // confirmed the upload, and nothing about the electric dataset is
          // addressed here.
          commitGasReadings(
            gasPointsRef.current,
            'replace',
            undefined,
            results.flatMap((r) => r.notes ?? []),
          );
          commitGasBillFeed('replace');
          reportDetection(false, true);
          setCommodity('gas');
          clearPendingFeeds();
          return;
        }
        setPendingMerge(results);
        setShowUploadModal(false);
      })
      .catch((e) => {
        clearPendingFeeds();
        setParseIssue(
          isParseDiagnostic(e)
            ? e
            : {
                ok: false,
                headline: t('upload.couldNotReadPlain'),
                detail: String((e as Error)?.message ?? e),
                hints: [t('upload.portalRedownloadHint')],
              },
        );
      })
      .finally(() => setParsing(false));
  };

  /**
   * Import the rows the merge review screen computed.
   *
   * The review screens ELECTRICITY (its merged range is an electric range),
   * so the gas intervals the same batch parsed ride along and commit with
   * it: one confirmation, both commodities, neither silently dropped.
   */
  const chooseMerge = (readings: DataPoint[]) => {
    const files = pendingMerge ?? [];
    setPendingMerge(null);
    const gasPoints = gasPointsRef.current;
    if (readings.length > 0) {
      // Every file in the merge review, bills included: the axis de-dupes
      // periods that two exports describe differently. The refusals from the
      // same files ride along — one review, one import, one notice.
      commitReadings(
        readings,
        "upload",
        files.flatMap((f) => splitSummaries(f.summaries ?? []).electric),
        files.flatMap((f) => f.notes ?? []),
      );
      // The merged dataset IS those files, bills included (replace).
      commitBillFeed("replace");
    }
    if (gasPoints.length > 0) {
      commitGasReadings(
        gasPoints,
        "replace",
        undefined,
        files.flatMap((f) => f.notes ?? []),
      );
      commitGasBillFeed("replace");
    }
    reportDetection(
      readings.length > 0 || files.some((f) => (f.summaries ?? []).some((s) => !isGasSummary(s))),
      gasPoints.length > 0 || files.some((f) => (f.summaries ?? []).some((s) => isGasSummary(s))),
    );
    if (readings.length === 0 && gasPoints.length === 0) clearPendingFeeds();
  };

  /** Back out of the merge review without importing anything. */
  const cancelMerge = () => {
    setPendingMerge(null);
    clearPendingFeeds();
    setShowUploadModal(true);
  };

  /**
   * Load exactly the rows the user picked (one UsagePoint, or all of them).
   *
   * An UPLOAD replaces: the file the user chose is what they want to see.
   * A live-sync pick MERGES: the feed is one more source of truth, and
   * choosing a meter must not delete the history already in the browser.
   */
  const chooseUsagePoint = (readings: DataPoint[]) => {
    const pick = pendingUpload;
    const origin = pick?.origin;
    setPendingUpload(null);
    if (readings.length === 0) {
      // A multi-UsagePoint GAS file: no electric row to pick, but the volume
      // intervals are real data the user just chose to import. Commit them to
      // the gas bucket — never to `energy_data_v2`, which is what an empty
      // electric pick used to leave behind.
      if (gasPointsRef.current.length > 0) {
        commitGasReadings(gasPointsRef.current, "replace", undefined, pick?.notes);
        commitGasBillFeed("replace");
        setCommodity("gas");
      }
      return;
    }
    // The refusals the file carried are raised by the commit below: choosing a
    // point is what makes the import real, so a cancelled pick never shows it.
    if (origin === "greenbutton") {
      commitReadings(mergeForWrite(rawDataRef.current, readings), "upload", pick?.summaries, pick?.notes);
      commitBillFeed("union");
      // A live-sync pick can also carry volume (a multi-commodity feed):
      // union it into the gas bucket with the same commit.
      if (gasPointsRef.current.length > 0) {
        commitGasReadings(gasPointsRef.current, "union", undefined, pick?.notes);
        commitGasBillFeed("union");
      }
      return;
    }
    commitReadings(readings, "upload", pick?.summaries, pick?.notes);
    commitBillFeed("replace");
  };

  /** Back out of the picker without importing anything. */
  const cancelUsagePoint = () => {
    setPendingUpload(null);
    clearPendingFeeds();
    setShowUploadModal(true);
  };

  /**
   * Wave H item 1 — "Try with example data".
   *
   * Fetches the bundled synthetic export and pushes it through the SAME
   * parser + commit path as a real upload: no privileged second route to
   * keep working, and a failure explains itself instead of opening an empty
   * dashboard (the whole point of the button is someone with no export).
   */
  const loadExampleData = async (): Promise<{ ok: boolean; detail?: string }> => {
    setParsing(true);
    setParseIssue(null);
    try {
      const loaded = await loadExampleReadings();
      if (!loaded.ok) {
        setParseIssue({
          ok: false,
          headline: t('upload.exampleUnavailable'),
          detail: loaded.detail,
          hints: [t('upload.exampleHint')],
        });
        return { ok: false, detail: loaded.detail };
      }
      commitReadings(loaded.readings, "example");
      // The bundled export carries no bills: an example dataset must not
      // keep showing a real customer's actual bill next to fake readings.
      // ELECTRICITY ONLY — the example set is synthetic kWh, so it has no
      // business clearing a gas bill feed it never contained.
      clearPendingFeeds();
      billFeedsRef.current = [EMPTY_BILL_FEED];
      commitBillFeed("replace");
      return { ok: true };
    } finally {
      setParsing(false);
    }
  };

  /**
   * Drop the example set and reopen the upload prompt. Readings are the one
   * thing this app owns, so it is explicit: the example data goes away, the
   * user's own file replaces it.
   */
  const discardExampleData = () => {
    // Readings: both keys, through the storage layer. The example flag and
    // the feed half are this hook's own keys (they have no storage.ts shape).
    reportStorage(clearEnergyData());
    try {
      localStorage.removeItem(EXAMPLE_DATA_KEY);
      localStorage.removeItem(USAGE_SUMMARIES_KEY);
      localStorage.removeItem(LOCAL_TIME_KEY);
    } catch { /* nothing to remove */ }
    billFeedRef.current = EMPTY_BILL_FEED;
    setBillFeed(EMPTY_BILL_FEED);
    setRawData([]);
    setExampleData(false);
    setParseIssue(null);
    setPendingUpload(null);
    setPendingMerge(null);
    // Nothing was imported any more, so there is nothing to explain.
    setRefusalNotes([]);
    setStartDate("");
    setEndDate("");
    setViewScope("BillingPeriod");
    setShowUploadModal(true);
  };

  const openResetConfirm = () => {
    // Read the key list NOW so the dialog states exactly what it will remove.
    const listed = listOurStoredKeys(APP_OWNED_STORAGE_KEYS);
    setResetKeys(listed.ok ? listed.value : []);
    setResetConfirmOpen(true);
  };

  const cancelResetConfirm = () => setResetConfirmOpen(false);

  /**
   * Step 2 of reset: remove THIS app's keys and nothing else, then reload
   * into an empty profile. `localStorage.clear()` is gone — it also wiped
   * whatever else shared the origin.
   */
  const confirmReset = () => {
    setResetConfirmOpen(false);
    const removed = resetStoredData(APP_OWNED_STORAGE_KEYS);
    if (!removed.ok) {
      // Nothing (or too little) came out: say it instead of pretending.
      reportStorage(removed);
      return;
    }
    window.location.reload();
  };

  /** Persist a new billing day; re-anchor the BillingPeriod scope onto it. */
  const updateBillingDay = (day: number, anchorStart: string) => {
    setBillingDayState(day);
    // Only a whole day in 1..31 reaches storage: a half-typed value is not
    // data yet (the old blind write happily stored "NaN", which the next load
    // then had to defend against).
    if (Number.isInteger(day) && day >= 1 && day <= 31) reportStorage(saveBillingDay(day));
    if (!day || day < 1 || day > 31) return; // typing in progress; skip re-anchor
    // A file that states its own periods ignores this setting (it is the
    // fallback for files that do not), so re-anchoring the window onto a
    // synthetic billing-day period would move the view off the timeline the
    // file actually defines. Persist the value, leave the window alone.
    if (billFeed.summaries.length > 0) return;
    // Use the middle of the current period to re-anchor.
    const anchorDate = anchorStart ? new Date(anchorStart + "T00:00:00") : new Date();
    const anchor = addDays(anchorDate, 15);
    const p = getBillingPeriod(anchor, day);
    setStartDate(format(p.start, "yyyy-MM-dd"));
    setEndDate(format(p.end, "yyyy-MM-dd"));
  };

  /** Re-anchor startDate/endDate when a scope button is clicked (and record the scope). */
  const applyViewScope = (scope: "BillingPeriod" | "Month" | "YTD") => {
    setViewScope(scope);
    if (scope === "BillingPeriod") {
      // The file's period holding "now" (clamped to the newest reading, so a
      // feed that stops weeks ago opens on the period it actually covers
      // rather than an empty current one). Falls back to billing_day when the
      // file states no periods at all.
      const anchor = anchorTimestamp(rawData) ?? Math.floor(Date.now() / 1000);
      const period = periodAt(axis, anchor);
      if (period) {
        const w = dateWindowOf(period);
        setStartDate(w.start);
        setEndDate(w.end);
        return;
      }
      const p = getBillingPeriod(new Date(), billingDay);
      setStartDate(format(p.start, "yyyy-MM-dd"));
      setEndDate(format(p.end, "yyyy-MM-dd"));
    } else if (scope === "Month") {
      setStartDate(format(startOfMonth(new Date()), "yyyy-MM-dd"));
      setEndDate(format(lastDayOfMonth(new Date()), "yyyy-MM-dd"));
    } else {
      setStartDate(format(new Date(new Date().getFullYear(), 0, 1), "yyyy-MM-dd"));
      setEndDate(format(new Date(), "yyyy-MM-dd"));
    }
  };

  /**
   * Serialize everything this browser holds (readings, billing day, bill
   * add-ons, plan timeline) into a versioned JSON document. Returns null when
   * there is nothing to back up — the drawer reports that instead of writing
   * an empty file that would wipe data if restored.
   */
  const exportBackup = (): BackupExport | null => {
    if (rawData.length === 0) return null;
    const now = new Date();
    const doc = buildBackupDocument({
      energyData: rawData,
      billingDay,
      extraCharges: readStoredExtraCharges(),
      planTimeline: readStoredTimeline(),
      // Wave N (backup v2): a restore should put back the whole picture, not
      // just the readings — the plan and the example-data banner are part of
      // what the user was looking at when they exported.
      selectedPlan: readStoredPlan(),
      isExample: exampleData,
      exportedAt: now,
    });
    return { filename: backupFilename(now), text: serializeBackup(doc) };
  };

  /**
   * Restore a previously exported file — BOTH shapes this app writes:
   *  - Wave G's full profile document (readings + billing day + bill add-ons
   *    + plan timeline), and
   *  - the readings-only export storage.ts produces (an object with `points`,
   *    or a bare array of rows).
   *
   * Validation happens BEFORE any write: a rejected file leaves the existing
   * profile completely untouched (import is all-or-nothing, never partial).
   * The readings and the billing day land through storage.ts, so an import
   * writes exactly the versioned key a manual upload writes.
   */
  const importBackupFile = async (file: File): Promise<BackupImportResult> => {
    let text: string;
    try {
      text = await file.text();
    } catch {
      return { ok: false, error: t('backup.errReadJson', { name: file.name }) };
    }

    const profile = parseBackup(text);
    if (profile.ok) {
      try {
        const values = storageValuesFromBackup(profile.value);
        // Readings first: if this fails nothing else is written, which keeps
        // the all-or-nothing promise above.
        const saved = saveEnergyData(profile.value.payload.energy_data, {
          source: "backup-import",
          uploadedAt: profile.value.exportedAt,
        });
        if (!saved.ok) {
          reportStorage(saved);
          return { ok: false, error: t('backup.errRefused', { detail: saved.detail }) };
        }
        const day = saveBillingDay(profile.value.payload.billing_day);
        if (!day.ok) {
          reportStorage(day);
          return { ok: false, error: t('backup.errRefusedBillingDay', { detail: day.detail }) };
        }
        // Everything else in the document is owned by the hook that reads it
        // (charges, timeline, plan, example flag). Same contract the account
        // sync uses (lib/account/sync.ts): an empty value means "clear this
        // flag", so a restore cannot leave a stale demo banner behind (Wave N).
        for (const [key, value] of Object.entries(values)) {
          if (key === "energy_data" || key === "billing_day") continue;
          if (value === "") localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      } catch {
        return {
          ok: false,
          error: t('backup.errRefusedBackup'),
        };
      }
      onBackupApplied?.();
      return { ok: true, filename: file.name };
    }

    // Not a profile document — accept the readings-only export instead of
    // making two export buttons produce files only one of them can read back.
    const readings = parseImport(text);
    if (readings.ok) {
      const saved = saveEnergyData(readings.value.points, {
        source: readings.value.source,
        uploadedAt: readings.value.uploadedAt,
      });
      if (!saved.ok) {
        reportStorage(saved);
        return { ok: false, error: t('backup.errRefused', { detail: saved.detail }) };
      }
      onBackupApplied?.();
      return { ok: true, filename: file.name };
    }

    // Neither shape: the profile reader's message is the one that names the
    // document this app asks for.
    return { ok: false, error: profile.error };
  };

  /** Re-read /greenbutton/status (connect button, post-disconnect, tests). */
  const refreshGbStatus = async (): Promise<GbStatus | null> => {
    const status = await fetchGbStatus();
    gbStatusRef.current = status;
    setGbStatus(status);
    return status;
  };

  /**
   * Drop the authorisation: wipes the token file on .110 through the shim,
   * then re-reads status so the UI flips back to "not connected".
   */
  const disconnectGreenButton = async (): Promise<boolean> => {
    const ok = await disconnectGb();
    // Wave M: a background loop that outlives the grant it depends on would
    // keep asking the utility for data this browser is no longer allowed to
    // read — drop it with the authorisation.
    if (ok) {
      void unregisterGreenButtonPeriodicSync();
      // …and drop whatever the worker staged. `oeo-gb-staged` holds a full
      // ESPI feed — real meter readings — and it is deliberately exempt from
      // the version scrub, so it outlives deploys by design. Stopping the sync
      // alone would leave a periodic-sync feed staged while the app was closed
      // sitting on disk AFTER the user revoked the authorisation. Delete it
      // with the grant.
      void caches.delete(GB_STAGED_CACHE).catch(() => undefined);
      void caches.delete(GB_CURSOR_CACHE).catch(() => undefined);
      setBackgroundSync("unconfigured");
    }
    await refreshGbStatus();
    setGbMessage(
      ok
        ? { tone: "ok", text: t('gb.disconnectedOk') }
        : { tone: "error", text: t('gb.disconnectFail') },
    );
    return ok;
  };

  const startGreenButtonConnect = () => {
    // Full page navigation, deliberately NOT router.push: the shim answers
    // with a 302 to the utility's login page, and only a top-level
    // navigation carries the origin through the OAuth round trip (and lets
    // the callback set the session cookie).
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/greenbutton/start");
  };

  return {
    rawData, rateHistory, loading, parsing,
    // Wave L: the bill half of the feed (UsageSummary periods + its clock)
    billFeed,
    // Commodity isolation (t_8a9038d6): the gas datasets + which section is
    // showing. `setCommodity` is a VIEW switch only — it never routes a write.
    gasData, gasBillFeed, commodity, setCommodity,
    // What the last import was detected as (reported, never guessed)
    commodityNotice, dismissCommodityNotice,
    showUploadModal, setShowUploadModal,
    billingDay, startDate, endDate, setStartDate, setEndDate,
    viewScope, setViewScope,
    handleFileUpload, updateBillingDay, applyViewScope,
    // Storage surfacing + a two-step, scoped reset (t_a8a54e33).
    storageNotice, dismissStorageNotice, raiseStorageNotice,
    // What the last committed import refused to price (t_880370e6).
    refusalNotes, dismissRefusalNotes,
    resetConfirmOpen, resetKeys,
    openResetConfirm, cancelResetConfirm, confirmReset,
    pendingUpload, chooseUsagePoint, cancelUsagePoint,
    pendingMerge, setPendingMerge, chooseMerge, cancelMerge,
    exportBackup, importBackupFile,
    parseIssue, setParseIssue,
    exampleData, loadExampleData, discardExampleData,
    // Green Button live sync (Wave K)
    gbStatus, gbSyncing, gbMessage, setGbMessage,
    syncFromGreenButton, refreshGbStatus, disconnectGreenButton, startGreenButtonConnect,
    // Background refresh + alerts (Wave M)
    gbRefreshTick, backgroundSync,
    // The file's own timeline — prev/next navigation reads it through a
    // getter in Dashboard so it never steps through a stale copy.
    axis,
  };
}

export type ZoomLevel = "monthly" | "weekly" | "daily" | "hourly";

/**
 * Zoom + period navigation.
 *
 * Fix for the original clamp bug: navigatePeriod used to widen the scope when
 * `next < startDate` as a STRING compare. That breaks whenever zoomTarget's
 * format (weekly = yyyy-MM, daily/hourly = yyyy-MM-dd) does not lexically
 * align with startDate's format (full yyyy-MM-dd) — "" < anything is true, so
 * an empty startDate made every step "widen". We now compare REAL Date
 * timestamps against the numeric scope window, so nav clamping is correct no
 * matter how the user arrived at the current scope.
 */
export function useZoomNavigation(
  startDate: string,
  endDate: string,
  setStartDate: (d: string) => void,
  setEndDate: (d: string) => void,
  getViewScope: () => ViewScope,
  getBillingDay: () => number,
  /** The file's own timeline; null/absent ⇒ the billing-day fallback. */
  getAxis?: () => BillingAxis | null,
) {
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>("monthly");
  const [zoomTarget, setZoomTarget] = useState<string | null>(null);

  const handleBarClick = (item: { key?: string } | null) => {
    if (!item || !item.key) return;
    if (zoomLevel === "monthly") { setZoomLevel("weekly"); setZoomTarget(item.key); }
    else if (zoomLevel === "weekly") { setZoomLevel("daily"); setZoomTarget(item.key); }
    else if (zoomLevel === "daily") { setZoomLevel("hourly"); setZoomTarget(item.key); }
  };

  const goBack = () => {
    if (zoomLevel === "hourly") setZoomLevel("daily");
    else if (zoomLevel === "daily") setZoomLevel("weekly");
    else if (zoomLevel === "weekly") setZoomLevel("monthly");
    setZoomTarget(null);
  };

  const setZoomLevelAndClear = (l: ZoomLevel) => { setZoomLevel(l); setZoomTarget(null); };

  const navigatePeriod = (dir: "prev" | "next") => {
    const step = dir === "next" ? 1 : -1;

    // --- ZOOMED: step the zoom target, then widen the scope window if needed.
    if (zoomTarget) {
      const cur = new Date((zoomLevel === "weekly" ? zoomTarget + "-01" : zoomTarget) + "T00:00:00");
      if (zoomLevel === "weekly") {
        cur.setMonth(cur.getMonth() + step);
      } else if (zoomLevel === "daily") {
        cur.setDate(cur.getDate() + step * 7);
      } else if (zoomLevel === "hourly") {
        cur.setDate(cur.getDate() + step);
      } else {
        return; // no period nav while at monthly overview (no target anyway)
      }
      const next = format(cur, zoomLevel === "weekly" ? "yyyy-MM" : "yyyy-MM-dd");
      setZoomTarget(next);

      const nextMs = new Date(
        (zoomLevel === "weekly" ? next + "-01" : next) + "T00:00:00",
      ).getTime();
      const spanMs =
        zoomLevel === "hourly" ? 86400000
        : zoomLevel === "daily" ? 7 * 86400000
        : 31 * 86400000; // weekly/month steps are ≤ one calendar month
      const curStartMs = new Date(startDate + "T00:00:00").getTime();
      const curEndMs = new Date(endDate + "T23:59:59").getTime();

      if (nextMs < curStartMs) setStartDate(next);
      if (nextMs + spanMs > curEndMs) setEndDate(next);
      return;
    }

    // --- UNZOOMED: page the scope window itself.
    const s = new Date(startDate + "T00:00:00");
    if (getViewScope() === "Month") {
      const target = dir === "next" ? addMonths(s, 1) : subMonths(s, 1);
      setStartDate(format(startOfMonth(target), "yyyy-MM-dd"));
      setEndDate(format(lastDayOfMonth(target), "yyyy-MM-dd"));
      return;
    }
    // BillingPeriod steps through the FILE's periods when the file has them
    // (this is the whole point of the billing axis): prev/next moves one
    // real bill — or one gap, or the open tail — at a time, and stops at
    // either end rather than wrapping from your newest bill to your oldest.
    const axis = getAxis?.() ?? null;
    if (getViewScope() === "BillingPeriod" && axis && axis.periods.length > 0) {
      // Mid-window, not the start: a window can begin a few hours before its
      // period does (the stamps are UTC, the date inputs are local days), and
      // an anchor outside every period would step nowhere at all.
      const startMs = new Date(startDate + "T00:00:00").getTime();
      const endMs = new Date(endDate + "T23:59:59").getTime();
      const mid = Math.floor((startMs + endMs) / 2 / 1000);
      const next = stepPeriod(axis, mid, dir);
      if (!next) return;
      const w = dateWindowOf(next);
      setStartDate(w.start);
      setEndDate(w.end);
      return;
    }
    // Custom (and a file with no periods) re-anchors through getBillingPeriod
    // using the billing-day anchor — the pre-axis behavior, kept as fallback.
    const target = dir === "next" ? addMonths(s, 1) : subMonths(s, 1);
    const p = getBillingPeriod(target, getBillingDay());
    setStartDate(format(p.start, "yyyy-MM-dd"));
    setEndDate(format(p.end, "yyyy-MM-dd"));
  };

  return { zoomLevel, setZoomLevel, zoomTarget, handleBarClick, goBack, setZoomLevelAndClear, navigatePeriod };
}

/* --------------------------------------------------------------------------
 * Local bill add-ons (delivery / regulatory / HST).
 *
 * These are user-owned inputs, never fetched: /api/rates only carries OEB
 * commodity rates, which are a different (and much smaller) part of the bill.
 * Every field seeds empty and stays empty until the user types something, so
 * the estimate behaves exactly as it did before this feature existed.
 * -------------------------------------------------------------------------- */

export const EXTRA_CHARGES_KEY = "extra_charges";

/**
 * Every OTHER localStorage key this app owns — the readings' companions that
 * a "Reset data" has to clear, or they outlive their own data (a plan choice
 * and bill add-ons with no readings left to apply them to).
 *
 * `energy_data_v2` / `energy_data` / `billing_day` are NOT listed here:
 * storage.ts owns those and adds them itself. Declared after the constants it
 * references because module-level const initialisers run in source order.
 */
export const APP_OWNED_STORAGE_KEYS: readonly string[] = [
  EXAMPLE_DATA_KEY,
  USAGE_SUMMARIES_KEY,
  LOCAL_TIME_KEY,
  GAS_USAGE_SUMMARIES_KEY,
  GAS_LOCAL_TIME_KEY,
  COMMODITY_STORAGE_KEY,
  EXTRA_CHARGES_KEY,
  PLAN_TIMELINE_KEY,
  PLAN_STORAGE_KEY,
  TAB_STORAGE_KEY,
  ESTIMATE_LEDGER_KEY,
  PLAN_ACK_KEY,
  RATE_ACK_KEY,
  NOTIFIED_KEY,
  NOTIFICATIONS_ENABLED_KEY,
];

function readStoredCharges(raw: string): ExtraCharges {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const out: ExtraCharges = {
    deliveryPerKwh: text(parsed.deliveryPerKwh),
    deliveryFlat: text(parsed.deliveryFlat),
    regulatoryPerKwh: text(parsed.regulatoryPerKwh),
    hstPct: text(parsed.hstPct),
  };
  // Wave L provenance: kept only when it is well-formed, so a hand-edited or
  // older backup degrades to "no source" instead of claiming one.
  const src = parsed.xmlSource as Partial<ExtraChargesSource> | undefined;
  if (
    src &&
    typeof src.periodStart === "number" &&
    typeof src.label === "string" &&
    src.values &&
    EXTRA_CHARGE_FIELDS.every((f) => typeof (src.values as Record<string, unknown>)[f] === "string")
  ) {
    out.xmlSource = {
      periodStart: src.periodStart,
      label: src.label,
      values: src.values as Record<ExtraChargeField, string>,
    };
  }
  return out;
}

/** Whitelisted read of the stored add-ons (missing/unreadable = all empty). */
function readStoredExtraCharges(): ExtraCharges {
  try {
    const raw = localStorage.getItem(EXTRA_CHARGES_KEY);
    if (raw) return readStoredCharges(raw);
  } catch { /* unreadable storage: export what we can, which is nothing here */ }
  return EMPTY_EXTRA_CHARGES;
}

export function useExtraCharges() {
  // Lazy init (not an effect): this only ever mounts client-side — Dashboard
  // still shows its loading screen on the server — so reading storage here
  // cannot cause a hydration mismatch, and it avoids a cascading render.
  const [charges, setCharges] = useState<ExtraCharges>(() => {
    if (typeof window === "undefined") return EMPTY_EXTRA_CHARGES;
    try {
      const raw = window.localStorage.getItem(EXTRA_CHARGES_KEY);
      if (raw) return readStoredCharges(raw);
    } catch { /* unreadable storage = behave like a first-time user */ }
    return EMPTY_EXTRA_CHARGES;
  });

  const setCharge = (field: ExtraChargeField, value: string) => {
    setCharges((prev) => {
      const next: ExtraCharges = { ...prev, [field]: value };
      try {
        localStorage.setItem(EXTRA_CHARGES_KEY, JSON.stringify(next));
      } catch { /* quota exceeded: keep the in-memory value */ }
      return next;
    });
  };

  /**
   * Wave L item 3 — drop the file's own numbers into the fields, but only
   * while they still say what they said when they were stored (untouched, or
   * still exactly the file's values). The moment a field differs, the user
   * owns it and no later file may overwrite it.
   */
  const applyDerivedIfPristine = useCallback((source: ExtraChargesSource) => {
    setCharges((prev) => {
      if (!chargesArePristine(prev)) return prev;
      const next: ExtraCharges = { ...source.values, xmlSource: source };
      try {
        localStorage.setItem(EXTRA_CHARGES_KEY, JSON.stringify(next));
      } catch { /* quota exceeded: keep the in-memory value */ }
      return next;
    });
  }, []);

  const resetCharges = () => {
    setCharges(EMPTY_EXTRA_CHARGES);
    try {
      localStorage.removeItem(EXTRA_CHARGES_KEY);
    } catch { /* nothing to remove */ }
  };

  return { charges, setCharge, resetCharges, applyDerivedIfPristine };
}
