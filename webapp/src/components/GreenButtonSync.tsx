/**
 * Green Button live-sync control (Wave K).
 *
 * Two shapes of the same state machine:
 *   chip   — compact, lives in the toolbar, hidden entirely until Oakville
 *            Hydro has actually issued credentials (so the public app shows
 *            nothing about a feature that is not switched on).
 *   modal  — the explanatory card inside "Link Data", where someone who has
 *            no XML export is deciding what to do.
 *
 * The component never holds a credential: connect is a full-page navigation
 * to the shim's /greenbutton/start, and everything after that rides the
 * HttpOnly session cookie.
 */

"use client";

/* Wave U — user-visible copy translates; lib/hook code reads the module locale. */
import { t, useTranslation } from "@/i18n";
import { RefreshCw, Link2, Unplug } from "lucide-react";
import type { GbStatus } from "@/lib/greenbutton/client";

type Props = {
  status: GbStatus | null;
  syncing: boolean;
  message: { tone: "ok" | "error"; text: string } | null;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  onDismissMessage: () => void;
  variant?: "chip" | "modal";
};

/**
 * The three states this control reports, as the card specifies them:
 *
 *   unconfigured — the utility has not issued credentials; the feature does
 *                  not exist for this deployment yet.
 *   disconnected — configured, but this browser holds no authorisation.
 *   authorised   — the shim holds a grant for this browser, nothing piped yet.
 *   synced       — a feed has actually been piped through and ingested.
 *
 * Exposed as `data-gb-state` on the root so tests (and the browser e2e gate)
 * assert on the state machine rather than on wording.
 */
export type GbUiState = "unconfigured" | "disconnected" | "authorised" | "synced";

export function gbUiState(status: GbStatus | null): GbUiState {
  if (!status?.configured) return "unconfigured";
  if (!status.connected) return "disconnected";
  return status.lastSyncAt ? "synced" : "authorised";
}

function lastSyncLine(status: GbStatus): string {
  if (!status.lastSyncAt) return t("gb.authorisedNoData");
  const at = new Date(status.lastSyncAt);
  const mb = status.lastSyncBytes !== null ? ` · ${(status.lastSyncBytes / 1024).toFixed(0)} KB` : "";
  return `Synced ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}${mb}`;
}

export function GreenButtonSync({
  status, syncing, message, onConnect, onSync, onDisconnect, onDismissMessage, variant = "chip",
}: Props) {
  const { t } = useTranslation();
  // Not configured: the feature does not exist for this deployment yet.
  if (!status?.configured) {
    if (variant === "modal") {
      return (
        <div
          data-testid="gb-unconfigured"
          data-gb-state="unconfigured"
          className="mt-4 md:mt-6 border-2 border-dashed border-slate-300 rounded-xl md:rounded-2xl p-4 text-left"
        >
          <div className="text-[11px] md:text-xs font-black uppercase text-slate-500">
            {t("gb.liveSyncTitle")}
          </div>
          <p className="mt-1 text-[10px] md:text-xs font-bold text-slate-500 normal-case">
            {t("gb.notSwitchedOn")}
          </p>
        </div>
      );
    }
    return null;
  }

  const connected = status.connected;
  const state = gbUiState(status);

  if (variant === "chip") {
    return (
      <div className="flex items-center gap-1 md:gap-2" data-testid="gb-chip" data-gb-state={state}>
        {message && (
          <span
            role="status"
            data-testid="gb-message"
            className={`hidden md:inline-block max-w-[18rem] truncate px-2 py-1 rounded-lg border-2 border-black text-[9px] md:text-[10px] font-black uppercase ${
              message.tone === "ok" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"
            }`}
            title={message.text}
            onClick={onDismissMessage}
          >
            {message.text}
          </span>
        )}
        {connected ? (
          <div className="flex items-center border-4 border-black rounded-xl md:rounded-2xl bg-white overflow-hidden">
            <button
              type="button"
              data-testid="gb-sync"
              onClick={onSync}
              disabled={syncing}
              title={lastSyncLine(status)}
              aria-label={t("gb.syncNowAria")}
              className="min-h-11 px-2 md:px-3 flex items-center gap-1 bg-green-600 text-white font-black uppercase text-[10px] disabled:opacity-60"
            >
              <RefreshCw size={14} strokeWidth={4} className={syncing ? "animate-spin" : ""} />
              <span className="hidden md:inline">
                {syncing ? t("gb.syncing") : state === "synced" ? t("gb.live") : t("gb.authorised")}
              </span>
            </button>
            <button
              type="button"
              data-testid="gb-disconnect"
              onClick={() => {
                if (window.confirm(t("gb.disconnectConfirm"))) {
                  onDisconnect();
                }
              }}
              aria-label={t("gb.disconnectAria")}
              className="min-h-11 px-2 border-l-4 border-black bg-white text-red-600 hover:bg-red-50"
            >
              <Unplug size={14} strokeWidth={4} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="gb-connect"
            onClick={onConnect}
            className="min-h-11 px-2 md:px-3 flex items-center gap-1 border-4 border-black rounded-xl md:rounded-2xl bg-green-600 text-white shadow-[4px_4px_0px_0px_rgba(37,99,235,1)] active:translate-y-0.5 active:shadow-none transition-all font-black uppercase text-[10px]"
          >
            <Link2 size={14} strokeWidth={4} />
            <span className="hidden md:inline">{t("gb.authorise")}</span>
          </button>
        )}
      </div>
    );
  }

  // --- modal variant: the explanatory card -----------------------------
  return (
    <div
      data-testid="gb-connect-card"
      data-gb-state={state}
      className="mt-4 md:mt-6 border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6 text-left bg-slate-50"
    >
      <div className="flex items-center gap-2">
        <Link2 size={16} strokeWidth={4} />
        <span className="text-[11px] md:text-sm font-black uppercase">
          {t("gb.liveSyncTitle")}
        </span>
      </div>

      {message && (
        <div
          role="status"
          data-testid="gb-message"
          className={`mt-3 px-3 py-2 rounded-lg border-2 border-black text-[10px] md:text-xs font-bold normal-case ${
            message.tone === "ok" ? "bg-green-100 text-green-900" : "bg-red-100 text-red-800"
          }`}
        >
          {message.text}{" "}
          <button type="button" onClick={onDismissMessage} className="font-black underline ml-1">
            {t("gb.dismiss")}
          </button>
        </div>
      )}

      {connected ? (
        <>
          <p className="mt-2 text-[10px] md:text-xs font-bold text-slate-600 normal-case" data-testid="gb-status">
            {lastSyncLine(status)} {t("gb.readingsStayLocal")}
          </p>
          <div className="mt-3 flex flex-col md:flex-row gap-2">
            <button
              type="button"
              data-testid="gb-sync"
              onClick={onSync}
              disabled={syncing}
              className="min-h-11 py-3 px-5 bg-green-600 text-white border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-60"
            >
              {syncing ? t("gb.syncing") : t("gb.syncNow")}
            </button>
            <button
              type="button"
              data-testid="gb-disconnect"
              onClick={() => {
                if (window.confirm(t("gb.disconnectConfirm"))) {
                  onDisconnect();
                }
              }}
              className="min-h-11 py-3 px-5 bg-white text-red-600 border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs"
            >
              {t("gb.disconnect")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-[10px] md:text-xs font-bold text-slate-600 normal-case">
            {t("gb.authoriseBlurb")}
          </p>
          <button
            type="button"
            data-testid="gb-connect"
            onClick={onConnect}
            className="mt-3 min-h-11 w-full py-3 md:py-4 bg-green-600 text-white border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all"
          >
            {t("gb.authorise")}
          </button>
        </>
      )}
    </div>
  );
}

export default GreenButtonSync;
