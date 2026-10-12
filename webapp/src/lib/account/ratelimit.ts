/**
 * Wave N — attempt budgeting for the three UNAUTHENTICATED credential
 * endpoints (`login`, `recover`, `register`).
 *
 * WHY THIS EXISTS. `argon2id` costs ~17 ms per verification, which is exactly
 * what makes a stolen database expensive to attack offline — and exactly what
 * makes an open `POST /account/login` a free online guessing loop (and a free
 * CPU oracle on `recover`, which is the same loop against a 100-bit code).
 * Timing equalisation (`auth.ts#timingEqualize`) stops an attacker *measuring*
 * which addresses exist; it does nothing about how *many* guesses they get.
 *
 * WHAT IS KEPT HERE, AND WHY THOSE KEYS:
 *
 *   login  identity (e-mail) + client IP + a process-wide total
 *   recover identity (e-mail) + client IP + a process-wide total
 *   register client IP + a process-wide total   (no identity yet: it has none)
 *
 * The identity key is the one that cannot be gamed — it is derived from the
 * request body, not from a header, so no proxy chain and no spoofed
 * `X-Forwarded-For` can rotate it. The IP key is best effort and only exists
 * to stop one source eating the whole budget; `clientIp()` below says exactly
 * how much it is worth. The global bucket is what remains when the IP is
 * unknowable (direct access, dev, or a proxy that does not forward one).
 *
 * TOKEN BUCKET, NOT A LOCKOUT. A rejected attempt costs one token and tokens
 * refill continuously, so:
 *
 *   - there is no "locked out for 15 minutes" cliff for a user who simply
 *     mistyped twice — the budget comes back one token at a time;
 *   - the answer to "when may I try again?" is a number (`Retry-After`), not
 *     a guess;
 *   - a permanent lockout (and therefore a login-DOS against a known e-mail
 *     address) is not something this file can express.
 *
 * A SUCCESS refills the identity bucket it was checked against: a user who
 * gets the password right has proved they are not guessing. It deliberately
 * does NOT refill the global bucket — an attacker who owns one valid account
 * must not be able to buy the whole server's budget back.
 *
 * State is in-process (a Map), because this runs in the one container that
 * holds the verifiers and that container is a single Node process. A restart
 * forgets the counters — an attacker cannot restart it, so that is a
 * convenience for us, not a hole for them. Documented in SECURITY.md §5.
 */

/** One bucket's budget: `capacity` attempts, refilled over `windowMs`. */
export type Limit = { capacity: number; windowMs: number };

const MINUTE = 60 * 1000;

/**
 * Budgets. Deliberately far above anything two people can do by hand: the
 * point is to bound an automated loop, not to notice a typo. If you tighten
 * these, `ratelimit.test.ts` pins the behaviour and the e2e gate
 * (`tests/e2e/account_smoke.sh`) is the thing that will tell you you went too
 * far — it performs real registers and logins against a booted server.
 */
export const LIMITS = {
  /** Failed logins against ONE address. The targeted-guessing brake. */
  loginIdentity: { capacity: 8, windowMs: 15 * MINUTE } satisfies Limit,
  /** Failed logins from one source address (only when an address is known). */
  loginIp: { capacity: 30, windowMs: 15 * MINUTE } satisfies Limit,
  /**
   * Failed logins process-wide — the floor when no address is derivable, and
   * the bucket that catches spraying across many addresses at once. It is
   * deliberately LOOSE: the per-address bucket is the one doing the work
   * (8 per 15 min against any single account), and a floor tight enough to
   * matter to an attacker would also be tight enough to catch a legitimate
   * user — or a repeated run of `tests/e2e/account_smoke.sh`, which performs
   * real logins from a single process. Nothing is refunded here on success.
   */
  loginGlobal: { capacity: 100, windowMs: 15 * MINUTE } satisfies Limit,
  /** Failed recovery attempts against ONE address: stricter, it is a 100-bit code. */
  recoverIdentity: { capacity: 5, windowMs: 15 * MINUTE } satisfies Limit,
  recoverIp: { capacity: 15, windowMs: 15 * MINUTE } satisfies Limit,
  recoverGlobal: { capacity: 20, windowMs: 15 * MINUTE } satisfies Limit,
  /** Registration attempts (any outcome) — the `ACCT_MAX_ACCOUNTS` squat brake. */
  registerIp: { capacity: 12, windowMs: 60 * MINUTE } satisfies Limit,
  registerGlobal: { capacity: 20, windowMs: 60 * MINUTE } satisfies Limit,
} as const;

type Bucket = { tokens: number; updatedAt: number; capacity: number; windowMs: number };

const buckets = new Map<string, Bucket>();

/**
 * Stop the map growing without bound if something iterates addresses.
 * Swept when it gets large; expired buckets are dropped, and if that is not
 * enough the oldest entry goes (Map iteration order = insertion order, and
 * `take()` re-inserts the key it touched, so "oldest" means "least recently
 * refreshed").
 */
const MAX_BUCKETS = 1000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    const refillPerMs = bucket.capacity / bucket.windowMs;
    if (bucket.tokens + (now - bucket.updatedAt) * refillPerMs >= bucket.capacity) buckets.delete(key);
  }
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (oldest.done) break;
    buckets.delete(oldest.value);
  }
}

export type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Try to spend one attempt from `key`'s bucket.
 *
 * Reading a bucket never spends from it — call `spend()` only when the attempt
 * actually happened — so a pre-check and a spend are two separate calls and
 * the pre-check cannot itself exhaust the budget.
 */
export function peek(key: string, now = Date.now()): Verdict {
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true };
  const tokens = refill(bucket, now);
  if (tokens >= 1) return { allowed: true };
  const perTokenMs = bucket.windowMs / bucket.capacity;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((1 - tokens) * perTokenMs) / 1000)) };
}

/** Consume one attempt from `key`'s bucket (creating it on first use). */
export function spend(key: string, limit: Limit, now = Date.now()): void {
  if (buckets.size >= MAX_BUCKETS) sweep(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.capacity !== limit.capacity || bucket.windowMs !== limit.windowMs) {
    bucket = { tokens: limit.capacity, updatedAt: now, capacity: limit.capacity, windowMs: limit.windowMs };
    buckets.delete(key);
    buckets.set(key, bucket);
  }
  // Clamped at zero, not allowed to run negative: an attacker who hammers an
  // exhausted bucket must not be able to push the wait out indefinitely —
  // that would turn a throttle into a lockout someone else can hold. At zero
  // the refilled rate IS the rate: capacity per window, forever.
  bucket.tokens = Math.max(0, refill(bucket, now) - 1);
  bucket.updatedAt = now;
}

function refill(bucket: Bucket, now: number): number {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  const refillPerMs = bucket.capacity / bucket.windowMs;
  const tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * refillPerMs);
  bucket.tokens = tokens;
  bucket.updatedAt = now;
  return tokens;
}

/** Hand the budget back (a successful credential check is not a guess). */
export function refund(key: string): void {
  buckets.delete(key);
}

/** Test hook — a fresh process has fresh buckets, so tests must too. */
export function resetRateLimits(): void {
  buckets.clear();
}

/* --------------------------------------------------------------------------
 * Which buckets does this request draw from?
 *
 * `kind` records how the key was derived, because that is what decides what
 * may be refunded: `identity` comes from the request BODY (unspoofable) and
 * is handed back when the credential turns out to be correct; `ip` and
 * `global` come from headers and from the process, and are never handed back
 * — an attacker who owns one valid login must not be able to buy the whole
 * server's budget back with it.
 *
 * Order is order of trust: identity first, then the address (see
 * `clientIp`), then the process-wide floor.
 * ------------------------------------------------------------------------ */

export type Attempt = { key: string; limit: Limit; kind: "identity" | "ip" | "global" };

export function loginAttempts(email: string, request: Request): Attempt[] {
  const attempts: Attempt[] = [{ key: `login:id:${email}`, limit: LIMITS.loginIdentity, kind: "identity" }];
  const ip = clientIp(request);
  if (ip) attempts.push({ key: `login:ip:${ip}`, limit: LIMITS.loginIp, kind: "ip" });
  attempts.push({ key: "login:global", limit: LIMITS.loginGlobal, kind: "global" });
  return attempts;
}

export function recoverAttempts(email: string, request: Request): Attempt[] {
  const attempts: Attempt[] = [{ key: `recover:id:${email}`, limit: LIMITS.recoverIdentity, kind: "identity" }];
  const ip = clientIp(request);
  if (ip) attempts.push({ key: `recover:ip:${ip}`, limit: LIMITS.recoverIp, kind: "ip" });
  attempts.push({ key: "recover:global", limit: LIMITS.recoverGlobal, kind: "global" });
  return attempts;
}

export function registerAttempts(request: Request): Attempt[] {
  const attempts: Attempt[] = [];
  const ip = clientIp(request);
  if (ip) attempts.push({ key: `register:ip:${ip}`, limit: LIMITS.registerIp, kind: "ip" });
  attempts.push({ key: "register:global", limit: LIMITS.registerGlobal, kind: "global" });
  return attempts;
}

/** True when EVERY bucket still has a token, otherwise the tightest verdict. */
export function checkAttempts(attempts: readonly Attempt[], now = Date.now()): Verdict {
  let blocked: { allowed: false; retryAfterSeconds: number } | null = null;
  for (const attempt of attempts) {
    const verdict = peek(attempt.key, now);
    if (!verdict.allowed && (blocked === null || verdict.retryAfterSeconds > blocked.retryAfterSeconds)) {
      blocked = verdict;
    }
  }
  return blocked ?? { allowed: true };
}

/** Charge every bucket for an attempt that actually happened. */
export function spendAttempts(attempts: readonly Attempt[], now = Date.now()): void {
  for (const attempt of attempts) spend(attempt.key, attempt.limit, now);
}

/** Hand back only the identity bucket: the caller proved it is not guessing. */
export function refundIdentity(attempts: readonly Attempt[]): void {
  for (const attempt of attempts) {
    if (attempt.kind === "identity") refund(attempt.key);
  }
}

/**
 * Hand back every bucket. Registration is the one place that does this: a
 * completed registration is the thing `ACCT_MAX_ACCOUNTS` already bounds, so
 * a user who legitimately created an account must not be left sharing an
 * hourly budget with their own earlier attempts (and the e2e gate, which
 * registers for real, would otherwise start failing on its third run).
 */
export function refundAttempts(attempts: readonly Attempt[]): void {
  for (const attempt of attempts) refund(attempt.key);
}

/**
 * Best-effort source address, or null when there is none worth keying on.
 *
 * Order: the FIRST `X-Forwarded-For` entry (what the outer proxy said the
 * client was), then `X-Real-IP` (what nginx saw — which is the proxy itself
 * when a tunnel is in front, i.e. shared by every client).
 *
 * HONEST LIMITS, stated because the review demanded it rather than assumed:
 *
 *  - **It is a throttle key, not an identity.** Anyone who can set the header
 *    can rotate it, so this key alone never protects anything that matters —
 *    which is why every credential endpoint ALSO has the identity bucket
 *    (body-derived, unspoofable) and a process-wide floor.
 *  - **It may be shared.** If the proxy in front does not forward a client
 *    address, every request carries the same key and the per-IP budget
 *    behaves as a second global budget. That is why the per-IP numbers are
 *    generous: a shared key must never be able to lock a legitimate user out
 *    of their own account.
 *  - null (no header at all) means the per-IP bucket is simply not used —
 *    direct access and the local e2e gate take the identity/global path only.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = request.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : null;
}
