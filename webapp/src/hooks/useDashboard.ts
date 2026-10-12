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
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, ChangeEvent } from "react";
import { format, addMonths, subMonths, addDays, startOfMonth, lastDayOfMonth } from "date-fns";
import {
  type DataPoint, type RateSet, type UsagePointGroup,
  type UsageSummary, type LocalTimeParams, type GreenButtonFeed,
  type ExtraCharges, type ExtraChargeField, type ExtraChargesSource,
  getBillingPeriod, parseGreenButtonFeed, selectInitialWindow,
  MIN_WINDOW_COVERAGE,
  EMPTY_EXTRA_CHARGES, EXTRA_CHARGE_FIELDS, chargesArePristine,
} from "@/lib/energy";
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
  loadBillingDay, saveBillingDay,
  parseImport, resetStoredData, listOurStoredKeys,
} from "@/lib/storage";
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

export type BillFeed = {
  /** Every billing period the parse found, oldest first. */
  summaries: UsageSummary[];
  /** The feed's own clock rules, or null when it declared none. */
  localTime: LocalTimeParams | null;
  /** File/sync the values came from, for the "sourced from" caption. */
  source: string | null;
};

export const EMPTY_BILL_FEED: BillFeed = { summaries: [], localTime: null, source: null };

/** Whitelisted read: whatever is unreadable or of the wrong shape is dropped. */
export function readStoredBillFeed(): BillFeed {
  try {
    const raw = localStorage.getItem(USAGE_SUMMARIES_KEY);
    const clock = localStorage.getItem(LOCAL_TIME_KEY);
    const summaries = raw ? (JSON.parse(raw) as UsageSummary[]) : [];
    const localTime = clock ? (JSON.parse(clock) as LocalTimeParams) : null;
    if (!Array.isArray(summaries)) return EMPTY_BILL_FEED;
    const clean = summaries.filter(
      (s) => s && typeof s.start === "number" && typeof s.duration === "number" && Array.isArray(s.items),
    );
    const okClock =
      localTime && typeof localTime.tzOffset === "number" ? localTime : null;
    if (clean.length === 0 && !okClock) return EMPTY_BILL_FEED;
    return { summaries: clean, localTime: okClock, source: null };
  } catch {
    return EMPTY_BILL_FEED;
  }
}

/** Persist; a storage failure must never break the UI. */
export function writeStoredBillFeed(feed: BillFeed): void {
  try {
    if (feed.summaries.length > 0) {
      localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(feed.summaries));
    } else {
      localStorage.removeItem(USAGE_SUMMARIES_KEY);
    }
    if (feed.localTime) {
      localStorage.setItem(LOCAL_TIME_KEY, JSON.stringify(feed.localTime));
    } else {
      localStorage.removeItem(LOCAL_TIME_KEY);
    }
  } catch { /* quota exceeded / private mode: keep the in-memory value */ }
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
    setBillFeed((prev) => {
      const next =
        mode === "replace"
          ? incoming.reduce((acc, f) => unionBillFeeds(EMPTY_BILL_FEED, f), EMPTY_BILL_FEED)
          : unionBillFeeds(prev, ...incoming);
      writeStoredBillFeed(next);
      return next;
    });
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
    } catch {
      return { ok: false, code: "unparseable" };
    }
    const groups = feed.groups;
    const incoming = groups.reduce((n, g) => n + g.readings.length, 0);
    if (incoming === 0) return { ok: false, code: "no_readings" };

    // Held until the rows below are actually committed (a multi-meter pick
    // can still be cancelled) and then folded in — a sync never deletes a
    // bill the feed no longer repeats.
    billFeedsRef.current = [
      { summaries: feed.summaries, localTime: feed.localTime, source: "your Green Button feed" },
    ];

    if (groups.length > 1) {
      setPendingUpload({
        fileName: "Oakville Hydro (live sync)",
        groups,
        origin: "greenbutton",
        summaries: feed.summaries,
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
      return { ok: true, incoming, added: 0, unchanged: true };
    }

    const merged = mergeForWrite(base, groups[0].readings);
    const keep = windowRef.current;
    const hadWindow = keep.start !== "" && keep.end !== "";
    commitReadings(merged, "upload", feed.summaries);
    commitBillFeed("union");
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
        if (!stored.ok) {
          // Unreadable storage: say so, and open the upload prompt — the
          // dashboard must not claim to be empty when it cannot tell.
          reportStorage(stored);
          if (mounted) setShowUploadModal(true);
        } else if (stored.value && stored.value.points.length > 0) {
          if (mounted) {
            loadedReadings = true;
            const parsed = stored.value.points;
            // Ref first: the Green Button sync runs later in THIS same init
            // pass and must see what was just restored.
            rawDataRef.current = parsed;
            setRawData(parsed);
            // A reload must keep saying "this is example data" if it is.
            if (localStorage.getItem(EXAMPLE_DATA_KEY) === "1") setExampleData(true);
            applyInitialWindow(parsed, day, readStoredBillFeed().summaries);
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

      try {
        const res = await fetch("/api/rates");
        const json = await res.json();
        if (mounted) setRateHistory(json.historicalRates || []);
      } catch { /* rate fetch failure degrades to empty history; math returns [] */ }

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
            : { tone: "error", text: describeGbError(outcome.code).detail },
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

    const countReadings = (gs: UsagePointGroup[]) =>
      gs.reduce((n, g) => n + g.readings.length, 0);

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
          const readings = countReadings(groups);
          // Wave L: the bill half rides along with the readings and is held
          // until the user actually imports (see commitBillFeed).
          billFeedsRef.current.push({
            summaries: feed.summaries,
            localTime: feed.localTime,
            source: file.name,
          });
          // A single-meter file is pre-picked; a multi-meter one stays null
          // until the review screen asks.
          resolve({
            name: file.name,
            groups,
            chosen: groups.length === 1 ? 0 : null,
            // The bills ride with the readings: the first-load window is
            // chosen in the same call that imports them.
            summaries: feed.summaries,
            ...(readings === 0 ? { issue: diagnoseGreenButtonDocument(text, 0) } : {}),
          });
        };
        reader.readAsText(file);
      });

    setParseIssue(null);
    Promise.all(files.map(parseOne))
      .then((results) => {
        const total = results.reduce((n, r) => n + countReadings(r.groups), 0);
        if (total === 0) {
          // Nothing readable: keep the modal open and say exactly why, and
          // drop the bills parsed out of the same unreadable batch.
          billFeedsRef.current = [];
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
            // the user already had alone.
            setPendingUpload({ fileName: only.name, groups: only.groups, summaries: only.summaries });
            setShowUploadModal(false);
            return;
          }
          commitReadings(only.groups[0].readings, "upload", only.summaries);
          // An upload REPLACES: this file is what the user asked to see, so
          // an unrelated upload also replaces the panel (to nothing, if it
          // carried no bills) instead of leaving a stranger's bill on screen.
          commitBillFeed("replace");
          return;
        }
        setPendingMerge(results);
        setShowUploadModal(false);
      })
      .catch((e) => {
        billFeedsRef.current = [];
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

  /** Import the rows the merge review screen computed. */
  const chooseMerge = (readings: DataPoint[]) => {
    setPendingMerge(null);
    if (readings.length > 0) {
      // Every file in the merge review, bills included: the axis de-dupes
      // periods that two exports describe differently.
      commitReadings(
        readings,
        "upload",
        (pendingMerge ?? []).flatMap((f) => f.summaries ?? []),
      );
      // The merged dataset IS those files, bills included (replace).
      commitBillFeed("replace");
    } else {
      billFeedsRef.current = [];
    }
  };

  /** Back out of the merge review without importing anything. */
  const cancelMerge = () => {
    setPendingMerge(null);
    billFeedsRef.current = [];
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
    const origin = pendingUpload?.origin;
    setPendingUpload(null);
    if (readings.length === 0) return;
    if (origin === "greenbutton") {
      commitReadings(mergeForWrite(rawDataRef.current, readings), "upload", pendingUpload?.summaries);
      commitBillFeed("union");
      return;
    }
    commitReadings(readings, "upload", pendingUpload?.summaries);
    commitBillFeed("replace");
  };

  /** Back out of the picker without importing anything. */
  const cancelUsagePoint = () => {
    setPendingUpload(null);
    billFeedsRef.current = [];
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
    setBillFeed(EMPTY_BILL_FEED);
    setRawData([]);
    setExampleData(false);
    setParseIssue(null);
    setPendingUpload(null);
    setPendingMerge(null);
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
    showUploadModal, setShowUploadModal,
    billingDay, startDate, endDate, setStartDate, setEndDate,
    viewScope, setViewScope,
    handleFileUpload, updateBillingDay, applyViewScope,
    // Storage surfacing + a two-step, scoped reset (t_a8a54e33).
    storageNotice, dismissStorageNotice, raiseStorageNotice,
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
