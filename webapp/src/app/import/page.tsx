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
 * dashboard reads (versioned `energy_data_v2`, legacy key migrated). The one thing
 * it adds is a promise the upload flow makes implicitly and this one states
 * out loud: **existing readings are never overwritten without a merge
 * review.** With an empty profile it imports straight away, because there is
 * nothing to lose.
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
  parseGreenButtonUsagePoints,
  type DataPoint,
  type UsagePointGroup,
} from '@/lib/energy';
import { diagnoseGreenButtonDocument, type ParseDiagnostic } from '@/lib/parseDiagnostic';
import UsagePointPicker from '@/components/UsagePointPicker';
import { EXAMPLE_DATA_KEY } from '@/hooks/useDashboard';
import {
  decodeImportPayload,
  mergeForWrite,
  planImport,
  type ImportPlan,
} from '@/lib/importPlan';
// The readings live under the versioned key; storage.ts owns the read, the
// legacy-key migration and the write (the dashboard reads exactly this).
import { loadEnergyData, saveEnergyData } from '@/lib/storage';

/** Only the failure branch is ever rendered as an error box. */
type FailedDiagnostic = Extract<ParseDiagnostic, { ok: false }>;

const CARD =
  'bg-white border-4 md:border-8 border-black rounded-[2rem] md:rounded-[3rem] ' +
  'shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] p-5 md:p-10 text-black';
const BTN =
  'min-h-11 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl ' +
  'border-4 border-black font-black uppercase text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] ' +
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
  const [plan, setPlan] = useState<{ plan: ImportPlan; incoming: DataPoint[]; existing: DataPoint[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const autoApplied = useRef(false);

  /**
   * The write. Same storage keys the upload modal's `commitReadings` touches
   * (`energy_data` plus the example-data flag), then a client navigation to
   * `/` so every hook that seeds itself from storage on boot re-reads the new
   * rows — the identical finalization path a manual upload ends on.
   */
  const commit = useCallback(
    (rows: DataPoint[]) => {
      const saved = saveEnergyData(rows, { source: 'import-page' });
      if (!saved.ok) {
        window.alert(t('backup.errRefused', { detail: saved.detail }));
        return;
      }
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

  /** Everything a confirmed write needs is computed here; nothing writes. */
  const reviewOrImport = useCallback((incoming: DataPoint[]) => {
    if (incoming.length === 0) {
      setIssue({
        ok: false,
        headline: t('upload.noReadingsHeadline'),
        detail: t('upload.noReadingsDetailParsed'),
        hints: [t('upload.noReadingsHint')],
      });
      return;
    }
    const existing = loadStored();
    if (existing.length === 0) {
      commit(incoming);
      return;
    }
    setPlan({ plan: planImport(existing, incoming), incoming, existing });
    // Wave U — `t` in deps so the diagnostics recompute on a language switch.
  }, [commit, t]);

  const ingestText = useCallback(
    (text: string) => {
      setIssue(null);
      setError(null);
      setParsing(true);
      try {
        const parsed = parseGreenButtonUsagePoints(text);
        const total = parsed.reduce((n, g) => n + g.readings.length, 0);
        if (total === 0) {
          const diag = diagnoseGreenButtonDocument(text, 0);
          setIssue(
            diag.ok
              ? {
                  ok: false,
                  headline: t('upload.noReadingsHeadline'),
                  detail: t('upload.noReadingsDetail'),
                  hints: [t('upload.noReadingsHint')],
                }
              : diag,
          );
          return;
        }
        if (parsed.length > 1) {
          // Several meters in one file: never silently pick or blend them.
          setGroups(parsed);
          return;
        }
        reviewOrImport(parsed[0].readings);
      } catch (e) {
        const diag = diagnoseGreenButtonDocument(text, 0);
        setIssue(
          diag.ok
            ? {
                ok: false,
                headline: t('upload.couldNotReadPlain'),
                detail: String((e as Error)?.message ?? e),
                hints: [t('upload.redownloadHint')],
              }
            : diag,
        );
      } finally {
        setParsing(false);
      }
    },
    [reviewOrImport, t],
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
        ingestText(await file.text());
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
    setGroups(null);
    setIssue(null);
    setError(null);
    setFileName(null);
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

    if (plan) {
      const { plan: p, incoming, existing } = plan;
      return (
        <section data-testid="import-review" className={CARD}>
          <h1 className="text-xl md:text-3xl uppercase tracking-tighter font-black mb-2 flex items-center gap-2">
            <GitMerge strokeWidth={4} size={22} /> Review before importing
          </h1>
          <p className="text-xs md:text-sm font-bold text-slate-600 mb-5">
            This browser already holds <strong>{p.existingRows}</strong> readings
            {p.existingFirst ? ` (${p.existingFirst} → ${p.existingLast})` : ''}. The new export
            carries <strong>{p.incomingRows}</strong>
            {p.incomingFirst ? ` (${p.incomingFirst} → ${p.incomingLast})` : ''}. Nothing is written
            until you choose.
          </p>

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" data-testid="import-review-stats">
            {[
              [t('importReview.inBrowser'), p.existingRows],
              [t('importReview.inFile'), p.incomingRows],
              [t('importReview.already'), p.overlapRows],
              [t('importReview.newRows'), p.addedRows],
            ].map(([label, value]) => (
              <div key={String(label)} className="border-2 md:border-4 border-black rounded-xl p-3 bg-slate-50">
                <dt className="text-[9px] md:text-[11px] font-black uppercase text-slate-500">{label}</dt>
                <dd className="text-lg md:text-2xl font-black" data-testid={`import-stat-${label}`}>
                  {value as number}
                </dd>
              </div>
            ))}
          </dl>

          {p.identical && (
            <p className="text-[11px] font-black uppercase text-amber-700 mb-4" data-testid="import-identical">
              This export matches what is already stored — merging will change nothing.
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="import-merge"
              className={BTN + ' bg-emerald-400'}
              onClick={() => commit(mergeForWrite(existing, incoming))}
            >
              <GitMerge size={14} strokeWidth={4} /> Merge ({p.mergeRows} rows)
            </button>
            <button
              type="button"
              data-testid="import-replace"
              className={BTN + ' bg-yellow-400'}
              onClick={() => commit(incoming)}
            >
              <Replace size={14} strokeWidth={4} /> Replace ({p.replaceRows} rows)
            </button>
            <button type="button" data-testid="import-cancel" className={BTN + ' bg-white'} onClick={reset}>
              <X size={14} strokeWidth={4} /> Cancel
            </button>
          </div>
          <p className="text-[10px] font-bold text-slate-500 mt-4">
            Merge keeps every timestamp you already have and takes the file&rsquo;s value where they
            overlap. Replace discards anything the file does not cover.
          </p>
        </section>
      );
    }

    return (
      <section className={CARD}>
        <h1 className="text-xl md:text-3xl uppercase tracking-tighter font-black mb-2 flex items-center gap-2">
          <FileDown strokeWidth={4} size={22} /> Import Green Button XML
        </h1>
        <p className="text-xs md:text-sm font-bold text-slate-600 mb-5">
          Client-only: the file is parsed here, in your browser, and stored in this browser. Nothing
          is uploaded. Paste the base64 from <code>dmd_export_b64.py --b64</code> or drop the XML
          file itself.
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
            (dragging ? 'border-purple-600 bg-purple-50' : 'border-black bg-slate-50')
          }
        >
          <p className="font-black uppercase text-sm md:text-base mb-3">Drop XML Here</p>
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
          <button type="button" className={BTN + ' bg-white'} onClick={() => fileRef.current?.click()}>
            Choose a file
          </button>
        </div>

        <label className="block text-[11px] font-black uppercase mb-2" htmlFor="import-paste">
          …or paste the XML / base64
        </label>
        <textarea
          ref={pasteRef}
          id="import-paste"
          data-testid="import-paste"
          rows={6}
          spellCheck={false}
          className="w-full border-4 border-black rounded-xl p-3 font-mono text-xs mb-3"
          placeholder="<?xml … or a base64 blob"
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
            className="mt-4 border-4 border-red-600 rounded-xl p-4 bg-red-50 text-red-700"
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

        <p className="text-[10px] font-bold text-slate-500 mt-5">
          Already have a dashboard? <Link className="underline" href="/">Open it</Link> — this page
          never replaces your readings without asking.
        </p>
      </section>
    );
  })();

  return <div className="fixed inset-0 overflow-y-auto bg-slate-50 p-4 md:p-8">{body}</div>;
}

export default function ImportPage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <Suspense
        fallback={<div className="p-8 font-black uppercase">Loading import…</div>}
      >
        <ImportFlow />
      </Suspense>
    </main>
  );
}
