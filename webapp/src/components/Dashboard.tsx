/**
 * Ontario Energy Optimizer - Interaction Fix Edition
 *
 * Flow: Overview ➔ Usage ➔ Plans & Track Record ➔ Money & What-If.
 *
 * Wave R — this file is the SHELL: state and handlers live in
 * src/hooks/useDashboard.ts, the tab strip in TabNav, and the content of each
 * section in OverviewPanel / UsagePanel / PlansPanel / MoneyPanel. What used
 * to be one 316-line scroll with the answer at the bottom is now four tabs
 * that open on the answer.
 */

"use client";

import React, { useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { HelpCircle, Zap, Upload, X, Trash2, Settings2 } from 'lucide-react';
import {
  type ChartDataItem,
  processRawData, filterByDateRange,
  buildActiveChartData, calculateComparison,
  detectAnomalies, buildHeatmapData, calculateFullDataTotals,
  calculateAlwaysOnFloor, calculateWfhShare,
  getFilteredForZoom,
  resolveZone,
} from '@/lib/energy';
import { buildEfficiency } from '@/lib/statistics';
import {
  useEnergyData, useActiveRateSet, useZoomNavigation, type ViewScope,
} from '@/hooks/useDashboard';
import { UsagePointPicker } from '@/components/UsagePointPicker';
import { GreenButtonSync } from '@/components/GreenButtonSync';
import { BackupControls } from '@/components/BackupControls';
import MultiFileMerge from '@/components/MultiFileMerge';
import { useRateStaleness } from '@/hooks/useRateStaleness';
import RefreshNoticeBanner from '@/components/RefreshNoticeBanner';
import { NotificationToggle } from '@/components/NotificationToggle';
import { useRefreshNotices } from '@/hooks/useRefreshNotices';
import TabNav from '@/components/TabNav';
import BestChoiceChip from '@/components/BestChoiceChip';
import OverviewPanel from '@/components/OverviewPanel';
import UsagePanel from '@/components/UsagePanel';
import PlansPanel from '@/components/PlansPanel';
import MoneyPanel from '@/components/MoneyPanel';
import { useTabs } from '@/hooks/useTabs';
import { useSelectedPlan, PLAN_LABEL } from '@/hooks/useSelectedPlan';
import { analyzeTouShifts } from '@/lib/touShift';
import { analyzeShiftVerification } from '@/lib/shiftVerification';
import { projectMonthBill } from '@/lib/billProjection';

export default function Dashboard() {
  const {
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
    gbStatus, gbSyncing, gbMessage, setGbMessage,
    syncFromGreenButton, disconnectGreenButton, startGreenButtonConnect,
    gbRefreshTick, backgroundSync,
    // Wave L: UsageSummary bills + the feed's own clock rules
    billFeed,
    // The billing axis: the file's own periods as the view's timeline.
    axis,
    // A restored backup must reach every hook that seeds itself from
    // localStorage (bill add-ons in particular), so reload once written.
  } = useEnergyData({ onBackupApplied: () => window.location.reload() });

  const [showFloorHelp, setShowFloorHelp] = React.useState(false);
  // Wave H item 2: the plan is a stored fact shared with the header chip,
  // not component state that forgets itself on reload.
  const [userPlan, setUserPlan] = useSelectedPlan();
  // Wave R: four tabs, remembered in localStorage and addressable at #tab=.
  const { tab, select: setActiveTab } = useTabs();
  // Wave H item 7: $/yr vs $/day reframing of the totals strip.
  const [costMode, setCostMode] = React.useState<'yr' | 'day'>('yr');

  // Keep navigatePeriod free of stale closures: getters read live state via
  // refs synced after render (lint-safe, no stale closures).
  const viewScopeRef = useRef<ViewScope>('BillingPeriod');
  const billingDayRef = useRef<number>(1);
  const axisRef = useRef(axis);
  useEffect(() => {
    viewScopeRef.current = viewScope;
    billingDayRef.current = billingDay;
    axisRef.current = axis;
  }, [viewScope, billingDay, axis]);

  /**
   * Wave H item 3 — Escape closes whatever is open, top layer first.
   *
   * ONE listener, registered once on mount and never re-registered, reading
   * the current overlay state through a ref written during render. The
   * obvious alternative (effect keyed on the overlay state) leaves a window
   * between "the modal is on screen" and "the effect re-ran" in which Escape
   * is silently dropped — which is exactly how this failed the first CI run.
   * Writing the ref in render means the listener is already correct the
   * moment the overlay's DOM node exists.
   *
   * One listener for every overlay instead of five (the backup drawer owns
   * its own, because it also has a toggle button to keep in sync). While the
   * parser is running the upload modal is deliberately NOT dismissable —
   * cancelling mid-parse would strand the FileReader.
   */
  const overlayRef = useRef({
    showFloorHelp, setShowFloorHelp, pendingUpload, pendingMerge,
    showUploadModal, parsing, cancelUsagePoint, cancelMerge,
    setParseIssue, setShowUploadModal,
  });
  // Written in a LAYOUT effect, not during render (the compiler forbids the
  // latter) and not in a passive effect (which runs after paint, reopening
  // the window this whole block exists to close). Layout effects run
  // synchronously after the DOM mutates and before the browser paints, so by
  // the time an overlay is visible — to a user or to Playwright — the
  // handler already reads the right state.
  useLayoutEffect(() => {
    overlayRef.current = {
      showFloorHelp, setShowFloorHelp, pendingUpload, pendingMerge,
      showUploadModal, parsing, cancelUsagePoint, cancelMerge,
      setParseIssue, setShowUploadModal,
    };
  }, [
    showFloorHelp, pendingUpload, pendingMerge, showUploadModal, parsing,
    cancelUsagePoint, cancelMerge, setParseIssue, setShowUploadModal,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const o = overlayRef.current;
      if (o.showFloorHelp) {
        o.setShowFloorHelp(false);
      } else if (o.pendingUpload) {
        o.cancelUsagePoint();
      } else if (o.pendingMerge) {
        o.cancelMerge();
      } else if (o.showUploadModal && !o.parsing) {
        o.setParseIssue(null);
        o.setShowUploadModal(false);
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // Registered ONCE on purpose: the handler reads live state via
    // overlayRef, so there is nothing for exhaustive-deps to want here.
  }, []);

  const { zoomLevel, setZoomLevelAndClear, zoomTarget, handleBarClick, goBack, navigatePeriod } =
    useZoomNavigation(startDate, endDate, setStartDate, setEndDate,
      () => viewScopeRef.current, () => billingDayRef.current,
      () => axisRef.current);

  // --- Calculations ---

  // Wave L item 4: when the file carries LocalTimeParameters it — not the
  // browser's timezone — decides the day bucket, the hour bucket and the
  // TOU/ULO/winter season for THIS dataset. No rules in the file means the
  // browser clock, exactly as before.
  const zone = useMemo(() => resolveZone(billFeed.localTime), [billFeed.localTime]);

  const processedData = useMemo(
    () => processRawData(rawData, rateHistory, zone),
    [rawData, rateHistory, zone],
  );

  const filteredData = useMemo(() => filterByDateRange(processedData, startDate, endDate), [processedData, startDate, endDate]);

  const activeChartData = useMemo(() => buildActiveChartData(filteredData, zoomLevel, zoomTarget), [filteredData, zoomLevel, zoomTarget]);

  const comparison = useMemo(() => calculateComparison(activeChartData), [activeChartData]);

  const anomalies = useMemo(() => detectAnomalies(processedData, filteredData), [processedData, filteredData]);

  const heatmapData = useMemo(() => buildHeatmapData(filteredData), [filteredData]);

  // Always-on floor (the old "vampire load"), phrased against the ~10% of
  // bill community benchmark and priced at THIS household's blended rate.
  const floor = useMemo(() => calculateAlwaysOnFloor(filteredData, userPlan), [filteredData, userPlan]);

  // Work-from-home window: what share of the visible energy lands on a
  // weekday between 07:00 and 19:00 — explains why a plan wins or loses.
  const wfh = useMemo(() => calculateWfhShare(filteredData), [filteredData]);

  // "This month's bill" projection: month-to-date + the recent daily average
  // carried to month end, gated on day 5 (see lib/billProjection).
  const projection = useMemo(
    () => projectMonthBill(processedData, userPlan, new Date()),
    [processedData, userPlan],
  );

  // Weekly before/after: last 7 full days vs the 7 before, on the full
  // dataset (a before/after must not move when the chart is zoomed).
  const verification = useMemo(
    () => analyzeShiftVerification(processedData, userPlan),
    [processedData, userPlan],
  );

  // Whole-dataset totals for the strip — deliberately NOT filtered by the
  // visible window: this row answers "what would all my data have cost?".
  const totals = useMemo(() => calculateFullDataTotals(processedData), [processedData]);

  // Wave S — the window the user is actually LOOKING at: the date
  // selection, narrowed further by whatever the chart is zoomed into (a
  // drilled month/week/day), because "in view" has to mean what is on
  // screen. Falls back to the selection when the zoom window is empty.
  const viewRange = useMemo(() => {
    const rows = getFilteredForZoom(filteredData, zoomLevel, zoomTarget);
    if (rows.length > 0) {
      return { start: rows[0].dayStr, end: rows[rows.length - 1].dayStr };
    }
    if (startDate && endDate) return { start: startDate, end: endDate };
    return null;
  }, [filteredData, zoomLevel, zoomTarget, startDate, endDate]);

  // ¢/kWh per closed bill, the all-time and in-view weighted averages, and
  // the behaviour-vs-rate trend verdict (pure fn — see lib/statistics.ts).
  const efficiency = useMemo(
    () =>
      buildEfficiency({
        summaries: billFeed.summaries,
        rates: rateHistory,
        view: viewRange,
      }),
    [billFeed.summaries, rateHistory, viewRange],
  );

  // Rate schedule in force for the plan cards — read live, never hardcoded.
  const activeRateSet = useActiveRateSet(processedData);

  // Once-per-session OEB staleness check (client-side, degrades silently).
  const staleness = useRateStaleness(rateHistory, processedData);

  /* --- Wave M: background-refresh notices -------------------------------
   * Recomputed from STATE (best plan + newest rate effectiveDate) every time
   * a refresh lands, not from a "something changed" event — so a pull that
   * brings back "nothing new" can still be the pull that crossed into a new
   * rate period. `connected` (the gb_session cookie) is the gate: a
   * manual-DMD-only browser gets an empty array and no storage writes.
   */
  const gbConnected = gbStatus?.connected === true;
  const { notices: refreshNotices, dismiss: dismissRefreshNotice } = useRefreshNotices({
    connected: gbConnected,
    totals,
    processedData,
    currentPlan: userPlan,
    refreshTick: gbRefreshTick,
  });

  // Ranked ToU-shift recommendations. Analyzes the FULL loaded dataset (not
  // the view-filtered window): recurrence is a property of recent history,
  // independent of which slice the chart currently shows.
  const shiftAnalysis = useMemo(
    () => analyzeTouShifts(processedData, userPlan, activeRateSet),
    [processedData, userPlan, activeRateSet],
  );

  const selectionCost = useMemo(() => {
    const costKey = `cost${userPlan}` as keyof ChartDataItem;
    return activeChartData.reduce((acc, curr) => acc + (curr[costKey] as number), 0);
  }, [activeChartData, userPlan]);

  // --- Verdict inputs (Wave R) ------------------------------------------
  // The window the comparison was measured over, in days. The banner and the
  // toolbar chip both quote it, so "$45/mo" can always say what it was scaled
  // from.
  const windowDays = useMemo(() => {
    if (filteredData.length === 0) return 0;
    const first = filteredData[0];
    const last = filteredData[filteredData.length - 1];
    return Math.max(1, Math.round((last.timestamp - first.timestamp) / 86_400) + 1);
  }, [filteredData]);

  // --- Totals-strip display state (Wave H items 5 + 7) --------------------
  // The strip reports the WHOLE dataset, so its unit conversions are anchored
  // on the dataset's own span — never on the visible window.
  const totalDays = totals
    ? Math.max(
        1,
        Math.round(
          (new Date(totals.lastDate + 'T00:00:00').getTime() -
            new Date(totals.firstDate + 'T00:00:00').getTime()) /
            86_400_000,
        ) + 1,
      )
    : 1;

  const perDayOf = (datasetTotal: number): number => datasetTotal / totalDays;
  const perYearOf = (datasetTotal: number): number => perDayOf(datasetTotal) * 365.25;

  // The one sentence the toggle exists for: "$3.42/day is $1,249/yr".
  const bestCostTotal = totals
    ? totals.bestPlan === 'TOU'
      ? totals.costTOU
      : totals.bestPlan === 'Tiered'
        ? totals.costTiered
        : totals.costULO
    : 0;
  const bestDaily = perDayOf(bestCostTotal);
  const bestYearly = perYearOf(bestCostTotal);
  const reframe = totals
    ? costMode === 'yr'
      ? `$${bestYearly.toFixed(0)}/yr for ${PLAN_LABEL[totals.bestPlan]} is $${bestDaily.toFixed(2)}/day`
      : `$${bestDaily.toFixed(2)}/day for ${PLAN_LABEL[totals.bestPlan]} is $${bestYearly.toFixed(0)}/yr`
    : '';

  // The open (unbilled) tail of Wave Q's axis — what the accrual curve draws.
  const openPeriod = axis.open ? { start: axis.open.start, end: axis.open.end } : null;

  /**
   * Wave I item 5 — the load shell.
   *
   * Wave H measured CLS 0.134 on the PREPARING OPTIMIZER swap, and the Wave I
   * probe reproduced 0.1479 with attribution to a single node going from
   * `{x:0,y:0,h:844}` to `{x:16,y:131,h:713}`. The cause was structural: both
   * branches of the old early return handed React a bare <div> at the same
   * position, so React REUSED that node and patched its className, top and
   * height in one frame — a whole-page element moving is exactly what layout
   * shift scores. Two changes close it:
   *
   *  1. The two states now carry different `key`s, so React REMOVES the shell
   *     and INSERTS the dashboard instead of mutating one node. Nothing that
   *     was on screen moves, so there is no shift to attribute.
   *  2. The shell mirrors the furniture the dashboard opens with — the nav
   *     card and the totals strip at their real padding/border — so the page
   *     height on either side of the swap is close and the change reads as a
   *     load rather than a relayout.
   */
  if (loading)
    return (
      <div
        key="loading"
        data-testid="dashboard-loading"
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="space-y-10 text-black relative font-black uppercase"
      >
        <div className="bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black flex flex-wrap items-center gap-4 md:gap-6">
          <div className="skeleton-bar h-11 w-11 rounded-xl border-2 border-black/10" />
          <div className="skeleton-bar h-11 w-44 rounded-lg border-2 border-black/10" />
          <div className="skeleton-bar h-11 w-32 rounded-lg border-2 border-black/10" />
          <div className="skeleton-bar h-11 flex-1 min-w-[7rem] rounded-lg border-2 border-black/10" />
        </div>
        <div className="bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black flex flex-wrap items-center gap-4 md:gap-6">
          <div className="skeleton-bar h-16 w-40 rounded-xl border-2 border-black/10" />
          <div className="skeleton-bar h-10 w-28 rounded-lg border-2 border-black/10" />
          <div className="skeleton-bar h-14 w-36 rounded-xl border-2 border-black/10" />
          <div className="skeleton-bar h-14 w-36 rounded-xl border-2 border-black/10" />
        </div>
        <div
          data-testid="preparing-optimizer"
          className="p-6 text-center font-black text-black text-3xl md:text-4xl animate-pulse uppercase tracking-tighter"
        >
          PREPARING OPTIMIZER...
        </div>
      </div>
    );

  return (
    <div key="ready" className="space-y-6 md:space-y-10 text-black relative font-black uppercase">
      {/* Wave R — the four sections, sticky under the header. Decision-first:
          Overview is the default, so the answer is the first thing rendered. */}
      <TabNav active={tab} onChange={setActiveTab} />

      {/* Wave M — what the last background refresh changed: a different best
          plan, or a newer OEB rate set. Empty (and never rendered) for a
          browser that has not authorised live sync. */}
      <RefreshNoticeBanner notices={refreshNotices} onDismiss={dismissRefreshNotice} />

      {/* Wave H item 1 — while the loaded readings are the synthetic set, the
          page says so on every view, and offers the way out. */}
      {exampleData && (
        <div
          data-testid="example-data-banner"
          role="status"
          className="relative z-[100] bg-amber-200 border-4 border-black rounded-xl md:rounded-2xl px-4 md:px-6 py-3 flex flex-wrap items-center gap-3 md:gap-4 text-black"
        >
          <div className="text-[11px] md:text-sm font-black uppercase">
            Example data — not real usage
          </div>
          <div className="text-[10px] md:text-xs font-bold normal-case text-slate-700 max-w-2xl">
            You are looking at a synthetic year modelled on an Ontario home with an EV,
            so the charts have something to draw. Do not quote these numbers on a bill.
          </div>
          <button
            type="button"
            data-testid="replace-example-data"
            onClick={discardExampleData}
            /* The provenance note prints; the button that swaps data is chrome. */
            className="no-print ml-auto min-h-11 px-4 py-2 bg-black text-white border-4 border-black rounded-lg md:rounded-xl font-black uppercase text-[10px] md:text-xs shadow-[4px_4px_0px_0px_rgba(37,99,235,1)] active:translate-y-0.5 active:shadow-none transition-all"
          >
            Use my own data
          </button>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Link your Green Button data"
          data-testid="upload-modal"
          className="fixed inset-0 bg-black/80 backdrop-blur-md z-[300] flex justify-center overflow-y-auto overlay-safe"
        >
          <div className="my-auto bg-white p-6 md:p-12 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] md:shadow-[20px_20px_0px_0px_rgba(0,0,0,1)] max-w-2xl w-full text-black">
             <h2 className="text-2xl md:text-5xl uppercase tracking-tighter mb-4 md:mb-6 flex items-center gap-2 md:gap-4 text-black font-black"><Upload size={24} className="md:w-12 md:h-12" strokeWidth={4} /> Link Data</h2>
             <p className="font-bold text-slate-600 text-sm md:text-lg mb-6 md:mb-10 text-black">Privacy-First: Data stays in your browser. <span className="underline decoration-blue-500">Upload your XML to begin.</span></p>
             <p className="text-[10px] md:text-xs font-black uppercase text-slate-500 mb-3">Pick one export, or hold Ctrl / ⌘ to pick 2+ and merge them.</p>
             <div className="relative">
               <input type="file" accept=".xml" multiple onChange={handleFileUpload} disabled={parsing} aria-label="Upload Green Button XML" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className={`p-8 md:p-16 border-4 md:border-8 border-dashed ${parsing ? 'border-yellow-400 bg-yellow-50' : 'border-black bg-slate-50'} rounded-xl md:rounded-[2rem] text-center`}><div className="text-lg md:text-2xl font-black uppercase text-black">{parsing ? "ANALYZING..." : "Drop XML Here"}</div></div>
             </div>
             {/* Wave K — the other way to get data in: authorise once and
                 let the shim pipe ESPI straight through to localStorage. */}
             <GreenButtonSync
               variant="modal"
               status={gbStatus}
               syncing={gbSyncing}
               message={gbMessage}
               onConnect={startGreenButtonConnect}
               onSync={() => { void syncFromGreenButton(); }}
               onDisconnect={() => { void disconnectGreenButton(); }}
               onDismissMessage={() => setGbMessage(null)}
             />
             {/* Why the last upload loaded nothing: names what was missing,
                 instead of a bare "invalid XML" (Wave G item 4). */}
             {parseIssue && !parseIssue.ok && (
               <div data-testid="parse-diagnostic" role="alert" className="mt-4 md:mt-6 border-4 border-black bg-red-50 rounded-xl md:rounded-2xl p-4 md:p-6 text-left">
                 <div className="text-sm md:text-lg font-black uppercase text-red-700 mb-2">{parseIssue.headline}</div>
                 <p className="text-[11px] md:text-sm font-bold text-slate-700 normal-case mb-3">{parseIssue.detail}</p>
                 {parseIssue.hints.length > 0 && (
                   <ul className="list-disc ml-5 space-y-1 text-[10px] md:text-xs font-bold text-slate-600 normal-case">
                     {parseIssue.hints.map((h) => <li key={h}>{h}</li>)}
                   </ul>
                 )}
               </div>
             )}
             {/* Wave H item 1 — the front door for anyone with no export:
                 one click loads the bundled synthetic year through the same
                 parser a real upload uses. */}
             <div className="mt-4 flex flex-col md:flex-row gap-3">
               <button
                 type="button"
                 data-testid="try-example-data"
                 onClick={() => { setParseIssue(null); void loadExampleData(); }}
                 disabled={parsing}
                 className="flex-1 min-h-11 py-3 md:py-4 bg-yellow-400 border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-50 disabled:cursor-wait"
               >
                 {parsing ? 'Loading example…' : 'Try with example data'}
               </button>
               {/* Reachable at every width: `md:hidden` used to hide it on
                   desktop, where the overlay has no backdrop/close affordance,
                   so a user who opened Upload by accident could not back out
                   without picking a file. */}
               {!parsing && (
                 <button
                   type="button"
                   onClick={() => { setParseIssue(null); setShowUploadModal(false); }}
                   className="min-h-11 py-3 md:py-4 px-6 bg-slate-100 border-2 border-black rounded-xl font-black uppercase text-[10px] md:text-xs"
                 >
                   Cancel
                 </button>
               )}
             </div>
             <p className="mt-3 text-[9px] md:text-[11px] font-bold text-slate-500 normal-case">
               <span className="font-black uppercase">Example data — not real usage.</span>{' '}
               A synthetic year modelled on an Ontario home with an EV (generated in this
               repo, no real meter or account). Nothing is uploaded anywhere — analysis
               stays in this browser, your own files included.
             </p>
          </div>
        </div>
      )}

      {/* Multi-UsagePoint picker: only when the feed carried more than one meter */}
      {pendingUpload && (
        <UsagePointPicker
          fileName={pendingUpload.fileName}
          groups={pendingUpload.groups}
          onChoose={chooseUsagePoint}
          onCancel={cancelUsagePoint}
        />
      )}

      {/* Multi-file merge review: 2+ exports picked at once — nothing is
          imported until the range, row count and duplicates are on screen. */}
      {pendingMerge && (
        <MultiFileMerge
          files={pendingMerge}
          onFilesChange={setPendingMerge}
          onConfirm={chooseMerge}
          onCancel={cancelMerge}
        />
      )}

      {/* Nav Controls — controls never print; the document below them does.
          Wave R declutter: rate staleness moved to Usage, file/GB status to
          Overview, and the CHART/INSIGHTS toggle is now the tab strip above.
          What stays global is what is global: alerts, the verdict, the plan.

          t_7f224ead — two DELIBERATE full-width rows, not two clusters that
          happen to wrap. Two clusters side by side need ~1645px in a card
          that is 1224px wide at 1440, so the plan cluster used to drop to a
          second line and `lg:ml-auto` pushed it right, leaving a 640x176px
          void in the bottom-left of the card. The card is now a column: each
          row is full width, and the flexible members (the scope switch, the
          floor button) absorb the slack instead of white space doing it. */}
      <div className="no-print relative z-[200] bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black flex flex-col gap-4 md:gap-6 text-black">
        <div className="w-full flex flex-wrap items-center gap-2 md:gap-4">
           <button type="button" onClick={() => { setParseIssue(null); setShowUploadModal(true); }} title="Upload XML" aria-label="Upload XML" className="min-h-11 min-w-11 p-3 md:p-4 bg-black text-white border-4 border-black rounded-xl md:rounded-2xl shadow-[4px_4px_0px_0px_rgba(37,99,235,1)] hover:translate-y-1 active:translate-y-0 active:shadow-none transition-all"><Upload size={18} strokeWidth={4} /></button>
           <button type="button" onClick={emergencyReset} title="Reset Data" aria-label="Reset all data in this browser" className="min-h-11 min-w-11 p-3 md:p-4 bg-white text-red-600 border-4 border-black rounded-xl md:rounded-2xl shadow-[4px_4px_0px_0px_rgba(220,38,38,1)] hover:translate-y-1 active:translate-y-0 active:shadow-none transition-all"><Trash2 size={18} strokeWidth={4} /></button>
           <BackupControls onExport={exportBackup} onImport={importBackupFile} disabled={parsing} />
          {/* Wave M — the only thing in the app allowed to ask the browser
              for notification permission, and only from its own click. */}
          <NotificationToggle connected={gbConnected} backgroundSync={backgroundSync} />
          {/* Wave R — the answer, on every tab. Click jumps to the banner. */}
          <BestChoiceChip
            comparison={comparison}
            userPlan={userPlan}
            days={windowDays}
            active={tab === 'overview'}
            onJump={() => setActiveTab('overview')}
          />

          <div className="flex flex-wrap items-center gap-1 md:gap-2 w-full sm:w-auto">
            <input type="date" aria-label="Window start date" value={startDate} onChange={e => { setStartDate(e.target.value); setViewScope('Custom'); }} className="min-h-11 min-w-0 flex-1 sm:flex-none p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-base md:text-sm text-black bg-white" />
            {/* The quiet separator between the two window dates. Explicit hex
                instead of `text-black opacity-40`: 40% black on white is
                #999999 = 2.84:1 at 10px (axe color-contrast — small text
                needs 4.5:1). #475569 (slate-600) is 7.02:1 on white and still
                reads as secondary; the hex is literal so the regression test
                can measure the ratio instead of trusting a palette name. */}
            <span data-testid="window-separator" className="text-[#475569] font-black text-[10px]">TO</span>
            <input type="date" aria-label="Window end date" value={endDate} onChange={e => { setEndDate(e.target.value); setViewScope('Custom'); }} className="min-h-11 min-w-0 flex-1 sm:flex-none p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-base md:text-sm text-black bg-white" />
          </div>

          {/* The scope switch is row 1's flexible member: it eats the
              slack so the row always reaches the card's right edge instead of
              ending in white space (it is alone on its line below ~940px, where
              it stretches across the whole row). */}
          <div className="flex flex-auto gap-1">
            <button type="button" aria-pressed={viewScope === 'BillingPeriod'} onClick={() => { applyViewScope('BillingPeriod'); setZoomLevelAndClear('monthly'); }} className={`inline-flex flex-1 min-h-11 min-w-11 items-center justify-center p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[10px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'BillingPeriod' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>Billing Period</button>

            <button type="button" aria-pressed={viewScope === 'Month'} onClick={() => { applyViewScope('Month'); setZoomLevelAndClear('monthly'); }} className={`inline-flex flex-1 min-h-11 min-w-11 items-center justify-center p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[10px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'Month' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>Month</button>

            <button type="button" aria-pressed={viewScope === 'YTD'} onClick={() => { applyViewScope('YTD'); setZoomLevelAndClear('monthly'); }} className={`inline-flex flex-1 min-h-11 min-w-11 items-center justify-center p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[10px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'YTD' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>YTD</button>
          </div>
        </div>

        {/* Row 2, full width. `lg:ml-auto` used to right-align this row and
            open the void; the floor button is the flexible member here. The
            gap opens to 24px at lg because the button is now wide enough that
            its `hover:scale-105` would otherwise reach into the switcher. */}
        <div className="w-full flex flex-wrap items-center gap-3 md:gap-4 lg:gap-6">
          <div className="bg-slate-100 p-2 md:p-3 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex items-center gap-2 md:gap-3">
             <Settings2 size={16} className="text-slate-500" />
             <input type="number" min="1" max="31" aria-label="Billing day of month" title={billFeed.summaries.length > 0 ? "Your file states its own billing periods, so this is only the fallback for exports that don't" : "Which day of the month your utility bills you on"} inputMode="numeric" value={billingDay} onChange={e => updateBillingDay(parseInt(e.target.value), startDate)} className="w-11 md:w-12 min-h-11 bg-transparent text-base md:text-sm outline-none text-black font-black" />
          </div>
          <div data-testid="plan-switcher" className="bg-slate-100 p-1 md:p-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex gap-1">
              {/* No aria-label on these: the visible Tiered/TOU/ULO IS the
                  accessible name. A label like "Select Time-of-Use plan" hides
                  "TOU" from the name (axe label-content-name-mismatch — the
                  name must contain what a sighted user reads), and the toggle
                  role already carries the state via aria-pressed. */}
              {(['Tiered', 'TOU', 'ULO'] as const).map((p) => <button key={p} type="button" aria-pressed={userPlan === p} onClick={() => setUserPlan(p)} className={`inline-flex min-h-11 items-center px-3 md:px-6 py-1 md:py-2 rounded-lg md:rounded-xl text-[10px] md:text-[10px] font-black transition-all ${userPlan === p ? 'bg-black text-white shadow-lg' : 'text-black hover:bg-white'}`}>{p}</button>)}
          </div>
          {floor && (
          <button type="button" onClick={() => setShowFloorHelp(true)} title="Always-on floor" aria-label="Always-on floor: what it is and how we measure yours" aria-haspopup="dialog" className="bg-blue-600 text-white min-h-11 flex-1 min-w-[120px] p-3 md:p-6 rounded-2xl md:rounded-3xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] border-2 md:border-4 border-black text-center font-black relative hover:scale-105 active:scale-105 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all group flex flex-col lg:flex-row lg:items-center lg:justify-center lg:gap-4 xl:gap-8">
            <div className="text-[8px] md:text-[10px] uppercase flex items-center justify-center gap-1">Always-on floor <HelpCircle size={8} className="opacity-50 md:size-4 group-hover:opacity-100" /></div>
            <div className="text-xl md:text-4xl italic lg:flex-1">${floor.annualCost.toFixed(0)}/yr</div>
            <div className="text-[8px] md:text-[10px] uppercase opacity-75">{floor.kwhPerDay.toFixed(1)} kWh/day</div>
          </button>
          )}
        </div>
      </div>

      {/* The four sections. Only the active one renders — a hidden tab's
          charts are not drawn, measured or announced to a screen reader. */}
      {tab === 'overview' && (
        <OverviewPanel
          comparison={comparison}
          userPlan={userPlan}
          days={windowDays}
          totals={totals}
          costMode={costMode}
          setCostMode={setCostMode}
          reframe={reframe}
          projection={projection}
          efficiency={efficiency}
          onOpenMoney={() => setActiveTab('money')}
          fileStatus={
            <div className="no-print" data-testid="overview-file-status">
              <GreenButtonSync
                variant="chip"
                status={gbStatus}
                syncing={gbSyncing}
                message={gbMessage}
                onConnect={startGreenButtonConnect}
                onSync={() => { void syncFromGreenButton(); }}
                onDisconnect={() => { void disconnectGreenButton(); }}
                onDismissMessage={() => setGbMessage(null)}
              />
            </div>
          }
        />
      )}

      {tab === 'usage' && (
        <UsagePanel
          staleness={staleness}
          anomalies={anomalies}
          heatmapData={heatmapData}
          processedData={processedData}
          zoomLevel={zoomLevel}
          zoomTarget={zoomTarget}
          goBack={goBack}
          navigatePeriod={navigatePeriod}
          setZoomLevelAndClear={setZoomLevelAndClear}
          activeChartData={activeChartData}
          handleBarClick={handleBarClick}
          selectionCost={selectionCost}
          userPlan={userPlan}
          startDate={startDate}
          filteredData={filteredData}
        />
      )}

      {tab === 'plans' && (
        <PlansPanel
          comparison={comparison}
          userPlan={userPlan}
          setUserPlan={setUserPlan}
          days={windowDays}
          activeRateSet={activeRateSet}
          startDate={startDate}
          endDate={endDate}
          wfh={wfh}
          shiftAnalysis={shiftAnalysis}
          verification={verification}
          summaries={billFeed.summaries}
          allData={processedData}
        />
      )}

      {tab === 'money' && (
        <MoneyPanel
          summaries={billFeed.summaries}
          allData={processedData}
          filteredData={filteredData}
          plan={userPlan}
          rates={activeRateSet}
          startDate={startDate}
          endDate={endDate}
          projection={projection}
          openPeriod={openPeriod}
        />
      )}

      {/* Always-on floor help modal */}
      {showFloorHelp && (
        <div className="no-print fixed inset-0 bg-black/80 backdrop-blur-md z-[400] flex justify-center overflow-y-auto overlay-safe" role="dialog" aria-modal="true" aria-label="What is the always-on floor?" data-testid="floor-help-modal">
          <div className="my-auto bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] md:shadow-[20px_20px_0px_0px_rgba(0,0,0,1)] max-w-xl w-full text-black relative">
            <button type="button" onClick={() => setShowFloorHelp(false)} aria-label="Close" className="absolute top-4 right-4 md:top-6 md:right-6 min-h-11 min-w-11 inline-flex items-center justify-center p-2 hover:bg-slate-100 active:bg-slate-200 rounded-full transition-all"><X size={24} className="md:w-8 md:h-8" strokeWidth={4} /></button>
            <h2 className="text-2xl md:text-4xl uppercase tracking-tighter mb-4 md:mb-6 flex items-center gap-2 md:gap-4 font-black"><Zap size={24} className="text-blue-600 md:w-10 md:h-10" strokeWidth={4} /> What is the always-on floor?</h2>
            <div className="space-y-4 md:space-y-6 font-bold text-slate-700">
              <p className="text-xs md:text-base">The floor is the slice of your bill that never switches off — the fridge, the chargers, the clocks, the standby lights. It is there whether you are home or not, and it is the one part of the bill you can actually switch.</p>
              {floor ? (
                <div className="bg-blue-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-blue-200 text-blue-900">
                  <h4 className="font-black uppercase text-[10px] md:text-sm mb-2">How we measure yours:</h4>
                  <ul className="list-disc ml-4 md:ml-5 space-y-1 md:space-y-2 text-[10px] md:text-sm">
                    <li>We look at your whole visible window and take the <strong>lowest 5% of readings</strong> — the stretches when nothing should have been running.</li>
                    <li>That floor draws <span className="font-black text-blue-600">{floor.watts.toFixed(0)} Watts</span>, about <span className="font-black text-blue-600">{floor.kwhPerDay.toFixed(1)} kWh a day</span>.</li>
                    <li>Priced at your blended <span className="font-black text-blue-600">{floor.blendedRateCents.toFixed(1)}¢/kWh</span>, that is <span className="font-black text-blue-600">${floor.annualCost.toFixed(0)} a year</span> of never-off energy.</li>
                    <li>{floor.detail}</li>
                  </ul>
                </div>
              ) : (
                <p className="text-xs md:text-sm">No readings in the current window yet — widen the date range above and the number appears here.</p>
              )}
              <p className="text-[10px] md:text-sm">Costs are commodity (variable) charges only — no delivery, regulatory charges or HST.</p>
              <button type="button" onClick={() => setShowFloorHelp(false)} className="w-full min-h-11 py-3 md:py-4 bg-black text-white rounded-xl md:rounded-2xl font-black uppercase hover:bg-blue-600 active:bg-blue-700 transition-colors mt-2 md:mt-4">Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
