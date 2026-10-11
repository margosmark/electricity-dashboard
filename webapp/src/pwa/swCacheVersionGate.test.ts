/**
 * Cache-versioning gate — the LOCAL e2e check that a deploy changes the PWA's
 * cache names, so an installed shell heals instead of going stale.
 *
 * The bug class: an installed PWA only re-installs its worker when /sw.js comes
 * back BYTE-DIFFERENT, and a cached HTML shell points at hashed
 * `/_next/static/chunks/*` files that only THIS build shipped. If a deploy
 * fails to change the cache names the browser keeps serving the old shell (and
 * the old chunks) against a server that no longer has them — the stale-chunk
 * failure mode, which no amount of cache-first correctness inside a single
 * build can fix. Waves hand-edit `public/sw.js` for features, so the contract
 * has to be enforced by something that reads the real file, not by review.
 *
 * The contract, then:
 *   1. every build stamps a new VERSION (`scripts/bump-sw-version.mjs`, wired
 *      into `prebuild`, so CI, Docker and the deploy all run it);
 *   2. both cache names are derived from that stamp — shell and runtime retire
 *      together;
 *   3. `activate` drops everything from an earlier build (that is the
 *      self-heal) while keeping the two caches that are STATE, not artifacts.
 *
 * `swVersion.test.ts` pins that shape by grepping. This file EXECUTES the real
 * `public/sw.js` — the exact bytes a deploy serves, stamped by the exact script
 * a deploy runs — twice against one fake CacheStorage, and asserts what a
 * browser would then observe: what is gone, what is served offline, and what
 * must never be served again.
 *
 * Part of the local gate: `npm run test`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WEBAPP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_PATH = path.join(WEBAPP_ROOT, 'public', 'sw.js');
const BUMP_SCRIPT = path.join(WEBAPP_ROOT, 'scripts', 'bump-sw-version.mjs');
const HTTP_SMOKE = path.join(WEBAPP_ROOT, 'tests', 'e2e', 'http_smoke.sh');
const ORIGIN = 'http://localhost:3199';

/** The bytes a fresh clone builds with — a deploy must never serve these. */
const COMMITTED_SOURCE = fs.readFileSync(SW_PATH, 'utf8');

/* --------------------------------------------------------------------------
 * A fake service-worker platform: the slice of the Cache API plus `fetch` that
 * public/sw.js actually touches, enough to run the real file in a vm.
 * `caches.match` walks caches in insertion order, which is what a browser whose
 * older cache was never retired would do — precisely the hazard under test.
 * ----------------------------------------------------------------------- */

type RequestLike = string | { url: string };

const href = (request: RequestLike): string =>
  new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;

class FakeResponse {
  readonly body: string;
  readonly status: number;
  readonly ok: boolean;

  constructor(body = '', init: { status?: number } = {}) {
    this.body = String(body);
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
  }

  clone(): FakeResponse {
    return new FakeResponse(this.body, { status: this.status });
  }

  text(): Promise<string> {
    return Promise.resolve(this.body);
  }
}

class FakeCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly name: string) {}

  put(request: RequestLike, response: FakeResponse): Promise<void> {
    this.entries.set(href(request), response.body);
    return Promise.resolve();
  }

  /**
   * `addAll` is the install-time precache. The body records WHICH cache wrote
   * it — `precached[oeo-v1-<build>-shell]:/` — so a test can tell one build's
   * shell from the next without standing up a real network for it.
   */
  addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      this.entries.set(href(url), `precached[${this.name}]:${href(url)}`);
    }
    return Promise.resolve();
  }

  match(request: RequestLike): Promise<FakeResponse | undefined> {
    const body = this.entries.get(href(request));
    return Promise.resolve(body === undefined ? undefined : new FakeResponse(body));
  }
}

class FakeCacheStorage {
  private readonly caches = new Map<string, FakeCache>();

  open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(name);
      this.caches.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }

  has(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.has(name));
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }

  async match(request: RequestLike): Promise<FakeResponse | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

/* --------------------------------------------------------------------------
 * Booting the real worker
 * ----------------------------------------------------------------------- */

interface SwEvent {
  waitUntil?: (work: Promise<unknown>) => void;
  respondWith?: (response: Promise<unknown>) => void;
  request?: { method: string; url: string; mode: string };
  tag?: string;
}

interface SwProbe {
  VERSION: string;
  SHELL_CACHE: string;
  RUNTIME_CACHE: string;
  SHELL_URLS: string[];
  GB_CURSOR_CACHE: string;
  GB_STAGED_CACHE: string;
  listeners: Record<string, Array<(event: SwEvent) => void>>;
  setOnline: (online: boolean) => void;
}

/** Evaluate `source` (the real public/sw.js, or a mutated copy of it). */
function bootSw(source: string, caches: FakeCacheStorage): SwProbe {
  const listeners: Record<string, Array<(event: SwEvent) => void>> = {};
  let online = true;

  const fetchImpl = (input: RequestLike): Promise<FakeResponse> => {
    const url = href(input);
    if (!online) return Promise.reject(new TypeError(`simulated network failure: ${url}`));
    return Promise.resolve(new FakeResponse(`net:${url}`));
  };

  const sandbox: Record<string, unknown> = {
    URL,
    Response: FakeResponse,
    console,
    fetch: fetchImpl,
    caches,
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    addEventListener: (type: string, listener: (event: SwEvent) => void) => {
      (listeners[type] ??= []).push(listener);
    },
  };

  const context = vm.createContext(sandbox);
  // In a real worker `self` IS the global scope, so bare `fetch(...)` in the
  // fetch handler and `self.caches` have to be the same object here too.
  vm.runInContext('globalThis.self = globalThis;', context);
  vm.runInContext(
    `${source}\n;globalThis.__probe = { VERSION, SHELL_CACHE, RUNTIME_CACHE, SHELL_URLS, GB_CURSOR_CACHE, GB_STAGED_CACHE };`,
    context,
  );

  const raw = sandbox.__probe as Omit<SwProbe, 'listeners' | 'setOnline'> | undefined;
  if (!raw) throw new Error('public/sw.js exposes no VERSION/cache-name declaration');

  return {
    VERSION: raw.VERSION,
    SHELL_CACHE: raw.SHELL_CACHE,
    RUNTIME_CACHE: raw.RUNTIME_CACHE,
    SHELL_URLS: [...raw.SHELL_URLS],
    GB_CURSOR_CACHE: raw.GB_CURSOR_CACHE,
    GB_STAGED_CACHE: raw.GB_STAGED_CACHE,
    listeners,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

/** Fire `install` or `activate` and wait for the work it put in waitUntil. */
async function runLifecycle(probe: SwProbe, type: 'install' | 'activate'): Promise<void> {
  const handlers = probe.listeners[type] ?? [];
  expect(handlers, `sw.js must register exactly one '${type}' handler`).toHaveLength(1);
  let work: Promise<unknown> | undefined;
  handlers[0]({ waitUntil: (pending) => { work = pending; } });
  expect(work, `'${type}' handler must wrap its work in event.waitUntil`).toBeDefined();
  await work;
}

interface Outcome {
  handled: boolean;
  body: string | null;
  error: unknown;
}

/** Fire the fetch handler; `handled:false` means the worker declined the URL. */
async function dispatch(probe: SwProbe, url: string, mode = 'same-origin'): Promise<Outcome> {
  const handlers = probe.listeners.fetch ?? [];
  expect(handlers, `sw.js must register exactly one 'fetch' handler`).toHaveLength(1);
  let responded: Promise<unknown> | undefined;
  handlers[0]({
    request: { method: 'GET', url: href(url), mode },
    respondWith: (pending) => { responded = pending; },
  });
  if (!responded) return { handled: false, body: null, error: null };
  try {
    const response = (await responded) as FakeResponse | undefined;
    return { handled: true, body: response ? await response.text() : null, error: null };
  } catch (error) {
    return { handled: true, body: null, error };
  }
}

/**
 * One deploy: copy the committed sw.js and run the script `prebuild` runs.
 * Two calls are two builds of the same commit — identical sources, so only the
 * stamp can tell them apart, which is exactly the case that has to work.
 */
function stampBuild(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-deploy-'));
  const file = path.join(dir, 'sw.js');
  fs.writeFileSync(file, COMMITTED_SOURCE);
  execFileSync(process.execPath, [BUMP_SCRIPT], { env: { ...process.env, SW_JS_PATH: file } });
  return fs.readFileSync(file, 'utf8');
}

function assertCacheNames(probe: SwProbe): void {
  expect(probe.VERSION).toMatch(/^oeo-v\d+-[a-z0-9]+$/);
  expect(probe.SHELL_CACHE).toBe(`${probe.VERSION}-shell`);
  expect(probe.RUNTIME_CACHE).toBe(`${probe.VERSION}-runtime`);
  expect(probe.SHELL_URLS.length).toBeGreaterThan(0);
  expect(probe.GB_CURSOR_CACHE).toBe('oeo-gb-cursor');
  expect(probe.GB_STAGED_CACHE).toBe('oeo-gb-staged');
}

interface TwoDeploys {
  storage: FakeCacheStorage;
  oldDeploy: SwProbe;
  newDeploy: SwProbe;
  deadChunk: string;
}

/**
 * Deploy A, a visit that warms the caches the way a browser would, then deploy
 * B of the same app. `newDeploySource` swaps in a hand-edited worker so the
 * teeth test can prove this gate actually fails on one.
 */
async function runTwoDeploys(newDeploySource?: string): Promise<TwoDeploys> {
  const storage = new FakeCacheStorage();

  const oldDeploy = bootSw(stampBuild(), storage);
  await runLifecycle(oldDeploy, 'install');
  await runLifecycle(oldDeploy, 'activate');
  await dispatch(oldDeploy, `${ORIGIN}/`, 'navigate');
  // A hashed chunk this build shipped, now sitting in the runtime cache.
  const deadChunk = `${ORIGIN}/_next/static/chunks/app-${'a'.repeat(8)}.js`;
  expect((await dispatch(oldDeploy, deadChunk)).body).toBe(`net:${deadChunk}`);

  // ...and the cross-deploy Green Button state a page publishes.
  await (await storage.open('oeo-gb-cursor')).put('/__gb_cursor', new FakeResponse('1791700000'));
  await (await storage.open('oeo-gb-staged')).put('/__gb_staged_feed', new FakeResponse('<usage/>'));

  const newDeploy = bootSw(newDeploySource ?? stampBuild(), storage);
  await runLifecycle(newDeploy, 'install');
  await runLifecycle(newDeploy, 'activate');

  return { storage, oldDeploy, newDeploy, deadChunk };
}

/** Everything a browser must be able to say about storage after deploy B. */
async function expectDeploySelfHealed({
  storage,
  oldDeploy,
  newDeploy,
  deadChunk,
}: TwoDeploys): Promise<void> {
  // The previous build's artifacts are gone — that is what stops a cached
  // shell from referencing chunks the server no longer ships.
  expect(await storage.has(oldDeploy.SHELL_CACHE)).toBe(false);
  expect(await storage.has(oldDeploy.RUNTIME_CACHE)).toBe(false);
  expect(await storage.match(deadChunk)).toBeUndefined();

  // ...install precached this build's shell...
  expect(await storage.has(newDeploy.SHELL_CACHE)).toBe(true);
  const shell = await (await storage.open(newDeploy.SHELL_CACHE)).match('/');
  expect(shell ? await shell.text() : null).toBe(
    `precached[${newDeploy.SHELL_CACHE}]:${ORIGIN}/`,
  );

  // ...and nothing versioned outside the current VERSION survived the sweep.
  for (const key of await storage.keys()) {
    expect(
      key.startsWith('oeo-gb-') || key.startsWith(newDeploy.VERSION),
      `cache ${key} outlived a deploy outside the current VERSION namespace`,
    ).toBe(true);
  }

  // The two caches that are STATE rather than build artifacts are still there
  // (their contents are pinned by the test below).
  expect(await storage.has(newDeploy.GB_CURSOR_CACHE)).toBe(true);
  expect(await storage.has(newDeploy.GB_STAGED_CACHE)).toBe(true);
}

describe('cache versioning across builds', () => {
  it('serves a byte-different /sw.js on every build', () => {
    const first = stampBuild();
    const second = stampBuild();
    // The committed placeholder must never ship: it means `prebuild` did not
    // run, so CACHE_NAME would be identical to the previous deploy.
    expect(first).not.toBe(COMMITTED_SOURCE);
    expect(second).not.toBe(COMMITTED_SOURCE);
    expect(second).not.toBe(first);
  });

  it('derives both cache names from that stamp, so shell and runtime retire together', () => {
    const first = bootSw(stampBuild(), new FakeCacheStorage());
    const second = bootSw(stampBuild(), new FakeCacheStorage());
    assertCacheNames(first);
    assertCacheNames(second);
    expect(first.SHELL_CACHE).not.toBe(second.SHELL_CACHE);
    expect(first.RUNTIME_CACHE).not.toBe(second.RUNTIME_CACHE);
  });

  it('rejects the un-stamped placeholder in the deploy smoke check', () => {
    const smoke = fs.readFileSync(HTTP_SMOKE, 'utf8');
    // Still checks the per-build marker...
    expect(smoke).toMatch(/oeo-v1-\[a-z0-9\]\+/);
    // ...and now fails a deploy that serves the committed placeholder.
    expect(smoke).toContain("const VERSION = 'oeo-v1-local'");
    expect(smoke).toMatch(/prebuild stamp did not run/);
  });
});

describe('two deploys against one browser', () => {
  it('retires every cache of the previous build and precaches the new shell', async () => {
    await expectDeploySelfHealed(await runTwoDeploys());
  });

  it('keeps the Green Button cursor and staged feed across the deploy', async () => {
    const { storage, newDeploy } = await runTwoDeploys();
    expect(await storage.has(newDeploy.GB_CURSOR_CACHE)).toBe(true);
    expect(await storage.has(newDeploy.GB_STAGED_CACHE)).toBe(true);
    const cursor = await (await storage.open(newDeploy.GB_CURSOR_CACHE)).match('/__gb_cursor');
    expect(cursor ? await cursor.text() : null).toBe('1791700000');
    const staged = await (await storage.open(newDeploy.GB_STAGED_CACHE)).match('/__gb_staged_feed');
    expect(staged ? await staged.text() : null).toBe('<usage/>');
  });

  it('serves the NEW shell offline, never the shell a deploy retired', async () => {
    const { oldDeploy, newDeploy } = await runTwoDeploys();
    newDeploy.setOnline(false);
    const nav = await dispatch(newDeploy, `${ORIGIN}/`, 'navigate');
    expect(nav.handled).toBe(true);
    expect(nav.error).toBeNull();
    expect(nav.body).toBe(`precached[${newDeploy.SHELL_CACHE}]:${ORIGIN}/`);
    expect(nav.body).not.toContain(oldDeploy.SHELL_CACHE);
  });

  it('refreshes the cached shell from the network, and keeps the refreshed copy', async () => {
    const { oldDeploy, storage, newDeploy } = await runTwoDeploys();
    newDeploy.setOnline(true);
    const nav = await dispatch(newDeploy, `${ORIGIN}/`, 'navigate');
    expect(nav.body).toBe(`net:${ORIGIN}/`);
    const cached = await (await storage.open(newDeploy.SHELL_CACHE)).match('/');
    expect(cached ? await cached.text() : null).toBe(`net:${ORIGIN}/`);

    newDeploy.setOnline(false);
    const offline = await dispatch(newDeploy, `${ORIGIN}/`, 'navigate');
    expect(offline.body).toBe(`net:${ORIGIN}/`);
    expect(offline.body).not.toContain(oldDeploy.SHELL_CACHE);
  });

  it('never hands out a chunk from a retired build', async () => {
    const { storage, oldDeploy, newDeploy, deadChunk } = await runTwoDeploys();

    // Offline, with the retired copy gone: the worker refuses rather than
    // serving the previous build's bytes. A dead chunk that nothing in the new
    // shell references is harmless; the stale one served against new HTML is
    // the blank-page bug.
    newDeploy.setOnline(false);
    const offline = await dispatch(newDeploy, deadChunk);
    expect(offline.handled).toBe(true);
    expect(offline.body).toBeNull();
    expect(offline.error).toBeInstanceOf(TypeError);
    expect(await storage.match(deadChunk)).toBeUndefined();

    // Online: the network decides, and what it returns lands in THIS build's
    // runtime cache — the retired one stays retired.
    newDeploy.setOnline(true);
    const online = await dispatch(newDeploy, deadChunk);
    expect(online.body).toBe(`net:${deadChunk}`);
    expect(await storage.has(newDeploy.RUNTIME_CACHE)).toBe(true);
    expect(await storage.has(oldDeploy.RUNTIME_CACHE)).toBe(false);
  });

  it('has teeth: a hand-edit that breaks the contract turns this gate red', async () => {
    // (1) A hand-edit that hardcodes a cache name instead of deriving it from
    // VERSION — the whole premise of this gate.
    const hardcoded = COMMITTED_SOURCE.replace(
      'const SHELL_CACHE = `${VERSION}-shell`;',
      "const SHELL_CACHE = 'oeo-shell';",
    );
    expect(hardcoded).not.toBe(COMMITTED_SOURCE);
    expect(() => assertCacheNames(bootSw(hardcoded, new FakeCacheStorage()))).toThrow();

    // (2) An `activate` that sweeps everything, including the cross-deploy
    // state that the file's own comment says must survive.
    const sweepsState = COMMITTED_SOURCE.replace(" && !key.startsWith('oeo-gb-')", '');
    expect(sweepsState).not.toBe(COMMITTED_SOURCE);
    await expect(expectDeploySelfHealed(await runTwoDeploys(sweepsState))).rejects.toThrow();
  });
});
