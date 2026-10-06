/**
 * Ontario Energy Optimizer — component hooks.
 *
 * All interactive Dashboard state lives here so Dashboard.tsx stays a thin
 * render shell. Pure math remains in lib/energy.ts (tested separately);
 * these hooks only own localStorage, fetch, and state coordination.
 */

"use client";

import { useState, useEffect, useMemo, useRef, ChangeEvent } from "react";
import { format, addMonths, subMonths, addDays, startOfMonth, lastDayOfMonth } from "date-fns";
import {
  type DataPoint, type RateSet, type UsagePointGroup,
  getBillingPeriod, parseGreenButtonUsagePoints, selectInitialWindow,
  mergeReadings, EMPTY_EXTRA_CHARGES, type ExtraCharges,
} from "@/lib/energy";
import {
  fetchGbStatus, fetchGbUsage, disconnectGb, describeGbError,
  type GbStatus,
} from "@/lib/greenbutton/client";
import {
  buildBackupDocument, serializeBackup, parseBackup, backupFilename, storageValuesFromBackup,
} from "@/lib/backup";
import { diagnoseGreenButtonDocument, type ParseDiagnostic } from "@/lib/parseDiagnostic";
import { loadExampleReadings } from "@/lib/exampleData";

/** Narrow a rejected FileReader promise back to a rendered failure diagnostic. */
function isParseDiagnostic(value: unknown): value is Extract<ParseDiagnostic, { ok: false }> {
  return !!value && typeof value === "object" && typeof (value as { headline?: unknown }).headline === "string";
}

/**
 * Set while the loaded readings are the bundled example dataset (Wave H item
 * 1). It is a separate key from `energy_data` so a user's own upload always
 * wins, and so clearing it never has to guess what else to delete.
 */
export const EXAMPLE_DATA_KEY = "energy_data_is_example";

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
  | { ok: true; incoming: number; added?: number; picker?: boolean }
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
  } | null>(null);

  /** 2+ files waiting on the merge review screen (range + rows before import). */
  const [pendingMerge, setPendingMerge] = useState<MergeFileChoice[] | null>(null);

  /**
   * Why the last upload produced nothing. Rendered inside the upload modal —
   * "invalid XML" tells a first-time user nothing, so the diagnostic names
   * what was missing instead (see lib/parseDiagnostic.ts).
   */
  const [parseIssue, setParseIssue] = useState<ParseDiagnostic | null>(null);

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

  /** Live-view refs: the sync path is called from effects whose closures
   *  were built before the data existed, so they read these instead. */
  const rawDataRef = useRef<DataPoint[]>([]);
  const gbStatusRef = useRef<GbStatus | null>(null);
  const syncingRef = useRef(false);
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
  const applyInitialWindow = (points: DataPoint[], day: number) => {
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
  const commitReadings = (data: DataPoint[], source: "upload" | "example" = "upload") => {
    writeRows(data);
    localStorage.setItem("energy_data", JSON.stringify(data));
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
      applyInitialWindow(data, billingDay);
    }
    setParseIssue(null);
    setShowUploadModal(false);
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

      let groups: UsagePointGroup[];
      try {
        groups = parseGreenButtonUsagePoints(res.xml);
      } catch {
        return { ok: false, code: "unparseable" };
      }
      const incoming = groups.reduce((n, g) => n + g.readings.length, 0);
      if (incoming === 0) return { ok: false, code: "no_readings" };

      if (groups.length > 1) {
        setPendingUpload({ fileName: "Oakville Hydro (live sync)", groups, origin: "greenbutton" });
        setShowUploadModal(false);
        return { ok: true, incoming, picker: true };
      }

      const merged = mergeReadings([
        { name: "Oakville Hydro (live)", readings: groups[0].readings },
        { name: "Existing readings", readings: base },
      ]);
      const added = merged.mergedRows - base.length;
      commitReadings(merged.readings);
      return { ok: true, incoming, added };
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
    async function init() {
      // localStorage FIRST: it decides both the visible window and whether
      // there is anything at all to show, and neither answer needs the network.
      let loadedReadings = false;
      try {
        const savedBDay = localStorage.getItem("billing_day");
        const day = savedBDay ? parseInt(savedBDay, 10) : 1;
        if (savedBDay && mounted) setBillingDayState(day);
        const savedData = localStorage.getItem("energy_data");
        if (savedData) {
          const parsed = JSON.parse(savedData) as DataPoint[];
          if (mounted && Array.isArray(parsed) && parsed.length > 0) {
            loadedReadings = true;
            // Ref first: the Green Button sync runs later in THIS same init
            // pass and must see what was just restored.
            rawDataRef.current = parsed;
            setRawData(parsed);
            // A reload must keep saying "this is example data" if it is.
            if (localStorage.getItem(EXAMPLE_DATA_KEY) === "1") setExampleData(true);
            applyInitialWindow(parsed, day);
          }
        } else if (mounted) {
          setShowUploadModal(true);
        }
      } catch { /* corrupt localStorage = treat as fresh */ }

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
        setGbMessage({ tone: "ok", text: "Connected to Oakville Hydro." });
      } else if (gbFlag?.startsWith("error:")) {
        const copy = describeGbError(gbFlag.slice("error:".length));
        setGbMessage({ tone: "error", text: `${copy.headline} — ${copy.detail}` });
      }

      if (status.connected) {
        const outcome = await syncFromGreenButton();
        if (mounted && gbFlag === "connected") {
          setGbMessage(
            outcome.ok
              ? {
                  tone: "ok",
                  text: outcome.picker
                    ? "Connected — pick which meter to load."
                    : `Live sync: ${outcome.incoming} readings from the feed, ` +
                      `${outcome.added ?? 0} new.`,
                }
              : { tone: "error", text: describeGbError(outcome.code).detail },
          );
        }
      }

      // Background refresh: every 15 minutes while the tab is actually
      // visible, and never overlapping a sync that is already running.
      poller = setInterval(() => {
        if (!mounted || document.visibilityState !== "visible") return;
        if (syncingRef.current || !gbStatusRef.current?.connected) return;
        void syncFromGreenButton();
      }, 15 * 60 * 1000);
    }
    init();
    return () => {
      mounted = false;
      if (poller) clearInterval(poller);
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
            headline: `Could not read ${file.name}.`,
            detail: 'The browser failed to open the file — it may have been moved or locked since you picked it.',
            hints: ['Pick the file again from disk.'],
          } satisfies ParseDiagnostic);
        reader.onload = (ev) => {
          const text = (ev.target?.result as string) ?? "";
          let groups: UsagePointGroup[];
          try {
            groups = parseGreenButtonUsagePoints(text);
          } catch (e) {
            // Security refusals (external entities) and malformed markup land
            // here: explain the document instead of repeating the exception.
            const diag = diagnoseGreenButtonDocument(text, 0);
            reject(
              diag.ok
                ? ({
                    ok: false,
                    headline: `Could not read ${file.name}.`,
                    detail: String((e as Error)?.message ?? e),
                    hints: ['Re-download the export and try again.'],
                  } satisfies ParseDiagnostic)
                : diag,
            );
            return;
          }
          const readings = countReadings(groups);
          // A single-meter file is pre-picked; a multi-meter one stays null
          // until the review screen asks.
          resolve({
            name: file.name,
            groups,
            chosen: groups.length === 1 ? 0 : null,
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
          // Nothing readable: keep the modal open and say exactly why.
          setParseIssue(
            results.map((r) => r.issue).find(Boolean) ?? {
              ok: false,
              headline: "No readings found in that file.",
              detail: "The upload was read successfully but contained no interval readings to import.",
              hints: ["Export Green Button XML with interval data from your utility portal."],
            },
          );
          return;
        }

        if (results.length === 1) {
          const only = results[0];
          if (only.groups.length > 1) {
            setPendingUpload({ fileName: only.name, groups: only.groups });
            setShowUploadModal(false);
            return;
          }
          commitReadings(only.groups[0].readings);
          return;
        }
        setPendingMerge(results);
        setShowUploadModal(false);
      })
      .catch((e) => {
        setParseIssue(
          isParseDiagnostic(e)
            ? e
            : {
                ok: false,
                headline: "That file could not be read.",
                detail: String((e as Error)?.message ?? e),
                hints: ["Re-download the export from your utility portal and try again."],
              },
        );
      })
      .finally(() => setParsing(false));
  };

  /** Import the rows the merge review screen computed. */
  const chooseMerge = (readings: DataPoint[]) => {
    setPendingMerge(null);
    if (readings.length > 0) commitReadings(readings);
  };

  /** Back out of the merge review without importing anything. */
  const cancelMerge = () => {
    setPendingMerge(null);
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
      const merged = mergeReadings([
        { name: "Oakville Hydro (live)", readings },
        { name: "Existing readings", readings: rawDataRef.current },
      ]);
      commitReadings(merged.readings);
      return;
    }
    commitReadings(readings);
  };

  /** Back out of the picker without importing anything. */
  const cancelUsagePoint = () => {
    setPendingUpload(null);
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
          headline: "Example data unavailable.",
          detail: loaded.detail,
          hints: ["Upload your own Green Button XML export to continue."],
        });
        return { ok: false, detail: loaded.detail };
      }
      commitReadings(loaded.readings, "example");
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
    try {
      localStorage.removeItem("energy_data");
      localStorage.removeItem(EXAMPLE_DATA_KEY);
    } catch { /* nothing to remove */ }
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

  const emergencyReset = () => {
    localStorage.clear();
    window.location.reload();
  };

  /** Persist a new billing day; re-anchor the BillingPeriod scope onto it. */
  const updateBillingDay = (day: number, anchorStart: string) => {
    setBillingDayState(day);
    localStorage.setItem("billing_day", day.toString());
    if (!day || day < 1 || day > 31) return; // typing in progress; skip re-anchor
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
   * add-ons) into a versioned JSON document. Returns null when there is
   * nothing to back up — the drawer reports that instead of writing an empty
   * file that would wipe data if restored.
   */
  const exportBackup = (): BackupExport | null => {
    if (rawData.length === 0) return null;
    const now = new Date();
    const doc = buildBackupDocument({
      energyData: rawData,
      billingDay,
      extraCharges: readStoredExtraCharges(),
      exportedAt: now,
    });
    return { filename: backupFilename(now), text: serializeBackup(doc) };
  };

  /**
   * Restore a previously exported file.
   *
   * Validation happens BEFORE any write: a rejected file leaves the existing
   * profile completely untouched (import is all-or-nothing, never partial).
   */
  const importBackupFile = async (file: File): Promise<BackupImportResult> => {
    let text: string;
    try {
      text = await file.text();
    } catch {
      return { ok: false, error: `Could not read ${file.name}. Choose the JSON file produced by “Export JSON”.` };
    }

    const parsed = parseBackup(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    try {
      const values = storageValuesFromBackup(parsed.value);
      localStorage.setItem("energy_data", values.energy_data);
      localStorage.setItem("billing_day", values.billing_day);
      localStorage.setItem("extra_charges", values.extra_charges);
    } catch {
      return {
        ok: false,
        error: "This browser refused to save the backup (storage may be full or blocked). Nothing was changed.",
      };
    }

    onBackupApplied?.();
    return { ok: true, filename: file.name };
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
    await refreshGbStatus();
    setGbMessage(
      ok
        ? { tone: "ok", text: "Disconnected — stored authorisation wiped from the server." }
        : { tone: "error", text: "Could not reach the shim to disconnect." },
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
    showUploadModal, setShowUploadModal,
    billingDay, startDate, endDate, setStartDate, setEndDate,
    viewScope, setViewScope,
    handleFileUpload, emergencyReset, updateBillingDay, applyViewScope,
    pendingUpload, chooseUsagePoint, cancelUsagePoint,
    pendingMerge, setPendingMerge, chooseMerge, cancelMerge,
    exportBackup, importBackupFile,
    parseIssue, setParseIssue,
    exampleData, loadExampleData, discardExampleData,
    // Green Button live sync (Wave K)
    gbStatus, gbSyncing, gbMessage, setGbMessage,
    syncFromGreenButton, refreshGbStatus, disconnectGreenButton, startGreenButtonConnect,
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
    // BillingPeriod and Custom both re-anchor through getBillingPeriod using
    // the billing-day anchor (matches original behavior).
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

function readStoredCharges(raw: string): ExtraCharges {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    deliveryPerKwh: text(parsed.deliveryPerKwh),
    deliveryFlat: text(parsed.deliveryFlat),
    regulatoryPerKwh: text(parsed.regulatoryPerKwh),
    hstPct: text(parsed.hstPct),
  };
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

  const setCharge = (field: keyof ExtraCharges, value: string) => {
    setCharges((prev) => {
      const next: ExtraCharges = { ...prev, [field]: value };
      try {
        localStorage.setItem(EXTRA_CHARGES_KEY, JSON.stringify(next));
      } catch { /* quota exceeded: keep the in-memory value */ }
      return next;
    });
  };

  const resetCharges = () => {
    setCharges(EMPTY_EXTRA_CHARGES);
    try {
      localStorage.removeItem(EXTRA_CHARGES_KEY);
    } catch { /* nothing to remove */ }
  };

  return { charges, setCharge, resetCharges };
}
