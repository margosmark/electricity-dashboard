/**
 * Registers the PWA service worker and warms the runtime caches.
 *
 * Why a component and not an inline <script>: registration must run after
 * hydration in the app's client bundle, and Next's metadata API owns the
 * manifest/theme-color tags (see app/layout.tsx).
 *
 * Behaviour:
 *  - production + browser only (vitest/jsdom and `next dev` never register,
 *    so tests and local dev can't end up behind a stale cached shell)
 *  - after the worker is ready it re-fetches /api/rates so the rate snapshot
 *    is in the runtime cache even if the very first page load raced ahead of
 *    the worker's clients.claim()
 *  - re-warms on controllerchange (a new worker version took over)
 *  - registration failures are swallowed: offline support is progressive
 *    enhancement, the app must work without it.
 */

"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let disposed = false;

    const warmRates = () => {
      // Fires through the controlling worker, whose fetch handler caches it.
      fetch("/api/rates").catch(() => {});
    };

    const onControllerChange = () => warmRates();

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (disposed) return;
        navigator.serviceWorker.ready.then(warmRates).catch(() => {});
        navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
        // Worker already active from a previous visit: registration resolves
        // but `ready` may have fired before our listener; warm once anyway.
        if (registration.active) warmRates();
      })
      .catch(() => { /* no SW = app still fully works online */ });

    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
