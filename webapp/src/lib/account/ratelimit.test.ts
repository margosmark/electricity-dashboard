// @vitest-environment node
/**
 * Wave N — the attempt budget, tested as arithmetic rather than as a loop.
 *
 * The route-level behaviour (401 × N → 429) lives in `account.test.ts`,
 * because that is where a real handler and a real database exist. What is
 * here is everything that would be tedious and slow to drive through argon2:
 * that a bucket spends, refuses, refills, and hands back only what it is
 * supposed to hand back.
 *
 * Every time-dependent case passes `now` explicitly, so nothing in this file
 * sleeps.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  LIMITS,
  checkAttempts,
  clientIp,
  loginAttempts,
  peek,
  recoverAttempts,
  refundAttempts,
  refundIdentity,
  registerAttempts,
  resetRateLimits,
  spend,
  spendAttempts,
} from "./ratelimit";

const KEY = "test:bucket";
const LIMIT = { capacity: 3, windowMs: 60_000 };

beforeEach(() => resetRateLimits());

describe("a bucket", () => {
  it("allows `capacity` attempts, then refuses with a positive Retry-After", () => {
    const t = 1_000_000;
    for (let i = 0; i < LIMIT.capacity; i++) expect(peek(KEY, t).allowed).toBe(true);
    for (let i = 0; i < LIMIT.capacity; i++) spend(KEY, LIMIT, t);

    const verdict = peek(KEY, t);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.retryAfterSeconds).toBeGreaterThan(0);
    // …and it is a bounded wait: never longer than the whole window.
    expect(verdict.allowed === false && verdict.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("refills continuously — a budget, not a lockout", () => {
    const t = 2_000_000;
    for (let i = 0; i < LIMIT.capacity; i++) spend(KEY, LIMIT, t);
    expect(peek(KEY, t).allowed).toBe(false);

    // One third of the window later, exactly one attempt is available again…
    expect(peek(KEY, t + 20_000).allowed).toBe(true);
    spend(KEY, LIMIT, t + 20_000);
    expect(peek(KEY, t + 20_000).allowed).toBe(false);

    // …and the whole window later the budget is back to full.
    expect(peek(KEY, t + 60_000).allowed).toBe(true);
  });

  it("never goes negative, however many times it is spent", () => {
    const t = 3_000_000;
    for (let i = 0; i < 50; i++) spend(KEY, LIMIT, t);
    expect(peek(KEY, t).allowed).toBe(false);
  });
});

describe("attempt plans", () => {
  const requestWith = (headers: Record<string, string> = {}) =>
    new Request("https://electricity.markarslan.ca/account/login", { headers });

  it("keys login on the address (unspoofable), the source, and the process", () => {
    const plan = loginAttempts("mark@example.com", requestWith({ "x-forwarded-for": "spoofed", "x-real-ip": "203.0.113.9" }));
    expect(plan.map((a) => a.kind)).toEqual(["identity", "ip", "global"]);
    expect(plan[0].key).toContain("mark@example.com");
    expect(plan[1].key).toContain("203.0.113.9");
    const other = loginAttempts("mark@example.com", requestWith({ "x-forwarded-for": "spoofed", "x-real-ip": "198.51.100.4" }));
    expect(other[0].key).toBe(plan[0].key);
    expect(other[1].key).not.toBe(plan[1].key);
  });

  it("spends every bucket in the plan and blocks on the tightest one", () => {
    const t = 4_000_000;
    const plan = [
      { key: "a", limit: { capacity: 5, windowMs: 60_000 }, kind: "identity" as const },
      { key: "b", limit: { capacity: 2, windowMs: 60_000 }, kind: "ip" as const },
    ];
    for (let i = 0; i < 2; i++) spendAttempts(plan, t);
    // Bucket `b` is empty while `a` still has three left: the plan refuses.
    const verdict = checkAttempts(plan, t);
    expect(verdict.allowed).toBe(false);
    // …and it reports the bucket that will take longest to refill.
    expect(verdict.allowed === false && verdict.retryAfterSeconds).toBeGreaterThan(1);
  });

  it("hands back ONLY the identity bucket on success", () => {
    const t = 5_000_000;
    const plan = loginAttempts("mark@example.com", requestWith({ "x-real-ip": "203.0.113.9" }));
    const [identity, , floor] = plan;

    // Exhaust the address bucket on its own: the plan now refuses…
    for (let i = 0; i < identity.limit.capacity; i++) spend(identity.key, identity.limit, t);
    expect(checkAttempts(plan, t).allowed).toBe(false);
    // …and a correct password makes it usable again.
    refundIdentity(plan);
    expect(checkAttempts(plan, t).allowed).toBe(true);

    // Now exhaust the process-wide floor. A valid login must NOT refund that,
    // or one account the attacker owns would buy the whole server's budget.
    for (let i = 0; i < floor.limit.capacity; i++) spend(floor.key, floor.limit, t);
    refundIdentity(plan);
    expect(checkAttempts(plan, t).allowed).toBe(false);
    expect(checkAttempts([identity], t).allowed).toBe(true);
    expect(checkAttempts([floor], t).allowed).toBe(false);
    // `refundAttempts` (registration's rule) would clear it — that is the
    // difference between the two helpers.
    refundAttempts(plan);
    expect(checkAttempts(plan, t).allowed).toBe(true);
  });

  it("hands the whole registration plan back after a completed registration", () => {
    const t = 6_000_000;
    const plan = registerAttempts(requestWith({ "x-real-ip": "203.0.113.9" }));
    for (let i = 0; i < LIMITS.registerIp.capacity; i++) spendAttempts(plan, t);
    expect(checkAttempts(plan, t).allowed).toBe(false);
    refundAttempts(plan);
    expect(checkAttempts(plan, t).allowed).toBe(true);
  });

  it("gives a request with no source address the process-wide floor only", () => {
    expect(clientIp(requestWith())).toBeNull();
    expect(registerAttempts(requestWith()).map((a) => a.kind)).toEqual(["global"]);
    expect(loginAttempts("x@example.com", requestWith()).map((a) => a.kind)).toEqual(["identity", "global"]);
    // Recover is the same shape with its own (tighter) budgets.
    expect(recoverAttempts("x@example.com", requestWith()).map((a) => a.limit)).toEqual([
      LIMITS.recoverIdentity,
      LIMITS.recoverGlobal,
    ]);
  });

  it("ignores spoofable X-Forwarded-For and accepts only a valid ingress X-Real-IP", () => {
    expect(clientIp(requestWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBeNull();
    expect(clientIp(requestWith({ "x-real-ip": "10.0.0.7" }))).toBe("10.0.0.7");
    expect(clientIp(requestWith({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "not-an-ip" }))).toBeNull();
  });
});
