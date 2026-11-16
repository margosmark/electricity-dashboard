// @vitest-environment node
/**
 * Unit-level guarantees for the Green Button shim.
 *
 * The flow tests in oauthFlow.test.ts prove the loop closes; these pin the
 * individual contracts that would be easy to break in a refactor without
 * anything looking wrong: what may reach disk, how resource paths are
 * validated, and how a token-endpoint failure is classified.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenStore, PERSISTED_KEYS, resetTokenStore } from "@/lib/greenbutton/tokens";
import { isSafeResourcePath, buildResourceUrl } from "@/lib/greenbutton/espi";
import {
  buildAuthorizeUrl,
  expiryFrom,
  newCodeVerifier,
  resolveResourceUri,
  s256Challenge,
} from "@/lib/greenbutton/oauth";
import {
  getConfig,
  resetConfigCache,
  getNotifyToken,
  getProcessIdentity,
} from "@/lib/greenbutton/config";
import { newState, consumeState, markSync, getSyncMeta, resetSessionState, markDataAvailable } from "@/lib/greenbutton/session";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gb-unit-"));
  resetTokenStore();
  resetSessionState();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("token store — zero data at rest", () => {
  it("writes ONLY the documented keys, mode 0600, and round-trips", async () => {
    const file = join(dir, "nested", "tokens.json");
    const store = new TokenStore(file);
    await store.save({
      accessToken: "at-value",
      refreshToken: "rt-value",
      expiresAt: 123,
      scope: "FB=1_3_4_5",
      subscriptionUri: "https://c.example/Batch/Subscription/1",
      authorizationUri: "https://c.example/Authorization/1",
      sessionToken: "sess",
      obtainedAt: 456,
    });

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = (await readFile(file, "utf8")) as string;
    const keys = Object.keys(JSON.parse(raw));
    expect(keys.sort()).toEqual([...PERSISTED_KEYS].sort());

    const fresh = new TokenStore(file);
    const loaded = await fresh.load();
    expect(loaded?.refreshToken).toBe("rt-value");
    expect(loaded?.obtainedAt).toBe(456);
  });

  it("drops unexpected fields instead of persisting them", async () => {
    const file = join(dir, "tokens.json");
    const store = new TokenStore(file);
    await store.save({
      accessToken: "at",
      obtainedAt: 1,
      // A future refactor must not be able to smuggle readings to disk.
      ...({ readings: [{ timestamp: 1, usage_kwh: 2 }] } as object),
    } as never);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).every((k) => PERSISTED_KEYS.includes(k as never))).toBe(true);
    expect(raw).not.toHaveProperty("readings");
    expect(JSON.stringify(raw)).not.toContain("usage_kwh");
  });

  it("treats a corrupt file as 'not authorised' rather than throwing", async () => {
    const file = join(dir, "tokens.json");
    await writeFile(file, "{not json", { mode: 0o600 });
    expect(await new TokenStore(file).load()).toBeNull();
  });

  it("degrades to memory-only when the path is unwritable, and says so", async () => {
    const blocked = join(dir, "no-such-dir-is-blocked", "tokens.json");
    // Make the PARENT a file so mkdir/write fails even as root-ish users.
    await writeFile(join(dir, "no-such-dir-is-blocked"), "a file, not a dir");
    const store = new TokenStore(blocked);
    await store.save({ accessToken: "at", obtainedAt: 1 });
    expect(store.persistence()).toBe("memory");
    // Still usable in this process — a bad mount costs a re-auth, not the feature.
    expect((await store.load())?.accessToken).toBe("at");
  });

  it("clear() removes the file and is idempotent", async () => {
    const file = join(dir, "tokens.json");
    const store = new TokenStore(file);
    await store.save({ accessToken: "at", obtainedAt: 1 });
    await store.clear();
    await expect(stat(file)).rejects.toThrow();
    await store.clear(); // second call must not throw
    expect(await store.load()).toBeNull();
  });

  it("serialises overlapping writes without leaving a temp file behind", async () => {
    const file = join(dir, "tokens.json");
    const store = new TokenStore(file);
    await Promise.all([
      store.save({ accessToken: "a1", obtainedAt: 1 }),
      store.save({ accessToken: "a2", obtainedAt: 2 }),
      store.save({ accessToken: "a3", obtainedAt: 3 }),
    ]);
    const loaded = await store.load();
    expect(["a1", "a2", "a3"]).toContain(loaded?.accessToken);
    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("ESPI resource path guard", () => {
  it("allows only relative ESPI suffixes", () => {
    expect(isSafeResourcePath(null)).toBe(true);
    expect(isSafeResourcePath(undefined)).toBe(true);
    expect(isSafeResourcePath("")).toBe(true);
    expect(isSafeResourcePath("UsagePoint")).toBe(true);
    expect(isSafeResourcePath("UsagePoint/abc-123/MeterReading/def")).toBe(true);

    for (const bad of [
      "https://169.254.169.254/latest/meta-data",
      "//evil.example/x",
      "../secrets",
      "UsagePoint/../../etc/passwd",
      "/absolute/path",
      "UsagePoint?injected=1",
      "UsagePoint#frag",
      "UsagePoint%2f..%2f",
      "Usage%20Point",
      "a/b/c/d/e",
    ]) {
      expect(isSafeResourcePath(bad), bad).toBe(false);
    }
  });

  it("builds the batch URL and clamps future published-max to now", () => {
    const now = Date.now();
    const url = new URL(
      buildResourceUrl(
        {
          accessToken: "x",
          subscriptionUri: "https://c.example/espi/1_1/resource/Batch/Subscription/1/",
          resourcePath: "UsagePoint/1",
          publishedMax: Math.floor(now / 1000) + 86_400,
        },
        now,
      ),
    );
    expect(url.pathname).toBe("/espi/1_1/resource/Batch/Subscription/1/UsagePoint/1");
    const sent = url.searchParams.get("published-max")!;
    expect(sent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/); // whole seconds
    expect(new Date(sent).getTime()).toBeLessThanOrEqual(now);
  });
});

describe("OAuth helpers", () => {
  it("builds an authorize URL with every required parameter", () => {
    const cfg = {
      ...getConfig(),
      configured: true,
      clientId: "cid",
      authorizeUrl: "https://custodian.example/oauth/authorize",
    };
    const url = new URL(buildAuthorizeUrl(cfg, "state-1", "https://app.example/cb", "FB=1_3_4_5"));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(url.searchParams.get("scope")).toBe("FB=1_3_4_5");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("client_secret")).toBeNull(); // never in a URL
  });

  it("mints an RFC 7636 verifier and its S256 challenge", () => {
    const verifier = newCodeVerifier();
    // 43-128 characters, unreserved charset only (RFC 7636 §4.1). base64url
    // of 48 random bytes lands at 64 and never emits +, / or =.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(newCodeVerifier()).not.toBe(verifier);

    // RFC 7636 Appendix B known-answer vector — if this ever drifts, every
    // challenge we send is wrong and no custodian will accept the flow.
    expect(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("puts the CHALLENGE on the authorize URL and never the verifier", () => {
    const cfg = { ...getConfig(), configured: true, clientId: "cid" };
    const verifier = newCodeVerifier();
    const challenge = s256Challenge(verifier);

    const withPkce = new URL(
      buildAuthorizeUrl(cfg, "state-1", "https://app.example/cb", "FB=1_3_4_5", challenge),
    );
    expect(withPkce.searchParams.get("code_challenge")).toBe(challenge);
    expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");
    // The whole point: what travels to the custodian cannot redeem the code.
    expect(withPkce.toString()).not.toContain(verifier);

    const without = new URL(
      buildAuthorizeUrl(cfg, "state-1", "https://app.example/cb", "FB=1_3_4_5"),
    );
    expect(without.searchParams.has("code_challenge")).toBe(false);
    expect(without.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("applies expiry skew so a token is refreshed a minute early", () => {
    const now = 1_000_000;
    expect(expiryFrom({ access_token: "a", expires_in: 3600 }, now)).toBe(now + 3_600_000 - 60_000);
    expect(expiryFrom({ access_token: "a" }, now)).toBeUndefined();
  });

  it("resolves relative ESPI pointers against the token endpoint", () => {
    expect(resolveResourceUri("/espi/Batch/1", "https://c.example/oauth/token")).toBe(
      "https://c.example/espi/Batch/1",
    );
    expect(resolveResourceUri(undefined, "https://c.example/oauth/token")).toBeUndefined();
    expect(resolveResourceUri("garbage://", "https://c.example/oauth/token")).toBeUndefined();
  });
});

describe("config", () => {
  afterEach(() => {
    resetConfigCache();
    delete process.env.GB_CLIENT_ID;
    delete process.env.GB_CLIENT_SECRET;
    delete process.env.GB_PUBLIC_ORIGIN;
    delete process.env.GB_NOTIFY_TOKEN;
    delete process.env.GB_PKCE;
  });

  it("is inert until the utility has issued credentials", () => {
    delete process.env.GB_CLIENT_ID;
    delete process.env.GB_CLIENT_SECRET;
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.unconfiguredReason).toContain("GB_CLIENT_ID");
    // The default URIs still form, so the registration form can be filled in
    // before credentials exist.
    expect(cfg.redirectUri).toBe("https://electricity.markarslan.ca/greenbutton/callback");
    expect(cfg.notificationUri).toMatch(/\/greenbutton\/notify\/[a-f0-9]{32}$/);
  });

  it("derives a stable notification token from the client secret", () => {
    process.env.GB_CLIENT_ID = "cid";
    process.env.GB_CLIENT_SECRET = "super-secret";
    resetConfigCache();
    const first = getNotifyToken();
    resetConfigCache();
    expect(getNotifyToken()).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(first).not.toBe("super-secret");
    // The token is derived, never the secret itself — nothing the utility or
    // a visitor sees can be reversed back into the client secret.
    expect(getConfig().notificationUri).not.toContain("super-secret");
  });

  it("lets a PINNED notify token win over the derived fallback", () => {
    // The registration records the notification URI before the custodian
    // issues the client secret, so the pinned value must not move when the
    // secret finally arrives. (Synthetic token — no live value lives here.)
    process.env.GB_CLIENT_ID = "cid";
    process.env.GB_CLIENT_SECRET = "super-secret";
    process.env.GB_NOTIFY_TOKEN = "pinned-notify-token-example-not-a-secret";
    resetConfigCache();
    expect(getNotifyToken()).toBe("pinned-notify-token-example-not-a-secret");
    expect(getConfig().notificationUri).toBe(
      "https://electricity.markarslan.ca/greenbutton/notify/pinned-notify-token-example-not-a-secret",
    );
    // …and it is identical whether or not the secret exists yet.
    process.env.GB_CLIENT_SECRET = "";
    resetConfigCache();
    expect(getConfig().notificationUri).toContain("pinned-notify-token-example-not-a-secret");
  });

  it("keeps PKCE OFF unless GB_PKCE is explicitly truthy", () => {
    // Off by default on purpose: the London-Hydro platform's acceptance of
    // code_challenge is unconfirmed, and a flow the custodian rejects is
    // worse than one missing defence-in-depth. Flip only on their reply.
    delete process.env.GB_PKCE;
    resetConfigCache();
    expect(getConfig().pkce).toBe(false);
    for (const falsy of ["", "0", "false", "no", "off", "banana"]) {
      process.env.GB_PKCE = falsy;
      resetConfigCache();
      expect(getConfig().pkce, `GB_PKCE=${JSON.stringify(falsy)}`).toBe(false);
    }
    for (const truthy of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.GB_PKCE = truthy;
      resetConfigCache();
      expect(getConfig().pkce, `GB_PKCE=${JSON.stringify(truthy)}`).toBe(true);
    }
  });
});

describe("session state", () => {
  it("consumes a CSRF state exactly once and then forgets it", () => {
    const s = newState();
    expect(s).toMatch(/^[a-f0-9]{48}$/);
    expect(consumeState(s)).not.toBeNull();
    expect(consumeState(s)).toBeNull();
    expect(consumeState("never-issued")).toBeNull();
    expect(consumeState(undefined)).toBeNull();
    expect(consumeState(null)).toBeNull();
  });

  it("parks the PKCE verifier with its state and hands it back exactly once", () => {
    const verifier = newCodeVerifier();
    const s = newState(verifier);
    expect(consumeState(s)?.codeVerifier).toBe(verifier);
    // Redeemed: the verifier is gone with the state it came in on, so it can
    // never be replayed against a second code.
    expect(consumeState(s)).toBeNull();
  });

  it("carries no verifier when the flow started without PKCE", () => {
    expect(consumeState(newState())?.codeVerifier).toBeUndefined();
  });

  it("keeps only scalars in the sync metadata", () => {
    markSync(1234);
    markDataAvailable(1_700_000_000_000);
    const meta = getSyncMeta();
    expect(meta.lastSyncBytes).toBe(1234);
    expect(meta.dataAvailableSince).toBe(1_700_000_000_000);
    expect(Object.values(meta).every((v) => typeof v === "number")).toBe(true);
    // Duplicated notifications must not move the marker backwards.
    markDataAvailable(1_600_000_000_000);
    expect(getSyncMeta().dataAvailableSince).toBe(1_700_000_000_000);
  });
});

describe("token file location", () => {
  it("defaults outside the container path shape used on .110", () => {
    delete process.env.GB_CLIENT_ID;
    resetConfigCache();
    const cfg = getConfig();
    // Local dev default is repo-local and gitignored; the deploy overrides it
    // to a host path — see OPERATIONS.md.
    expect(cfg.tokenFile).toBe("./.greenbutton/tokens.json");
  });
});

describe("process identity (x-gb-process)", () => {
  afterEach(() => {
    delete process.env.GB_TOKEN_FILE;
    delete process.env.GB_CLIENT_ID;
    delete process.env.GB_CLIENT_SECRET;
    resetConfigCache();
  });

  it("says `app` for a process nobody pointed at a token file", () => {
    // energy-dashboard gets NO GB_* env at all (docker-compose.yml), so it
    // keeps the in-repo default. It must never claim to be the shim — that
    // claim is what the old per-location header made, and it was wrong in
    // production while the split was inverted (security finding H1).
    delete process.env.GB_TOKEN_FILE;
    resetConfigCache();
    expect(getConfig().tokenFile).toBe("./.greenbutton/tokens.json");
    expect(getProcessIdentity()).toBe("app");
  });

  it("says `shim` from the mounted token file — credentials or not", () => {
    process.env.GB_TOKEN_FILE = "/var/lib/greenbutton/tokens.json";
    resetConfigCache();
    expect(getProcessIdentity()).toBe("shim");
  });

  it("is decided by the token file, not by whether credentials arrived", () => {
    // Both containers report configured:false until Oakville issues the
    // secret, so `configured` cannot tell them apart; only the deployment
    // contract (who was handed the token file) can.
    process.env.GB_TOKEN_FILE = "/var/lib/greenbutton/tokens.json";
    process.env.GB_CLIENT_ID = "cid";
    process.env.GB_CLIENT_SECRET = "super-secret";
    resetConfigCache();
    expect(getConfig().configured).toBe(true);
    expect(getProcessIdentity()).toBe("shim");

    delete process.env.GB_TOKEN_FILE;
    delete process.env.GB_CLIENT_ID;
    delete process.env.GB_CLIENT_SECRET;
    resetConfigCache();
    expect(getConfig().configured).toBe(false);
    expect(getProcessIdentity()).toBe("app");
  });
});
