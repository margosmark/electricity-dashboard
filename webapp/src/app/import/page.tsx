/**
 * Wave J — `/import`, the client-only landing place for a refreshed export.
 *
 * The dashboard has no backend and must never grow one, so the automated
 * DMD refresh on .110 cannot POST anything anywhere. The handoff is:
 *
 *   ops/dmd/dmd_export_b64.py  →  base64  →  paste / drop here  →  localStorage
 *
 * This page parses the payload with the app's own Green Button parser (the
 * exact code path the upload modal uses, so a file that loads here loads
 * there), then writes the readings through the same storage contract the
 * dashboard reads (versioned `energy_data_v2`, legacy key migrated) and the
 * bill half through the modal's own keys (`usage_summaries` /
 * `local_time_parameters`) — a feed is both halves, and writing only the
 * readings is how an Enbridge export used to import with no gas anywhere
 * (t_05195060). The one thing this page adds is a promise the upload flow
 * makes implicitly and this one states out loud: **existing readings are
 * never overwritten without a merge review.** With an empty profile it
 * imports straight away, because there is nothing to lose.
 *
 * Sources accepted: a dropped/picked XML file, a pasted XML document, pasted
 * base64 (`dmd_export_b64.py --b64`), and `?d=<base64>` for small payloads.
 */

'use client';

/* Wave U — user-visible copy translates; lib code reads the module locale. */
import { useTranslation } from "@/i18n";
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileDown, GitMerge, Replace, X } from 'lucide-react';
import {
  parseGreenButtonFeed,
  type DataPoint,
  type UsagePointGroup,
} from '@/lib/energy';
import { type ParseDiagnostic } from '@/lib/parseDiagnostic';
import UsagePointPicker from '@/components/UsagePointPicker';
// Commodity 7: a gas extract's bill half is decided with the WHOLE feed in
// hand (which IntervalBlock belongs to which period), exactly as the upload
// modal does it — see gasBillUi.
import { enrichGasSummaries, isGasFeed } from '@/lib/gasBillUi';
// Commodity isolation (t_8a9038d6): one document, two buckets — the gas half
// must reach `energy_gas_v2`, never the electric writer.
import { splitFeed, primaryCommodity, unionGasPoints, type Commodity } from '@/lib/commodity';
// t_cb0cf70f — Defect B: stage the detection verdict before router.push so
// the dashboard's notice can disclose what THIS page just wrote.
import { stageCommodityNotice } from '@/lib/importNotice';
import {
  countUsableRows,
  EMPTY_BILL_FEED,
  EXAMPLE_DATA_KEY,
  readStoredBillFeed,
  readStoredGasBillFeed,
  writeStoredBillFeed,
  writeStoredGasBillFeed,
  commoditySelection,
  type BillFeed,
} from '@/hooks/useDashboard';
import {
  decodeImportPayload,
  mergeForWrite,
  planImport,
  type ImportPlan,
} from '@/lib/importPlan';
import { planBillFeed, type BillFeedMode } from './billFeedPlan';
// One implementation of "what the app says when a document will not import"
// — shared with the upload modal and the sync toolbar (greenbutton/recovery.ts).
// It owns BOTH conversions this page used to make inline: the gate's
// zero-usable-rows sentence and the catch's failure sentence.
import { recoveryMessage } from '@/lib/greenbutton/recovery';
// The readings live under the versioned key; storage.ts owns the read, the
// legacy-key migration and the write (the dashboard reads exactly this).
import {
  loadEnergyData,
  saveEnergyData,
  loadGasData,
  saveGasData,
  type GasPoint,
} from '@/lib/storage';

/** Only the failure branch is ever rendered as an error box. */
type FailedDiagnostic = Extract<ParseDiagnostic, { ok: false }>;

const CARD =
  'bg-card border-4 md:border-8 border-edge rounded-[2rem] md:rounded-[3rem] ' +
  'shadow-hard-10 p-5 md:p-10 text-ink';
const BTN =
  'min-h-11 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl ' +
  'border-4 border-edge font-black uppercase text-xs shadow-hard-4 ' +
  'active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40';

function loadStored(): DataPoint[] {
  if (typeof window === 'undefined') return [];
  // Unreadable storage reads as "no existing rows" — this page's safe
  // default, since there is then nothing to merge with or overwrite.
  const stored = loadEnergyData();
  return stored.ok && stored.value ? stored.value.points : [];
}

function ImportFlow() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [issue, setIssue] = useState<FailedDiagnostic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [groups, setGroups] = useState<UsagePointGroup[] | null>(null);
  const [plan, setPlan] = useState<{
    plan: ImportPlan;
    incoming: DataPoint[];
    existing: DataPoint[];
    /**
     * What this document was detected as (t_cb0cf70f — Defect B): the gas
     * review screen disclosed its commodity since t_8a9038d6, but an
     * electric or mixed document's review showed no detection line at all.
     * Computed when the review opens, from the halves the pending import
     * actually carries.
     */
    detected: 'electricity' | 'both';
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const autoApplied = useRef(false);
  /**
   * The BILL half of the file being imported, held until the user actually
   * commits it — a picker or a review screen that is cancelled must not have
   * already written bills (the rule useDashboard's `billFeedsRef` follows for
   * the same reason).
   *
   * `usable` is the whole document's row count, which is what the "no
   * readings" gate has to ask: a gas extract carries ZERO electric
   * `DataPoint`s — its rows live in commodity-7 volume series (see
   * `countUsableRows`), so gating on `readings` alone rejected every Enbridge
   * export with "produced no readable rows".
   */
  const pendingRef = useRef<{
    /** Whole document's row count (electric + volume) — the import gate. */
    usable: number;
    /** Electric intervals (kWh) the document carries. */
    electric: DataPoint[];
    /** Gas intervals (m³) the document carries — a disjoint type. */
    gas: GasPoint[];
    /** Each commodity's bill half, held until the user commits (t_8a9038d6). */
    electricFeed: BillFeed;
    gasFeed: BillFeed;
    /** Which section this document should open when it lands. */
    primary: Commodity | null;
  } | null>(null);

  /**
   * The GAS review screen (t_8a9038d6): a gas document meeting stored gas
   * data must not overwrite it silently — the electric plan review has the
   * same rule for the same reason.
   */
  const [gasPlan, setGasPlan] = useState<{
    incoming: GasPoint[];
    existing: GasPoint[];
    incomingFeed: BillFeed;
    existingFeed: BillFeed;
  } | null>(null);

  /**
   * The write. Same storage keys the upload modal's `commitReadings` touches
   * (`energy_data` plus the example-data flag), then a client navigation to
   * `/` so every hook that seeds itself from storage on boot re-reads the new
   * rows — the identical finalization path a manual upload ends on.
   *
   * A feed is TWO halves: the readings above, and the UsageSummary bills +
   * clock rules under `usage_summaries` / `local_time_parameters`. Writing
   * only the first is how an Enbridge export used to import "successfully"
   * with no gas anywhere (`isGasFeed` false ⇒ every gas surface off), so the
   * bill half commits in the same click, with the merge/replace verdict the
   * review screen just got (planBillFeed).
   */
  const commit = useCallback(
    (rows: DataPoint[], mode: BillFeedMode) => {
      const pending = pendingRef.current;

      // The GAS half of a mixed document rides along first, as a MERGE
      // (t_8a9038d6): the review screen the user just confirmed was about
      // ELECTRIC rows, so nothing here may replace gas data they did not
      // review — and a gas failure aborts before the electric write, so a
      // refused import still writes nothing.
      if (pending && (pending.gas.length > 0 || pending.gasFeed.summaries.length > 0)) {
        const gasStored = loadGasData();
        if (!gasStored.ok) {
          window.alert(t('backup.errRefused', { detail: gasStored.detail }));
          return;
        }
        const gasPoints = unionGasPoints(gasStored.value?.points ?? [], pending.gas);
        // Write the interval bucket only when it holds something (t_cb0cf70f):
        // a bills-only gas half — an electric-led mixed document — has no gas
        // intervals, and creating an EMPTY `energy_gas_v2` would announce a
        // bucket the document never carried. The modal path never writes one
        // either, so the two entry paths agree key-for-key. The bill half
        // below still lands either way; when points exist the union write is
        // unchanged (merge never clears stored intervals).
        if (gasPoints.length > 0) {
          const gasSaved = saveGasData(gasPoints, { source: 'import-page' });
          if (!gasSaved.ok) {
            window.alert(t('backup.errRefused', { detail: gasSaved.detail }));
            return;
          }
        }
        const gasWritten = writeStoredGasBillFeed(
          planBillFeed('merge', readStoredGasBillFeed(), pending.gasFeed),
          'union',
        );
        if (!gasWritten.ok) {
          window.alert(t('import.billsRefused', { detail: gasWritten.detail }));
          return;
        }
      }

      // Snapshot before any write: what the bill merge unions against is the
      // feed this browser held when the import was confirmed.
      const existingBills = readStoredBillFeed();
      const saved = saveEnergyData(rows, { source: 'import-page' });
      if (!saved.ok) {
        window.alert(t('backup.errRefused', { detail: saved.detail }));
        return;
      }
      const written = writeStoredBillFeed(
        planBillFeed(mode, existingBills, pending?.electricFeed ?? EMPTY_BILL_FEED),
      );
      // A failed bill write is reported, never absorbed: those keys are the
      // ONLY persisted copy of an electric user's periods, and a silent quota
      // failure would look exactly like a finished import until the reload
      // that found no periods. The page stays here — navigating away would
      // report a half-import as done.
      if (!written.ok) {
        window.alert(t('import.billsRefused', { detail: written.detail }));
        return;
      }
      // Open the section this document actually filled (view choice only —
      // what was written above was decided by the document, not by this).
      commoditySelection.write(pending?.primary ?? 'electricity');
      // Detection disclosure across the navigation (t_cb0cf70f — Defect B):
      // the dashboard's notice is hook state that does not exist yet when
      // this page commits, so the verdict — derived from the halves this
      // commit actually WROTE — is staged for the hook to consume on mount.
      // Without it an electric or mixed document imported here surfaced no
      // detection disclosure anywhere.
      const wroteElectricity = Boolean(
        pending && (pending.electric.length > 0 || pending.electricFeed.summaries.length > 0),
      );
      const wroteGas = Boolean(
        pending && (pending.gas.length > 0 || pending.gasFeed.summaries.length > 0),
      );
      stageCommodityNotice(
        wroteElectricity && wroteGas ? 'both' : wroteGas ? 'gas' : wroteElectricity ? 'electricity' : null,
      );
      try {
        window.localStorage.removeItem(EXAMPLE_DATA_KEY);
      } catch {
        // The flag is bookkeeping; the readings above are what matters.
      }
      router.push('/');
    },
    // Wave U — `t` in deps so the saved-failure alert recomputes on a switch.
    [router, t],
  );

  /**
   * The GAS write (t_8a9038d6). Addresses ONLY `energy_gas_v2` and the gas
   * bill keys — `energy_data_v2` and `usage_summaries` are not touched here,
   * which is what lets a gas import land beside an existing electric dataset
   * in either order.
   */
  const commitGas = useCallback(
    (mode: BillFeedMode) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const stored = loadGasData();
      if (!stored.ok) {
        window.alert(t('backup.errRefused', { detail: stored.detail }));
        return;
      }
      const points =
        mode === 'replace'
          ? pending.gas
          : unionGasPoints(stored.value?.points ?? [], pending.gas);
      const saved = saveGasData(points, { source: 'import-page' });
      if (!saved.ok) {
        window.alert(t('backup.errRefused', { detail: saved.detail }));
        return;
      }
      const written = writeStoredGasBillFeed(
        planBillFeed(mode, readStoredGasBillFeed(), pending.gasFeed),
        mode === 'replace' ? 'replace' : 'union',
      );
      if (!written.ok) {
        window.alert(t('import.billsRefused', { detail: written.detail }));
        return;
      }
      // The dashboard opens on the section this import filled.
      commoditySelection.write('gas');
      // Same handoff as `commit` (t_cb0cf70f — Defect B): stage the verdict
      // so the dashboard's notice — which does not exist yet across this
      // navigation — says gas was imported instead of saying nothing.
      stageCommodityNotice('gas');
      router.push('/');
    },
    [router, t],
  );

  /** Everything a confirmed write needs is computed here; nothing writes. */
  const reviewOrImport = useCallback((incoming: DataPoint[]) => {
    const pending = pendingRef.current;
    // The gate asks the WHOLE document (electric rows + gas volume rows),
    // because a gas extract parses to rows that are not `readings`.
    if (!pending || pending.usable === 0) {
      setIssue({
        ok: false,
        headline: t('upload.noReadingsHeadline'),
        detail: t('upload.noReadingsDetailParsed'),
        hints: [t('upload.noReadingsHint')],
      });
      return;
    }
    // A document with NO electric rows is a GAS import: its review must ask
    // about gas intervals, and its write must never address the electric keys
    // (an empty `saveEnergyData([])` used to wipe `energy_data_v2` here).
    if (pending.electric.length === 0 && pending.electricFeed.summaries.length === 0) {
      const gasStored = loadGasData();
      if (!gasStored.ok) {
        window.alert(t('backup.errRefused', { detail: gasStored.detail }));
        return;
      }
      const existingGas = gasStored.value?.points ?? [];
      const existingGasFeed = readStoredGasBillFeed();
      if (existingGas.length === 0 && existingGasFeed.summaries.length === 0) {
        // Nothing to lose → straight through, MERGE (never replace: without
        // a review the user has not chosen to drop anything).
        commitGas('merge');
        return;
      }
      setGasPlan({
        incoming: pending.gas,
        incomingFeed: pending.gasFeed,
        existing: existingGas,
        existingFeed: existingGasFeed,
      });
      return;
    }

    const existing = loadStored();
    if (existing.length === 0) {
      // Nothing to lose → straight through. MERGE, never replace: with no
      // review screen the user has not chosen to drop anything, so a file
      // that carries no bills must not take the ones already stored (AC3).
      commit(incoming, 'merge');
      return;
    }
    // The review's detection line (t_cb0cf70f — Defect B): this path only
    // runs for a document WITH an electric half, so it is 'both' exactly
    // when the pending import also carries gas rows or gas periods.
    const carriesGas = pending.gas.length > 0 || pending.gasFeed.summaries.length > 0;
    setPlan({
      plan: planImport(existing, incoming),
      incoming,
      existing,
      detected: carriesGas ? 'both' : 'electricity',
    });
    // Wave U — `t` in deps so the diagnostics recompute on a language switch.
  }, [commit, commitGas, t]);

  const ingestText = useCallback(
    (text: string, name?: string) => {
      setIssue(null);
      setError(null);
      setParsing(true);
      pendingRef.current = null;
      try {
        // One pass, everything the bytes carry — the exact call the upload
        // modal makes, so a file that loads here loads there: readings for
        // the picker, bills + clock for the commit.
        const feed = parseGreenButtonFeed(text);
        const parsed = feed.groups;
        // The gate counts gas volume rows too — see countUsableRows. Gating
        // on `g.readings` alone rejected every Enbridge extract, whose rows
        // are commodity-7 volume series, with "produced no readable rows".
        const usable = countUsableRows(parsed);
        if (usable === 0) {
          // Nothing to import — and the message says WHY (no entries, no
          // timestamps, not Green Button data at all), not just "no readings".
          // recoveryMessage owns this sentence too: with no `error` it is the
          // GATE branch, and it keeps this page's own `upload.noReadings*`
          // copy when the diagnosis has nothing sharper to say (a file that
          // parsed and simply carried no usable rows was not a failed parse).
          setIssue(recoveryMessage({ text, readings: 0 }));
          return;
        }
        // The bill half rides along with the rows until the user commits —
        // a cancelled picker or review writes nothing (same rule as the
        // modal's billFeedsRef). Enrichment needs the WHOLE feed: which
        // IntervalBlock belongs to which billing period is only decidable
        // with every block in hand, and the labels ride the summaries into
        // localStorage with them.
        // Enrichment needs the WHOLE feed (which IntervalBlock belongs to
        // which period), then the split routes each half to ITS commodity —
        // m³ never reaches the electric writer, kWh never the gas one.
        const summaries = isGasFeed(feed.summaries) ? enrichGasSummaries(feed) : feed.summaries;
        const split = splitFeed({ groups: parsed, summaries });
        pendingRef.current = {
          usable,
          electric: split.electric,
          gas: split.gas,
          electricFeed: {
            summaries: split.electricSummaries,
            localTime: feed.localTime,
            source: name ?? null,
          },
          gasFeed: {
            summaries: split.gasSummaries,
            localTime: feed.localTime,
            source: name ?? null,
          },
          primary: primaryCommodity(split),
        };
        if (parsed.length > 1) {
          // Several meters in one file: never silently pick or blend them.
          setGroups(parsed);
          return;
        }
        reviewOrImport(parsed[0].readings);
      } catch (e) {
        // ONE conversion for every failure, shared with the upload modal and
        // the sync toolbar (greenbutton/recovery.ts): a refusal shows its own
        // copy (it names the number it judged), everything else is explained
        // from the raw text, and the exception's own message is never shown —
        // it is parser prose written for a developer, in English, in both
        // locales. The old fallback here quoted `e.message` at the reader —
        // in French included.
        setIssue(recoveryMessage({ text, error: e }));
      } finally {
        setParsing(false);
      }
    },
    [reviewOrImport],
  );

  /** Raw XML or base64 in; the parser takes it from there. */
  const applyPayload = useCallback(
    (raw: string) => {
      const decoded = decodeImportPayload(raw);
      if (!decoded.ok) {
        setError(decoded.error);
        return;
      }
      ingestText(decoded.text);
    },
    [ingestText],
  );

  // `?d=<base64>` — a link Mark can click from .110 for small payloads.
  useEffect(() => {
    const d = searchParams.get('d');
    if (!d || autoApplied.current) return;
    autoApplied.current = true;
    // Deferred one tick: the effect body itself stays free of state writes
    // (react-hooks/set-state-in-effect), the payload is ingested right after.
    const timer = window.setTimeout(() => applyPayload(d), 0);
    return () => window.clearTimeout(timer);
  }, [searchParams, applyPayload]);

  const readFile = useCallback(
    async (file: File) => {
      setFileName(file.name);
      setParsing(true);
      try {
        ingestText(await file.text(), file.name);
      } catch {
        setError(t('upload.couldNotRead', { name: file.name }));
        setParsing(false);
      }
    },
    // Wave U — `t` in deps so the read-failure message recomputes on a switch.
    [ingestText, t],
  );

  const reset = () => {
    setPlan(null);
    setGasPlan(null);
    setGroups(null);
    setIssue(null);
    setError(null);
    setFileName(null);
    // Nothing was written, so nothing of that file may still be waiting to
    // be: a later commit must not fold in bills the user walked away from.
    pendingRef.current = null;
  };

  const body = (() => {
    if (groups) {
      return (
        <UsagePointPicker
          fileName={fileName ?? 'import.xml'}
          groups={groups}
          onChoose={(readings) => {
            setGroups(null);
            reviewOrImport(readings);
          }}
          onCancel={reset}
        />
      );
    }

    if (gasPlan) {
      // The gas twin of the electric review: same "nothing is written until
      // you choose" promise, counted in intervals (m³), never in kWh.
      const existingByTs = new Set(gasPlan.existing.map((g) => g.timestamp));
      const incomingByTs = new Set(gasPlan.incoming.map((g) => g.timestamp));
      let overlap = 0;
      for (const ts of incomingByTs) if (existingByTs.has(ts)) overlap += 1;
      const merged = new Map<number, GasPoint>();
      for (const g of gasPlan.existing) merged.set(g.timestamp, g);
      for (const g of gasPlan.incoming) merged.set(g.timestamp, g);
      const mergeCount = merged.size;

      return (
        <section data-testid="gas-import-review" className={CARD}>
          <h1 className="text-xl md:text-3xl uppercase tracking-tighter font-black mb-2 flex items-center gap-2">
            <GitMerge strokeWidth={4} size={22} /> {t('import.reviewTitle')}
          </h1>
          <p className="text-xs md:text-sm font-bold text-ink-2 mb-3" data-testid="gas-detected">
            {t('import.detectedGas')}
          </p>
          <p className="text-xs md:text-sm font-bold text-ink-2 mb-5">
            {t('import.gasReviewBody', {
              existing: gasPlan.existing.length,
              incoming: gasPlan.incoming.length,
            })}
            {t('import.nothingWritten')}
          </p>

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" data-testid="gas-import-review-stats">
            {[
              [t('importReview.inBrowser'), gasPlan.existing.length],
              [t('importReview.inFile'), gasPlan.incoming.length],
              [t('importReview.already'), overlap],
              [t('importReview.newRows'), incomingByTs.size - overlap],
            ].map(([label, value]) => (
              <div key={String(label)} className="border-2 md:border-4 border-edge rounded-xl p-3 bg-inset">
                <dt className="text-[9px] md:text-[11px] font-black uppercase text-ink-3">{label}</dt>
                <dd className="text-lg md:text-2xl font-black" data-testid={`gas-import-stat-${label}`}>
                  {value as number}
                </dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="gas-import-merge"
              className={BTN + ' bg-emerald-400 text-accent-ink'}
              onClick={() => commitGas('merge')}
            >
              <GitMerge size={14} strokeWidth={4} /> {t('import.mergeBtn')} ({t('import.gasIntervals', { count: mergeCount })})
            </button>
            <button
              type="button"
              data-testid="gas-import-replace"
              className={BTN + ' bg-yellow-400 text-accent-ink'}
              onClick={() => commitGas('replace')}
            >
              <Replace size={14} strokeWidth={4} /> {t('import.replaceBtn')} ({t('import.gasIntervals', { count: incomingByTs.size })})
            </button>
            <button type="button" data-testid="gas-import-cancel" className={BTN + ' bg-card'} onClick={reset}>
              <X size={14} strokeWidth={4} /> {t('common.cancel')}
            </button>
          </div>
          <p className="text-[10px] font-bold text-ink-3 mt-4">
            {t('import.mergeNote')}
          </p>
        </section>
      );
    }

    if (plan) {
      const { plan: p, incoming, existing, detected } = plan;
      return (
        <section data-testid="import-review" className={CARD}>
          <h1 className="text-xl md:text-3xl uppercase tracking-tighter font-black mb-2 flex items-center gap-2">
            <GitMerge strokeWidth={4} size={22} /> {t('import.reviewTitle')}
          </h1>
          {/* Detection disclosure (t_cb0cf70f — Defect B): the gas review
              has disclosed its commodity since t_8a9038d6; an electric or
              mixed document's review said nothing about what it was. */}
          <p className="text-xs md:text-sm font-bold text-ink-2 mb-3" data-testid="electric-detected">
            {t(detected === 'both' ? 'import.detectedMixed' : 'import.detectedElectricity')}
          </p>
          <p className="text-xs md:text-sm font-bold text-ink-2 mb-5">
            {t('import.thisBrowserHolds')} <strong>{p.existingRows}</strong> {t('import.readings', { count: p.existingRows })}
            {p.existingFirst ? ` (${p.existingFirst} → ${p.existingLast})` : ''}{t('import.newExportCarries')} <strong>{p.incomingRows}</strong>
            {p.incomingFirst ? ` (${p.incomingFirst} → ${p.incomingLast})` : ''}{t('import.nothingWritten')}
          </p>

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" data-testid="import-review-stats">
            {[
              [t('importReview.inBrowser'), p.existingRows],
              [t('importReview.inFile'), p.incomingRows],
              [t('importReview.already'), p.overlapRows],
              [t('importReview.newRows'), p.addedRows],
            ].map(([label, value]) => (
              <div key={String(label)} className="border-2 md:border-4 border-edge rounded-xl p-3 bg-inset">
                <dt className="text-[9px] md:text-[11px] font-black uppercase text-ink-3">{label}</dt>
                <dd className="text-lg md:text-2xl font-black" data-testid={`import-stat-${label}`}>
                  {value as number}
                </dd>
              </div>
            ))}
          </dl>

          {p.identical && (
            <p className="text-[11px] font-black uppercase text-warn mb-4" data-testid="import-identical">
              {t('import.identical')}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="import-merge"
              className={BTN + ' bg-emerald-400 text-accent-ink'}
              onClick={() => commit(mergeForWrite(existing, incoming), 'merge')}
            >
              <GitMerge size={14} strokeWidth={4} /> {t('import.mergeBtn')} ({p.mergeRows} {t('import.rows', { count: p.mergeRows })})
            </button>
            <button
              type="button"
              data-testid="import-replace"
              className={BTN + ' bg-yellow-400 text-accent-ink'}
              onClick={() => commit(incoming, 'replace')}
            >
              <Replace size={14} strokeWidth={4} /> {t('import.replaceBtn')} ({p.replaceRows} {t('import.rows', { count: p.replaceRows })})
            </button>
            <button type="button" data-testid="import-cancel" className={BTN + ' bg-card'} onClick={reset}>
              <X size={14} strokeWidth={4} /> {t('common.cancel')}
            </button>
          </div>
          <p className="text-[10px] font-bold text-ink-3 mt-4">
            {t('import.mergeNote')}
          </p>
        </section>
      );
    }

    return (
      <section className={CARD}>
        <h1 className="text-xl md:text-3xl uppercase tracking-tighter font-black mb-2 flex items-center gap-2">
          <FileDown strokeWidth={4} size={22} /> {t('import.title')}
        </h1>
        <p className="text-xs md:text-sm font-bold text-ink-2 mb-5">
          {t('import.clientOnlyLead')} <code>dmd_export_b64.py --b64</code> {t('import.orDropFile')}
        </p>

        <div
          data-testid="import-drop"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void readFile(file);
          }}
          className={
            'border-4 border-dashed rounded-2xl p-6 md:p-10 text-center mb-5 transition-colors ' +
            (dragging ? 'border-purple-600 bg-purple-50' : 'border-edge bg-inset')
          }
        >
          <p className="font-black uppercase text-sm md:text-base mb-3">{t('upload.dropzone')}</p>
          <input
            ref={fileRef}
            data-testid="import-file"
            type="file"
            accept=".xml,text/xml,application/xml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
              e.target.value = '';
            }}
          />
          <button type="button" className={BTN + ' bg-card'} onClick={() => fileRef.current?.click()}>
            {t('import.chooseFile')}
          </button>
        </div>

        <label className="block text-[11px] font-black uppercase mb-2" htmlFor="import-paste">
          {t('import.pasteLabel')}
        </label>
        <textarea
          ref={pasteRef}
          id="import-paste"
          data-testid="import-paste"
          rows={6}
          spellCheck={false}
          className="w-full border-4 border-edge rounded-xl p-3 font-mono text-xs mb-3"
          placeholder={t('import.pastePlaceholder')}
        />
        <button
          type="button"
          data-testid="import-load"
          className={BTN + ' bg-purple-500 text-white'}
          disabled={parsing}
          onClick={() => applyPayload(pasteRef.current?.value ?? '')}
        >
          {parsing ? t('upload.reading') : t('upload.parseAndImport')}
        </button>

        {(issue || error) && (
          <div
            role="alert"
            data-testid="import-error"
            className="mt-4 border-4 border-bad rounded-xl p-4 bg-bad-soft text-bad"
          >
            <p className="font-black uppercase text-sm">{issue?.headline ?? 'Import failed'}</p>
            <p className="text-xs font-bold mt-1">{issue?.detail ?? error}</p>
            {issue?.hints?.length ? (
              <ul className="text-xs font-bold mt-2 list-disc pl-5">
                {issue.hints.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        <p className="text-[10px] font-bold text-ink-3 mt-5">
          {t('import.alreadyHave')} <Link className="underline" href="/">{t('import.openIt')}</Link> {t('import.neverReplaces')}
        </p>
      </section>
    );
  })();

  return <div className="fixed inset-0 overflow-y-auto bg-inset p-4 md:p-8">{body}</div>;
}

export default function ImportPage() {
  const { t } = useTranslation();
  return (
    <main className="min-h-screen bg-inset">
      <Suspense
        fallback={<div className="p-8 font-black uppercase">{t('import.loading')}</div>}
      >
        <ImportFlow />
      </Suspense>
    </main>
  );
}
