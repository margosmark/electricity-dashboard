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
 * Nothing here is a secret by itself; it only reads secrets that the
 * deployment chose to give this process.
 */

export const SESSION_COOKIE = "acct_session";

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
const DEFAULT_DB_PATH = "./.account/accounts.db";
/** Internal-only: how often to re-check the app's rate payload for a change. */
const DEFAULT_RATES_POLL_MS = 6 * 60 * 60 * 1000;

export type AccountConfig = {
  /** True only when this process was explicitly told to be the account server. */
  enabled: boolean;
  /** Absolute-or-relative SQLite file. Never on a path the app container writes. */
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
   * Registration is unauthenticated by design — no invite system, no SMTP —
   * and a 5 MB blob per account is a disk-fill vector on an open endpoint.
   * A tiny cap turns that into a bounded cost: the deployment sits behind
   * the Pangolin PIN gate anyway, this is the second lock.
   */
  maxAccounts: number;
};

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
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

  cached = {
    enabled,
    dbPath: str("ACCT_DB_PATH", DEFAULT_DB_PATH),
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
