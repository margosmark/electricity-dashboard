/**
 * Wave N — long-running services owned by the account-server process.
 *
 * Under client-side E2EE the server cannot compute anything from the user's
 * data, so exactly two notification triggers are server-computable and both
 * of them observe PUBLIC state (see the trigger table in WAVE-N-DESIGN.md):
 *
 *   oeb_rates      — the app's `/api/rates` payload, identified by its
 *                    `ratesSourceVersion` fingerprint (a hash that changes
 *                    iff a rate value changes). When the fingerprint moves,
 *                    new rates shipped and every subscribed account is told.
 *   data_available — arrives from the Green Button shim's existing webhook,
 *                    which deliberately holds scalars only. The shim POSTs
 *                    to `/account/internal/notify` over the docker network;
 *                    that path is denied at the edge.
 *
 * WHY A TIMER AND NOT A CRON: this process is already the only one that holds
 * the VAPID key, so the check has to happen here anyway. The interval is
 * memoised on `globalThis` so a hot reload or a second route import cannot
 * stack timers, and every failure is swallowed — a rate check that cannot
 * reach the app must never take the account server down with it.
 */

import type { AccountConfig } from "./config";
import { getAccountConfig } from "./config";
import { openDb, getMeta, setMeta } from "./db";
import { fanOut } from "./push";

type ServiceState = { timer: ReturnType<typeof setInterval> | null; running: boolean };

const KEY = "__waveNAccountServices" as const;

function state(): ServiceState {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = { timer: null, running: false } satisfies ServiceState;
  return g[KEY] as ServiceState;
}

/**
 * Start (once) whatever this process must do in the background.
 * Called from `requireEnabled()` — i.e. lazily on the first account request,
 * so a deployment with no account traffic runs no timer at all.
 */
export function ensureAccountServices(): void {
  const cfg = getAccountConfig();
  if (!cfg.enabled) return;
  const st = state();
  if (st.timer) return;
  void checkRates(cfg);
  st.timer = setInterval(() => {
    void checkRates(cfg);
  }, cfg.ratesPollMs);
  // Never hold the process open: the server exits when the runtime says so.
  st.timer.unref?.();
}

/** Test hook — stop the watcher and forget it was ever started. */
export function resetAccountServices(): void {
  const st = state();
  if (st.timer) clearInterval(st.timer);
  const g = globalThis as Record<string, unknown>;
  delete g[KEY];
}

export type RatesCheckOutcome =
  | "unchanged"
  | "baseline"
  | "changed"
  | "unreachable"
  | "unrecognised";

/**
 * Compare the app's rate fingerprint with the last one we saw.
 *
 * The FIRST observation is a baseline, not an event: a freshly deployed
 * account server must not announce rates that shipped before anyone
 * subscribed. Every other outcome is a real signal.
 */
export async function checkRates(cfg: AccountConfig, fetchImpl = fetch): Promise<RatesCheckOutcome> {
  let version: string;
  let latestEffective: string | null = null;
  try {
    const res = await fetchImpl(cfg.ratesUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "unreachable";
    const body = (await res.json()) as Record<string, unknown>;
    version = typeof body.ratesSourceVersion === "string" ? body.ratesSourceVersion : "";
    if (!version) return "unrecognised";
    const history = Array.isArray(body.historicalRates) ? (body.historicalRates as unknown[]) : [];
    const last = history[history.length - 1] as { effectiveDate?: unknown } | undefined;
    latestEffective = typeof last?.effectiveDate === "string" ? last.effectiveDate : null;
  } catch {
    return "unreachable";
  }

  const db = openDb(cfg.dbPath);
  const seen = getMeta(db, "rates_source_version");
  if (seen === version) return "unchanged";
  setMeta(db, "rates_source_version", version);
  if (seen === null) return "baseline";

  await fanOut(cfg, db, {
    topic: "oeb_rates",
    title: "New electricity rates in the app",
    body: latestEffective
      ? `Ontario rates were updated — newest set effective ${latestEffective}.`
      : "Ontario rates were updated — open the dashboard to re-price your usage.",
    url: "/",
  });
  return "changed";
}
