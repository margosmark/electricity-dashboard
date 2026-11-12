/**
 * Same-origin transport for the OEB rates page — replaces the former
 * next.config.ts rewrite, which piped the ENTIRE upstream response through
 * (headers included). OEB's own Drupal headers measure ~5.1 KB (measured
 * 2026-10-17: a ~3.7 KB Content-Security-Policy plus a ~0.7 KB
 * X-Content-Security-Policy), and nginx's first-read proxy buffer cannot
 * hold them: `upstream sent too big header` → 502 on every hop between the
 * app and the browser (production, 2026-10-17). Worse, the number changes
 * without notice whenever OEB touches its policy — no header-size tune on
 * the edge can be anything but a dry run against tomorrow's upstream.
 *
 * A Fetch API Response object cannot have its headers emptied in place, so
 * this handler never lets the upstream HEADERS through: it serves only the
 * upstream BODY and reissues the tiny set of headers this origin itself
 * asserts (content-type, no-store, and the hardening CSP below). The OEB
 * CSP/Drupal headers are dropped here because they carry a policy for the
 * oeb.ca DOCUMENT delivered from oeb.ca — a policy we neither control nor
 * want re-pointed at this origin — and because nginx's first-read buffer
 * cannot hold ~5 KB of them (the 502 above).
 *
 * THIS RESPONSE IS A NAVIGABLE DOCUMENT, AND THAT IS THE F2 SURFACE
 * (security assessment t_0d85b1f8, 2026-11-09): `GET /oeb-rates-page`
 * answers `text/html` on this origin, so a browser that NAVIGATES to the
 * URL renders oeb.ca's markup — including its 4 inline <script> blocks —
 * as a same-origin document with read access to this origin's localStorage
 * (`energy_data_v2`, `usage_summaries`). The staleness check itself is
 * harmless (`res.text()` → src/hooks/useRateStaleness.ts), but the same
 * bytes are also a document, and this app-wide CSP does NOT cover that:
 * src/proxy.ts's `script-src` carries `'unsafe-inline'`, so OEB's inline
 * scripts run. Proven in a browser before this fix: after navigating,
 * `window.a2a_config` / `window.dataLayer` / `window.$buoop` were all
 * objects (cross-origin script loading was already blocked — only inline
 * execution was open).
 *
 * So the fix is asserted HERE, on the response itself: every status this
 * route produces (success, non-2xx passthrough, cached copy, unavailable)
 * carries `Content-Security-Policy: sandbox; default-src 'none'` (the
 * shared constant in src/lib/oebRouteCsp.ts). The `sandbox` token with no
 * allow-* flags makes the document a UNIQUE ORIGIN with scripts, forms,
 * plugins and top-level navigation disabled, so an injected payload can
 * neither run nor reach this origin's storage; `default-src 'none'`
 * additionally refuses script/style/img/connect outright.
 *
 * src/proxy.ts asserts the SAME constant for this path, and that layer is
 * the one whose value reaches the browser: measured with curl against a
 * production build (2026-11-09), Next applies the proxy's headers after the
 * route handler's, so a `content-security-policy` set here is REPLACED by
 * the proxy's (`cache-control: no-store` from this same response survived
 * intact; only the CSP name collided). Both layers therefore carry one
 * value: if the proxy's matcher ever stops covering this path, this
 * response's own header is the policy the browser gets.
 * Pinned by route.test.ts (unit: all four shapes) and tests/e2e/csp.spec.ts
 * (browser: an inline probe injected into the served document must NOT
 * execute, with a positive control on `/`).
 *
 * Also deliberately NOT forwarded upstream: the request's `cookie` header.
 * The client fetch is same-origin, so it would otherwise carry the
 * Green Button `gb_session` cookie to oeb.ca — the old rewrite passed
 * whatever the browser sent. `user-agent` IS forwarded (Drupal serves a
 * degraded page to unknown agents; the browser's own value is what the old
 * transport sent too). The former route returned upstream Set-Cookie
 * headers for oeb.ca's domains; this one drops every UPSTREAM header but
 * content-type (the other headers on this response — no-store, the hardening
 * CSP, x-oeb-rates-* — are this origin's own, set below), so a response
 * cannot set or touch cookies at this origin.
 *
 * UPSTREAM FAILURE DEGRADES — IT NEVER 500s (defect seen in production
 * 2026-10-24: an OEB-side DNS outage, `getaddrinfo EAI_AGAIN www.oeb.ca`
 * with SERVFAIL from 8.8.8.8 and 1.1.1.1, turned every hit on this path
 * into a 500 of our own making). A third party's outage is not this
 * origin's error. A thrown `fetch` now answers HTTP 200 with either
 *   (a) the last-known-good body this same process already saw, wrapped in
 *       a plain-language banner that says it is a saved copy and names the
 *       exact time it was fetched (`x-oeb-rates-source: cached`,
 *       `x-oeb-rates-fetched-at`), or
 *   (b) with no usable copy — never fetched, or fetched longer ago than
 *       CACHED_MAX_AGE_MS — an honest empty-state document that says so
 *       and shows no rate as current (`x-oeb-rates-source: unavailable`).
 * The copy lives in process memory and dies with the process: it exists to
 * ride out an upstream outage, not to mirror oeb.ca. A non-2xx upstream
 * answer still passes through with its own status (an answer, however
 * unhelpful, is not a network failure), and the header-echo pin above still
 * governs the success path. Consumer-facing decisions still run client-side
 * in useRateStaleness.ts, which treats both degraded shapes as "no banner".
 */

import { OEB_RATES_URL } from '@/lib/oebRates';
// The hardening policy this route asserts on EVERY response it produces —
// the shared constant in src/lib/oebRouteCsp.ts, which also records the
// measured fact that src/proxy.ts (not this handler) is the layer whose CSP
// reaches the wire. Same constant, both layers, one value.
import { OEB_ROUTE_CSP } from '@/lib/oebRouteCsp';
// The unavailable-page copy names the SAME last-verified date /api/rates
// publishes. Importing the constant (PM fold, t_9991d1f2) keeps one source:
// a bump that changes one and not the other was previously invisible.
import { RATES_LAST_CHECKED } from '@/app/api/rates/route';

/** Pass these through upstream if the browser sent them — nothing else. */
const FORWARDED_REQUEST_HEADERS = ['user-agent', 'accept'] as const;

/**
 * How long a captured copy may still be served during an outage. Beyond
 * this the empty state takes over: a month-old schedule handed out as "the
 * OEB page" is a wrong answer dressed as a right one.
 */
export const CACHED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The last body this process saw come back 2xx from OEB. */
let lastGood: { html: string; contentType: string | null; fetchedAt: number } | null = null;

/** Test seam only — the real cache lives for the life of the process. */
export function __resetUpstreamCacheForTests(): void {
  lastGood = null;
}

export async function GET(request: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(OEB_RATES_URL, {
      headers: headersForUpstream(request),
      // Never reuse a fetched page across requests: the staleness check is a
      // once-per-session probe, and a stale copy would report rates OEB no
      // longer publishes. `no-store` governs the FETCH cache; the in-process
      // last-known-good copy is this route's own degradation fallback and is
      // served only when the upstream cannot be reached at all — and then
      // with its age on display.
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch {
    // TypeError: fetch failed / getaddrinfo EAI_AGAIN: the upstream is
    // unreachable. Degrade; never 500 a user-facing page for someone else's
    // outage.
    return degradedResponse(Date.now());
  }

  const headers = new Headers({
    'cache-control': 'no-store',
    // The F2 control — set FIRST so the header order below stays stable for
    // the route.test.ts pin (Headers iterates in insertion order).
    'content-security-policy': OEB_ROUTE_CSP,
  });
  const contentType = upstream.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);

  if (upstream.ok) {
    // Buffered rather than streamed so this very response can become the
    // last-known-good copy served during a later outage.
    const html = await upstream.text();
    lastGood = { html, contentType, fetchedAt: Date.now() };
    return new Response(html, { status: upstream.status, headers });
  }

  // Non-2xx: an answer, so pass it through untouched (status included).
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** The 200 that stands in for an unreachable upstream. Never stale-silent. */
function degradedResponse(now: number): Response {
  const fresh = lastGood !== null && now - lastGood.fetchedAt <= CACHED_MAX_AGE_MS ? lastGood : null;

  if (fresh === null) {
    return new Response(unavailableDocument(lastGood?.fetchedAt ?? null), {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': OEB_ROUTE_CSP,
        'content-type': 'text/html; charset=UTF-8',
        'x-oeb-rates-source': 'unavailable',
      },
    });
  }

  const fetchedAt = new Date(fresh.fetchedAt).toISOString();
  return new Response(withSavedCopyBanner(fresh.html, fetchedAt), {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': OEB_ROUTE_CSP,
      'content-type': fresh.contentType ?? 'text/html; charset=UTF-8',
      'x-oeb-rates-source': 'cached',
      'x-oeb-rates-fetched-at': fetchedAt,
    },
  });
}

/**
 * The banner is real markup injected right after the upstream `</head>` so
 * it surfaces at the top of the document the browser renders; with no head
 * element to anchor to, prepending still puts it first. It carries an inline
 * `style` — which the route's own hardening CSP (`OEB_ROUTE_CSP`,
 * `default-src 'none'`) REFUSES on a navigation, so a human who opens a
 * degraded copy sees it as plain, unstyled text at the top rather than the
 * amber slab it was drawn as. That is deliberate: the banner's job is to be
 * read, and the slab is not worth reopening a style surface on a
 * third-party document for. It is never rendered by the app itself —
 * useRateStaleness parses the body and treats both degraded shapes as "no
 * banner" — so no styled surface was lost here. No script, no remote asset,
 * in any case.
 */
function withSavedCopyBanner(html: string, fetchedAtIso: string): string {
  const banner =
    '<div id="oeb-saved-copy-notice" role="note" style="' +
    'font:16px/1.5 system-ui,sans-serif;padding:16px;margin:0;' +
    'background:#fef3c7;color:#111;border-bottom:2px solid #b45309;">' +
    '<strong>Saved copy.</strong> The Ontario Energy Board&rsquo;s website is ' +
    'temporarily unreachable, so this is a saved copy of its rate schedule, ' +
    `last updated <time datetime="${fetchedAtIso}">${fetchedAtIso}</time>. ` +
    'It may be out of date — check oeb.ca before relying on it.</div>';

  const headClose = html.search(/<\/head\s*>/i);
  if (headClose === -1) return banner + html;
  const insertAt = headClose + html.slice(headClose).search(/>/) + 1;
  return html.slice(0, insertAt) + banner + html.slice(insertAt);
}

/** Honest empty state: no rates, an explanation, and the last fetch time we know. */
function unavailableDocument(lastFetchedAt: number | null): string {
  const last =
    lastFetchedAt === null
      ? 'This server has not fetched the page recently enough to show a saved copy.'
      : `The last saved copy was fetched at ${new Date(lastFetchedAt).toISOString()} and is too old to show.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rates temporarily unavailable</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;">
<main role="main">
<h1 style="font-size:24px;margin:0 0 12px;">Rate schedule temporarily unavailable</h1>
<p>The Ontario Energy Board&rsquo;s rate schedule (www.oeb.ca) cannot be reached right now,
so this page has nothing to show. ${last}</p>
<p>This dashboard&rsquo;s own shipped rate sets are unaffected — they are published at
<a href="/api/rates">/api/rates</a> and were last verified on ${RATES_LAST_CHECKED}.</p>
</main></body></html>`;
}

function headersForUpstream(request: Request): Headers {
  const forwarded = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
}
