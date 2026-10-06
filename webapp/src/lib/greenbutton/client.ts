/**
 * Browser side of the Green Button CMD shim.
 *
 * Deliberately thin: four calls, no state, no tokens. Everything that could
 * hold a credential lives behind the `gb_session` HttpOnly cookie on the
 * server, so this file can be read by anyone who can read the app bundle.
 */

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
  notificationUri: string;
};

export type GbUsageResult =
  | { ok: true; xml: string; bytes: number }
  | { ok: false; code: string; detail?: string };

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
      let detail: string | undefined;
      try {
        const body = (await res.json()) as { error?: string; detail?: string };
        if (body.error) code = body.error;
        detail = body.detail;
      } catch { /* non-JSON error body: keep the status code */ }
      return { ok: false, code, detail };
    }
    const xml = await res.text();
    return { ok: true, xml, bytes: xml.length };
  } catch (e) {
    return {
      ok: false,
      code: "unreachable",
      detail: e instanceof Error ? e.message : String(e),
    };
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
        headline: "Live sync is not set up yet",
        detail: "Oakville Hydro has not issued this app its Green Button credentials.",
        hints: ["Upload your Green Button XML export instead — everything still works offline."],
      };
    case "not_connected":
    case "session_required":
      return {
        headline: "Not connected in this browser",
        detail: "The dashboard has no Green Button authorisation for this device yet.",
        hints: ["Press “Connect Oakville Hydro” to authorise, or keep uploading exports."],
      };
    case "grant_revoked":
      return {
        headline: "Oakville Hydro disconnected us",
        detail: "The authorisation was revoked or has expired, so live sync stopped.",
        hints: ["Press “Connect Oakville Hydro” to authorise again."],
      };
    case "client_auth":
      return {
        headline: "Shim credentials rejected",
        detail: "The token endpoint rejected this app's client_id/client_secret.",
        hints: [
          "This is a server-side configuration problem, not something re-authorising can fix.",
          "Check GB_CLIENT_ID / GB_CLIENT_SECRET on .110.",
        ],
      };
    case "data_pending":
      return {
        headline: "The utility is still assembling your data",
        detail: "Green Button answered 202 Accepted — the batch is being prepared in the background.",
        hints: ["Try again in a few minutes."],
      };
    case "unreachable":
      return {
        headline: "Could not reach live sync",
        detail: "The shim did not answer in time.",
        hints: ["Check the connection and try again; your existing data is untouched."],
      };
    default:
      return {
        headline: "Live sync failed",
        detail: code,
        hints: ["Your existing readings were not changed."],
      };
  }
}
