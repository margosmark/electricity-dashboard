/**
 * Wave N — the account server's configuration.
 *
 * WHY THIS IS ITS OWN MODULE (and not a field on `greenbutton/config.ts`):
 * two independent secrets live behind this one flag — argon2 password
 * verifiers + session tokens, and the VAPID private key. Wave K's topology
 * lesson says the process that serves the public web app must not hold them,
 * so `docker-compose.yml` sets `ACCT_*` on `account-server` and sets no
 * `ACCT_*` at all on `energy-dashboard`. Reading our own environment back is
 * therefore a truthful "who am I" — the same trick `getProcessIdentity()`
 * uses for `GB_TOKEN_FILE`.
 *
 * Consequences that fall out of that:
 *
 *  - Every `/account/*` route is *registered* in both processes (same image)
 *    but answers 404 unless this config says `enabled`. The public app
 *    process cannot answer an account request even if the router sends it
 *    one: it holds no database path, no session keys and no VAPID key.
 *  - `getProcessIdentity()` in `greenbutton/config.ts` reports `account` for
 *    this process, so `X-Edge-Location: account` and `x-gb-process: account`
 *    must pair — the same falsifiable contract the app/shim split has.
 *
 * Nothing here is a secret by itself; it only reads secret files that the
 * deployment chose to mount into this process. Secret values are never
 * accepted from environment variables.
 */

import { resolve, relative, isAbsolute, join } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { validateEmailConfig } from "./email";

export const SESSION_COOKIE = "acct_session";
export const EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;
export const SMTP_EVENT_MAX_SKEW_MS = 5 * 60 * 1000;

/** RFC hostname syntax used for the SMTP EHLO argument. */
export function isValidHelo(value: string): boolean {
  if (value.length < 1 || value.length > 253 || /[\r\n]/.test(value)) return false;
  const labels = value.split(".");
  return labels.every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

/** Deliberately identical to Wave K's `gb_session` contract (90-day sliding). */
export const SESSION_TTL_MS = 60 * 1000 * 60 * 24 * 90;

/**
 * Ceiling on one encrypted blob upload.
 *
 * A full year of hourly readings is ~350 KB of JSON before encryption, so
 * 5 MB is ~14x headroom — generous, and still a bounded read: never an
 * unbounded `request.body` an unauthenticated caller could use to fill the
 * disk. Same rule as the 64 KB cap on `POST /greenbutton/notify/[token]`.
 */
export const MAX_SYNC_BYTES = 5 * 1024 * 1024;

const DEFAULT_PUBLIC_ORIGIN = "https://electricity.markarslan.ca";
/** Internal-only: how often to re-check the app's rate payload for a change. */
const DEFAULT_RATES_POLL_MS = 6 * 60 * 60 * 1000;

export type AccountConfig = {
  /** True only when this process was explicitly told to be the account server. */
  enabled: boolean;
  /** Host bind source and checkout paths, used to reject repository-local storage. */
  hostDataDir: string;
  hostRepoDir: string;
  /** Absolute database file path within dataDir. */
  dbPath: string;
  /** The origin the app is served from — drives cookie flags + Origin checks. */
  publicOrigin: string;
  sessionTtlMs: number;
  maxSyncBytes: number;
  /** VAPID triple; null ⇒ push is inert (sync still works). */
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  /**
   * Shared secret for the shim→account fan-out (`data_available`).
   * Lives on the docker network only: `location /account/internal` is
   * denied at the edge (ops/edge/default.conf.template).
   */
  internalToken: string;
  /** Where rate changes are observed from — the app process, not a rebuild. */
  ratesUrl: string;
  ratesPollMs: number;
  /**
   * Hard ceiling on registered accounts (family scale, not a product).
   *
   * Registration is closed until mailbox verification is enabled; this does
   * not authorize account creation.
   *
   * NOTE (round-1 review, M2): the Pangolin PIN gate is NOT counted on here.
   * Measured from the public internet on 2026-10-07 with no cookies, `GET /`
   * answered 200 straight through with no challenge, so the first lock is not
   * observable from outside and this cap plus the per-source attempt budget
   * (`lib/account/ratelimit.ts`) are what actually bound the endpoint.
   */
  maxAccounts: number;
  /** Public registration/recovery must prove mailbox control first. */
  emailVerificationEnabled: boolean;
  /** Null until the deployment supplies a complete SMTP sender contract. */
  smtp: {
    host: string;
    port: number;
    tlsMode: "implicit" | "starttls";
    username: string;
    password: string;
    helo: string;
    from: string;
    replyTo: string;
    timeoutMs: number;
    eventsSecret: string;
  } | null;
};

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(str(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Read a 0400-mounted secret without putting its value in process.env. */
function secretFile(name: string): string | null {
  const file = str(name);
  if (!file) return null;
  try {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0 || (mode & 0o400) === 0) return null;
    const value = readFileSync(file, "utf8").replace(/\r?\n$/, "");
    return value.length > 0 && !/[\r\n]/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function mailbox(value: string): { address: string; domain: string } | null {
  const match = /^([^<>\s@]+)@([^<>\s@]+)$/.exec(value);
  if (!match || /[\r\n]/.test(value)) return null;
  return { address: value, domain: match[2].toLowerCase() };
}

let cached: AccountConfig | null = null;

/**
 * Read (and memoise) the account configuration.
 *
 * Memoised for the same reason the Green Button config is: route handlers
 * call it per request and a half-written env must not flip the feature
 * mid-session. Tests call `resetAccountConfigCache()`.
 */
export function getAccountConfig(): AccountConfig {
  if (cached) return cached;

  const enabled = str("ACCT_ENABLED", "false").toLowerCase() === "true";
  const publicKey = str("VAPID_PUBLIC_KEY");
  const privateKey = str("VAPID_PRIVATE_KEY");
  const subject = str("VAPID_SUBJECT", "mailto:ops@markarslan.ca");
  const smtpHost = str("ACCT_SMTP_HOST");
  const smtpFrom = str("ACCT_SMTP_FROM");
  const smtpPort = Number(str("ACCT_SMTP_PORT"));
  const tlsMode = str("ACCT_SMTP_TLS_MODE").toLowerCase();
  const smtpReplyTo = str("ACCT_SMTP_REPLY_TO");
  const from = mailbox(smtpFrom);
  const replyTo = mailbox(smtpReplyTo);
  const originHost = (() => {
    try { return new URL(str("ACCT_PUBLIC_ORIGIN", DEFAULT_PUBLIC_ORIGIN)).hostname.toLowerCase(); } catch { return ""; }
  })();
  const username = secretFile("ACCT_SMTP_USERNAME_FILE");
  const password = secretFile("ACCT_SMTP_PASSWORD_FILE");
  const eventsSecret = secretFile("ACCT_SMTP_EVENTS_SECRET_FILE");
  const timeoutMs = Number(str("ACCT_SMTP_TIMEOUT_MS"));
  const completeSmtpContract = Boolean(
    smtpHost && Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535 &&
    (tlsMode === "starttls" || tlsMode === "implicit") &&
    username && password && eventsSecret && from && replyTo &&
    from.domain === originHost && replyTo.domain === from.domain &&
    isValidHelo(str("ACCT_SMTP_HELO")) && Number.isInteger(timeoutMs) && timeoutMs > 0,
  );
  const smtp = completeSmtpContract
    ? {
        host: smtpHost,
        port: smtpPort,
        tlsMode: tlsMode as "implicit" | "starttls",
        username: username!,
        password: password!,
        helo: str("ACCT_SMTP_HELO"),
        from: from!.address,
        replyTo: replyTo!.address,
        timeoutMs,
        eventsSecret: eventsSecret!,
      }
    : null;

  const dataDir = "/data";
  cached = {
    enabled,
    hostDataDir: str("ACCT_DATA_DIR_HOST"),
    hostRepoDir: str("ACCT_REPO_HOST_DIR"),
    dbPath: str("ACCT_DB_PATH", join(dataDir, "accounts.db")),
    publicOrigin: str("ACCT_PUBLIC_ORIGIN", DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, ""),
    sessionTtlMs: SESSION_TTL_MS,
    maxSyncBytes: MAX_SYNC_BYTES,
    // Push is a separate capability from accounts: a deployment may run sync
    // with no VAPID keys rather than failing the whole feature.
    vapid: publicKey && privateKey ? { publicKey, privateKey, subject } : null,
    internalToken: str("ACCT_INTERNAL_TOKEN"),
    /**
     * Where rate changes are observed from.
     *
     * Default is the APP container over the docker network, not the public
     * URL: a hairpin through the edge would make a rate check depend on
     * external DNS and on the very router that is splitting the traffic.
     * The app process owns `/api/rates`, so asking it is also the only way
     * to observe exactly what users are served.
     */
    ratesUrl: str("ACCT_RATES_URL", "http://energy-dashboard:3000/api/rates"),
    ratesPollMs: Number(str("ACCT_RATES_POLL_MS", String(DEFAULT_RATES_POLL_MS))) || DEFAULT_RATES_POLL_MS,
    maxAccounts: Number(str("ACCT_MAX_ACCOUNTS", "10")) || 10,
    emailVerificationEnabled: str("ACCT_EMAIL_VERIFICATION_ENABLED", "false").toLowerCase() === "true",
    smtp,
  };
  return cached;
}

/** Test hook — env changes must be observable. */
export function resetAccountConfigCache(): void {
  cached = null;
}

/**
 * Is this process the account server?
 *
 * Read from the environment on purpose (see the module header): this is the
 * one answer nginx cannot forge, because the two containers run the same
 * image and differ only in their env.
 */
export function isAccountProcess(): boolean {
  return str("ACCT_ENABLED", "false").toLowerCase() === "true";
}

export function assertHostDataLocation(hostDataDir: string, hostRepoDir: string): void {
  if (!isAbsolute(hostDataDir) || !isAbsolute(hostRepoDir)) {
    throw new Error("Account storage unavailable: ACCT_DATA_DIR must be an absolute host path and ACCT_REPO_HOST_DIR must be set.");
  }
  const hostRel = relative(resolve(hostRepoDir), resolve(hostDataDir));
  if (hostRel === "" || (!hostRel.startsWith("..") && !isAbsolute(hostRel))) {
    throw new Error("Account storage unavailable: ACCT_DATA_DIR must be outside the host repository checkout.");
  }
}

export function assertSecureDataDir(directory: string): void {
  let stat;
  try { stat = statSync(directory); } catch {
    throw new Error("Account storage unavailable: ACCT_DATA_DIR does not exist or is not mounted.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("Account storage unavailable: ACCT_DATA_DIR must be owned by the account process uid and have mode 0700 or stricter.");
  }
}

export function assertAccountDataDir(cfg: AccountConfig): void {
  validateEmailConfig(process.env);
  assertHostDataLocation(cfg.hostDataDir, cfg.hostRepoDir);
  const mountPath = process.env.NODE_ENV === "test" ? cfg.hostDataDir : "/data";
  let resolved: string;
  try { resolved = realpathSync(mountPath); } catch {
    throw new Error("Account storage unavailable: account data directory is not mounted.");
  }
  const rel = relative(realpathSync(process.cwd()), resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("Account storage unavailable: mounted /data must be outside the application checkout.");
  }
  if (resolve(cfg.dbPath) !== join(resolved, "accounts.db")) {
    throw new Error("Account storage unavailable: ACCT_DB_PATH must be /data/accounts.db inside ACCT_DATA_DIR.");
  }
  assertSecureDataDir(resolved);
}
