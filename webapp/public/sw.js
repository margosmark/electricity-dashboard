/**
 * Ontario Energy Optimizer service worker.
 *
 * Goal: the app is installable and fully usable with no connection. All math
 * is client-side and readings live in localStorage, so the only network
 * dependencies are the HTML shell and /api/rates. (Wave T adds ONE more, and
 * it is optional: the browser's own fetch of historical temperatures from
 * Open-Meteo's CDN for the dates the loaded readings cover — never proxied
 * through this worker, never cached here, and every consumer renders an
 * honest "no data" when it fails.)
 *
 * Strategy:
 *  - install:  precache the shell (HTML + manifest + icons), skipWaiting
 *  - activate: drop caches from older versions, clients.claim so the first
 *              visit is controlled (the page then warms runtime caches)
 *  - fetch:
 *      navigations  -> network first, fall back to cached shell (offline)
 *      /api/rates   -> network first, cache fallback (offline rate math)
 *      immutable    -> cache first: /_next/static, icons, manifest, favicon
 *      /greenbutton/* -> never cached (Wave K: one-shot, stateful, secret)
 *      anything else same-origin -> untouched (browser default)
 *
 * WAVE M — PERIODIC BACKGROUND SYNC:
 *  - `periodicsync` (tag `greenbutton-refresh`) fetches the piped feed using
 *    a cursor the PAGE published into Cache Storage, stages the response, and
 *    messages any open window so it can merge immediately.
 *  - The service worker has NO `localStorage`, so it cannot merge readings,
 *    cannot re-price the three plans and cannot raise the plan-change banner
 *    by itself. Staging + messaging is the honest maximum available; if no
 *    window is open, the staged body is merged the next time one is.
 *  - The loop is only ever REGISTERED by a browser that has authorised live
 *    sync (src/lib/periodicSync.ts), and an unauthorised request 401s into
 *    the `!res.ok` early return — so a manual-upload-only profile does no
 *    background work at all.
 *  - Availability is Chromium-only and installed-app-only; minInterval is a
 *    floor, not a schedule. See src/lib/periodicSync.ts for the citations.
 *
 * UPDATE CONTRACT: scripts/bump-sw-version.mjs rewrites `VERSION` from the
 * `prebuild` npm lifecycle, so every `npm run build` (CI, Docker, deploy)
 * serves a byte-different /sw.js — the browser installs the new worker, and
 * the activate handler below then drops every cache whose name does not start
 * with the new VERSION. The stamp is the build's own millisecond clock, so an
 * identical rebuild still serves new bytes: one precache is cheaper than a
 * shell that might outlive the chunks it names. `src/pwa/swCacheVersionGate.test.ts`
 * runs the whole cycle (two stamps, one storage) on every `npm run test`.
 *
 * IMPORTANT: self.* is used for ALL serviceworker globals so eslint's plain
 * browser env (no `serviceworker` globals declared) stays green.
 */
// CACHE VERSION — stamped by scripts/bump-sw-version.mjs from the `prebuild`
// npm lifecycle, so every `npm run build` (CI, Docker, deploy) serves a
// byte-different /sw.js and installed PWAs re-install + drop old caches.
// 'oeo-v1-local' is the committed placeholder a fresh clone builds with.
const VERSION = 'oeo-v1-local';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    self.caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Every cache from an earlier BUILD dies here: that is what makes
            // a shell cached by a deploy heal instead of pointing at chunks
            // the server no longer ships. The `oeo-gb-` pair (declared below)
            // is STATE, not a build artifact — the refresh cursor and a staged
            // feed waiting for a window to merge it — so a deploy keeps it.
            .filter((key) => !key.startsWith(VERSION) && !key.startsWith('oeo-gb-'))
            .map((key) => self.caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* --------------------------------------------------------------------------
 * Wave M — periodic background refresh of the piped Green Button feed.
 *
 * The names below are mirrored in `src/lib/backgroundRefresh.ts`; a unit test
 * asserts the two files agree, because a drift here would quietly stage every
 * feed where nobody ever looks.
 *
 * These two caches are deliberately NOT named from VERSION: `activate` drops
 * anything that does not start with the current version, and a cursor or a
 * staged feed has to survive a deploy.
 * ------------------------------------------------------------------------ */
const GB_CURSOR_CACHE = 'oeo-gb-cursor';
const GB_STAGED_CACHE = 'oeo-gb-staged';
const GB_CURSOR_URL = '/__gb_cursor';
const GB_STAGED_URL = '/__gb_staged_feed';
const GB_PERIODIC_TAG = 'greenbutton-refresh';

/** Newest timestamp the PAGE already holds — the incremental cursor. */
function gbReadCursor() {
  return self.caches
    .open(GB_CURSOR_CACHE)
    .then((cache) => cache.match(GB_CURSOR_URL))
    .then((res) => (res ? res.text() : null))
    .then((raw) => {
      const value = raw === null ? NaN : parseInt(raw, 10);
      return Number.isFinite(value) && value > 0 ? value : null;
    })
    .catch(() => null);
}

/**
 * Fetch the feed and stage it for a window to merge.
 *
 * Cookie rides along: a same-origin `fetch` defaults to `credentials:
 * 'same-origin'`, and `gb_session` is what authorises the request. An
 * unauthorised or unconfigured browser gets 401/503, which lands in the
 * `!res.ok` early return — this handler never throws, because an unhandled
 * rejection here is a failed `periodicsync` event and a silent console error.
 */
function gbBackgroundRefresh() {
  return gbReadCursor()
    .then((cursor) => {
      const url = new URL('/greenbutton/usage', self.location.origin);
      // One hour of overlap, same as the page's own pull: the newest interval
      // may have been incomplete when it was last seen, and rows are deduped
      // by timestamp anyway.
      if (cursor) url.searchParams.set('publishedMin', String(cursor - 3600));
      return self.fetch(url.toString(), { cache: 'no-store' });
    })
    .then((res) => (res.ok ? res.text() : ''))
    .then((xml) => {
      if (!xml) return null;
      return self.caches
        .open(GB_STAGED_CACHE)
        .then((cache) =>
          cache.put(
            GB_STAGED_URL,
            new Response(xml, { headers: { 'Content-Type': 'application/xml' } }),
          ),
        )
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((clients) => {
          for (const client of clients) client.postMessage({ type: 'gb-staged-feed' });
        });
    })
    .catch(() => {
      /* offline / shim down / grant gone: nothing staged, nothing to report */
    });
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== GB_PERIODIC_TAG) return;
  event.waitUntil(gbBackgroundRefresh());
});

function isImmutableStatic(pathname) {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/favicon.ico' ||
    pathname === '/apple-touch-icon.png'
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Green Button (Wave K): OAuth redirects and the ESPI pipe-through are
  // one-shot and stateful — never cache them, and never let a navigation to
  // the callback overwrite the cached app shell with an error page.
  if (url.pathname.startsWith('/greenbutton/')) return;

  // App shell: try network so deploys show up, cached copy when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            self.caches
              .open(SHELL_CACHE)
              .then((cache) => cache.put('/', copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => self.caches.match('/'))
    );
    return;
  }

  // Rates: network first with cache fallback so offline cost math still works.
  if (url.pathname === '/api/rates') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            self.caches
              .open(RUNTIME_CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => self.caches.match(request))
    );
    return;
  }

  // Hashed build assets + static icons: cache first, populate on miss.
  if (isImmutableStatic(url.pathname)) {
    event.respondWith(
      self.caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            self.caches
              .open(RUNTIME_CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => {});
          }
          return response;
        });
      })
    );
  }

  // Everything else: no handler, browser default.
});
