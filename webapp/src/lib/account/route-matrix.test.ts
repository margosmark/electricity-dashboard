// @vitest-environment node
/**
 * Wave N — the `/account/*` contract matrix: every PATH × every HTTP METHOD ×
 * every AUTH STATE × both FEATURE STATES, in one table, over the whole surface.
 *
 * WHY A MATRIX AND NOT ONE MORE TARGETED PROBE. This surface has already taken
 * two whack-a-mole patches: `2c8ca8d` (a wrong-method probe answered `405` and
 * auto-`OPTIONS` `204` + `Allow` while the feature was OFF, admitting an
 * account API on a deployment that claims to have none) and `e147a85` (the ON
 * gate was red as written because the container's `/data` was not writable).
 * Each was found by whoever thought to aim at that cell. The contract here is
 * regular — *invisible, not broken* while OFF, and the gate order in
 * `lib/account/http.ts` while ON — so it is stated ONCE, over the closed
 * surface, and a new route or a new verb cannot enter the bundle without a red
 * test.
 *
 * WHAT IS READ FROM DISK (and why that matters). The route list and the verbs
 * each route exports are parsed out of `src/app/account/**\/route.ts`; they are
 * not written down here. A new `/account/*` route, or a real handler where
 * `CONTRACT` below declares a `wrongMethod` stub, fails this file until it is
 * declared. That is the property the two patches above did not have.
 *
 * EVERY BODY-BEARING PROBE SENDS `{}` — deliberately invalid. Each cell then
 * asks WHICH GATE ANSWERED (feature flag → origin → session → payload), not
 * what the business logic does with a good payload. Happy paths stay where they
 * are: `account.test.ts` (in-process) and `tests/e2e/account_smoke.sh` (HTTP).
 *
 * WHAT THIS FILE CANNOT PROVE, and where that lives instead:
 *
 *  - **The router's own answers.** Next routes by PATH and answers a verb the
 *    route does not export — plus its auto-`OPTIONS` — from inside the bundle,
 *    before any handler runs. That is the exact mechanism behind `2c8ca8d`,
 *    and there is no router in this process. Here the stubs' *logic* is
 *    pinned; the live routing half is proven over real HTTP by
 *    `tests/e2e/account_smoke.sh` (both flag states, every method) and by the
 *    containerised topology gate.
 *  - **`HEAD`.** Next serves `HEAD` from the route's `GET`. There is no `HEAD`
 *    export to call in-process, so a `HEAD` probe drives the `GET` handler and
 *    only the status is asserted; that every route DOES export a `GET` (real
 *    or stub) is the static half, and the live statuses are in the HTTP gate.
 *  - **`x-gb-process` / `x-edge-location`.** Set by `src/proxy.ts` and by
 *    nginx — neither exists here (`proxy.test.ts`,
 *    `lib/account/topology.test.ts`, and the HTTP gate cover them).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { SESSION_COOKIE, SESSION_TTL_MS, resetAccountConfigCache } from "./config";
import { closeAllDbs, findSession, insertSession, openDb } from "./db";
import { resetAccountServices } from "./services";
import { resetRateLimits } from "./ratelimit";
import { hashToken, newSessionToken } from "./auth";

import * as registerRoute from "@/app/account/register/route";
import * as loginRoute from "@/app/account/login/route";
import * as logoutRoute from "@/app/account/logout/route";
import * as sessionRoute from "@/app/account/session/route";
import * as syncRoute from "@/app/account/sync/route";
import * as notifyRoute from "@/app/account/notify/route";
import * as recoverRoute from "@/app/account/recover/route";
import * as prefsRoute from "@/app/account/push/preferences/route";
import * as subscribeRoute from "@/app/account/push/subscribe/route";
import * as internalNotifyRoute from "@/app/account/internal/notify/route";

const BASE = "https://electricity.markarslan.ca";
const EMAIL = "matrix@example.com";
const PASSWORD = "correct horse battery staple";
const INTERNAL_TOKEN = "matrix-internal-token";
const DAY_MS = 24 * 60 * 60 * 1000;

/* ==========================================================================
 * 1. The surface, read from disk
 * ========================================================================== */

/** The verbs the router can dispatch. */
const VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
type Method = (typeof VERBS)[number];

/** The verbs a route MODULE can export. `HEAD` is served from `GET`. */
const EXPORTABLE = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_APP_DIR = path.resolve(HERE, "../../app/account");
const ROUTE_EXPORT = /^export \{([^}]*)\} from "@\/lib\/account\/http";/m;
const REAL_HANDLER = /^export async function (GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/gm;

type StubVerb = { fn: string; verb: string };
type SurfaceRoute = { route: string; file: string; real: string[]; stub: StubVerb[] };

function parseRouteFile(src: string): { real: string[]; stub: StubVerb[] } {
  const real = [...src.matchAll(REAL_HANDLER)].map((m) => m[1]);
  const stubLine = ROUTE_EXPORT.exec(src);
  const stub = stubLine
    ? [...stubLine[1].matchAll(/([A-Za-z0-9_]+) as (GET|POST|PUT|PATCH|DELETE|OPTIONS)/g)].map((m) => ({
        fn: m[1],
        verb: m[2],
      }))
    : [];
  return { real, stub };
}

function readSurface(dir: string = ACCOUNT_APP_DIR, segments: string[] = []): SurfaceRoute[] {
  const out: SurfaceRoute[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readSurface(full, [...segments, entry.name]));
    } else if (entry.name === "route.ts") {
      const route = `/account${segments.map((s) => `/${s}`).join("")}`;
      out.push({
        route,
        file: path.relative(path.resolve(HERE, "../../../.."), full),
        ...parseRouteFile(fs.readFileSync(full, "utf8")),
      });
    }
  }
  return out;
}

const SURFACE = readSurface();

/** The modules, keyed by route path — the same ten paths as the files on disk. */
const MODULES: Record<string, Record<string, unknown>> = {
  "/account/register": registerRoute,
  "/account/login": loginRoute,
  "/account/logout": logoutRoute,
  "/account/session": sessionRoute,
  "/account/sync": syncRoute,
  "/account/notify": notifyRoute,
  "/account/recover": recoverRoute,
  "/account/push/preferences": prefsRoute,
  "/account/push/subscribe": subscribeRoute,
  "/account/internal/notify": internalNotifyRoute,
};

/* ==========================================================================
 * 2. The contract
 * ========================================================================== */

type Auth = "anonymous" | "valid" | "forged" | "expired" | "stale";
const AUTH_STATES: Auth[] = ["anonymous", "valid", "forged", "expired", "stale"];

type Answer = {
  status: number;
  /** The `error` code the answer must carry, where the contract has one. */
  error?: string;
  /** Body pins for the cells whose BODY is the contract. */
  check?: (body: Record<string, unknown>, res: Response) => void;
};

type VerbContract = { anonymous: Answer; authenticated: Answer };

/**
 * A cookie that resolves to no live session row is not a session: this is where
 * the whole `forged` / `expired` half of the matrix comes from. `requireSession`
 * answers exactly what it answers with NO cookie at all — one 401 with one
 * `session_required` code, never a different message for "there was a cookie and
 * it was wrong", which would be a session-validity oracle.
 */
type RouteContract = {
  /** Verbs with a REAL handler. Every other verb on the route must be a stub. */
  real: Partial<Record<(typeof EXPORTABLE)[number], VerbContract>>;
};

const CONTRACT: Record<string, RouteContract> = {
  // Registration / login / recovery are the three unauthenticated endpoints:
  // a cookie changes nothing about what `{}` gets back from them.
  "/account/register": {
    real: {
      POST: {
        anonymous: { status: 400, error: "invalid_email" },
        authenticated: { status: 400, error: "invalid_email" },
      },
    },
  },
  "/account/login": {
    real: {
      POST: {
        anonymous: { status: 400, error: "invalid_email" },
        authenticated: { status: 400, error: "invalid_email" },
      },
    },
  },
  "/account/recover": {
    real: {
      POST: {
        anonymous: { status: 400, error: "invalid_email" },
        authenticated: { status: 400, error: "invalid_email" },
      },
    },
  },
  // Logout is deliberately idempotent: signed out, it still says 200 — with
  // `wasAuthenticated: false` — so a second click is not a support ticket.
  "/account/logout": {
    real: {
      POST: {
        anonymous: { status: 200, check: (b) => expect(b.wasAuthenticated).toBe(false) },
        authenticated: {
          status: 200,
          check: (b) => {
            expect(b.wasAuthenticated).toBe(true);
            expect(b.email).toBe(EMAIL);
          },
        },
      },
    },
  },
  // The feature-flag probe, and the only route that rotates a stale session.
  "/account/session": {
    real: {
      GET: {
        anonymous: {
          status: 200,
          check: (b) => {
            expect(b.enabled).toBe(true);
            expect(b.authed).toBe(false);
          },
        },
        authenticated: {
          status: 200,
          check: (b) => {
            expect(b.authed).toBe(true);
            expect(b.email).toBe(EMAIL);
            expect(typeof b.kdfSalt).toBe("string");
          },
        },
      },
    },
  },
  /*
   * From here down the session gate is in front of the payload gate, which is
   * what makes the `anonymous` and `authenticated` halves different answers to
   * the SAME invalid body. The `authenticated` status is therefore the proof
   * that the request got PAST the session gate — 400/503, never 401.
   */
  "/account/sync": {
    real: {
      GET: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: {
          status: 200,
          check: (b) => {
            expect(b.rev).toBe(0); // never uploaded — a normal state, not an error
            expect(b.data).toBeNull();
          },
        },
      },
      PUT: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: { status: 400, error: "invalid_blob" },
      },
    },
  },
  "/account/notify": {
    real: {
      POST: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: { status: 400, error: "invalid_topic" },
      },
    },
  },
  "/account/push/preferences": {
    real: {
      GET: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: {
          status: 200,
          check: (b) => expect((b.prefs as Record<string, unknown>).dailyCap).toBe(3),
        },
      },
      PUT: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: { status: 200, check: (b) => expect(b.ok).toBe(true) },
      },
    },
  },
  // `503 push_unconfigured` is the honest answer on a server with no VAPID
  // keys: the session gate passed, push is inert, nothing was stored.
  "/account/push/subscribe": {
    real: {
      POST: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: { status: 503, error: "push_unconfigured" },
      },
      DELETE: {
        anonymous: { status: 401, error: "session_required" },
        authenticated: { status: 400, error: "invalid_subscription" },
      },
    },
  },
  /*
   * The internal fan-out is gated by a SHARED SECRET, not by a session, and it
   * answers the same bare 404 as a disabled process while the token is absent —
   * so a session must NOT be a substitute for `X-Account-Internal`. That cell
   * (`authenticated` → 404) is the one this row exists for.
   */
  "/account/internal/notify": {
    real: {
      POST: {
        anonymous: { status: 404, error: "not_found" },
        authenticated: { status: 404, error: "not_found" },
      },
    },
  },
};

/* ==========================================================================
 * 3. Fixtures — one account, five auth states
 * ========================================================================== */

let dbDir: string;
let dbPath: string;
let accountId: number;
/** A live session for `EMAIL` (the `valid` column). */
let validToken: string;

const cfgDb = () => openDb(dbPath);

function tokenCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** A cookie nobody ever issued: 24 random bytes, no row behind it. */
function forgedCookie(): string {
  return tokenCookie(randomBytes(24).toString("base64url"));
}

/**
 * A LIVE session for the fixture account — the `valid` column.
 *
 * The matrix probes `POST /account/logout` WITH that session (that is the
 * `wasAuthenticated: true` cell) and logout deletes the row, by design. So this
 * column re-mints the row if it is gone: every `valid` cell must mean "a live
 * session", never "whatever the previous route did to the fixture".
 */
function validCookie(): string {
  const db = cfgDb();
  const hash = hashToken(validToken);
  if (!findSession(db, hash)) insertSession(db, hash, accountId, SESSION_TTL_MS);
  return tokenCookie(validToken);
}

/** A REAL row whose `expires_at` has already passed — re-seeded per probe. */
function expiredCookie(): string {
  const t = newSessionToken();
  insertSession(cfgDb(), t.hash, accountId, -60_000);
  return tokenCookie(t.token);
}

/**
 * A REAL, live row last seen two days ago — re-seeded per probe.
 *
 * `GET /account/session` rotates it (deletes the row, mints a new token) while
 * every other route only slides the expiry, so a token reused across probes
 * would answer 401 on the second `session` probe for a reason that has nothing
 * to do with the cell under test.
 */
function staleCookie(): string {
  const t = newSessionToken();
  const db = cfgDb();
  insertSession(db, t.hash, accountId, SESSION_TTL_MS);
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
    Date.now() - 2 * DAY_MS,
    t.hash,
  );
  return tokenCookie(t.token);
}

function cookieFor(auth: Auth): string | undefined {
  switch (auth) {
    case "anonymous":
      return undefined;
    case "valid":
      return validCookie();
    case "forged":
      return forgedCookie();
    case "expired":
      return expiredCookie();
    case "stale":
      return staleCookie();
  }
}

/** `{}` for the verbs that carry a body; nothing for the ones that do not. */
function bodyFor(method: Method): string | undefined {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
    ? "{}"
    : undefined;
}

function probe(method: Method, route: string, cookie?: string): Request {
  const body = bodyFor(method);
  return new Request(`${BASE}${route}`, {
    method,
    headers: {
      origin: BASE,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body } : {}),
  });
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __unparsable: text.slice(0, 200) };
  }
}

/**
 * The handler the ROUTER would run for `method`.
 *
 * `HEAD` is served from the route's `GET` (Next's rule), which is why the
 * static test below refuses a route that exports neither.
 */
function handlerFor(mod: Record<string, unknown>, method: Method): (req: Request) => Promise<Response> {
  const name = method === "HEAD" ? "GET" : method;
  return mod[name] as (req: Request) => Promise<Response>;
}

/** One in-process call, with the cell named in every failure message. */
async function call(
  mod: Record<string, unknown>,
  method: Method,
  route: string,
  auth: Auth,
): Promise<Response> {
  const handler = handlerFor(mod, method);
  expect(typeof handler, `${method} ${route} — no handler the router could dispatch`).toBe("function");
  const res = await handler(probe(method, route, cookieFor(auth)));
  expect(res instanceof Response, `${method} ${route} [${auth}] — handler returned no Response`).toBe(true);
  return res;
}

function answeredByTable(
  route: string,
  method: Method,
  auth: Auth,
  res: Response,
  body: Record<string, unknown>,
): void {
  const cell = `${method} ${route} [${auth}]`;
  const contract = CONTRACT[route];
  expect(contract, `${cell} — no contract row for this route`).toBeTruthy();

  const effective = (method === "HEAD" ? "GET" : method) as (typeof EXPORTABLE)[number];
  const declared = contract.real[effective];

  if (!declared) {
    // Every verb the route does not implement is the shared `wrongMethod` stub:
    // an honest 405 that NAMES the refused method, never a blanket 404.
    expect(res.status, `${cell} — an unimplemented verb must answer 405`).toBe(405);
    expect(body.error, cell).toBe("method_not_allowed");
    if (method !== "HEAD") {
      expect(String(body.detail), `${cell} — the 405 must name the method it refused`).toContain(method);
    }
    expect(res.headers.get("cache-control"), cell).toBe("no-store");
    return;
  }

  const want = auth === "anonymous" || auth === "forged" || auth === "expired"
    ? declared.anonymous
    : declared.authenticated;
  expect(res.status, `${cell} — expected ${want.status}`).toBe(want.status);
  if (want.error) expect(body.error, cell).toBe(want.error);
  expect(res.headers.get("cache-control"), `${cell} — account answers are never cacheable`).toBe("no-store");
  // A `HEAD` probe in-process drives `GET`, whose body is a repair, not the
  // contract (the live body-less status is the HTTP gate's job).
  if (method !== "HEAD" && want.check) want.check(body, res);
}

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "wave-n-matrix-"));
  dbPath = join(dbDir, "accounts.db");
  process.env.ACCT_ENABLED = "true";
  process.env.ACCT_DB_PATH = dbPath;
  process.env.ACCT_PUBLIC_ORIGIN = BASE;
  process.env.ACCT_INTERNAL_TOKEN = INTERNAL_TOKEN;
  process.env.ACCT_MAX_ACCOUNTS = "10";
  process.env.ACCT_RATES_URL = "http://127.0.0.1:1/api/rates";
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  resetAccountConfigCache();

  const res = await registerRoute.POST(
    new Request(`${BASE}/account/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  expect(res.status, "the matrix fixture must be able to register an account").toBe(201);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /acct_session=([^;]*)/.exec(setCookie);
  expect(match, "register must hand back a session cookie").toBeTruthy();
  validToken = match![1];

  const row = cfgDb().prepare("SELECT id FROM accounts WHERE email = ?").get(EMAIL) as
    | { id: number }
    | undefined;
  expect(row, "the registered account must be readable back").toBeTruthy();
  accountId = row!.id;
});

afterAll(() => {
  resetAccountServices();
  closeAllDbs();
  resetAccountConfigCache();
  for (const key of [
    "ACCT_ENABLED",
    "ACCT_DB_PATH",
    "ACCT_PUBLIC_ORIGIN",
    "ACCT_INTERNAL_TOKEN",
    "ACCT_MAX_ACCOUNTS",
    "ACCT_RATES_URL",
  ]) {
    delete process.env[key];
  }
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  // The flag and the attempt budget are PROCESS state: resetting them per test
  // means no cell can pass or fail because of a counter another cell spent.
  delete process.env.ACCT_ENABLED;
  process.env.ACCT_ENABLED = "true";
  resetAccountConfigCache();
  resetRateLimits();
});

afterEach(() => {
  resetAccountServices();
  closeAllDbs();
});

/* ==========================================================================
 * 4. The surface test — no route, no verb, escapes the table
 * ========================================================================== */

describe("the surface on disk and the contract table describe the same thing", () => {
  it("discovers every route file, and declares every route it discovers", () => {
    const onDisk = SURFACE.map((r) => r.route);
    expect(onDisk.length, "the /account surface should not be empty").toBeGreaterThan(0);
    expect(new Set(onDisk).size, "two route.ts files must never claim the same path").toBe(onDisk.length);

    for (const route of onDisk) {
      expect(MODULES[route], `${route} has no module in this test's map`).toBeTruthy();
      expect(CONTRACT[route], `${route} has no row in CONTRACT — a new route must declare its cells`).toBeTruthy();
    }
    for (const route of Object.keys(CONTRACT)) {
      expect(onDisk, `${route} is pinned in CONTRACT but does not exist on disk`).toContain(route);
    }
    for (const route of Object.keys(MODULES)) {
      expect(onDisk, `${route} is imported but has no route file`).toContain(route);
    }
  });

  it("pins exactly the real handlers that exist — a new one is a new row, not a silent cell", () => {
    for (const { route, real } of SURFACE) {
      const declared = Object.keys(CONTRACT[route].real).sort();
      expect(real.slice().sort(), `${route} exports real handlers the contract does not declare`).toEqual(declared);
    }
  });

  it("answers all seven verbs per route: real handlers, or the shared wrong-method stub", () => {
    for (const { route, real, stub } of SURFACE) {
      const covered = new Set<string>([...real, ...stub.map((s) => s.verb)]);
      // `HEAD` does not exist as an export: Next serves it from `GET`, which is
      // therefore the one verb every route MUST have — real or stub.
      expect(covered.has("GET"), `${route} exports no GET — nothing could answer HEAD`).toBe(true);
      covered.add("HEAD");
      for (const verb of VERBS) {
        expect(covered.has(verb), `${route} has no handler for ${verb}`).toBe(true);
      }
      // A verb cannot be both: a real handler and a stub would shadow silently.
      for (const verb of real) {
        expect(stub.map((s) => s.verb), `${route} declares ${verb} twice`).not.toContain(verb);
      }
      for (const verb of EXPORTABLE) {
        const isReal = real.includes(verb);
        const isStub = stub.some((s) => s.verb === verb);
        expect(isReal || isStub, `${route} loses ${verb}`).toBe(true);
      }
    }
  });

  it("uses the shared wrongMethod for every stub — never a hand-rolled 404 or 405", () => {
    for (const { route, stub } of SURFACE) {
      for (const s of stub) {
        expect(s.fn, `${route} stubs ${s.verb} with ${s.fn}, not lib/account/http#wrongMethod`).toBe(
          "wrongMethod",
        );
      }
    }
  });
});

/* ==========================================================================
 * 5. The behavioural matrix, per route
 * ========================================================================== */

for (const { route, file } of SURFACE) {
  const mod = MODULES[route];

  describe(`${route} (${file})`, () => {
    it("feature OFF: every method × every auth state answers one bare 404", async () => {
      delete process.env.ACCT_ENABLED;
      resetAccountConfigCache();

      for (const method of VERBS) {
        for (const auth of AUTH_STATES) {
          const cell = `${method} ${route} [${auth}]`;
          const res = await call(mod, method, route, auth);
          const body = await readBody(res);
          // Byte-identical to "no such route": an app-container answer must not
          // confirm that an account API exists anywhere behind this origin.
          expect(res.status, `${cell} — the OFF half of the contract is 404, always`).toBe(404);
          expect(body, `${cell} — the OFF body is exactly {error:"not_found"}`).toEqual({
            error: "not_found",
          });
          // The two tells the 2c8ca8d defect shipped: `Allow` (from a 405 or an
          // auto-OPTIONS 204) and any `detail` that names a method.
          expect(res.headers.get("allow"), `${cell} — no Allow header may leak a route`).toBeNull();
          expect(res.headers.get("cache-control"), cell).toBe("no-store");
        }
      }
    });

    it("feature ON: declared handlers answer per the table, every other verb answers 405", async () => {
      for (const method of VERBS) {
        for (const auth of AUTH_STATES) {
          const res = await call(mod, method, route, auth);
          const body = await readBody(res);
          answeredByTable(route, method, auth, res, body);
        }
      }
    });
  });
}

/* ==========================================================================
 * 6. The cells the loop cannot express
 * ========================================================================== */

describe("the internal fan-out is gated by the shared secret, not the path", () => {
  const post = (headers: Record<string, string>) =>
    internalNotifyRoute.POST(
      new Request(`${BASE}/account/internal/notify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: "{}",
      }),
    );

  it("404s without the token — the same bare 404 as a disabled process", async () => {
    const res = await post({});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("404s on a WRONG token, so the answer cannot confirm the route either", async () => {
    const res = await post({ "x-account-internal": "not-the-token" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("lets the shim through with the right token — and then answers the payload gate", async () => {
    const res = await post({ "x-account-internal": INTERNAL_TOKEN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_topic");
  });
});

describe("the one route that rotates is the one route that may", () => {
  const session = (cookie?: string) =>
    sessionRoute.GET(
      new Request(`${BASE}/account/session`, { headers: cookie ? { cookie } : {} }),
    );

  it("hands back the SAME cookie for a fresh session — no gratuitous rotation", async () => {
    const res = await session(tokenCookie(validToken));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie"), "a fresh session must not be re-minted").toBeNull();
  });

  it("rotates a session untouched for more than a day, and writes the new value back", async () => {
    const res = await session(staleCookie());
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie, "a stale session must be rotated").toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("leaves other routes rotating nothing — they slide the expiry instead", async () => {
    const res = await prefsRoute.GET(
      new Request(`${BASE}/account/push/preferences`, { headers: { cookie: staleCookie() } }),
    );
    expect(res.status).toBe(200);
    expect(
      res.headers.get("set-cookie"),
      "a route without the cookie write must not ask for rotation (L1 from security round 1)",
    ).toBeNull();
  });
});
