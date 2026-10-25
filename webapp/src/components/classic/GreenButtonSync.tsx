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
 * When the utility has NOT issued credentials the modal does not show an
 * error, a dead button or an empty control: it shows the WAITING STATE —
 * what is pending, in homeowner language, plus the day-one connection
 * journey (what you'll need, what you'll do, what happens after) so the
 * wait reads as a state with a next step rather than a broken feature
 * (t_10f231ed). The chip stays hidden in that state by design: the toolbar
 * owes the user nothing about a feature that does not exist yet.
 *
 * The component never holds a credential: connect is a full-page navigation
 * to the shim's /greenbutton/start, and everything after that rides the
 * HttpOnly session cookie.
 *
 * INK (t_3e571ddb): the `bg-green-600` slab is a FIXED literal (#00a63e) that
 * does not flip with the theme, so its ink is fixed too — `text-accent-ink`
 * (#000 both themes, 6.52:1). It previously carried `text-white`, which
 * measured 3.22:1 and went red on the theme-contrast walk the moment the
 * ledger was emptied; the colour call's rule ("ink inside a fixed slab is
 * fixed") is what decides this, not a re-pick of the green.
 */

"use client";

/* Wave U — user-visible copy translates; lib/hook code reads the module locale. */
import { fmtNumber, t, useTranslation } from "@/i18n";
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
  const mb = status.lastSyncBytes !== null ? ` · ${fmtNumber(status.lastSyncBytes / 1024)} KB` : "";
  return `Synced ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}${mb}`;
}

export function GreenButtonSync({
  status, syncing, message, onConnect, onSync, onDisconnect, onDismissMessage, variant = "chip",
}: Props) {
  const { t } = useTranslation();
  // Not configured: the utility has not issued credentials, so the journey
  // cannot complete. This card is the only place that says so — it must read
  // as a STATE (what is pending, what still works, what happens next), never
  // as an error or a dead control.
  if (!status?.configured) {
    if (variant === "modal") {
      return (
        <div
          data-testid="gb-unconfigured"
          data-gb-state="unconfigured"
          className="mt-4 md:mt-6 border-2 border-dashed border-edge/40 rounded-xl md:rounded-2xl p-4 md:p-5 text-left"
        >
          <div className="flex items-center gap-2">
            <Link2 size={16} strokeWidth={4} />
            <span className="text-[11px] md:text-xs font-black uppercase text-ink-3">
              {t("gb.liveSyncTitle")}
            </span>
          </div>

          <p
            className="mt-2 text-xs md:text-sm font-bold text-ink normal-case"
            data-testid="gb-waiting-headline"
          >
            {t("gb.waiting.headline")}
          </p>
          <p
            className="mt-1 text-[10px] md:text-xs font-bold text-ink-2 normal-case"
            data-testid="gb-waiting-pending"
          >
            {t("gb.waiting.pending")}
          </p>
          {/* The "this is not broken" half: what keeps working today. */}
          <p
            className="mt-2 text-[10px] md:text-xs font-bold text-ink-2 normal-case"
            data-testid="gb-waiting-works"
          >
            {t("gb.waiting.worksToday")}
          </p>

          {/* Day-one connection journey — the wait, plus the three things a
              homeowner will actually meet when it lifts. Kept inside this
              card so it travels with the state it explains; ordered list
              because the sequence is the point. */}
          <div className="mt-3 border-t-2 border-edge/40 pt-3" data-testid="gb-journey">
            <div className="text-[11px] md:text-xs font-black uppercase tracking-[0.08em] text-ink-3">
              {t("gb.journey.title")}
            </div>
            <ol className="mt-2 space-y-2">
              {[
                { n: 1, label: t("gb.journey.need.label"), body: t("gb.journey.need.body") },
                { n: 2, label: t("gb.journey.do.label"), body: t("gb.journey.do.body") },
                { n: 3, label: t("gb.journey.after.label"), body: t("gb.journey.after.body") },
              ].map((step) => (
                <li
                  key={step.n}
                  className="flex gap-2"
                  data-testid={`gb-journey-step-${step.n}`}
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-edge/40 bg-card text-[10px] font-black text-ink-2"
                  >
                    {step.n}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[10px] md:text-xs font-black uppercase text-ink">
                      {step.label}
                    </span>
                    <span className="block text-[10px] md:text-xs font-bold text-ink-2 normal-case">
                      {step.body}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
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
            className={`hidden md:inline-block max-w-[18rem] truncate px-2 py-1 rounded-lg border-2 border-edge text-[9px] md:text-[10px] font-black uppercase ${
              message.tone === "ok" ? "bg-ok-bg text-ok-ink" : "bg-err-bg text-err-ink"
            }`}
            title={message.text}
            onClick={onDismissMessage}
          >
            {message.text}
          </span>
        )}
        {connected ? (
          <div className="flex items-center border-4 border-edge rounded-xl md:rounded-2xl bg-card overflow-hidden">
            <button
              type="button"
              data-testid="gb-sync"
              onClick={onSync}
              disabled={syncing}
              title={lastSyncLine(status)}
              aria-label={t("gb.syncNowAria")}
              className="min-h-11 px-2 md:px-3 flex items-center gap-1 bg-green-600 text-accent-ink font-black uppercase text-[10px] disabled:opacity-60"
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
              className="min-h-11 px-2 border-l-4 border-edge bg-card text-bad hover:bg-hover"
            >
              <Unplug size={14} strokeWidth={4} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="gb-connect"
            onClick={onConnect}
            className="min-h-11 px-2 md:px-3 flex items-center gap-1 border-4 border-edge rounded-xl md:rounded-2xl bg-green-600 text-accent-ink shadow-hard-blue-4 active:translate-y-0.5 active:shadow-none transition-all font-black uppercase text-[10px]"
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
      className="mt-4 md:mt-6 border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6 text-left bg-inset"
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
          className={`mt-3 px-3 py-2 rounded-lg border-2 border-edge text-[10px] md:text-xs font-bold normal-case ${
            message.tone === "ok" ? "bg-ok-bg text-ok-ink" : "bg-err-bg text-err-ink"
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
          <p className="mt-2 text-[10px] md:text-xs font-bold text-ink-2 normal-case" data-testid="gb-status">
            {lastSyncLine(status)} {t("gb.readingsStayLocal")}
          </p>
          <div className="mt-3 flex flex-col md:flex-row gap-2">
            <button
              type="button"
              data-testid="gb-sync"
              onClick={onSync}
              disabled={syncing}
              className="min-h-11 py-3 px-5 bg-green-600 text-accent-ink border-4 border-edge rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs shadow-hard-4 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-60"
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
              className="min-h-11 py-3 px-5 bg-card text-bad border-4 border-edge rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs"
            >
              {t("gb.disconnect")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-[10px] md:text-xs font-bold text-ink-2 normal-case">
            {t("gb.authoriseBlurb")}
          </p>
          <button
            type="button"
            data-testid="gb-connect"
            onClick={onConnect}
            className="mt-3 min-h-11 w-full py-3 md:py-4 bg-green-600 text-accent-ink border-4 border-edge rounded-xl md:rounded-2xl font-black uppercase text-[11px] md:text-xs shadow-hard-4 active:translate-y-0.5 active:shadow-none transition-all"
          >
            {t("gb.authorise")}
          </button>
        </>
      )}
    </div>
  );
}

export default GreenButtonSync;
