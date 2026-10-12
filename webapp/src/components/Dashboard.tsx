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
import { HelpCircle, Zap, Upload, X, Trash2, Settings2, AlertTriangle, Download } from 'lucide-react';
import { format } from 'date-fns';
import { downloadTextFile } from '@/lib/download';
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
  type StorageNotice,
} from '@/hooks/useDashboard';
// The readings-only export (storage.ts's own document) — the toolbar's
// quick export, distinct from BackupControls' full-profile JSON.
import { exportEnergyData } from '@/lib/storage';
import { UsagePointPicker } from '@/components/UsagePointPicker';
import { GreenButtonSync } from '@/components/GreenButtonSync';
import { BackupControls } from '@/components/BackupControls';
import { AccountControls } from '@/components/AccountControls';
import { AccountTriggers } from '@/components/AccountTriggers';
import MultiFileMerge from '@/components/MultiFileMerge';
import { useRateStaleness } from '@/hooks/useRateStaleness';
import { useHourlyTemps } from '@/hooks/useHourlyTemps';
import RefreshNoticeBanner from '@/components/RefreshNoticeBanner';
import { NotificationToggle } from '@/components/NotificationToggle';
import LocaleToggle from '@/components/LocaleToggle';
import ThemeToggle from '@/components/ThemeToggle';
import { useThemeBootstrap } from '@/lib/theme';
import { useRefreshNotices } from '@/hooks/useRefreshNotices';
import TabNav from '@/components/TabNav';
import BestChoiceChip from '@/components/BestChoiceChip';
import OverviewPanel from '@/components/OverviewPanel';
import UsagePanel from '@/components/UsagePanel';
import PlansPanel from '@/components/PlansPanel';
import MoneyPanel from '@/components/MoneyPanel';
import { useTabs } from '@/hooks/useTabs';
import { useSelectedPlan } from '@/hooks/useSelectedPlan';
// Wave U — locale, translation and locale-aware formatters. Every text-
// producing memo below lists `t` in its deps so a language switch recomputes.
import {
  planLabel, FR_PLAN_SHORT, fmtMoney, fmtMoney0, fmtNumber, useTranslation,
} from '@/i18n';
import { analyzeTouShifts } from '@/lib/touShift';
import { analyzeShiftVerification } from '@/lib/shiftVerification';
import { projectMonthBill } from '@/lib/billProjection';
import { daysBetweenDayKeys } from '@/lib/dateSpan';

/**
 * One row per storage problem — never let a failed write look like a saved one.
 * Wave U: keys, not sentences, so the row translates with the app.
 */
const STORAGE_MESSAGE_KEYS: Record<StorageNotice['kind'], string> = {
  quota: 'storage.quota',
  corrupt: 'storage.corrupt',
  cleanup: 'storage.cleanup',
};

/** Visible, dismissible row for any storage failure — quota / corrupt / cleanup. */
function StorageNoticeRow({ notice, onDismiss }: { notice: StorageNotice; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" data-testid="storage-notice" className="flex flex-wrap items-start gap-3 md:gap-4 bg-red-600 text-white p-4 md:p-6 rounded-xl md:rounded-2xl border-4 border-edge shadow-hard-6 font-black uppercase">
      <AlertTriangle size={20} strokeWidth={4} className="shrink-0 mt-1" />
      <div className="flex-1 min-w-[200px]">
        <div className="text-xs md:text-base">{t(STORAGE_MESSAGE_KEYS[notice.kind])}</div>
        <div className="text-[10px] md:text-xs opacity-90 normal-case mt-1 break-all">{notice.detail}</div>
      </div>
      <button onClick={onDismiss} title={t('storage.dismiss')} aria-label={t('storage.dismiss')} className="ml-auto p-2 bg-card text-ink border-2 border-edge rounded-lg hover:bg-hover transition-all">
        <X size={16} strokeWidth={4} />
      </button>
    </div>
  );
}

export default function Dashboard() {
  const {
    rawData, rateHistory, loading, parsing,
    showUploadModal, setShowUploadModal,
    billingDay, startDate, endDate, setStartDate, setEndDate,
    viewScope, setViewScope,
    handleFileUpload, updateBillingDay, applyViewScope,
    pendingUpload, chooseUsagePoint, cancelUsagePoint,
    pendingMerge, setPendingMerge, chooseMerge, cancelMerge,
    exportBackup, importBackupFile,
    // Storage surfacing + the two-step, scoped reset (t_a8a54e33)
    storageNotice, dismissStorageNotice, raiseStorageNotice,
    resetConfirmOpen, resetKeys, openResetConfirm, cancelResetConfirm, confirmReset,
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

  // Wave U — the shell's locale subscription. `t` is the memo key for every
  // text-producing computation below.
  const { t, locale } = useTranslation();
  // Dark mode — converges <html data-theme> on the stored preference once
  // the tree is mounted. The FOUC script in layout.tsx has normally already
  // painted the right theme before hydration; this only takes over the
  // `matchMedia` subscription so a phone flipping to dark at sunset repaints
  // live (see lib/theme.ts rule 1).
  useThemeBootstrap();
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

  // --- Readings-only export / import (storage.ts's own document) ----------
  //
  // Deliberately separate from BackupControls, which moves the WHOLE profile
  // (readings + billing day + bill add-ons + plan timeline): this one moves
  // just the readings. Both files are accepted by the same import, so the two
  // affordances are two sizes of the same round trip, not two formats.

  const handleExportData = () => {
    const exported = exportEnergyData(rawData, 'manual-export');
    if (!exported.ok) {
      raiseStorageNotice({ kind: exported.reason, detail: exported.detail });
      return;
    }
    downloadTextFile(
      `energy-optimizer-export-${format(new Date(), 'yyyy-MM-dd')}.json`,
      exported.value,
      'application/json',
    );
  };

  /** The modal's "…or import a previous export (.json)" input. */
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void importBackupFile(file).then((res) => {
      if (res.ok) return; // onBackupApplied reloads and the rows reappear
      // Inside the modal the parse-diagnostic box is where failures are read.
      setParseIssue({
        ok: false,
        headline: t('backup.import.failHeadline'),
        detail: res.error ?? t('backup.import.failDetail'),
        hints: [
          t('backup.import.failHintPick'),
          t('backup.import.failHintAtomic'),
        ],
      });
    });
  };

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

  // Wave T: the ONE Open-Meteo fetch behind the temperature-banded curve and
  // the anomaly context lines. Client-side CDN, cached in this browser,
  // scoped to the dates the readings themselves cover — never a request about
  // a period that has no data, and never through this app's server.
  const temps = useHourlyTemps(processedData);

  const activeChartData = useMemo(() => buildActiveChartData(filteredData, zoomLevel, zoomTarget), [filteredData, zoomLevel, zoomTarget]);

  const comparison = useMemo(() => calculateComparison(activeChartData), [activeChartData]);

  const anomalies = useMemo(
    () => detectAnomalies(processedData, filteredData, temps.temps),
    [processedData, filteredData, temps.temps],
  );

  // Wave N: anomalies are computed HERE (the data never leaves the browser),
  // and AccountTriggers is what lets one reach a closed tab — via the
  // server's caps, never on its own. Renders nothing.
  const accountTriggers = <AccountTriggers anomalies={anomalies} />;

  const heatmapData = useMemo(() => buildHeatmapData(filteredData), [filteredData]);

  // Always-on floor (the old "vampire load"), phrased against the ~10% of
  // bill community benchmark and priced at THIS household's blended rate.
  const floor = useMemo(() => calculateAlwaysOnFloor(filteredData, userPlan), [filteredData, userPlan]);

  // Work-from-home window: what share of the visible energy lands on a
  // weekday between 07:00 and 19:00 — explains why a plan wins or loses.
  const wfh = useMemo(() => calculateWfhShare(filteredData), [filteredData]);

  // "This month's bill" projection: month-to-date + the recent daily average
  // carried to month end, gated on day 5 (see lib/billProjection).
  // Wave U: `t` in deps — projectMonthBill builds its gate note/caption in
  // the active language, so a toggle must re-run it.
  const projection = useMemo(
    () => projectMonthBill(processedData, userPlan, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [processedData, userPlan, t],
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
  // on the dataset's own span — never on the visible window. Shared with
  // OverviewPanel so the two cannot drift (lib/dateSpan.ts).
  const totalDays = totals ? daysBetweenDayKeys(totals.firstDate, totals.lastDate) : 1;

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
  // Wave U: locale-aware money + localized plan name; `t` in deps so the
  // sentence recomputes on toggle instead of staying in the old language.
  const reframe = React.useMemo(() => {
    if (!totals) return '';
    const name = planLabel(totals.bestPlan);
    return costMode === 'yr'
      ? t('totals.reframe.yr', { yearly: fmtMoney0(bestYearly), daily: fmtMoney(bestDaily), plan: name })
      : t('totals.reframe.day', { yearly: fmtMoney0(bestYearly), daily: fmtMoney(bestDaily), plan: name });
  }, [totals, costMode, bestYearly, bestDaily, t]);

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
        className="space-y-10 text-ink relative font-black uppercase"
      >
        <div className="bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-edge flex flex-wrap items-center gap-4 md:gap-6">
          <div className="skeleton-bar h-11 w-11 rounded-xl border-2 border-edge/10" />
          <div className="skeleton-bar h-11 w-44 rounded-lg border-2 border-edge/10" />
          <div className="skeleton-bar h-11 w-32 rounded-lg border-2 border-edge/10" />
          <div className="skeleton-bar h-11 flex-1 min-w-[7rem] rounded-lg border-2 border-edge/10" />
        </div>
        <div className="bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-edge flex flex-wrap items-center gap-4 md:gap-6">
          <div className="skeleton-bar h-16 w-40 rounded-xl border-2 border-edge/10" />
          <div className="skeleton-bar h-10 w-28 rounded-lg border-2 border-edge/10" />
          <div className="skeleton-bar h-14 w-36 rounded-xl border-2 border-edge/10" />
          <div className="skeleton-bar h-14 w-36 rounded-xl border-2 border-edge/10" />
        </div>
        <div
          data-testid="preparing-optimizer"
          className="p-6 text-center font-black text-ink text-3xl md:text-4xl animate-pulse uppercase tracking-tighter"
        >
          {t('loading.preparing')}
        </div>
      </div>
    );

  return (
    <div key="ready" className="space-y-6 md:space-y-10 text-ink relative font-black uppercase">
      {/* Wave N — renders nothing on its own: it is what lets an anomaly
          computed here reach a closed tab (server caps, never on its own). */}
      {accountTriggers}
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
          className="relative z-[100] bg-warn-strip border-4 border-edge rounded-xl md:rounded-2xl px-4 md:px-6 py-3 flex flex-wrap items-center gap-3 md:gap-4 text-ink"
        >
          <div className="text-[11px] md:text-sm font-black uppercase">
            {t('example.banner.title')}
          </div>
          <div className="text-[10px] md:text-xs font-bold normal-case text-ink-2 max-w-2xl">
            {t('example.banner.body')}
          </div>
          <button
            type="button"
            data-testid="replace-example-data"
            onClick={discardExampleData}
            /* The provenance note prints; the button that swaps data is chrome. */
            className="no-print ml-auto min-h-11 px-4 py-2 bg-inv text-inv-ink border-4 border-edge rounded-lg md:rounded-xl font-black uppercase text-[10px] md:text-xs shadow-hard-blue-4 active:translate-y-0.5 active:shadow-none transition-all"
          >
            {t('example.banner.useOwn')}
          </button>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('upload.modal.aria')}
          data-testid="upload-modal"
          className="fixed inset-0 bg-inv/80 backdrop-blur-md z-[300] flex justify-center overflow-y-auto overlay-safe"
        >
          <div className="my-auto bg-card p-6 md:p-12 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-edge shadow-hard-10 md:shadow-hard-20 max-w-2xl w-full text-ink">
             <h2 className="text-2xl md:text-5xl uppercase tracking-tighter mb-4 md:mb-6 flex items-center gap-2 md:gap-4 text-ink font-black"><Upload size={24} className="md:w-12 md:h-12" strokeWidth={4} /> {t('upload.modal.title')}</h2>
             <p className="font-bold text-ink-2 text-sm md:text-lg mb-6 md:mb-10 text-ink">{t('upload.modal.privacy')} <span className="underline decoration-blue-500">{t('upload.modal.privacyHighlight')}</span></p>
             {storageNotice && <div className="mb-4 md:mb-6"><StorageNoticeRow notice={storageNotice} onDismiss={dismissStorageNotice} /></div>}
             <p className="text-[10px] md:text-xs font-black uppercase text-ink-3 mb-3">{t('upload.modal.mergeHint')}</p>
             <div className="relative">
               <input type="file" accept=".xml" multiple onChange={handleFileUpload} disabled={parsing} aria-label={t('upload.xml.aria')} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className={`p-8 md:p-16 border-4 md:border-8 border-dashed ${parsing ? 'border-yellow-400 bg-accent-soft' : 'border-edge bg-inset'} rounded-xl md:rounded-[2rem] text-center`}><div className="text-lg md:text-2xl font-black uppercase text-ink">{parsing ? t('upload.analyzing') : t('upload.dropzone')}</div></div>
             </div>
             {/* The other way in with no utility file at all: a JSON this app
                 exported before (full profile or readings only). */}
             <label className="mt-4 block cursor-pointer">
               <input type="file" accept="application/json,.json" onChange={handleImportJson} aria-label={t('upload.importJson.aria')} className="sr-only" />
               <span className="block min-h-11 w-full py-3 bg-good-soft border-2 border-edge rounded-xl font-black uppercase text-[10px] md:text-xs text-ink text-center">{t('upload.importJson.label')}</span>
             </label>
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
               <div data-testid="parse-diagnostic" role="alert" className="mt-4 md:mt-6 border-4 border-edge bg-red-50 rounded-xl md:rounded-2xl p-4 md:p-6 text-left">
                 <div className="text-sm md:text-lg font-black uppercase text-bad mb-2">{parseIssue.headline}</div>
                 <p className="text-[11px] md:text-sm font-bold text-ink-2 normal-case mb-3">{parseIssue.detail}</p>
                 {parseIssue.hints.length > 0 && (
                   <ul className="list-disc ml-5 space-y-1 text-[10px] md:text-xs font-bold text-ink-2 normal-case">
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
                 className="flex-1 min-h-11 py-3 md:py-4 bg-yellow-400 text-accent-ink border-4 border-edge rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs shadow-hard-4 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-50 disabled:cursor-wait"
               >
                 {parsing ? t('upload.tryExample.loading') : t('upload.tryExample.idle')}
               </button>
               {/* Reachable at every width: `md:hidden` used to hide it on
                   desktop, where the overlay has no backdrop/close affordance,
                   so a user who opened Upload by accident could not back out
                   without picking a file. */}
               {!parsing && (
                 <button
                   type="button"
                   onClick={() => { setParseIssue(null); setShowUploadModal(false); }}
                   className="min-h-11 py-3 md:py-4 px-6 bg-hover border-2 border-edge rounded-xl font-black uppercase text-[10px] md:text-xs"
                 >
                   {t('common.cancel')}
                   </button>
               )}
             </div>
             <p className="mt-3 text-[9px] md:text-[11px] font-bold text-ink-3 normal-case">
               <span className="font-black uppercase">{t('example.modal.title')}</span>{' '}
               {t('example.modal.body')}
             </p>
          </div>
        </div>
      )}

      {/* Reset: two-step confirm, scoped to this app's keys only */}
      {resetConfirmOpen && (
        <div className="fixed inset-0 bg-inv/80 backdrop-blur-md z-[350] flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-label={t('reset.aria')} data-testid="reset-confirm" className="bg-card p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-edge shadow-hard-10 md:shadow-hard-20 max-w-lg w-full text-ink">
            <h2 className="text-xl md:text-3xl uppercase tracking-tighter mb-3 md:mb-4 flex items-center gap-2 md:gap-3 text-bad font-black"><AlertTriangle size={22} strokeWidth={4} /> {t('reset.title')}</h2>
            <p className="font-bold text-ink-2 text-xs md:text-sm mb-2">{t('reset.body', { count: resetKeys.length })} <em>{t('reset.browserOnly')}</em></p>
            <p className="font-black uppercase text-[10px] md:text-xs text-ink-3 mb-4 md:mb-6 break-all">{resetKeys.length > 0 ? resetKeys.join(', ') : t('reset.nothingStored')} — {t('reset.otherUntouched')}</p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button type="button" onClick={confirmReset} title={t('reset.confirmTitle')} className="min-h-11 flex-1 py-3 md:py-4 bg-red-600 text-white border-4 border-edge rounded-xl md:rounded-2xl font-black uppercase text-xs md:text-sm hover:bg-red-700 active:translate-y-0.5 transition-colors">{t('reset.confirm')}</button>
              <button type="button" onClick={cancelResetConfirm} title={t('reset.cancelTitle')} className="min-h-11 flex-1 py-3 md:py-4 bg-hover border-2 border-edge rounded-xl md:rounded-2xl font-black uppercase text-xs md:text-sm hover:bg-track active:translate-y-0.5 transition-colors">{t('common.cancel')}</button>
            </div>
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
      <div className="no-print relative z-[200] bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-hard-8 border-4 border-edge flex flex-col gap-4 md:gap-6 text-ink">
        <div className="w-full flex flex-wrap items-center gap-2 md:gap-4">
           <button type="button" onClick={() => { setParseIssue(null); setShowUploadModal(true); }} title={t('toolbar.upload')} aria-label={t('toolbar.upload')} className="min-h-11 min-w-11 p-3 md:p-4 bg-inv text-inv-ink border-4 border-edge rounded-xl md:rounded-2xl shadow-hard-blue-4 hover:translate-y-1 active:translate-y-0 active:shadow-none transition-all"><Upload size={18} strokeWidth={4} /></button>
           <button type="button" onClick={openResetConfirm} title={t('toolbar.resetTitle')} aria-label={t('toolbar.reset')} className="min-h-11 min-w-11 p-3 md:p-4 bg-card text-bad border-4 border-edge rounded-xl md:rounded-2xl shadow-hard-red-4 hover:translate-y-1 active:translate-y-0 active:shadow-none transition-all"><Trash2 size={18} strokeWidth={4} /></button>
           <button type="button" onClick={handleExportData} title={t('toolbar.export')} aria-label={t('toolbar.export')} disabled={rawData.length === 0} className="min-h-11 min-w-11 p-3 md:p-4 bg-card text-info border-4 border-edge rounded-xl md:rounded-2xl shadow-hard-blue-4 hover:translate-y-1 active:translate-y-0 active:shadow-none transition-all disabled:opacity-40 disabled:cursor-not-allowed"><Download size={18} strokeWidth={4} /></button>
           <BackupControls onExport={exportBackup} onImport={importBackupFile} disabled={parsing} />
          {/* Wave M — the only thing in the app allowed to ask the browser
              for notification permission, and only from its own click. */}
          <NotificationToggle connected={gbConnected} backgroundSync={backgroundSync} />
          {/* Wave N — the account control sits with the other global chrome:
              sign-in state is as global as the notification toggle. */}
          <AccountControls onDataApplied={() => window.location.reload()} />
          {/* Wave R — the answer, on every tab. Click jumps to the banner. */}
          <BestChoiceChip
            comparison={comparison}
            userPlan={userPlan}
            days={windowDays}
            active={tab === 'overview'}
            onJump={() => setActiveTab('overview')}
          />

          <div className="flex flex-wrap items-center gap-1 md:gap-2 w-full sm:w-auto">
            <input type="date" aria-label={t('toolbar.windowStart')} value={startDate} onChange={e => { setStartDate(e.target.value); setViewScope('Custom'); }} className="min-h-11 min-w-0 flex-1 sm:flex-none p-3 border-2 md:border-4 border-edge rounded-lg md:rounded-xl font-black text-base md:text-sm text-ink bg-card" />
            {/* The quiet separator between the two window dates. Explicit hex
                instead of `text-ink opacity-40`: 40% black on white is
                #999999 = 2.84:1 at 10px (axe color-contrast — small text
                needs 4.5:1). #475569 (slate-600) is 7.02:1 on white and still
                reads as secondary; the hex is literal so the regression test
                can measure the ratio instead of trusting a palette name. */}
            <span data-testid="window-separator" className="text-ink-2 font-black text-[10px]">{t('toolbar.to')}</span>
            <input type="date" aria-label={t('toolbar.windowEnd')} value={endDate} onChange={e => { setEndDate(e.target.value); setViewScope('Custom'); }} className="min-h-11 min-w-0 flex-1 sm:flex-none p-3 border-2 md:border-4 border-edge rounded-lg md:rounded-xl font-black text-base md:text-sm text-ink bg-card" />
          </div>

          {/* The scope switch is row 1's flexible member: it eats the
              slack so the row always reaches the card's right edge instead of
              ending in white space (it is alone on its line below ~940px, where
              it stretches across the whole row). */}
          <div className="flex flex-auto gap-1">
            <button type="button" aria-pressed={viewScope === 'BillingPeriod'} onClick={() => { applyViewScope('BillingPeriod'); setZoomLevelAndClear('monthly'); }} className={`inline-flex flex-1 min-h-11 min-w-11 items-center justify-center p-2 md:p-3 border-2 md:border-4 border-edge rounded-lg md:rounded-xl font-black text-[10px] md:text-[10px] shadow-hard-2 md:shadow-hard-4 active:shadow-none transition-all uppercase ${viewScope === 'BillingPeriod' ? 'bg-yellow-400 text-accent-ink' : 'bg-card text-ink hover:bg-inset'}`}>{t('scope.billingPeriod')}</button>

            <button type="button" aria-pressed={viewScope === 'Month'} onClick={() => { applyViewScope('Month'); setZoomLevelAndClear('monthly'); }} className={`inline-flex flex-1 min-h-11 min-w-11 items-center justify-center p-2 md:p-3 border-2 md:border-4 border-edge rounded-lg md:rounded-xl font-black text-[10px] md:text-[10px] shadow-hard-2 md:shadow-hard-4 active:shadow-none transition-all uppercase ${viewScope === 'Month' ? 'bg-yellow-400 text-accent-ink' : 'bg-card text-ink hover:bg-inset'}`}>{t('scope.month')}</button>

            <button type="button" aria-pressed={viewScope === 'YTD'} onClick={() => { applyViewScope('YTD'); setZoomLevelAndClear('monthly'); }} className={`inline-flex flex-1 min-h-11 min-w-11 items-center justify-center p-2 md:p-3 border-2 md:border-4 border-edge rounded-lg md:rounded-xl font-black text-[10px] md:text-[10px] shadow-hard-2 md:shadow-hard-4 active:shadow-none transition-all uppercase ${viewScope === 'YTD' ? 'bg-yellow-400 text-accent-ink' : 'bg-card text-ink hover:bg-inset'}`}>{t('scope.ytd')}</button>
          </div>
        </div>

        {/* Row 2, full width. `lg:ml-auto` used to right-align this row and
            open the void; the floor button is the flexible member here. The
            gap opens to 24px at lg because the button is now wide enough that
            its `hover:scale-105` would otherwise reach into the switcher. */}
        <div className="w-full flex flex-wrap items-center gap-3 md:gap-4 lg:gap-6">
          <div className="bg-hover p-2 md:p-3 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge flex items-center gap-2 md:gap-3">
             <Settings2 size={16} className="text-ink-3" />
             <input type="number" min="1" max="31" aria-label={t('toolbar.billingDay')} title={billFeed.summaries.length > 0 ? t('toolbar.billingDay.fileOwns') : t('toolbar.billingDay.fallback')} inputMode="numeric" value={billingDay} onChange={e => updateBillingDay(parseInt(e.target.value), startDate)} className="w-11 md:w-12 min-h-11 bg-transparent text-base md:text-sm outline-none text-ink font-black" />
          </div>
          <div data-testid="plan-switcher" className="bg-hover p-1 md:p-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge flex gap-1">
              {/* No aria-label on these: the visible Tiered/TOU/ULO IS the
                  accessible name. A label like "Select Time-of-Use plan" hides
                  "TOU" from the name (axe label-content-name-mismatch — the
                  name must contain what a sighted user reads), and the toggle
                  role already carries the state via aria-pressed. */}
              {/* Wave U — in French the switcher shows the compact OEB names
                  (Heures / Paliers / Nuit); in English the canonical
                  Tiered/TOU/ULO, which stay the accessible name (the visible
                  text IS the name — see the note above). `data-plan` always
                  carries the canonical id. */}
              {(['Tiered', 'TOU', 'ULO'] as const).map((p) => <button key={p} type="button" data-plan={p} aria-pressed={userPlan === p} onClick={() => setUserPlan(p)} className={`inline-flex min-h-11 items-center px-3 md:px-6 py-1 md:py-2 rounded-lg md:rounded-xl text-[10px] md:text-[10px] font-black transition-all ${userPlan === p ? 'bg-inv text-inv-ink shadow-lg' : 'text-ink hover:bg-card'}`}>{locale === 'fr' ? FR_PLAN_SHORT[p] : p}</button>)}
          </div>
          {/* Wave U — the EN/FR switch, deliberately NEXT TO the plan chip:
              the language of the answer belongs beside the answer. A real
              <button> in the tab order with aria-pressed and a localized
              name (Wave H's a11y bar). */}
          <LocaleToggle />
          {/* Dark mode — next to the language switch because both are
              preferences about how the answer is SHOWN, not what it says.
              A radiogroup, not a cycling button: three states behind one
              control is an ARIA anti-pattern (see ThemeToggle.tsx). */}
          <ThemeToggle />
          {/* `lg:min-w-max` on the floor button: below lg it stacks its three
              lines, so it cannot overflow sideways; from lg up it becomes a
              row, and a wide theme/language cluster could squeeze it under its
              own content — which then spills out of the card and trips the
              toolbar gate's "does not scroll sideways" check (it did, at
              1100x900, before this). max-content as a floor means the button
              never shrinks past what it must print: when the row cannot hold
              it, flex-wrap moves it to a line of its own and `flex-1` stretches
              it there instead of truncating the annual number. It stops
              wrapping at 1279px — the width where all five row-2 items fit
              on one line again. The old `xl:gap-8` is gone for the same
              budget: it added 32px to that max-content and was what pushed
              1280 (the very next breakpoint) back into a wrap, opening a
              45,936px² dead band 936px² over the gate. */}
          {floor && (
          <button type="button" onClick={() => setShowFloorHelp(true)} title={t('floor.button')} aria-label={t('floor.buttonAria')} aria-haspopup="dialog" className="bg-blue-600 text-white min-h-11 flex-1 min-w-[120px] lg:min-w-max p-3 md:p-6 rounded-2xl md:rounded-3xl shadow-hard-4 md:shadow-hard-8 border-2 md:border-4 border-edge text-center font-black relative hover:scale-105 active:scale-105 active:shadow-hard-2 transition-all group flex flex-col lg:flex-row lg:items-center lg:justify-center lg:gap-4">
            <div className="text-[8px] md:text-[10px] uppercase flex items-center justify-center gap-1">{t('floor.button')} <HelpCircle size={8} className="opacity-50 md:size-4 group-hover:opacity-100" /></div>
            <div className="text-xl md:text-4xl italic lg:flex-1">{t('floor.annual', { cost: fmtMoney0(floor.annualCost) })}</div>
            <div className="text-[8px] md:text-[10px] uppercase opacity-75">{t('floor.perDay', { kwh: fmtNumber(floor.kwhPerDay, 1) })}</div>
          </button>
          )}
        </div>
      </div>

      {/* Storage failure row (visible whenever a read/write did not land) */}
      {storageNotice && !showUploadModal && (
        <StorageNoticeRow notice={storageNotice} onDismiss={dismissStorageNotice} />
      )}

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
          temps={temps}
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
          billingDay={billingDay}
        />
      )}

      {/* Always-on floor help modal */}
      {showFloorHelp && (
        <div className="no-print fixed inset-0 bg-inv/80 backdrop-blur-md z-[400] flex justify-center overflow-y-auto overlay-safe" role="dialog" aria-modal="true" aria-label={t('floor.modalAria')} data-testid="floor-help-modal">
          <div className="my-auto bg-card p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-edge shadow-hard-10 md:shadow-hard-20 max-w-xl w-full text-ink relative">
            <button type="button" onClick={() => setShowFloorHelp(false)} aria-label={t('common.close')} className="absolute top-4 right-4 md:top-6 md:right-6 min-h-11 min-w-11 inline-flex items-center justify-center p-2 hover:bg-hover active:bg-track rounded-full transition-all"><X size={24} className="md:w-8 md:h-8" strokeWidth={4} /></button>
            <h2 className="text-2xl md:text-4xl uppercase tracking-tighter mb-4 md:mb-6 flex items-center gap-2 md:gap-4 font-black"><Zap size={24} className="text-info md:w-10 md:h-10" strokeWidth={4} /> {t('floor.modalTitle')}</h2>
            <div className="space-y-4 md:space-y-6 font-bold text-ink-2">
              <p className="text-xs md:text-base">{t('floor.explainer')}</p>
              {floor ? (
                <div className="bg-info-soft p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-info-edge text-ink">
                  <h4 className="font-black uppercase text-[10px] md:text-sm mb-2">{t('floor.measureTitle')}</h4>
                  <ul className="list-disc ml-4 md:ml-5 space-y-1 md:space-y-2 text-[10px] md:text-sm">
                    <li>{t('floor.measureStep1a')}<strong>{t('floor.measureStep1b')}</strong>{t('floor.measureStep1c')}</li>
                    <li>{t('floor.measureStep2a')}<span className="font-black text-info">{t('unit.watts', { watts: fmtNumber(floor.watts) })}</span>{t('floor.measureStep2b')}<span className="font-black text-info">{t('unit.kwhPerDay', { kwh: fmtNumber(floor.kwhPerDay, 1) })}</span>.</li>
                    <li>{t('floor.measureStep3a')}<span className="font-black text-info">{t('unit.centsPerKwh', { cents: fmtNumber(floor.blendedRateCents, 1) })}</span>{t('floor.measureStep3b')}<span className="font-black text-info">{t('floor.yearlyCost', { cost: fmtMoney0(floor.annualCost) })}</span>{t('floor.measureStep3c')}</li>
                    <li>{floor.detail}</li>
                  </ul>
                </div>
              ) : (
                <p className="text-xs md:text-sm">{t('floor.noWindow')}</p>
              )}
              <p className="text-[10px] md:text-sm">{t('legal.commodityOnly')}</p>
              <button type="button" onClick={() => setShowFloorHelp(false)} className="w-full min-h-11 py-3 md:py-4 bg-inv text-inv-ink rounded-xl md:rounded-2xl font-black uppercase hover:bg-blue-600 active:bg-blue-700 transition-colors mt-2 md:mt-4">{t('common.gotIt')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
