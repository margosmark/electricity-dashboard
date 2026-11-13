/**
 * Browser side of the Green Button CMD shim.
 *
 * Deliberately thin: four calls, no state, no tokens. Everything that could
 * hold a credential lives behind the `gb_session` HttpOnly cookie on the
 * server, so this file can be read by anyone who can read the app bundle.
 */

/* Wave U — the connect-flow copy translates; lib code reads the module locale. */
import { t } from '@/i18n';

export type GbStatus = {
  configured: boolean;
  unconfiguredReason: string | null;
  connected: boolean;
  tokenPersistence: "file" | "memory" | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncBytes: number | null;
  dataAvailableSince: string | null;
  redirectUri: string;
};

export type GbUsageResult =
  | { ok: true; xml: string; bytes: number }
  /** `code` only — the error body of `/greenbutton/usage` is a machine
   * code and nothing else (see `jsonError`), and this result feeds the
   * sync toolbar's `outcome.detail ?? describeGbError(code).detail`.
   * There is deliberately no `detail` field to forward server prose with. */
  | { ok: false; code: string };

const TIMEOUT_MS = 60_000;

function withTimeout(ms: number): AbortSignal | undefined {
  if (typeof AbortController === "undefined") return undefined;
  return AbortSignal.timeout(ms);
}

export async function fetchGbStatus(): Promise<GbStatus | null> {
  try {
    const res = await fetch("/greenbutton/status", {
      cache: "no-store",
      signal: withTimeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as GbStatus;
  } catch {
    // Offline / shim down: the dashboard must keep working exactly as before.
    return null;
  }
}

/**
 * Pull the piped ESPI feed.
 *
 * `publishedMin` is the incremental cursor — the newest timestamp we already
 * hold (minus an hour of overlap). The custodian may ignore it and return
 * everything; either way the caller merges by timestamp, so an over-wide
 * response costs nothing and an under-wide one still advances the data.
 */
export async function fetchGbUsage(publishedMin?: number): Promise<GbUsageResult> {
  try {
    const url = new URL("/greenbutton/usage", window.location.origin);
    if (publishedMin !== undefined) url.searchParams.set("publishedMin", String(publishedMin));
    const res = await fetch(url.toString(), { cache: "no-store", signal: withTimeout(TIMEOUT_MS) });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) code = body.error;
      } catch { /* non-JSON error body: keep the status code */ }
      // NO `detail` from the body. This result feeds the sync toolbar's
      // `outcome.detail ?? describeGbError(code).detail`, so anything read
      // here is quoted at the reader — in English, at a French one, and
      // for a custodian-supplied body, in words we do not control. The
      // server logs its own breadcrumb; the catalog answers the reader
      // (greenbutton/recovery.test.ts pins both halves of that).
      return { ok: false, code };
    }
    const xml = await res.text();
    return { ok: true, xml, bytes: xml.length };
  } catch {
    // No `detail` either: the sync toolbar renders `outcome.detail ??
    // describeGbError(code).detail`, so leaving it off puts
    // gb.unreachableDetail — a catalog sentence, in the reader's locale —
    // in front of what the network stack wrote in English ("Failed to
    // fetch"), instead of quoting the exception at the reader the way this
    // catch used to (greenbutton/recovery.ts's contract, extended to this
    // catch: it feeds the SAME rendered line as useDashboard's).
    return { ok: false, code: "unreachable" };
  }
}

export async function disconnectGb(): Promise<boolean> {
  try {
    const res = await fetch("/greenbutton/disconnect", {
      method: "POST",
      cache: "no-store",
      signal: withTimeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Human copy for every failure the shim can report. Never echoes secrets. */
export function describeGbError(code: string): { headline: string; detail: string; hints: string[] } {
  switch (code) {
    case "not_configured":
      return {
        headline: t('gb.notConfiguredHeadline'),
        detail: t('gb.notConfiguredDetail'),
        hints: [t('gb.notConfiguredHint')],
      };
    case "not_connected":
    case "session_required":
      return {
        headline: t('gb.notConnectedHeadline'),
        detail: t('gb.notConnectedDetail'),
        hints: [t('gb.notConnectedHint')],
      };
    case "grant_revoked":
      return {
        headline: t('gb.revokedHeadline'),
        detail: t('gb.revokedDetail'),
        hints: [t('gb.revokedHint')],
      };
    case "client_auth":
      return {
        headline: t('gb.clientAuthHeadline'),
        detail: t('gb.clientAuthDetail'),
        hints: [t('gb.clientAuthHint1'), t('gb.clientAuthHint2')],
      };
    case "data_pending":
      return {
        headline: t('gb.dataPendingHeadline'),
        detail: t('gb.dataPendingDetail'),
        hints: [t('gb.dataPendingHint')],
      };
    case "upstream":
      // 5xx / unreachable / malformed: the shim answered, the custodian
      // did not. This code used to arrive WITH a server-composed `detail`;
      // now the code alone reaches here (jsonError carries no detail), so
      // it needs its own sentence — the default branch would echo the
      // English word "upstream" at the reader.
      return {
        headline: t('gb.upstreamHeadline'),
        detail: t('gb.upstreamDetail'),
        hints: [t('gb.upstreamHint')],
      };
    case "unreachable":
      return {
        headline: t('gb.unreachableHeadline'),
        detail: t('gb.unreachableDetail'),
        hints: [t('gb.unreachableHint')],
      };
    default:
      return {
        headline: t('gb.failedHeadline'),
        detail: code,
        hints: [t('gb.failedHint')],
      };
  }
}
