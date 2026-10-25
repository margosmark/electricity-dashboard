/**
 * /oeb-rates-page at the APPLICATION HTTP BOUNDARY — real sockets, real
 * header blocks, real bytes.
 *
 * WHY A SECOND SUITE EXISTS BESIDE route.test.ts. The unit suite drives
 * `GET()` directly and inspects the `Response` object it returns. That pins
 * the handler's *decisions*, but the defect this card exists for was a WIRE
 * event: on 2026-10-17 every hop between this app and the browser died as a
 * 502 (`upstream sent too big header`) because the old next.config rewrite
 * passed OEB's ~5 KB Drupal header block straight through to nginx, whose
 * first-read proxy buffer is 4 KB. Whether bytes actually leave a socket, in
 * what size block, and with what status line can only be observed on a
 * socket. This suite therefore puts a real `node:http` server in front of
 * the route handler and reads the answer back with a raw TCP client — the
 * same measurement nginx makes — so "returns 200, not 502" and "the header
 * block is N bytes" are observed facts, not inferences from an object.
 *
 * THE ONE SEAM. The route fetches a hard-coded `https://www.oeb.ca/…` URL,
 * and the fence on this card forbids touching `route.ts`, so global `fetch`
 * is spied to rewrite ONLY the destination origin onto a local fixture
 * server. Nothing else is stubbed: the request bytes leave a real socket,
 * the fixture serves a real ~5.4 KB header block over a real socket, undici
 * parses it for real, and the route's answer travels back over a real socket
 * to the raw reader. Every assertion below is made on bytes read off the
 * wire, and the reader is validated by a canary before it is trusted (first
 * test in this file).
 *
 * WHAT WOULD MAKE THIS SUITE VACUOUS, AND THE GUARDS AGAINST IT:
 *   - A fetch that fails for any reason makes the route degrade to a 200
 *     with `x-oeb-rates-source`, so a bare "status is 200" assertion would
 *     pass even if the oversized-header path were broken. The success test
 *     therefore requires the body to be the upstream body byte-for-byte AND
 *     `x-oeb-rates-source` to be ABSENT — the degraded shapes always set it.
 *   - A reader that could not see a large block would report a small one for
 *     the app too. The canary points the same reader at a real oversized
 *     response and requires the large number.
 *   - An adapter that silently dropped headers would make any response look
 *     small. The canary writes a fat header THROUGH the same adapter, and
 *     every other test asserts headers that must survive (content-type,
 *     cache-control, x-oeb-rates-source) by name.
 *
 * The nginx rig itself is out of scope for this card (approved narrowing,
 * 2026-10-24): this is the app side of that boundary, asserted where it can
 * run inside `npm run test` with no docker.
 */

// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

import { GET, __resetUpstreamCacheForTests } from './route';
import { OEB_RATES_URL } from '@/lib/oebRates';

/* ------------------------------------------------------------------ *
 * The fixture upstream: OEB's Drupal header block, at production size.
 * ------------------------------------------------------------------ */

/**
 * A multi-kilobyte Drupal CSP is mostly a very long media/CDN allowlist, so
 * the two CSP values are BUILT to the sizes measured off www.oeb.ca on
 * 2026-10-17 (route.ts header comment: ~3.7 KB Content-Security-Policy plus
 * a ~0.7 KB legacy X- variant) rather than padded with a filler character.
 */
function cspOfSize(minBytes: number): string {
  const head = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com https://www.youtube.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
  let policy = `${head}; img-src 'self' data: https://static.oeb.ca`;
  let i = 0;
  while (Buffer.byteLength(policy, 'utf8') < minBytes) {
    i += 1;
    policy += ` https://media-${i}.oeb.ca`;
  }
  return policy;
}

/** The header block the fixture upstream serves, exactly as written. */
const UPSTREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=UTF-8',
  'content-security-policy': cspOfSize(3700),
  'x-content-security-policy': cspOfSize(700),
  'x-drupal-dynamic-cache': 'UNCACHEABLE (response policy)',
  'x-drupal-cache': 'MISS',
  'x-request-id': '02098b8a5b7d9485676e3c7485d1b38f',
  'x-generator': 'Drupal 10 (https://www.drupal.org)',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  expires: 'Sun, 19 Nov 1978 05:00:00 GMT',
  'cache-control': 'public, max-age=0, must-revalidate',
  vary: 'Cookie, Accept-Language, Origin',
  'content-language': 'en',
  'set-cookie':
    'SSESSb1c9d4f27a3e5b8c7d6e5f4a3b2c1d0e=AbCdEfGhIjKlMnOpQrStUvWxYz1234567890; expires=Sun, 25-Oct-2026 12:00:00 GMT; path=/; domain=.oeb.ca; secure; HttpOnly; SameSite=Lax',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  link:
    '</sites/default/files/css/css_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.css>; rel=preload; as=style, ' +
    '</sites/default/files/js/js_9f8e7d6c5b4a39281706f5e4d3c2b1a0.js>; rel=preload; as=script',
  server: 'nginx/1.25.3',
  date: 'Fri, 24 Oct 2026 12:00:00 GMT',
};

/** Bytes the header NAMES+VALUES alone occupy (excludes Node's own additions). */
const DECLARED_UPSTREAM_HEADER_BYTES = Buffer.byteLength(
  Object.entries(UPSTREAM_HEADERS)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join(''),
  'utf8',
);

/** The floor this card names: the ~5.3 KB set that 502'd production. */
const OVERSIZED_FLOOR_BYTES = 5300;

/** nginx's default first-read `proxy_buffer_size` — the buffer that overflowed. */
const NGINX_FIRST_READ_BYTES = 4096;

const UPSTREAM_BODY =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Current Rates</title></head>' +
  '<body><h1>Current Rates</h1><table><tr><td>Off-Peak</td><td>8.7 &#162;/kWh</td></tr>' +
  '<tr><td>Mid-Peak</td><td>13.2 &#162;/kWh</td></tr>' +
  '<tr><td>On-Peak</td><td>17.9 &#162;/kWh</td></tr></table></body></html>';

/* ------------------------------------------------------------------ *
 * The raw reader — what nginx does: read the status line plus header block
 * off the socket and measure it before a byte of body is read.
 * ------------------------------------------------------------------ */

type WireResponse = {
  statusLine: string;
  statusCode: number;
  /** Bytes after the status line's CRLF through the terminating CRLF CRLF. */
  headerBlockBytes: number;
  headers: Record<string, string>;
  body: string;
};

function wireGet(port: number, path: string): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let headEnd = -1;
    let expectedBodyBytes: number | null = null;
    let sawEnd = false;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const tryFinish = () => {
      if (settled || headEnd < 0) return;
      const buffered = Buffer.concat(chunks);
      const head = buffered.subarray(0, headEnd + 4);
      const body = buffered.subarray(headEnd + 4);
      const complete = expectedBodyBytes === null ? sawEnd : body.length >= expectedBodyBytes;
      if (!complete) return;

      settled = true;
      socket.destroy();

      const headText = head.toString('latin1');
      const lines = headText.split('\r\n');
      const statusLine = lines[0] ?? '';
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        if (line === '') continue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const statusLineBytes = Buffer.byteLength(statusLine, 'latin1') + 2;
      resolve({
        statusLine,
        statusCode: Number.parseInt(statusLine.split(' ')[1] ?? '', 10),
        headerBlockBytes: head.length - statusLineBytes,
        headers,
        body: body.toString('utf8'),
      });
    };

    socket.setTimeout(10_000, () => fail(new Error(`wire read timed out on port ${port}`)));
    socket.on('error', fail);
    socket.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'User-Agent: wire-probe/1.0',
        'Accept: text/html',
        // Sent on PURPOSE: the transport must not forward it upstream.
        'Cookie: gb_session=wire-secret',
        'Connection: close',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (headEnd < 0) {
        const joined = Buffer.concat(chunks);
        const marker = joined.indexOf('\r\n\r\n');
        if (marker === -1) return;
        headEnd = marker;
        const headText = joined.subarray(0, marker + 4).toString('latin1');
        const contentLength = headText
          .split('\r\n')
          .find((line) => line.toLowerCase().startsWith('content-length:'));
        if (contentLength !== undefined) {
          const parsed = Number.parseInt(
            contentLength.slice(contentLength.indexOf(':') + 1),
            10,
          );
          // A malformed length is "no length known", never "never complete".
          expectedBodyBytes = Number.isNaN(parsed) ? null : parsed;
        }
      }
      tryFinish();
    });
    socket.on('end', () => {
      sawEnd = true;
      tryFinish();
    });
  });
}

/* ------------------------------------------------------------------ *
 * The app side: a real node:http server adapting req → Request → GET().
 * ------------------------------------------------------------------ */

/** Hop-by-hop headers a proxy adapter must not carry into the Request. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'content-length',
]);

type RouteHandler = (request: Request) => Promise<Response>;

/**
 * Boots `handler` behind a real HTTP server. The adapter buffers the body and
 * sets content-length the way Next does for a route response it has fully
 * read, so what the raw reader sees is the shape a proxy would see. It is
 * deliberately dumb: it writes every header the handler returns, oversized or
 * not — the canary test below proves exactly that.
 */
function startServer(handler: RouteHandler): Promise<{ server: Server; port: number }> {
  let port = 0;
  const server = createServer((nodeReq: IncomingMessage, nodeRes) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of nodeReq) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        const payload = Buffer.concat(chunks);

        const headers = new Headers();
        for (const [name, value] of Object.entries(nodeReq.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else headers.set(name, value);
        }

        const method = nodeReq.method ?? 'GET';
        const request = new Request(`http://127.0.0.1:${port}${nodeReq.url ?? '/'}`, {
          method,
          headers,
          ...(payload.length > 0 && method !== 'GET' && method !== 'HEAD' ? { body: payload } : {}),
        });

        const response = await handler(request);
        const body = Buffer.from(await response.arrayBuffer());
        response.headers.forEach((value, name) => nodeRes.setHeader(name, value));
        nodeRes.setHeader('content-length', String(body.byteLength));
        nodeRes.statusCode = response.status;
        nodeRes.end(body);
      } catch (error) {
        // A harness bug must never masquerade as an app answer.
        nodeRes.statusCode = 599;
        nodeRes.end(`harness error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

/** A port that was listening and is now closed — connection refused, for real. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/* ------------------------------------------------------------------ *
 * Fixtures and the single fetch seam.
 * ------------------------------------------------------------------ */

const realFetch = globalThis.fetch.bind(globalThis);

/** Origin the route's upstream fetch is rewritten onto for the current test. */
let upstreamOrigin = '';

/** Requests the fixture upstream actually served (what oeb.ca would see). */
let fixtureHits: Request[] = [];

/** Every request the ROUTE built to send upstream — recorded at the seam. */
let forwardedUpstream: Headers[] = [];

let upstream: { server: Server; port: number };
let app: { server: Server; port: number };
let deadPort: number;

beforeAll(async () => {
  // The fixture answers like www.oeb.ca: the production-sized header block
  // and the rates body the staleness check parses. A direct raw read of THIS
  // server is the oversized stimulus measured in the test below.
  upstream = await startServer(async (request) => {
    fixtureHits.push(request);
    return new Response(UPSTREAM_BODY, { status: 200, headers: UPSTREAM_HEADERS });
  });
  app = await startServer((request) => GET(request));
  deadPort = await closedPort();
  upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
  // Hook budget raised from vitest's 10 s default: this suite runs alongside
  // whatever else the machine is doing, and a starved process must slow down,
  // not fail for a reason that has nothing to do with the contract.
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
});

beforeEach(() => {
  __resetUpstreamCacheForTests();
  fixtureHits = [];
  forwardedUpstream = [];
  // Default target: the live fixture. A test that wants an outage overrides
  // this inside its own body — a failure state must never leak into the next
  // test (that is exactly how a green suite starts lying).
  upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
  // THE seam: destination only. Method, headers, body, sockets and the
  // upstream's oversized header block are all real.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(OEB_RATES_URL) && init?.headers !== undefined) {
        forwardedUpstream.push(new Headers(init.headers));
      }
      const rewritten = url.startsWith(OEB_RATES_URL)
        ? `${upstreamOrigin}${url.slice(OEB_RATES_URL.length)}`
        : url;
      return realFetch(rewritten, init);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Tests.
 * ------------------------------------------------------------------ */

describe('instrument canary — validate the reader before trusting it', () => {
  it('measures an oversized header block when a server really writes one', async () => {
    const fat = `c${'x'.repeat(5000)}`;
    const canary = await startServer(
      async () => new Response('canary', { status: 200, headers: { 'content-security-policy': fat } }),
    );
    try {
      const wire = await wireGet(canary.port, '/');
      expect(wire.statusCode).toBe(200);
      expect(wire.body).toBe('canary');
      // The reader sees the fat header BOTH as a line and as a measured block
      // — and the block it reports is over nginx's first-read buffer, so a
      // reader that silently truncated would fail here rather than report a
      // comfortable number for the app later.
      expect(wire.headers['content-security-policy']).toBe(fat);
      expect(wire.headerBlockBytes).toBeGreaterThanOrEqual(Buffer.byteLength(fat, 'utf8'));
      expect(wire.headerBlockBytes).toBeGreaterThanOrEqual(NGINX_FIRST_READ_BYTES);
    } finally {
      await new Promise<void>((resolve) => canary.server.close(() => resolve()));
    }
    // Time budget: vitest's 5 s default is a CPU-load flake on a shared box,
    // not a signal about sockets. The assertions themselves are the gate.
  }, 15_000);
});

describe('/oeb-rates-page over a real socket', () => {
  it('answers 200 with a small header block when upstream sends ~5.3 KB of headers', async () => {
    // The fixture's own block, measured with the SAME reader: the oversized
    // stimulus is real before the response is judged.
    const stimulus = await wireGet(upstream.port, '/consumer-information-and-protection/electricity-rates');
    expect(stimulus.statusCode).toBe(200);
    expect(DECLARED_UPSTREAM_HEADER_BYTES).toBeGreaterThanOrEqual(OVERSIZED_FLOOR_BYTES);
    expect(stimulus.headerBlockBytes).toBeGreaterThanOrEqual(OVERSIZED_FLOOR_BYTES);
    // In the production order of magnitude — a 40 KB fixture would make every
    // downstream assertion meaningless.
    expect(stimulus.headerBlockBytes).toBeLessThan(NGINX_FIRST_READ_BYTES * 2);
    // That read was served by the fixture too; count only the app's own
    // upstream fetch from here on.
    fixtureHits = [];

    const wire = await wireGet(app.port, '/oeb-rates-page');

    // 1. HTTP 200 on the wire — not 502, not 500, not a degraded stand-in.
    expect(wire.statusLine).toContain(' 200 ');
    expect(wire.statusCode).toBe(200);

    // 2. Not a silent degradation: the route's degraded shapes always label
    //    themselves, and the success path is the one that carries the body.
    expect(wire.headers['x-oeb-rates-source']).toBeUndefined();

    // 3. The body is the upstream body, byte for byte.
    expect(wire.body).toBe(UPSTREAM_BODY);

    // 4. The measured block: what nginx would read first. The number is in
    //    the assertion message, so a future regression quotes real bytes.
    expect(
      wire.headerBlockBytes,
      `app header block was ${wire.headerBlockBytes} B against an upstream block of ` +
        `${stimulus.headerBlockBytes} B (nginx first-read buffer: ${NGINX_FIRST_READ_BYTES} B)`,
    ).toBeLessThan(1024);
    expect(wire.headerBlockBytes).toBeLessThan(stimulus.headerBlockBytes / 4);

    // 5. No single line may approach nginx's first-read buffer either.
    for (const [name, value] of Object.entries(wire.headers)) {
      const lineBytes = Buffer.byteLength(`${name}: ${value}\r\n`, 'utf8');
      expect(
        lineBytes,
        `${name} was ${lineBytes} B — a single line that large is what overflowed the buffer`,
      ).toBeLessThan(NGINX_FIRST_READ_BYTES);
    }

    // 6. The two headers that caused the production 502, by name, plus the
    //    rest of the upstream set that must never be echoed.
    expect(wire.headers['content-security-policy']).toBeUndefined();
    expect(wire.headers['x-content-security-policy']).toBeUndefined();
    expect(wire.headers['set-cookie']).toBeUndefined();
    expect(wire.headers['x-generator']).toBeUndefined();
    expect(wire.headers['x-drupal-dynamic-cache']).toBeUndefined();
    expect(wire.headers.link).toBeUndefined();

    // 7. The headers this origin does assert survive the round trip.
    expect(wire.headers['content-type']).toBe('text/html; charset=UTF-8');
    expect(wire.headers['cache-control']).toBe('no-store');
    expect(Number.parseInt(wire.headers['content-length'] ?? '', 10)).toBe(
      Buffer.byteLength(UPSTREAM_BODY, 'utf8'),
    );

    // 8. The exchange really happened, and the request-side contract holds
    //    over the wire too: user-agent forwarded, cookie/credentials NOT
    //    forwarded — both as the route built it and as the fixture received it.
    expect(forwardedUpstream).toHaveLength(1);
    expect(forwardedUpstream[0]?.get('user-agent')).toBe('wire-probe/1.0');
    expect(forwardedUpstream[0]?.get('accept')).toBe('text/html');
    expect(forwardedUpstream[0]?.get('cookie')).toBeNull();
    expect(forwardedUpstream[0]?.get('authorization')).toBeNull();

    expect(fixtureHits).toHaveLength(1);
    expect(fixtureHits[0]?.headers.get('user-agent')).toBe('wire-probe/1.0');
    expect(fixtureHits[0]?.headers.get('cookie')).toBeNull();
  }, 15_000);

  it('answers 200 with a truthful empty state when the upstream is unreachable', async () => {
    upstreamOrigin = `http://127.0.0.1:${deadPort}`;

    const wire = await wireGet(app.port, '/oeb-rates-page');

    expect(wire.statusCode).toBe(200);
    expect(wire.headers['x-oeb-rates-source']).toBe('unavailable');
    expect(wire.headers['content-type']).toContain('text/html');
    expect(wire.body).toContain('Rate schedule temporarily unavailable');
    expect(wire.body).toContain('cannot be reached right now');
    // Truthful: it claims nothing it does not have — no rate, no period, and
    // none of the upstream body it never received.
    expect(wire.body).not.toMatch(/¢|kWh|off-?peak|mid-?peak|on-?peak/i);
    expect(wire.body).not.toContain(UPSTREAM_BODY);
    // And it never 500s/502s for a third party's outage.
    expect(wire.statusLine).not.toContain(' 500 ');
    expect(wire.statusLine).not.toContain(' 502 ');
    // It TRIED — the route still built the request — and still answered 200.
    expect(forwardedUpstream).toHaveLength(1);
    expect(fixtureHits).toHaveLength(0);
  }, 15_000);

  it('serves the saved copy with its exact fetch time when the upstream later drops', async () => {
    // 1. A good fetch — the in-process last-known-good copy, warmed for real.
    const good = await wireGet(app.port, '/oeb-rates-page');
    expect(good.statusCode).toBe(200);
    expect(good.headers['x-oeb-rates-source']).toBeUndefined();
    expect(good.body).toBe(UPSTREAM_BODY);
    expect(fixtureHits).toHaveLength(1);
    expect(forwardedUpstream).toHaveLength(1);

    // 2. The upstream goes away.
    upstreamOrigin = `http://127.0.0.1:${deadPort}`;
    const wire = await wireGet(app.port, '/oeb-rates-page');

    expect(wire.statusCode).toBe(200);
    expect(wire.headers['x-oeb-rates-source']).toBe('cached');
    const fetchedAt = wire.headers['x-oeb-rates-fetched-at'];
    expect(fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // The upstream document survives with only the banner spliced in after
    // </head>: both halves are still there, byte for byte.
    const splitAt = UPSTREAM_BODY.indexOf('</head>') + '</head>'.length;
    expect(wire.body).toContain(UPSTREAM_BODY.slice(0, splitAt));
    expect(wire.body).toContain(UPSTREAM_BODY.slice(splitAt));
    expect(wire.body).toContain('id="oeb-saved-copy-notice"');
    expect(wire.body).toContain('Saved copy.');
    expect(wire.body).toContain(String(fetchedAt));
    expect(wire.body.indexOf('oeb-saved-copy-notice')).toBeLessThan(
      wire.body.indexOf('<table>'),
    );

    // Degraded or not, upstream headers still never reach the wire.
    expect(wire.headers['content-security-policy']).toBeUndefined();
    expect(wire.headers['set-cookie']).toBeUndefined();
    expect(wire.headers['cache-control']).toBe('no-store');
    expect(
      wire.headerBlockBytes,
      `degraded response header block was ${wire.headerBlockBytes} B`,
    ).toBeLessThan(1024);
  }, 15_000);
});
