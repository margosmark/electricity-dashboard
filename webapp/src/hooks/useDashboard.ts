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
  type DataPoint, type RateSet,
  getBillingPeriod, parseGreenButtonXML,
} from "@/lib/energy";

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
            const last = new Date(parsed[parsed.length - 1].timestamp * 1000);
            const period = getBillingPeriod(last, day);
            setStartDate(format(period.start, "yyyy-MM-dd"));
            setEndDate(format(period.end, "yyyy-MM-dd"));
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
        const data = parseGreenButtonXML(ev.target?.result as string);
        if (data.length > 0) {
          setRawData(data);
          localStorage.setItem("energy_data", JSON.stringify(data));
          const last = new Date(data[data.length - 1].timestamp * 1000);
          const period = getBillingPeriod(last, billingDay);
          setStartDate(format(period.start, "yyyy-MM-dd"));
          setEndDate(format(period.end, "yyyy-MM-dd"));
          setShowUploadModal(false);
        }
      } catch {
        alert("Parse Error");
      } finally {
        setParsing(false);
      }
    };
    reader.readAsText(file);
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

  /** Re-anchor startDate/endDate when a scope button is clicked. */
  const applyViewScope = (scope: "BillingPeriod" | "Month" | "YTD") => {
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
    handleFileUpload, emergencyReset, updateBillingDay, applyViewScope,
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
  getViewScope: () => "Month" | "YTD" | "BillingPeriod" | "Custom",
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
