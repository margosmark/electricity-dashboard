/**
 * Green Button Connect My Data (CMD) shim — configuration.
 *
 * The shim is an OAuth2 proxy that holds ONLY the OAuth client credentials and
 * the caller's token set. It never stores meter readings: the ESPI feed is
 * streamed straight through to the browser, which keeps them in localStorage
 * exactly like a manual upload did (see `lib/greenbutton/README.md`).
 *
 * Everything is env-driven so the same build works against:
 *   - Oakville Hydro production  (defaults below)
 *   - a local mock custodian     (tests / dev set GB_* explicitly)
 *
 * The feature is inert (status reports `configured: false`) until a real
 * client_id + client_secret have been issued by the utility.
 */

import { createHash } from "node:crypto";

export type TokenAuthStyle = "basic" | "body";

export type GreenButtonConfig = {
  /** True once client_id AND client_secret are present. */
  configured: boolean;
  /** Why the feature is off, for the status endpoint (never a secret). */
  unconfiguredReason: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Registered with the utility: where it sends the user back. */
  redirectUri: string;
  /** Registered with the utility: where it POSTs BatchList notifications. */
  notificationUri: string;
  /** ESPI scope string (no spaces — see greenbutton authorization_scope.md). */
  scope: string;
  /** How the client authenticates at the token endpoint. */
  tokenAuthStyle: TokenAuthStyle | "auto";
  /** Absolute path of the token file (outside the container on .110). */
  tokenFile: string;
  /**
   * RFC 7636 PKCE (S256) on the authorization_code flow.
   *
   * Defence in depth against a code read off the callback URL — an
   * extension, a proxy, a Referer, or an access log. It is opt-in because
   * the London-Hydro platform's stance is unconfirmed: shipping it on by
   * default risks a flow the custodian rejects, so it waits for their reply
   * (GB_PKCE=true flips it).
   */
  pkce: boolean;
};

/** Public origin the utility has on file for us — drives both registered URIs. */
const DEFAULT_PUBLIC_ORIGIN = "https://electricity.markarslan.ca";

/** London-Hydro-platform default (greenbutton.oakvillehydro.com). */
const DEFAULT_AUTHORIZE_URL = "https://greenbutton.oakvillehydro.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://greenbutton.oakvillehydro.com/oauth/token";

/**
 * Minimal scope for what the app actually consumes: FB_1 Common Data
 * Custodian + FB_3 Core Green Button Connect My Data + FB_4 Interval
 * Metering + FB_5 Interval Electricity Metering.
 *
 * Deliberately NOT the 24-block list open-green-button uses for this utility:
 * the Oakville registration form only offers Usage / Billing / Account
 * checkboxes, we only ever read interval usage, and agreement §1 says the
 * recipient may use the data "only to perform its services to the Customer".
 * Widen here (env GB_SCOPE) only if the platform rejects the narrow string.
 */
const DEFAULT_SCOPE = "FB=1_3_4_5";

/** Dev-only token location; production overrides it to a host path. */
const DEFAULT_TOKEN_FILE = "./.greenbutton/tokens.json";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}

let cached: GreenButtonConfig | null = null;

/**
 * Read (and memoise) the configuration from the environment.
 *
 * Memoised because the route handlers call it per request and because a
 * half-written .env must not make the feature flip mid-session. Call
 * `resetConfigCache()` in tests.
 */
export function getConfig(): GreenButtonConfig {
  if (cached) return cached;

  const publicOrigin = str("GB_PUBLIC_ORIGIN", DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, "");
  const clientId = str("GB_CLIENT_ID");
  const clientSecret = str("GB_CLIENT_SECRET");
  const notifyToken = str("GB_NOTIFY_TOKEN") || deriveNotifyToken(clientSecret);

  const configured = clientId !== "" && clientSecret !== "";
  cached = {
    configured,
    unconfiguredReason: configured
      ? ""
      : "GB_CLIENT_ID / GB_CLIENT_SECRET are not set — Oakville Hydro has not issued credentials yet",
    authorizeUrl: str("GB_AUTHORIZE_URL", DEFAULT_AUTHORIZE_URL),
    tokenUrl: str("GB_TOKEN_URL", DEFAULT_TOKEN_URL),
    clientId,
    clientSecret,
    redirectUri: str("GB_REDIRECT_URI", `${publicOrigin}/greenbutton/callback`),
    notificationUri: str("GB_NOTIFICATION_URI", `${publicOrigin}/greenbutton/notify/${notifyToken}`),
    scope: str("GB_SCOPE", DEFAULT_SCOPE),
    tokenAuthStyle: parseAuthStyle(str("GB_TOKEN_AUTH_STYLE", "auto")),
    tokenFile: str("GB_TOKEN_FILE", DEFAULT_TOKEN_FILE),
    pkce: parseBool(str("GB_PKCE", "false")),
  };
  return cached;
}

/**
 * Which container is this process?
 *
 * `greenbutton-shim` and `energy-dashboard` run the SAME image, so nothing in
 * the build tells them apart — only the deployment does. `docker-compose.yml`
 * mounts the token volume and sets `GB_TOKEN_FILE` on the shim and sets no
 * `GB_*` env at all on the app, so reading that back from our own config
 * answers "who am I" from inside the process.
 *
 * This is the only source nginx cannot lie about. The router's `X-Edge-Location`
 * header says which branch of *its* config matched, not who produced the body;
 * on 2026-10-07 that header read `shim` while the app container was answering
 * (stale upstream DNS, security finding H1), so a header derived from the
 * location could never detect the inversion. This one changes with the
 * process, not with the path.
 */
export type ProcessIdentity = "shim" | "app";

export function getProcessIdentity(): ProcessIdentity {
  // The in-repo default is what a process keeps when nobody told it where a
  // token file lives. The app container sets no GB_* env, so it keeps the
  // default and reports "app"; the shim is pointed at its mounted
  // /var/lib/greenbutton/tokens.json and reports "shim". Tests and dev that
  // want to act as the shim must set GB_TOKEN_FILE.
  return getConfig().tokenFile === DEFAULT_TOKEN_FILE ? "app" : "shim";
}

/** The unguessable path segment of the notification URI. */
export function getNotifyToken(): string {
  const uri = getConfig().notificationUri;
  const m = uri.match(/\/notify\/([A-Za-z0-9_-]{16,})\/?$/);
  return m ? m[1] : "";
}

/**
 * Fallback when `GB_NOTIFY_TOKEN` is not pinned: derived from the client
 * secret so it is stable across restarts.
 *
 * This is a FALLBACK, not the production path. The registration form records
 * the notification URI *before* Oakville issues the client secret, so a
 * derived value would change the moment credentials arrived and leave the
 * utility posting to a URL we 404. `docker-compose.yml` pins an explicit
 * token for exactly that reason; see GREENBUTTON-CMD.md §6.
 */
function deriveNotifyToken(clientSecret: string): string {
  // Always a 32-hex token — the registered notification URI must have the
  // same shape whether or not credentials exist yet, so filling in the form
  // before Oakville issues them can't bake a placeholder into their records.
  return createHash("sha256")
    .update(`greenbutton-notify:${clientSecret || "unconfigured"}`)
    .digest("hex")
    .slice(0, 32);
}

function parseAuthStyle(raw: string): TokenAuthStyle | "auto" {
  return raw === "basic" || raw === "body" ? raw : "auto";
}

/** Truthy env flags: `1/true/yes/on`, case-insensitive. Anything else is off. */
function parseBool(raw: string): boolean {
  return /^(1|true|yes|on)$/i.test(raw);
}

/** Test hook — env changes must be observable. */
export function resetConfigCache(): void {
  cached = null;
}
