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
 * large or numerous OEB's headers become.
 */

// @vitest-environment node
import { describe, it, expect, afterEach, vi, MockInstance } from 'vitest';

import { GET } from './route';

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

  it('streams the upstream BODY through unchanged', async () => {
    mockUpstream(streamedResponse('<table>FOO</table>', FAT_UPSTREAM_HEADERS));
    const res = await GET(probeRequest());
    await expect(res.text()).resolves.toBe('<table>FOO</table>');
  });

  it('echoes no upstream header except content-type — regardless of size', async () => {
    mockUpstream(streamedResponse('<table>FOO</table>', FAT_UPSTREAM_HEADERS));
    const res = await GET(probeRequest());
    // Headers allows duplicates — walk every pair via forEach.
    const echoed: string[] = [];
    res.headers.forEach((_value, key) => echoed.push(key.toLowerCase()));

    expect(echoed.length).toBeLessThanOrEqual(2);
    expect(echoed, `offending headers echoed: ${JSON.stringify(echoed)}`).toEqual(
      ['cache-control', 'content-type'],
    );
    // The two headers that broke the edge are pinned by name:
    expect(res.headers.has('content-security-policy')).toBe(false);
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
