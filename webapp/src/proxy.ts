/**
 * `x-gb-process` on every response this app produces.
 *
 * The edge router can say which location matched (`X-Edge-Location`) but not
 * who answered: `greenbutton-shim` and `energy-dashboard` run the same image
 * behind the same nginx, so a location-derived header keeps claiming the split
 * is correct even while the wrong container serves the request — measured in
 * production on 2026-10-07 (security finding H1), where nginx's startup-time
 * upstream cache had inverted the split and `X-Edge-Upstream: shim` was
 * returned by the app container.
 *
 * This proxy runs inside the serving process and labels the response from that
 * process's own config, so the header changes when the container changes and
 * not when the path does. Both directions are then checkable from the public
 * URL with no shell:
 *
 *   curl -sSI .../greenbutton/status  →  x-gb-process: shim  (must pair with
 *                                        X-Edge-Location: greenbutton)
 *   curl -sSI .../                    →  x-gb-process: app   (must pair with
 *                                        X-Edge-Location: default)
 *
 * `greenbutton`+`app` or `default`+`shim` is the inversion, on a header the
 * router cannot forge. See src/lib/greenbutton/config.ts#getProcessIdentity.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getProcessIdentity } from "@/lib/greenbutton/config";

/**
 * Content-Security-Policy.
 *
 * WHY IT IS HERE NOW: this page is the sole custodian of the user's meter
 * readings (`energy_data_v2` in localStorage), and it renders THIRD-PARTY HTML
 * ON ITS OWN ORIGIN — `next.config.ts` rewrites `/oeb-rates-page` straight to
 * `www.oeb.ca`. Anything that can inject markup or script into that OEB page
 * would otherwise execute same-origin, with direct read access to the
 * readings. `X-Frame-Options` does nothing for this: it is not clickjacking,
 * it is same-origin execution. CSP is the control that contains it.
 *
 * WHAT THIS POLICY ACTUALLY BUYS — stated plainly, because it is weaker than
 * the textbook version and pretending otherwise would be worse than having none.
 *
 * It DOES stop, and this is the part that matters for the OEB proxy above:
 *   - `<script src="https://…">` from anywhere but this origin (the measured
 *     case: Chromium reports the directive and never receives a response),
 *   - `<object>` / `<embed>` / `<base href>` hijacks (`object-src`,
 *     `base-uri` both `'none'`),
 *   - framing the app (`frame-ancestors 'none'`, the CSP form of XFO),
 *   - `connect-src` to anywhere but here + Open-Meteo — so an injected page
 *     cannot exfiltrate the readings,
 *   - `img-src` outside this origin / `data:` / `blob:`.
 *
 * It does NOT stop an inline `<script>` payload, because `script-src` carries
 * `'unsafe-inline'`. That is not laziness: `/`, `/import` and the 404 are
 * prerendered, and Next's RSC flight payload is inline — with no nonce able to
 * exist (see below), the only way to permit it is `'unsafe-inline'`.
 *
 * So what actually covers that gap is that this app has NO raw-HTML or
 * code-from-string primitive to reach through: those are absent from
 * `webapp/src` by a source-level test (`lib/security.test.tsx`, which walks
 * every file and fails on any of them — including ones mentioned in
 * comments), and feed-derived strings render only through React text nodes.
 * The policy and that test are one guard each for one half of the same threat.
 *
 * `style-src 'unsafe-inline'` is required by Tailwind v4 and by Recharts'
 * runtime styles; it is not a script surface.
 *
 * WHY THERE IS NO NONCE HERE — measured, not assumed:
 *
 * The textbook Next 16 recipe is a per-request nonce: Next reads one out of
 * the *request* CSP header (`getScriptNonceFromHeader`, consumed at
 * `app-render.js:210`) and stamps it onto its inline bootstrap scripts. That
 * does not work for THIS app. `/`, `/import` and the 404 are all prerendered
 * as static content (`○ (Static)` in the build output), so their HTML is
 * produced at build time when no request — and therefore no nonce — exists.
 * Verified against a real `next start`: the RSC flight payload rendered with
 * `nonce="$undefined"`, and enforcing the nonce-based policy blocked it,
 * which takes hydration (and so the whole app) down.
 *
 * The two ways out were both rejected on evidence:
 *   - Pin sha256 hashes of the inline payloads. The hashes are per-PAGE and
 *     per-BUILD: measured, `/` has 5 inline scripts, `/import` 6, the 404 5
 *     plus a style — so every deploy changes them. Without a regeneration
 *     step wired into the build this silently breaks the site, which is a
 *     footgun that fails at the worst possible time.
 *   - Force the pages dynamic (`export const dynamic = 'force-dynamic'`). That
 *     gives up static prerendering and adds a render per request, against two
 *     Lighthouse performance budgets (desktop ≥ 90, mobile ≥ 85).
 *
 * `'report-only'` is NOT used: a report-only header enforces nothing, and
 * shipping a real one that is verified against a booted production build is
 * stronger than shipping an unenforced suggestion.
 *
 * The one third-party origin the browser talks to is Open-Meteo (date ranges
 * only — see lib/openMeteo.ts). Everything else, including the custodian's ESPI
 * feed, is same-origin via /greenbutton/usage.
 *
 * The OEB rewrite inherits this policy (headers apply on `/:path*`), which is
 * the point: third-party HTML rendered here is then held to `default-src
 * 'self'` and cannot load script, frames or connections from our origin.
 */
function buildCsp(upgradeInsecureRequests: boolean): string {
  return [
    "default-src 'self'",
    // `'unsafe-inline'` is what lets Next's inline RSC payload run — a nonce
    // cannot exist on a prerendered page (see above). An injected
    // `<script src="…">` from another origin is still refused: 'self' does not
    // cover it. What closes the inline gap is the source scan in
    // lib/security.test.tsx — there is no raw-HTML or code-from-string
    // primitive anywhere in this tree for it to reach through.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // Recharts renders tooltip/label markup; data: URIs cover inline images.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://archive-api.open-meteo.com",
    // No <object>/<embed> anywhere in this app — and neither in an attacker's
    // injected markup, which is the point.
    "object-src 'none'",
    "base-uri 'none'",
    // The same guarantee X-Frame-Options gives, expressed in CSP.
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Only for an origin whose TLS we have inventoried (see
    // INVENTORIED_HTTPS_ORIGINS) — never for a surface that serves plaintext.
    ...(upgradeInsecureRequests ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The origins whose TLS is inventoried and handed over — and therefore the
 * ONLY ones that may receive `upgrade-insecure-requests`.
 *
 * The directive rewrites EVERY subresource request to https. On a surface that
 * serves no TLS that is not a hardening, it is a total outage: measured
 * 2026-10-12 on `http://10.10.11.110:3939` — the documented local surface
 * (OPERATIONS.md: "localhost health checks still work at :3939") — the browser
 * upgraded all 15 subresources to `https://10.10.11.110:3939/`, where nothing
 * listens (`curl https://…:3939` = 000; `http` = 200). The page then rendered
 * as HTML with ZERO interactive elements, hydration never ran, and the UI sat
 * on "PREPARING OPTIMIZER…" permanently. CSP took the whole app down.
 *
 * WHY THIS IS A HOST LIST AND NOT `request.url`'s SCHEME — measured, because
 * the first implementation did exactly that and shipped the outage. nginx
 * (`edge-router`, host `:3939`) sets `X-Forwarded-Proto: https` for the whole
 * deployment — it cannot distinguish a request forwarded from the public TLS
 * edge (10.10.11.100) from a direct plaintext LAN hit — so Next resolves
 * `request.url` to `https://` in both cases. Verified from this box: a
 * plaintext request to :3939 that ALSO carried `X-Forwarded-Proto: http` came
 * back `https://`-shaped, so the scheme check always chose the upgrade. The
 * Host header is the one signal that survives the chain: the public name
 * arrives as `electricity.markarslan.ca`, a LAN hit as `10.10.11.110:3939`.
 *
 * Default is OFF. An unknown host means "no TLS inventory", which is the safe
 * direction — a surface nobody has inventoried simply does not get the
 * directive, so it can never be broken by it. Adding an HTTPS origin means
 * adding it here AND to OPERATIONS.md §Public URL.
 *
 * (`electricity.princessandmark.com` resolves to the same host but answers
 * with Traefik's default self-signed cert, so it is NOT in the inventory.)
 *
 * Note the deliberate asymmetry with `Strict-Transport-Security`, which
 * next.config.ts emits on every response: RFC 6797 §8.1 requires a UA to
 * IGNORE an STS header received over non-secure transport, so on the :3939
 * surface it is inert (measured present, and harmless). `upgrade-insecure-
 * requests` has no such rule and acts on the response it arrives with — which
 * is exactly why it is the one that must be scoped.
 */
const INVENTORIED_HTTPS_ORIGINS = new Set(["electricity.markarslan.ca"]);

function isInventoriedHttpsOrigin(request?: NextRequest): boolean {
  // The Host header is authoritative in production (nginx passes the client's
  // Host through). `nextUrl.host` is the fallback: Next derives it from that
  // same header, and a Request built in a test does not always carry an
  // explicit `host` header (it is a forbidden header name in the Fetch spec).
  const host = request?.headers.get("host") || request?.nextUrl?.host || "";
  return INVENTORIED_HTTPS_ORIGINS.has(host.split(":")[0].trim().toLowerCase());
}

export default function proxy(request?: NextRequest): NextResponse {
  const csp = buildCsp(isInventoriedHttpsOrigin(request));
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", csp);
  // Cheap companions that need no nonce work at all.
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("x-gb-process", getProcessIdentity());
  return response;
}

export const config = {
  // Everything that can carry a body someone might read, minus immutable
  // static assets — a cached sw.js/manifest has no container to identify and
  // must not vary by this header.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest).*)"],
};
