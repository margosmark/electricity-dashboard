// @vitest-environment node
/**
 * Wave K gate: the OAuth loop closes and the feed pipes through.
 *
 * Everything below runs against a REAL mock data custodian over HTTP —
 * authorize → callback → token exchange → ESPI batch → streamed XML → the
 * app's own parser — plus the failure modes that matter: revoked grants,
 * rotated refresh tokens, async 202 batches, the SSRF guard, and the
 * session gate that keeps the feed private.
 *
 * This is the substitute for gate 1 ("shim against the SANDBOX authorizeUrl
 * with a dummy user"), which needs Oakville Hydro to have issued credentials
 * first.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockCustodian } from "../../../scripts/mock-custodian.mjs";
import { resetConfigCache, getNotifyToken } from "@/lib/greenbutton/config";
import { resetTokenStore, PERSISTED_KEYS } from "@/lib/greenbutton/tokens";
import { resetSessionState, getSyncMeta } from "@/lib/greenbutton/session";
import { parseGreenButtonUsagePoints } from "@/lib/energy";

import { GET as statusGET } from "@/app/greenbutton/status/route";
import { GET as startGET } from "@/app/greenbutton/start/route";
import { GET as callbackGET } from "@/app/greenbutton/callback/route";
import { GET as usageGET } from "@/app/greenbutton/usage/route";
import { POST as disconnectPOST } from "@/app/greenbutton/disconnect/route";
import { POST as notifyPOST } from "@/app/greenbutton/notify/[token]/route";

const APP = "http://localhost:3939";
const REDIRECT_URI = `${APP}/greenbutton/callback`;

type Mock = Awaited<ReturnType<typeof startMockCustodian>>;

let mock: Mock;
let dir: string;
let tokenFile: string;
const jar = new Map<string, string>();

function applySetCookie(res: Response): void {
  const header = res.headers as Headers & { getSetCookie?: () => string[] };
  const lines = header.getSetCookie?.() ?? [];
  for (const line of lines) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function appRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookieHeader()) headers.set("cookie", cookieHeader());
  return new Request(`${APP}${path}`, { ...init, headers });
}

/** The .mjs mock has no type annotations; this is its request-log shape. */
type MockRequest = { method?: string; path: string; query: Record<string, string | undefined> };
function requests(): MockRequest[] {
  return (mock.state.requests as unknown as MockRequest[]) ?? [];
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Drive authorize → callback the way a browser would; leaves the session cookie in the jar. */
async function connect(): Promise<Response> {
  jar.clear();
  const start = await startGET();
  expect(start.status).toBe(302);
  applySetCookie(start);
  const authorizeUrl = start.headers.get("location");
  expect(authorizeUrl).toContain("/oauth/authorize");
  expect(authorizeUrl).toContain(`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);

  const atAuth = (await fetch(authorizeUrl!, { redirect: "manual" })) as Response;
  expect(atAuth.status).toBe(302);
  const callbackUrl = atAuth.headers.get("location");
  expect(callbackUrl).toContain("/greenbutton/callback");

  const cb = await callbackGET(
    new Request(callbackUrl!, { headers: { cookie: cookieHeader() } }),
  );
  applySetCookie(cb);
  return cb;
}

beforeAll(async () => {
  mock = await startMockCustodian();
  dir = await mkdtemp(join(tmpdir(), "greenbutton-test-"));
  tokenFile = join(dir, "tokens.json");

  process.env.GB_AUTHORIZE_URL = mock.authorizeUrl;
  process.env.GB_TOKEN_URL = mock.tokenUrl;
  process.env.GB_CLIENT_ID = mock.opts.clientId;
  process.env.GB_CLIENT_SECRET = mock.opts.clientSecret;
  process.env.GB_REDIRECT_URI = REDIRECT_URI;
  process.env.GB_TOKEN_FILE = tokenFile;
  process.env.GB_SCOPE = "FB=1_3_4_5";
  process.env.GB_PUBLIC_ORIGIN = APP;
  delete process.env.GB_TOKEN_AUTH_STYLE;
  delete process.env.GB_NOTIFY_TOKEN;
  resetConfigCache();
});

afterAll(async () => {
  await mock?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  resetConfigCache();
  resetTokenStore();
  resetSessionState();
});

beforeEach(async () => {
  resetTokenStore();
  resetSessionState();
  jar.clear();
  // A token file left by the previous test would make "before authorisation"
  // assertions lie, so every case starts from no authorisation at all.
  await rm(tokenFile, { force: true });
  mock.setRevoked(false);
  mock.setRotation("none");
  mock.setAsync202(false);
  mock.setOmitResourceUri(false);
  mock.setResourceRejectOnce(false);
  mock.setAuthorizationFail(false);
  mock.setAuthorizationRedirect(null);
  mock.setBatchRedirect(null);
  mock.state.requests.length = 0;
});

describe("authorization_code loop", () => {
  it("starts, callbacks, stores ONLY the token set, and unlocks the feed", async () => {
    // --- status before anything -------------------------------------
    const before = await json(await statusGET(appRequest("/greenbutton/status")));
    expect(before.configured).toBe(true);
    expect(before.connected).toBe(false);

    // --- authorize round trip ---------------------------------------
    const cb = await connect();
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("gb=connected");

    // --- what reached disk ------------------------------------------
    expect(await fileExists(tokenFile)).toBe(true);
    const onDisk = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    // Zero data at rest: the file may only ever hold the token set.
    for (const key of Object.keys(onDisk)) {
      expect(PERSISTED_KEYS).toContain(key);
    }
    expect(typeof onDisk.accessToken).toBe("string");
    expect(typeof onDisk.refreshToken).toBe("string");
    expect(onDisk.subscriptionUri).toContain("/espi/1_1/resource/Batch/Subscription/");
    // mode 0600
    const mode = (await stat(tokenFile)).mode & 0o777;
    expect(mode).toBe(0o600);

    // --- status after -------------------------------------------------
    const after = await json(await statusGET(appRequest("/greenbutton/status")));
    expect(after.connected).toBe(true);

    // --- the feed, without the session cookie ------------------------
    const naked = await usageGET(new Request(`${APP}/greenbutton/usage`));
    expect(naked.status).toBe(401);
    expect((await json(naked)).error).toBe("session_required");

    // --- the feed, with it -------------------------------------------
    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toContain("application/atom+xml");
    expect(feed.headers.get("x-greenbutton-pipe")).toBe("stream");
    const xml = await feed.text();
    // Namespaced in the feed (espi:), un-prefixed after the app's parser
    // strips namespaces — assert on the raw pipe, then on the parse.
    expect(xml).toContain("IntervalReading");
    expect(xml).toContain("<espi:IntervalBlock>");

    // The whole point: the app's OWN parser reads what was piped through.
    const groups = parseGreenButtonUsagePoints(xml);
    expect(groups).toHaveLength(1);
    expect(groups[0].readings.length).toBe(mock.opts.intervals);
    expect(groups[0].readings[0].usage_kwh).toBeGreaterThan(0);

    // --- and the server kept nothing ---------------------------------
    expect(getSyncMeta().lastSyncBytes).toBe(xml.length);
    const stillOnlyTokens = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stillOnlyTokens).every((k) => PERSISTED_KEYS.includes(k as never))).toBe(true);
    expect(JSON.stringify(stillOnlyTokens)).not.toContain("IntervalReading");
  });

  it("sends the narrow scope and the registered redirect_uri to the custodian", async () => {
    await connect();
    const authorize = requests().find((r) => r.path === "/oauth/authorize");
    expect(authorize?.query.scope).toBe("FB=1_3_4_5");
    expect(authorize?.query.redirect_uri).toBe(REDIRECT_URI);
    expect(authorize?.query.response_type).toBe("code");
    expect(authorize?.query.client_id).toBe(mock.opts.clientId);
    expect(authorize?.query.state).toBeTruthy();
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const start = await startGET();
    applySetCookie(start);
    const authorizeUrl = start.headers.get("location")!;
    const atAuth = (await fetch(authorizeUrl, { redirect: "manual" })) as Response;
    const callbackUrl = atAuth.headers.get("location")!;
    // Tamper: drop the cookie the flow was started with.
    jar.delete("gb_state");
    const cb = await callbackGET(
      new Request(callbackUrl, { headers: { cookie: cookieHeader() } }),
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("gb=error:state_mismatch");
    expect(await fileExists(tokenFile)).toBe(false);
  });
});

describe("revocation", () => {
  it("clears the stored tokens and reports grant_revoked when the utility says no", async () => {
    const cb = await connect();
    expect(cb.headers.get("location")).toContain("gb=connected");
    expect(await fileExists(tokenFile)).toBe(true);

    mock.setRevoked(true);
    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(401);
    const body = await json(feed);
    expect(body.error).toBe("grant_revoked");

    // Recovery path: nothing left to leak, nothing left to retry with.
    expect(await fileExists(tokenFile)).toBe(false);
    const status = await json(await statusGET(appRequest("/greenbutton/status")));
    expect(status.connected).toBe(false);
  });
});

describe("refresh-token rotation (savagedata behaviour)", () => {
  it("persists the rotated refresh token before returning", async () => {
    mock.setRotation("always");
    await connect();
    const first = JSON.parse(await readFile(tokenFile, "utf8")) as { refreshToken: string };

    // Expire the access token so the next feed pull MUST refresh.
    const current = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    current.expiresAt = Date.now() - 1000;
    await writeFile(tokenFile, JSON.stringify(current), { mode: 0o600 });
    resetTokenStore(); // force a reload from disk

    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(200);
    await feed.arrayBuffer(); // let the stream complete

    const rotated = JSON.parse(await readFile(tokenFile, "utf8")) as { refreshToken: string };
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(requests().some((r) => r.path === "/oauth/token")).toBe(true);
  });
});

describe("ESPI resource guards", () => {
  it("refuses absolute and traversal resource paths (SSRF)", async () => {
    await connect();
    for (const bad of [
      "https://169.254.169.254/latest/meta-data",
      "../../etc/passwd",
      "/etc/passwd",
      "UsagePoint?x=1",
    ]) {
      const res = await usageGET(
        appRequest(`/greenbutton/usage?resourcePath=${encodeURIComponent(bad)}`),
      );
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_resource_path");
    }
  });

  it("passes a legitimate relative ESPI suffix through", async () => {
    await connect();
    const res = await usageGET(
      appRequest("/greenbutton/usage?resourcePath=UsagePoint/usage-point-1"),
    );
    // The mock only serves the batch URI, so the suffix 404s — which proves
    // the request went to the custodian rather than being rejected locally.
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("upstream");
  });

  it("surfaces an async 202 batch as data_pending instead of hanging", async () => {
    await connect();
    mock.setAsync202(true);
    const res = await usageGET(appRequest("/greenbutton/usage"));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("data_pending");
  });

  it("clamps a future published-max instead of sending one", async () => {
    const { buildResourceUrl } = await import("@/lib/greenbutton/espi");
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const url = new URL(buildResourceUrl({
      accessToken: "x",
      subscriptionUri: "https://custodian.example/espi/1_1/resource/Batch/Subscription/1",
      publishedMax: future,
    }));
    expect(url.searchParams.get("published-max")).not.toBeNull();
    const sent = Math.floor(new Date(url.searchParams.get("published-max")!).getTime() / 1000);
    expect(sent).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(url.searchParams.get("published-max")).not.toContain(".");
  });
});

describe("ESPI pointer resolution (Authorization-resource fallback)", () => {
  // The token response may omit `resourceURI`; the spec-defined fallback is
  // the Authorization resource. That path had ZERO coverage — and every one
  // of its failure modes used to destroy the years-long refresh token or
  // poison the token file.

  it("classifies a 500 from the Authorization resource as upstream, not revocation", async () => {
    mock.setOmitResourceUri(true);
    const cb = await connect();
    expect(cb.headers.get("location")).toContain("gb=connected");
    mock.setAuthorizationFail(true);

    const res = await usageGET(appRequest("/greenbutton/usage"));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("upstream");
    // A custodian hiccup must never destroy the grant.
    expect(await fileExists(tokenFile)).toBe(true);
    const status = await json(await statusGET(appRequest("/greenbutton/status")));
    expect(status.connected).toBe(true);
  });

  it("keeps the authorisation when the Authorization resource is unreachable", async () => {
    mock.setOmitResourceUri(true);
    await connect();
    const raw = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    raw.authorizationUri = "http://127.0.0.1:1/espi/authorization";
    await writeFile(tokenFile, JSON.stringify(raw), { mode: 0o600 });
    resetTokenStore();

    const res = await usageGET(appRequest("/greenbutton/usage"));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("upstream");
    expect(await fileExists(tokenFile)).toBe(true);
  });

  it("resolves the relative resourceURI the Authorization resource advertises and pipes the feed", async () => {
    mock.setOmitResourceUri(true);
    await connect();

    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(200);
    const xml = await feed.text();
    expect(xml).toContain("IntervalReading");
    expect(parseGreenButtonUsagePoints(xml)).toHaveLength(1);

    // Persisted ABSOLUTE: a raw relative URI makes buildResourceUrl throw
    // `Invalid URL` on every later sync — permanent 500s from one bad save.
    const onDisk = JSON.parse(await readFile(tokenFile, "utf8")) as { subscriptionUri?: string };
    expect(onDisk.subscriptionUri).toMatch(/^https?:\/\//);

    const again = await usageGET(appRequest("/greenbutton/usage"));
    expect(again.status).toBe(200);
  });

  it("recovers when the utility expired the access token server-side", async () => {
    mock.setOmitResourceUri(true);
    await connect();
    mock.expireAccessTokens(); // server forgot the AT; the client copy still looks fresh

    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(200);
    await feed.arrayBuffer();
    expect(await fileExists(tokenFile)).toBe(true);
  });

  it("persists the resolved pointer across an access-token refresh in the same request", async () => {
    mock.setOmitResourceUri(true);
    await connect();
    const current = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    current.expiresAt = Date.now() - 1000;
    await writeFile(tokenFile, JSON.stringify(current), { mode: 0o600 });
    resetTokenStore();

    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(200);
    await feed.arrayBuffer();
    const onDisk = JSON.parse(await readFile(tokenFile, "utf8")) as { subscriptionUri?: string };
    // The refresh's save must not clobber the pointer saved moments earlier.
    expect(onDisk.subscriptionUri).toMatch(/^https?:\/\//);
  });

  it("survives rotation plus a one-shot resource 401 (retry uses the rotated refresh token)", async () => {
    mock.setRotation("always");
    mock.setResourceRejectOnce(true);
    await connect();
    const current = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    current.expiresAt = Date.now() - 1000;
    await writeFile(tokenFile, JSON.stringify(current), { mode: 0o600 });
    resetTokenStore();

    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(200);
    await feed.arrayBuffer();
    // RED today: the forced retry reuses the pre-rotation refresh token,
    // gets invalid_grant, and wipes the freshly rotated one from disk.
    expect(await fileExists(tokenFile)).toBe(true);
    const onDisk = JSON.parse(await readFile(tokenFile, "utf8")) as { refreshToken?: string };
    expect(onDisk.refreshToken).toBeTruthy();
  });

  it("keeps the authorisation when the Authorization resource redirects cross-host", async () => {
    mock.setOmitResourceUri(true);
    await connect();
    // Same server, different hostname → fetch strips Authorization on the
    // follow → the target 401s → must not read as "grant revoked".
    mock.setAuthorizationRedirect(
      `${mock.origin.replace("127.0.0.1", "localhost")}/espi/1_1/resource/Authorization/mock-auth-1-landed`,
    );

    const res = await usageGET(appRequest("/greenbutton/usage"));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("upstream");
    expect(await fileExists(tokenFile)).toBe(true);
  });

  it("keeps the authorisation when the usage batch redirects cross-host", async () => {
    await connect();
    mock.setBatchRedirect(
      `${mock.origin.replace("127.0.0.1", "localhost")}/espi/1_1/resource/Batch/Subscription/mock-sub-1-landed`,
    );

    const res = await usageGET(appRequest("/greenbutton/usage"));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("upstream");
    expect(await fileExists(tokenFile)).toBe(true);
  });

  it("still clears the token set when it carries no ESPI pointer at all", async () => {
    mock.setOmitResourceUri(true);
    await connect();
    const raw = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    delete raw.authorizationUri;
    await writeFile(tokenFile, JSON.stringify(raw), { mode: 0o600 });
    resetTokenStore();

    const res = await usageGET(appRequest("/greenbutton/usage"));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("grant_revoked");
    expect(await fileExists(tokenFile)).toBe(false);
  });
});

describe("notification webhook", () => {
  it("accepts a BatchList at the registered token path and only records a timestamp", async () => {
    await connect();
    const before = getSyncMeta().dataAvailableSince;

    const res = await notifyPOST(
      new Request(`${APP}/greenbutton/notify/${getNotifyToken()}`, {
        method: "POST",
        headers: { "content-type": "application/atom+xml" },
        body: `<?xml version="1.0"?><feed><entry><link href="https://custodian/espi/1_1/resource/Batch/Subscription/1"/></entry></feed>`,
      }),
      { params: Promise.resolve({ token: getNotifyToken() }) },
    );
    expect(res.status).toBe(200);
    const after = getSyncMeta().dataAvailableSince;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // Scalar only — no resource URIs retained.
    expect(JSON.stringify(getSyncMeta())).not.toContain("custodian");
  });

  it("404s an unknown notification token", async () => {
    await connect();
    const res = await notifyPOST(
      new Request(`${APP}/greenbutton/notify/not-the-token`, { method: "POST", body: "<feed/>" }),
      { params: Promise.resolve({ token: "not-the-token" }) },
    );
    expect(res.status).toBe(404);
  });

  it("never publishes the notification token through /greenbutton/status", async () => {
    await connect();
    const raw = await (await statusGET(appRequest("/greenbutton/status"))).text();
    expect(raw).not.toContain("notificationUri");
    // The token itself must not appear anywhere in the response body — not
    // as a field, not in a URL, not in an error string (finding M1).
    expect(raw).not.toContain(getNotifyToken());
    // redirectUri is still there: the UI needs it and it holds no secret.
    expect(raw).toContain(REDIRECT_URI);
  });

  it("reads at most 64 KB of a 100 MB notification instead of buffering it", async () => {
    await connect();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // An instrumented body: every chunk we are asked for is counted, so the
    // assertion is about bytes actually pulled off the wire, not about what
    // the handler claims. 100 MB total, delivered in 16 KB chunks.
    const CHUNK = 16 * 1024;
    const LIMIT = 100 * 1024 * 1024;
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= LIMIT) {
          controller.close();
          return;
        }
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x41));
      },
      cancel() {
        cancelled = true;
      },
    });

    const started = Date.now();
    const res = await notifyPOST(
      new Request(`${APP}/greenbutton/notify/${getNotifyToken()}`, {
        method: "POST",
        headers: { "content-type": "application/atom+xml" },
        body,
        duplex: "half",
      } as RequestInit),
      { params: Promise.resolve({ token: getNotifyToken() }) },
    );
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // The whole 100 MB was never delivered: the reader stopped at the cap and
    // cancelled the rest.
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + CHUNK);
    expect(cancelled).toBe(true);
    // And it got there fast because it never buffered anything.
    expect(elapsed).toBeLessThan(5_000);

    const logged = log.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes("notification:"));
    expect(logged).toHaveLength(1);
    const bytes = Number(/bytes=(\d+)/.exec(logged[0])?.[1]);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    log.mockRestore();
  });
});

describe("disconnect", () => {
  it("wipes the token file and expires the session", async () => {
    await connect();
    expect(await fileExists(tokenFile)).toBe(true);

    const res = await disconnectPOST(appRequest("/greenbutton/disconnect", { method: "POST" }));
    expect(res.status).toBe(200);
    applySetCookie(res);
    expect(await fileExists(tokenFile)).toBe(false);

    const feed = await usageGET(appRequest("/greenbutton/usage"));
    expect(feed.status).toBe(401);
    expect((await json(feed)).error).toBe("not_connected");
  });

  it("refuses a cross-site disconnect", async () => {
    await connect();
    const res = await disconnectPOST(
      appRequest("/greenbutton/disconnect", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await fileExists(tokenFile)).toBe(true);
  });
});

describe("multi-meter feed", () => {
  it("pipes a 2-UsagePoint document the client can still group", async () => {
    const two = await startMockCustodian({ usagePoints: 2, intervals: 12 });
    try {
      const prev = { ...process.env };
      process.env.GB_AUTHORIZE_URL = two.authorizeUrl;
      process.env.GB_TOKEN_URL = two.tokenUrl;
      resetConfigCache();
      resetTokenStore();

      jar.clear();
      const start = await startGET();
      applySetCookie(start);
      const atAuth = (await fetch(start.headers.get("location")!, { redirect: "manual" })) as Response;
      const cb = await callbackGET(
        new Request(atAuth.headers.get("location")!, { headers: { cookie: cookieHeader() } }),
      );
      applySetCookie(cb);
      expect(cb.status).toBe(302);

      const feed = await usageGET(appRequest("/greenbutton/usage"));
      expect(feed.status).toBe(200);
      const groups = parseGreenButtonUsagePoints(await feed.text());
      expect(groups).toHaveLength(2);
      expect(groups.every((g) => g.readings.length === 12)).toBe(true);

      Object.assign(process.env, prev);
    } finally {
      // Back to the primary mock for any later test.
      process.env.GB_AUTHORIZE_URL = mock.authorizeUrl;
      process.env.GB_TOKEN_URL = mock.tokenUrl;
      resetConfigCache();
      resetTokenStore();
      await two.close();
    }
  });
});
