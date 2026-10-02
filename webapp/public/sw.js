/**
 * Ontario Energy Optimizer service worker.
 *
 * Goal: the app is installable and fully usable with no connection. All math
 * is client-side and readings live in localStorage, so the only network
 * dependencies are the HTML shell and /api/rates.
 *
 * Strategy:
 *  - install:  precache the shell (HTML + manifest + icons), skipWaiting
 *  - activate: drop caches from older versions, clients.claim so the first
 *              visit is controlled (the page then warms runtime caches)
 *  - fetch:
 *      navigations  -> network first, fall back to cached shell (offline)
 *      /api/rates   -> network first, cache fallback (offline rate math)
 *      immutable    -> cache first: /_next/static, icons, manifest, favicon
 *      anything else same-origin -> untouched (browser default)
 *
 * UPDATE CONTRACT: scripts/bump-sw-version.mjs rewrites `VERSION` from the
 * `prebuild` npm lifecycle, so every `npm run build` (CI, Docker, deploy)
 * serves a byte-different /sw.js — the browser installs the new worker, and
 * the activate handler below then drops every cache whose name does not start
 * with the new VERSION. An unchanged rebuild keeps the same VERSION on purpose:
 * identical sources are an identical artifact and need no re-install.
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
            .filter((key) => !key.startsWith(VERSION))
            .map((key) => self.caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
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
