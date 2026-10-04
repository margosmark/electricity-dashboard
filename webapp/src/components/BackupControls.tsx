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
  'p-3 md:p-4 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl ' +
  'shadow-[4px_4px_0px_0px_rgba(124,58,237,1)] hover:translate-y-1 transition-all';

export function BackupControls({ onExport, onImport, disabled = false }: Props) {
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
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    setError(null);
    const doc = onExport();
    if (!doc) {
      setStatus('Nothing to export yet — upload your utility XML first.');
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
      else setError(res.error ?? 'That file could not be imported.');
    } finally {
      setBusy(false);
      // Allow re-picking the same file after a failure.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="backup-toggle"
        title="Backup & restore"
        aria-label="Backup and restore"
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
          className="absolute left-0 top-[calc(100%+8px)] z-[250] w-[300px] md:w-[340px] bg-white border-4 border-black rounded-xl md:rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-5 text-black font-black uppercase"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="text-xs md:text-sm">Backup &amp; Restore</div>
            <button
              type="button"
              aria-label="Close backup drawer"
              onClick={() => setOpen(false)}
              className="p-1 hover:bg-slate-100 rounded"
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
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-black bg-yellow-400 text-[10px] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40"
            >
              <Download size={14} strokeWidth={4} /> Export JSON
            </button>

            <button
              type="button"
              data-testid="backup-import"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
              className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-black bg-white text-[10px] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40"
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
