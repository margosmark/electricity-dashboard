/**
 * Token store for the Green Button CMD shim.
 *
 * WHAT LIVES HERE: the OAuth token set only — access token, refresh token,
 * expiry, granted scope, and the two ESPI resource pointers the token
 * response carries (`subscriptionUri` / `authorizationUri`).
 *
 * WHAT NEVER LIVES HERE: meter readings, interval blocks, XML, or anything
 * derived from them. The `/greenbutton/usage` handler streams the ESPI feed
 * from the custodian straight into the response body and never calls into
 * this module with data. That is the zero-data-at-rest invariant, pinned by
 * the on-disk key-set assertions in `shim.test.ts` and by `oauthFlow.test.ts`
 * (a real authorize → callback loop that re-reads the file afterwards), so a
 * future refactor cannot quietly widen it.
 *
 * WHERE IT LIVES: a single JSON file, mode 0600, outside the container.
 * `GB_TOKEN_FILE` is the container-side path (default
 * `./.greenbutton/tokens.json` for local dev); the HOST side of the bind
 * mount is `GB_TOKEN_DIR`, pinned in the untracked `.env` — on .110 that is
 * `~/.greenbutton-shim`, deliberately outside the git worktree so
 * no clone, clean, or `git add -A` can ever touch it (see OPERATIONS.md).
 * If the path is not writable the store degrades to memory-only and says so
 * via `persistence()`, so a bad mount costs a re-authorisation on restart
 * rather than a broken feature.
 */

import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export type TokenSet = {
  accessToken: string;
  /** RFC 6749 §6 — years-long, rotated by some custodians on every refresh. */
  refreshToken?: string;
  /** Epoch ms after which `accessToken` must be refreshed. */
  expiresAt?: number;
  /** Scope as GRANTED (may be a subset of what we asked for). */
  scope?: string;
  /** ESPI batch the tokens unlock, e.g. .../Batch/Subscription/<uuid>. */
  subscriptionUri?: string;
  /** ESPI Authorization resource, advertised by some custodians. */
  authorizationUri?: string;
  /**
   * Per-browser session secret handed out by the OAuth callback and required
   * (as an HttpOnly cookie) by every data-bearing endpoint.
   *
   * Without it the shim — which now holds a working access token — would hand
   * Mark's interval data to anyone who could guess the public URL. It is a
   * credential for THIS service only: it never travels to the utility and
   * grants nothing on greenbutton.oakvillehydro.com.
   */
  sessionToken?: string;
  obtainedAt: number;
};

/** The only keys ever written to disk. Pinned by tests. */
export const PERSISTED_KEYS: readonly (keyof TokenSet)[] = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "scope",
  "subscriptionUri",
  "authorizationUri",
  "sessionToken",
  "obtainedAt",
];

export type Persistence = "file" | "memory";

export class TokenStore {
  #file: string;
  #mem: TokenSet | null = null;
  #loaded = false;
  #persistence: Persistence = "file";
  #queue: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<TokenSet | null> {
    if (this.#loaded) return this.#mem;
    this.#loaded = true;
    try {
      const raw = await readFile(this.#file, "utf8");
      const parsed = JSON.parse(raw) as Partial<TokenSet>;
      if (typeof parsed?.accessToken !== "string" || !parsed.accessToken) {
        this.#mem = null;
        return null;
      }
      this.#mem = sanitise(parsed);
      return this.#mem;
    } catch {
      // Missing file, unreadable file, or corrupt JSON all mean the same
      // thing to the caller: not authorised yet.
      this.#mem = null;
      return null;
    }
  }

  /**
   * Persist the token set. Serialised through a queue so a refresh that
   * races a disconnect can never leave a half-written file behind.
   */
  save(tokens: TokenSet): Promise<void> {
    const run = async (): Promise<void> => {
      this.#mem = sanitise(tokens);
      this.#loaded = true;
      if (this.#persistence === "memory") return;
      try {
        await mkdir(dirname(this.#file), { recursive: true });
        const tmp = `${this.#file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(this.#mem, null, 2), { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, this.#file);
      } catch {
        // Unwritable mount: keep serving from memory and report it, rather
        // than throwing away a perfectly good authorisation.
        this.#persistence = "memory";
      }
    };
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  async clear(): Promise<void> {
    this.#queue = this.#queue.then(
      () => undefined,
      () => undefined,
    );
    this.#mem = null;
    this.#loaded = true;
    if (this.#persistence === "memory") return;
    try {
      await unlink(this.#file);
    } catch {
      // Already gone — clearing twice must be a no-op.
    }
  }

  persistence(): Persistence {
    return this.#persistence;
  }

  /** Test hook. */
  reset(): void {
    this.#mem = null;
    this.#loaded = false;
    this.#persistence = "file";
    this.#queue = Promise.resolve();
  }
}

/** Drop anything unexpected before it can reach disk or memory. */
function sanitise(raw: Partial<TokenSet>): TokenSet {
  const out: TokenSet = {
    accessToken: String(raw.accessToken ?? ""),
    obtainedAt: typeof raw.obtainedAt === "number" ? raw.obtainedAt : Date.now(),
  };
  if (typeof raw.refreshToken === "string" && raw.refreshToken) out.refreshToken = raw.refreshToken;
  if (typeof raw.expiresAt === "number") out.expiresAt = raw.expiresAt;
  if (typeof raw.scope === "string" && raw.scope) out.scope = raw.scope;
  if (typeof raw.subscriptionUri === "string" && raw.subscriptionUri) out.subscriptionUri = raw.subscriptionUri;
  if (typeof raw.authorizationUri === "string" && raw.authorizationUri) out.authorizationUri = raw.authorizationUri;
  if (typeof raw.sessionToken === "string" && raw.sessionToken) out.sessionToken = raw.sessionToken;
  return out;
}

/**
 * The process-wide store. One reader/writer per Next.js server process; the
 * route handlers all share it so a refresh in one request is visible to the
 * next.
 */
let store: TokenStore | null = null;

export function getTokenStore(file: string): TokenStore {
  if (!store) store = new TokenStore(file);
  return store;
}

/** Test hook — drops the singleton so a new path takes effect. */
export function resetTokenStore(): void {
  store = null;
}
