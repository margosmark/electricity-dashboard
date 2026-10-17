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
 * this handler never lets the upstream HEADERS through: it streams only the
 * upstream BODY and reissues the tiny set of headers this origin itself
 * asserts (content-type, no-store). The OEB CSP/Drupal headers are dropped
 * here because they carry a policy for the oeb.ca DOCUMENT delivered from
 * oeb.ca — the page is never rendered as a document at this origin; the
 * staleness check reads `res.text()` and parses tables out of it
 * (src/hooks/useRateStaleness.ts). The policy THAT surface needs is this
 * app's own, and src/proxy.ts applies it to this path by matcher.
 *
 * Also deliberately NOT forwarded upstream: the request's `cookie` header.
 * The client fetch is same-origin, so it would otherwise carry the
 * Green Button `gb_session` cookie to oeb.ca — the old rewrite passed
 * whatever the browser sent. `user-agent` IS forwarded (Drupal serves a
 * degraded page to unknown agents; the browser's own value is what the old
 * transport sent too). The former route returned upstream Set-Cookie
 * headers for oeb.ca's domains; this one drops every header but
 * content-type, so a response cannot set or touch cookies at this origin.
 *
 * Still stateless and still nobody's backend: no server state, no caching
 * (`cache: 'no-store'` — GET route handlers do not memoize across deploy
 * boundaries), and every consumer-facing decision still runs client-side
 * in useRateStaleness.ts.
 */

import { OEB_RATES_URL } from '@/lib/oebRates';

/** Pass these through upstream if the browser sent them — nothing else. */
const FORWARDED_REQUEST_HEADERS = ['user-agent', 'accept'] as const;

export async function GET(request: Request): Promise<Response> {
  const upstream = await fetch(OEB_RATES_URL, {
    headers: headersForUpstream(request),
    // Never reuse a cached page across requests: the staleness check is a
    // once-per-session probe, and a stale copy would report rates OEB no
    // longer publishes.
    cache: 'no-store',
    redirect: 'follow',
  });

  const headers = new Headers({ 'cache-control': 'no-store' });
  const contentType = upstream.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);

  return new Response(upstream.body, { status: upstream.status, headers });
}

function headersForUpstream(request: Request): Headers {
  const forwarded = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
}
