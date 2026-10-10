/**
 * Wave G item 1 — the Backup drawer.
 *
 * One pair of buttons (Export JSON / Import JSON) behind a single toggle in
 * the nav bar. The drawer carries the one sentence users need: everything
 * this app knows lives in this browser, so a backup file is the only way to
 * move or save it.
 *
 * The component owns no storage logic — it calls the hooks handed in by
 * Dashboard, shows the failure message verbatim, and never fails silently.
 */

"use client";

/* Wave U — user-visible copy translates; lib code reads the module locale. */
import { useTranslation } from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Database, Download, Upload, X } from 'lucide-react';
import { downloadTextFile } from '@/lib/download';
import type { BackupExport, BackupImportResult } from '@/hooks/useDashboard';

export type BackupFileResult = BackupImportResult;

type Props = {
  /** Null = nothing to export (empty profile); the drawer says so. */
  onExport: () => BackupExport | null;
  onImport: (file: File) => Promise<BackupFileResult>;
  disabled?: boolean;
};

const TOGGLE_CLASS =
  'min-h-11 min-w-11 inline-flex items-center justify-center ' +
  'p-3 md:p-4 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl ' +
  'shadow-[4px_4px_0px_0px_rgba(124,58,237,1)] hover:translate-y-1 active:translate-y-0 active:shadow-[2px_2px_0px_0px_rgba(124,58,237,1)] transition-all';

export function BackupControls({ onExport, onImport, disabled = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Wave H item 3: Escape closes this drawer too, same as every other
  // overlay. It owns its own listener because the toggle button's
  // aria-expanded has to stay in sync with the open state.
  //
  // Registered ONCE (not gated on `open`) so there is no frame in which the
  // drawer is on screen but Escape is still unhandled — the same race that
  // cost the first CI run on the upload modal. `openRef` is written during
  // render, so the handler is correct the moment the drawer's DOM exists.
  const openRef = useRef(open);
  // Layout effect: correct before paint, so Escape works the instant the
  // drawer is on screen (and lint allows it — refs are not written during
  // render).
  useLayoutEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // Wave I item 2 — the drawer used to be `absolute left-0 w-[300px]` inside a
  // wrapper that was `relative` at EVERY width, so its position followed the
  // toggle: on a 390 px phone the toggle sits at x≈153 and the drawer ran to
  // x≈453, giving the document 63–93 px of horizontal scroll (measured
  // scrollWidth 453 vs 390/360). Below `md` the wrapper is no longer the
  // positioning context, so the drawer anchors to the nav card instead —
  // `left-0 right-0` spans that card and can never leave the viewport. At `md`
  // and up the toggle is the anchor again, which is where the popover belongs
  // on a wide screen.
  const rootRef = useRef<HTMLDivElement>(null);

  // Wave I item 2 (part 2) — the mobile touch path for closing the drawer.
  // Escape works, but a phone has no Escape key and the drawer sits on top of
  // the page with no backdrop: tapping anywhere outside it now dismisses it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    setError(null);
    const doc = onExport();
    if (!doc) {
      setStatus(t("backup.nothingToExport"));
      return;
    }
    downloadTextFile(doc.filename, doc.text, 'application/json;charset=utf-8');
    setStatus(`Saved ${doc.filename}`);
  };

  const handleImport = async (file: File) => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const res = await onImport(file);
      if (res.ok) setStatus(`${res.filename ?? file.name} imported — reloading…`);
      else setError(res.error ?? t("backup.importFailed"));
    } finally {
      setBusy(false);
      // Allow re-picking the same file after a failure.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div ref={rootRef} className="md:relative">
      <button
        type="button"
        data-testid="backup-toggle"
        title={t("backup.title")}
        aria-label={t("backup.aria")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { setOpen((v) => !v); setStatus(null); setError(null); }}
        className={TOGGLE_CLASS + ' disabled:opacity-40 disabled:cursor-not-allowed'}
      >
        <Database size={18} strokeWidth={4} />
      </button>

      {open && (
        <div
          data-testid="backup-drawer"
          role="dialog"
          aria-label={t("backup.aria")}
          className="absolute left-0 right-0 md:right-auto top-[calc(100%+8px)] z-[250] w-auto md:w-[340px] max-w-[calc(100vw-2rem)] bg-white border-4 border-black rounded-xl md:rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-5 text-black font-black uppercase"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="text-xs md:text-sm">Backup &amp; Restore</div>
            <button
              type="button"
              aria-label={t("backup.closeAria")}
              onClick={() => setOpen(false)}
              className="min-h-11 min-w-11 inline-flex items-center justify-center p-1 hover:bg-slate-100 active:bg-slate-200 rounded"
            >
              <X size={16} strokeWidth={4} />
            </button>
          </div>

          <p className="text-[9px] md:text-[10px] leading-relaxed text-slate-500 font-black mb-4">
            Everything lives in this browser — no server copy. Export a JSON backup before clearing your profile,
            switching devices, or just to keep one.
          </p>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              data-testid="backup-export"
              onClick={handleExport}
              disabled={disabled}
              className="min-h-11 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-black bg-yellow-400 text-[11px] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40"
            >
              <Download size={14} strokeWidth={4} /> Export JSON
            </button>

            <button
              type="button"
              data-testid="backup-import"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
              className="min-h-11 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-black bg-white text-[11px] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40"
            >
              <Upload size={14} strokeWidth={4} /> Import JSON
            </button>
            <input
              ref={inputRef}
              data-testid="backup-import-input"
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImport(file);
              }}
            />
          </div>

          {status && (
            <div data-testid="backup-status" className="mt-3 text-[9px] md:text-[10px] text-emerald-700 break-words">
              {status}
            </div>
          )}
          {error && (
            <div data-testid="backup-error" role="alert" className="mt-3 text-[9px] md:text-[10px] text-red-600 break-words normal-case font-bold">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BackupControls;
