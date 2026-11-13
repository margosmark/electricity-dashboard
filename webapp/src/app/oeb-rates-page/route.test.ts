/**
 * Pins the /oeb-rates-page transport contract AFTER the rewrite → route
 * handler swap (edge 502 fix, production 2026-10-17).
 *
 * The old transport was a next.config rewrite to www.oeb.ca. A rewrite
 * pass-through means the response carries OEB's OWN upstream headers
 * verbatim — ~5.1 KB, dominated by two Drupal CSP headers (a ~3.7 KB
 * Content-Security-Policy plus a ~0.7 KB legacy X- variant) — and nginx's
 * first-read proxy buffer could not hold them, so every request died as a
 * 502 at the edge. These tests pin the property that fixes it for good:
 * the handler ECHOES NO UPSTREAM HEADER except content-type, no matter how
 * large or numerous OEB's headers become — plus the ONE header this origin
 * asserts itself on this route (the F2 hardening CSP, OEB_ROUTE_CSP), which
 * must be exactly ours and never upstream's.
 */

// @vitest-environment node
import { describe, it, expect, afterEach, vi, MockInstance } from 'vitest';

import { GET, CACHED_MAX_AGE_MS, __resetUpstreamCacheForTests } from './route';
// The hardening policy itself lives in the module src/proxy.ts shares — the
// route and the proxy both assert this one constant (see oebRouteCsp.ts for
// which of the two actually reaches the browser, measured).
import { OEB_ROUTE_CSP } from '@/lib/oebRouteCsp';
// PM fold (t_9991d1f2): the unavailable page's copy and /api/rates must name
// the SAME last-verified date — imported from the one constant both read.
import { GET as ratesGET, RATES_LAST_CHECKED } from '@/app/api/rates/route';

type MockedFetch = MockInstance<typeof fetch>;

const UPSTREAM_URL = 'https://www.oeb.ca/consumer-information-and-protection/electricity-rates';

function streamedResponse(body: string, headers: Record<string, string>, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

function probeRequest(): Request {
  return new Request('http://localhost:3000/oeb-rates-page', {
    headers: {
      'user-agent': 'probe-agent/1',
      accept: 'text/html',
      // The dangerous one is the cookie: a same-origin fetch carries the
      // app's own session, so whatever the transport forwards upstream
      // would receive it. Pin that it is never left in.
      cookie: 'gb_session=probe-secret; other=data',
      authorization: 'Bearer probe-secret',
    },
  });
}

/**
 * A suspiciously fat upstream: today's real OEB header set (2026-10-17,
 * ~5.1 KB) peaked at, so the tests fail the moment ANY of it escapes the
 * handler. A fresh Response per call — the same shared body would be
 * "disturbed" by the first reader.
 */
const FAT_UPSTREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=UTF-8',
  'content-security-policy': `c${'x'.repeat(3700)}`,
  'x-content-security-policy': `y${'x'.repeat(700)}`,
  'x-drupal-dynamic-cache': 'UNCACHEABLE (response policy)',
  'x-request-id': '02098b8a5b7d9485676e3c7485d1b38f',
  'x-generator': 'Drupal 10',
  expires: 'Sun, 19 Nov 1978 05:00:00 GMT',
  'set-cookie': 'oeb_tracking=ted; Domain=.oeb.ca; Max-Age=31536000',
};

describe('/oeb-rates-page transport (route handler)', () => {
  let fetchMock: MockedFetch;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockUpstream(response: Response): void {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  }

  it('fetches the same OEB URL the old rewrite pointed at', async () => {
    mockUpstream(streamedResponse('<table>FOO</table>', FAT_UPSTREAM_HEADERS));
    const res = await GET(probeRequest());
    expect(res.status).toBe(200);
    const [target] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe(UPSTREAM_URL);
  });

  it('passes the upstream BODY through unchanged', async () => {
    mockUpstream(streamedResponse('<table>FOO</table>', FAT_UPSTREAM_HEADERS));
    const res = await GET(probeRequest());
    await expect(res.text()).resolves.toBe('<table>FOO</table>');
  });

  it('echoes no upstream header — and the CSP it answers with is OURS, not oeb.ca’s', async () => {
    mockUpstream(streamedResponse('<table>FOO</table>', FAT_UPSTREAM_HEADERS));
    const res = await GET(probeRequest());
    // Headers allows duplicates — walk every pair via forEach.
    const echoed: string[] = [];
    res.headers.forEach((_value, key) => echoed.push(key.toLowerCase()));

    // Exactly three: the two this route always asserted, plus the F2
    // hardening CSP it now asserts for itself. Sorted, because Headers
    // iterates in insertion order and the SET is the contract.
    expect([...echoed].sort(), `offending headers echoed: ${JSON.stringify(echoed)}`).toEqual(
      ['cache-control', 'content-security-policy', 'content-type'],
    );
    // The upstream CSP (a 3.7 KB Drupal policy, in FAT_UPSTREAM_HEADERS)
    // must never be the one that reaches the browser: the value has to be
    // byte-identical to this route's own.
    expect(res.headers.get('content-security-policy')).toBe(OEB_ROUTE_CSP);
    // The two headers that broke the edge are pinned by name:
    expect(res.headers.has('x-content-security-policy')).toBe(false);
    // An upstream Set-Cookie never survives the swap; the only cache
    // assertion this route makes is its own no-store.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/html; charset=UTF-8');
  });

  it('drops the cookies and credentials it is handed — oeb.ca must never see gb_session', async () => {
    mockUpstream(streamedResponse('<table>FOO</table>', FAT_UPSTREAM_HEADERS));
    await GET(probeRequest());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const forwarded = new Headers(init.headers);
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('authorization')).toBeNull();
    // But keep the browser-ish identity the old transport also sent:
    expect(forwarded.get('user-agent')).toBe('probe-agent/1');
    expect(forwarded.get('accept')).toBe('text/html');
  });

  it('propagates the upstream status for non-200 answers', async () => {
    // Streamed body → the Response constructor adds no default
    // content-type, mirroring a bare upstream with none.
    mockUpstream(streamedResponse('no rates today', {}, 503));
    const res = await GET(probeRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.text()).resolves.toBe('no rates today');
  });

  it('still answers when the upstream sends no content-type at all', async () => {
    mockUpstream(streamedResponse('<!doctype html>', { 'x-drupal-cache': 'HIT' }));
    const res = await GET(probeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-drupal-cache')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.text()).resolves.toBe('<!doctype html>');
  });
});

/**
 * Upstream failure degrades gracefully (production defect 2026-10-24: an
 * OEB-side DNS outage — `getaddrinfo EAI_AGAIN www.oeb.ca` — 500'd every
 * hit on this user-facing path). These tests simulate the DNS failure by
 * rejecting the upstream fetch exactly the way undici does, and pin both
 * accepted degraded shapes: a timestamped saved copy, or an honest empty
 * state. Never a 500, and never a stale schedule presented as current.
 */
describe('/oeb-rates-page upstream DNS failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetUpstreamCacheForTests();
  });

  function dnsFailure(): void {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  }

  function mockUpstream(response: Response): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  }

  it('answers 200 with an honest empty state when there is no cached copy', async () => {
    __resetUpstreamCacheForTests();
    dnsFailure();
    const res = await GET(probeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-oeb-rates-source')).toBe('unavailable');
    const body = await res.text();
    expect(body).toContain('Rate schedule temporarily unavailable');
    expect(body).toContain('cannot be reached right now');
    expect(body).toContain('has not fetched the page recently enough');
    // No rate values at all: the empty state must not look like rates.
    expect(body).not.toMatch(/¢|kWh|off-?peak/i);
  });

  it('names the SAME last-verified date in its copy that /api/rates publishes', async () => {
    // The duplicate-source defect the PM fold (t_9991d1f2) closes: the
    // unavailable page inlined "2026-10-02" while /api/rates read
    // RATES_LAST_CHECKED, so a bump would leave the error page silently
    // lying. Both now import the one constant — and this pin fails if they
    // ever diverge again.
    __resetUpstreamCacheForTests();
    dnsFailure();
    const body = await (await GET(probeRequest())).text();
    const payload = (await (await ratesGET()).json()) as { lastChecked: string };
    expect(payload.lastChecked).toBe(RATES_LAST_CHECKED);
    expect(body).toContain(`were last verified on ${RATES_LAST_CHECKED}.`);
  });

  it('never 500s, however many times the upstream stays unreachable', async () => {
    dnsFailure();
    for (let i = 0; i < 3; i += 1) {
      await expect(GET(probeRequest())).resolves.toSatisfy((res: Response) => res.status === 200);
    }
  });

  it('serves the last-known-good copy with its exact fetch time on the banner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    mockUpstream(
      streamedResponse(
        '<!doctype html><html><head><title>OEB</title></head><body><table>TARIFF</table></body></html>',
        FAT_UPSTREAM_HEADERS,
      ),
    );
    await GET(probeRequest());

    dnsFailure();
    vi.setSystemTime(new Date('2026-10-24T12:05:00.000Z'));
    const res = await GET(probeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('x-oeb-rates-source')).toBe('cached');
    expect(res.headers.get('x-oeb-rates-fetched-at')).toBe('2026-10-24T12:00:00.000Z');
    // Upstream headers still never leak, degraded or not — and the saved
    // copy carries the same hardening CSP as the live path.
    expect(res.headers.get('content-security-policy')).toBe(OEB_ROUTE_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.text();
    // The saved copy still carries the upstream body the staleness check parses…
    expect(body).toContain('<table>TARIFF</table>');
    // …and the banner names itself and its age, so nothing stale reads as current.
    expect(body).toContain('Saved copy.');
    expect(body).toContain('2026-10-24T12:00:00.000Z');
    expect(body).toContain('id="oeb-saved-copy-notice"');
    // Injected at the top of the document, after </head>.
    expect(body.indexOf('oeb-saved-copy-notice')).toBeLessThan(body.indexOf('<table>'));
  });

  it('serves the empty state once the saved copy is older than the max age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    mockUpstream(streamedResponse('<!doctype html><html><body><table>TARIFF</table></body></html>', FAT_UPSTREAM_HEADERS));
    await GET(probeRequest());

    dnsFailure();
    vi.setSystemTime(new Date(Date.parse('2026-10-24T12:00:00.000Z') + CACHED_MAX_AGE_MS + 60_000));
    const res = await GET(probeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('x-oeb-rates-source')).toBe('unavailable');
    const body = await res.text();
    expect(body).toContain('Rate schedule temporarily unavailable');
    expect(body).toContain('2026-10-24T12:00:00.000Z'); // the too-old copy's time, named
    expect(body).not.toContain('<table>TARIFF</table>'); // and not served as rates
  });

  it('does not treat a non-2xx upstream answer as a cacheable copy', async () => {
    mockUpstream(streamedResponse('<html>Service unavailable</html>', {}, 503));
    await GET(probeRequest());
    dnsFailure();
    const res = await GET(probeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-oeb-rates-source')).toBe('unavailable');
    await expect(res.text()).resolves.not.toContain('Service unavailable');
  });
});

/**
 * F2 (security assessment t_0d85b1f8): this route answers text/html on OUR
 * origin, so the bytes are a navigable document — OEB's 4 inline <script>
 * blocks executed same-origin under the app-wide CSP before this fix
 * (`window.a2a_config`/`dataLayer`/`$buoop` were objects after navigation,
 * with this origin's localStorage readable). The control is a response
 * header this route asserts itself, and it has to be on EVERY shape the
 * route can answer, because any of them is a document a browser can be
 * pointed at: live upstream, non-2xx passthrough, the in-process saved
 * copy, and the honest empty state.
 */
describe('/oeb-rates-page hardening CSP (F2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetUpstreamCacheForTests();
  });

  function mockUpstream(response: Response): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  }

  function dnsFailure(): void {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  }

  async function shapes(): Promise<Array<[string, Response]>> {
    const out: Array<[string, Response]> = [];

    mockUpstream(streamedResponse('<table>OK</table>', FAT_UPSTREAM_HEADERS));
    out.push(['live200', await GET(probeRequest())]);

    mockUpstream(streamedResponse('nope', {}, 503));
    out.push(['non-2xx passthrough', await GET(probeRequest())]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'));
    mockUpstream(streamedResponse('<table>OK</table>', FAT_UPSTREAM_HEADERS));
    await GET(probeRequest());
    dnsFailure();
    vi.setSystemTime(new Date('2026-10-24T12:05:00.000Z'));
    out.push(['saved copy', await GET(probeRequest())]);

    vi.useRealTimers();
    __resetUpstreamCacheForTests();
    dnsFailure();
    out.push(['unavailable', await GET(probeRequest())]);

    return out;
  }

  it('carries the sandbox policy on every status it can answer', async () => {
    for (const [label, res] of await shapes()) {
      // Byte-equal to this route's own constant — which is also the proof
      // that the 3.7 KB Drupal policy upstream sent did not ride along.
      expect(res.headers.get('content-security-policy'), label).toBe(OEB_ROUTE_CSP);
    }
  });

  it('names sandbox + default-src none — the two properties the fix rests on', () => {
    // Parsed rather than string-matched so a reformat of the constant cannot
    // silently drop a directive the browser depends on.
    const directives = OEB_ROUTE_CSP.split(';').map((d) => d.trim());
    expect(directives).toContain('sandbox');
    // `sandbox` with no allow-* token: unique origin, no scripts, no forms.
    expect(OEB_ROUTE_CSP).not.toMatch(/allow-/);
    expect(directives).toContain("default-src 'none'");
  });
});
