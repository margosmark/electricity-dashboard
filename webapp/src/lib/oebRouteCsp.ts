/**
 * The OEB proxy route's identity and the response policy that route MUST
 * answer with — one module so the two layers that set a CSP for this path
 * cannot drift apart (src/proxy.ts and src/app/oeb-rates-page/route.ts).
 *
 * WHY THE POLICY LIVES HERE AND NOT ONLY IN THE ROUTE — measured, not
 * assumed (curl against a production `next start` build, 2026-11-09):
 * `src/proxy.ts` sets `Content-Security-Policy` on every matched response,
 * and Next applies the proxy's headers AFTER the route handler's, so the
 * route's own value for that name never reaches the browser — the wire
 * carried only the app-wide policy (`script-src 'self' 'unsafe-inline'`),
 * with `cache-control: no-store` from the same route present and intact.
 * Route-level headers survive for every OTHER name; CSP is the one the
 * proxy overwrites. So the proxy must set THIS value for this path, and the
 * route asserts the same constant as its own belt: whichever layer wins,
 * the browser gets `OEB_ROUTE_CSP`.
 *
 * WHAT IT IS FOR — F2 (security assessment t_0d85b1f8, 2026-11-09): this
 * route serves www.oeb.ca's HTML as a NAVIGABLE DOCUMENT on this origin.
 * The app-wide policy permits inline script by design (Next's prerendered
 * pages need 'unsafe-inline'), so before the fix OEB's 4 inline <script>
 * blocks executed here with this origin's localStorage in reach — browser
 * proven: `window.a2a_config` / `window.dataLayer` / `window.$buoop` were
 * all objects after navigating. `sandbox` with no allow-* token makes the
 * document a unique origin with scripts/forms/plugins disabled, and
 * `default-src 'none'` refuses script, style, image, font and connections
 * outright — an injected payload can neither run nor read or write this
 * origin's storage.
 *
 * CSP headers compose by INTERSECTION (every policy on a response must be
 * satisfied), so if a second policy ever rides along it can only narrow
 * this one — never widen it.
 */

/**
 * Same-origin route handler that proxies the OEB page (CORS-free transport).
 *
 * Moved here from src/lib/oebRates.ts when the proxy layer needed it too;
 * that module re-exports it, so every existing import path still works.
 */
export const OEB_RATES_PROXY_PATH = '/oeb-rates-page';

/**
 * The hardening policy for the OEB proxy response, on every status that
 * route can answer (live upstream, non-2xx passthrough, the in-process
 * saved copy, the honest empty state) — any of them is a document a browser
 * can be pointed at. Pinned by route.test.ts (all four shapes) and
 * tests/e2e/csp.spec.ts (the browser refuses an injected inline script
 * there, with the same probe as a positive control on `/`).
 */
export const OEB_ROUTE_CSP = "sandbox; default-src 'none'";
