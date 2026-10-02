/**
 * Ontario Energy Optimizer — component hooks.
 *
 * All interactive Dashboard state lives here so Dashboard.tsx stays a thin
 * render shell. Pure math remains in lib/energy.ts (tested separately);
 * these hooks only own localStorage, fetch, and state coordination.
 */

"use client";

import { useState, useEffect, useMemo, ChangeEvent } from "react";
import { format, addMonths, subMonths, addDays, startOfMonth, lastDayOfMonth } from "date-fns";
import {
  type DataPoint, type RateSet, type UsagePointGroup,
  getBillingPeriod, parseGreenButtonUsagePoints, selectInitialWindow,
  EMPTY_EXTRA_CHARGES, type ExtraCharges,
} from "@/lib/energy";

export type { ExtraCharges };

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
 * emergency reset, billing-day editing, and view-scope re-anchoring.
 */
export function useEnergyData() {
  const [rawData, setRawData] = useState<DataPoint[]>([]);
  const [rateHistory, setRateHistory] = useState<RateSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [billingDay, setBillingDayState] = useState<number>(1);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [viewScope, setViewScope] = useState<ViewScope>("BillingPeriod");

  /** Multi-meter upload waiting for the user to pick which point to load. */
  const [pendingUpload, setPendingUpload] = useState<{
    fileName: string;
    groups: UsagePointGroup[];
  } | null>(null);

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
   * (Used by both the single-meter path and the UsagePoint picker, so the
   * first-load fix applies to an upload however the user completed it.)
   */
  const commitReadings = (data: DataPoint[]) => {
    setRawData(data);
    localStorage.setItem("energy_data", JSON.stringify(data));
    applyInitialWindow(data, billingDay);
    setShowUploadModal(false);
  };

  // --- Start sequence ---
  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        const res = await fetch("/api/rates");
        const json = await res.json();
        if (mounted) setRateHistory(json.historicalRates || []);
      } catch { /* rate fetch failure degrades to empty history; math returns [] */ }
      try {
        const savedBDay = localStorage.getItem("billing_day");
        const day = savedBDay ? parseInt(savedBDay, 10) : 1;
        if (savedBDay && mounted) setBillingDayState(day);
        const savedData = localStorage.getItem("energy_data");
        if (savedData) {
          const parsed = JSON.parse(savedData) as DataPoint[];
          if (mounted && Array.isArray(parsed) && parsed.length > 0) {
            setRawData(parsed);
            applyInitialWindow(parsed, day);
          }
        } else if (mounted) {
          setShowUploadModal(true);
        }
      } catch { /* corrupt localStorage = treat as fresh */ }
      if (mounted) setLoading(false);
    }
    init();
    return () => { mounted = false; };
  }, []);

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const groups = parseGreenButtonUsagePoints(ev.target?.result as string);
        const total = groups.reduce((n, g) => n + g.readings.length, 0);
        if (total === 0) return; // nothing readable: leave the modal open, as before
        if (groups.length > 1) {
          // More than one meter/rate class in the file: never merge silently.
          setPendingUpload({ fileName: file.name, groups });
          setShowUploadModal(false);
          return;
        }
        commitReadings(groups[0].readings);
      } catch {
        alert("Parse Error");
      } finally {
        setParsing(false);
      }
    };
    reader.readAsText(file);
  };

  /** Load exactly the rows the user picked (one UsagePoint, or all of them). */
  const chooseUsagePoint = (readings: DataPoint[]) => {
    setPendingUpload(null);
    if (readings.length > 0) commitReadings(readings);
  };

  /** Back out of the picker without importing anything. */
  const cancelUsagePoint = () => {
    setPendingUpload(null);
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

  return {
    rawData, rateHistory, loading, parsing,
    showUploadModal, setShowUploadModal,
    billingDay, startDate, endDate, setStartDate, setEndDate,
    viewScope, setViewScope,
    handleFileUpload, emergencyReset, updateBillingDay, applyViewScope,
    pendingUpload, chooseUsagePoint, cancelUsagePoint,
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
