/**
 * Mock Green Button data custodian — London-Hydro-platform shaped
 * (greenbutton.oakvillehydro.com is the real thing this imitates).
 *
 * Purpose: close the OAuth + ESPI loop end to end without needing Oakville
 * Hydro to have issued credentials yet, so the shim's plumbing is provable
 * before Mark's registration step lands. It is a TEST fixture: no deps, no
 * persistence, single process.
 *
 * Endpoints (the three the real platform exposes):
 *   GET  /oauth/authorize              → 302 back to redirect_uri with code+state
 *   POST /oauth/token                  → code exchange / refresh (client_secret_basic
 *                                        or form-body, like the real one)
 *   GET  /espi/1_1/resource/Batch/…    → Atom feed of IntervalReadings (Bearer-gated)
 *   GET  /espi/1_1/resource/Authorization/… → advertises <resourceURI>
 *
 * Modes the tests flip at runtime: `setRevoked(true)` (refresh + resource
 * both start refusing), `setRotation('always')` (one-time refresh tokens, the
 * savagedata behaviour), `setAsync202(true)` (202 Accepted + notification),
 * `setOmitResourceUri(true)` (token response carries only `authorizationURI`,
 * forcing the ESPI Authorization-resource fallback), `setResourceRejectOnce(true)`
 * (one server-side early 401 on the feed, despite a live `expires_in`),
 * `expireAccessTokens()` (the utility forgets every access token it issued
 * while refresh tokens stay valid), `setAuthorizationFail(true)` (the
 * Authorization resource answers 500), `setAuthorizationRedirect(url)` /
 * `setBatchRedirect(url)` (302 elsewhere — pointing at another origin makes
 * fetch strip the Authorization header on the way, which must never be
 * mistaken for a revoked grant), and PKCE: an authorize request carrying
 * `code_challenge` makes the token endpoint REJECT the exchange unless
 * `code_verifier` hashes back to it (RFC 7636 §4.6), so a dropped verifier
 * fails the loop instead of passing quietly.
 *
 * CLI: `node scripts/mock-custodian.mjs --port 8099 --client-id x --client-secret y`
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const HOUR = 3600;

/** Atom/ESPI document shaped exactly like a utility's CMD batch response. */
export function buildAtomFeed({
  subscriptionUri,
  usagePoints = 1,
  startEpoch,
  intervals = 48,
  intervalSeconds = HOUR,
}) {
  const entries = [];
  for (let u = 0; u < usagePoints; u++) {
    const upId = `usage-point-${u + 1}`;
    const mrId = `meter-reading-${u + 1}`;
    const readings = [];
    for (let i = 0; i < intervals; i++) {
      const start = startEpoch + i * intervalSeconds;
      // Deterministic, obviously-synthetic Wh values (never real data).
      const value = 300 + ((i * 37 + u * 11) % 900);
      readings.push(
        `        <espi:IntervalReading>\n` +
          `          <espi:timePeriod>\n` +
          `            <espi:start>${start}</espi:start>\n` +
          `            <espi:duration>${intervalSeconds}</espi:duration>\n` +
          `          </espi:timePeriod>\n` +
          `          <espi:value>${value}</espi:value>\n` +
          `        </espi:IntervalReading>`,
      );
    }
    // ESPI/Atom shape a utility actually emits: readings are CHILDREN of
    // IntervalBlock, and the entry's self link is what attributes them to a
    // UsagePoint (webapp/src/lib/energy.ts groups on that href).
    entries.push(
      `  <entry>\n` +
        `    <title>${upId} IntervalBlock</title>\n` +
        `    <link rel="self" href="${subscriptionUri}/UsagePoint/${upId}/MeterReading/${mrId}/IntervalBlock/block-${u + 1}"/>\n` +
        `    <link rel="up" href="${subscriptionUri}/UsagePoint/${upId}"/>\n` +
        `    <content type="application/xml">\n` +
        `      <espi:IntervalBlock>\n` +
        `${readings.join('\n')}\n` +
        `      </espi:IntervalBlock>\n` +
        `    </content>\n` +
        `  </entry>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://www.opengis.net/espi/1.0">\n` +
    `  <title>Green Button Customer Energy Usage</title>\n` +
    `  <id>${subscriptionUri}</id>\n` +
    entries.join('\n') +
    `\n</feed>\n`
  );
}

function parseUrlencoded(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function clientAuthMatches(req, body, clientId, clientSecret) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return decoded === `${clientId}:${clientSecret}`;
  }
  return body.client_id === clientId && body.client_secret === clientSecret;
}

/**
 * Start the mock. Returns handles the tests drive.
 */
export async function startMockCustodian(options = {}) {
  const opts = {
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    usagePoints: 1,
    intervals: 48,
    startEpoch: Math.floor(Date.now() / 1000) - 48 * HOUR,
    ...options,
  };

  const state = {
    revoked: false,
    rotation: 'none', // 'always' → new refresh token on every refresh
    async202: false,
    // Token exchange answers WITHOUT `resourceURI` (only `authorizationURI`):
    // forces the client down the ESPI Authorization-resource fallback path.
    omitResourceUri: false,
    // The resource server 401s the FIRST feed request even though the access
    // token is valid per `expires_in` (server-side early expiry).
    resourceRejectOnce: false,
    // The Authorization resource itself is sick (500) no matter the token.
    authorizationFail: false,
    // The Authorization resource 302s elsewhere (cross-origin when the test
    // points it at a second listener — fetch strips Authorization there).
    authorizationRedirect: null,
    // The usage batch 302s elsewhere: same credential-strip hazard on the
    // MAIN data path, not just the pointer fallback.
    batchRedirect: null,
    accessTokens: new Set(),
    refreshTokens: new Map(), // refreshToken → { access }
    codes: new Map(),
    requests: [],
    authStyleSeen: new Set(),
  };

  let seq = 0;
  const nextId = () => `${Date.now().toString(36)}-${(seq += 1)}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    // ---- authorize -----------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const stateParam = url.searchParams.get('state');
      if (clientId !== opts.clientId) {
        res.writeHead(302, { location: `${redirectUri}?error=invalid_client&state=${stateParam ?? ''}` });
        return void res.end();
      }
      const code = `code-${nextId()}`;
      // PKCE: remember what the client challenged with so the exchange can be
      // verified against it (RFC 7636 §4.6). A challenge-less client is
      // still accepted — the real platform's stance is unconfirmed.
      state.codes.set(code, {
        redirectUri,
        scope: url.searchParams.get('scope') ?? '',
        challenge: url.searchParams.get('code_challenge'),
        challengeMethod: url.searchParams.get('code_challenge_method'),
      });
      const sep = redirectUri.includes('?') ? '&' : '?';
      res.writeHead(302, { location: `${redirectUri}${sep}code=${code}&state=${stateParam ?? ''}` });
      return void res.end();
    }

    // ---- token ---------------------------------------------------------
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const raw = await readBody(req);
      const body = parseUrlencoded(raw);
      // Whitelisted fields only — never the client_secret, even in a fixture.
      const logged = state.requests[state.requests.length - 1];
      if (logged && logged.path === url.pathname) {
        logged.body = {
          grant_type: body.grant_type ?? null,
          code_verifier: body.code_verifier ?? null,
          redirect_uri: body.redirect_uri ?? null,
        };
      }
      state.authStyleSeen.add(req.headers.authorization ? 'basic' : 'body');
      if (!clientAuthMatches(req, body, opts.clientId, opts.clientSecret)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'invalid_client' }));
      }

      if (body.grant_type === 'authorization_code') {
        const record = state.codes.get(body.code);
        if (!record || record.redirectUri !== body.redirect_uri) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        // RFC 7636 §4.6: a server that issued a challenge REQUIRES a
        // verifier that hashes back to it. This is the check a strict
        // custodian applies, so the tests fail loudly if the shim ever
        // drops the verifier on the way to the token endpoint.
        if (record.challenge) {
          const derived =
            record.challengeMethod === 'S256' &&
            typeof body.code_verifier === 'string' &&
            body.code_verifier.length >= 43
              ? createHash('sha256').update(body.code_verifier, 'ascii').digest('base64url')
              : '';
          if (derived !== record.challenge) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return void res.end(
              JSON.stringify({ error: 'invalid_grant', error_description: 'pkce_verification_failed' }),
            );
          }
        }
        state.codes.delete(body.code);
        const access = `access-${nextId()}`;
        const refresh = `refresh-${nextId()}`;
        state.accessTokens.add(access);
        state.refreshTokens.set(refresh, { access });
        // ESPI puts the data pointer in the token response; some custodians
        // omit `resourceURI` and only advertise it from the Authorization
        // resource. `omitResourceUri` models that second shape.
        const pointers = state.omitResourceUri
          ? { authorizationURI: '/espi/1_1/resource/Authorization/mock-auth-1' }
          : {
              resourceURI: '/espi/1_1/resource/Batch/Subscription/mock-sub-1',
              authorizationURI: '/espi/1_1/resource/Authorization/mock-auth-1',
            };
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(
          JSON.stringify({
            access_token: access,
            token_type: 'Bearer',
            refresh_token: refresh,
            expires_in: 3600,
            scope: record.scope,
            ...pointers,
          }),
        );
      }

      if (body.grant_type === 'refresh_token') {
        if (state.revoked || !state.refreshTokens.has(body.refresh_token)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        const access = `access-${nextId()}`;
        state.accessTokens.add(access);
        let refresh = body.refresh_token;
        if (state.rotation === 'always') {
          state.refreshTokens.delete(body.refresh_token);
          refresh = `refresh-${nextId()}`;
          state.refreshTokens.set(refresh, { access });
        } else {
          state.refreshTokens.get(refresh).access = access;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(
          JSON.stringify({ access_token: access, token_type: 'Bearer', refresh_token: refresh, expires_in: 3600 }),
        );
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    }

    // ---- ESPI: Authorization resource ----------------------------------
    if (req.method === 'GET' && url.pathname.startsWith('/espi/1_1/resource/Authorization/mock-auth-1')) {
      // The `-landed` twin exists so a redirect knob can point at a real,
      // non-redirecting target: first hop 302s, landing path serves (401
      // when the follow arrived without credentials).
      if (url.pathname === '/espi/1_1/resource/Authorization/mock-auth-1' && state.authorizationRedirect) {
        // Infrastructure-level redirect (an http→https hop or an edge rewrite)
        // arrives BEFORE auth, exactly like a real load balancer's.
        res.writeHead(302, { location: state.authorizationRedirect });
        return void res.end();
      }
      if (url.pathname === '/espi/1_1/resource/Authorization/mock-auth-1' && state.authorizationFail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'server_error' }));
      }
      if (state.revoked || !authorised(req, state)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      return void res.end(
        `<?xml version="1.0"?><Authorization xmlns="http://www.opengis.net/espi/1.0">` +
          `<resourceURI>/espi/1_1/resource/Batch/Subscription/mock-sub-1</resourceURI>` +
          `<customerResourceURI>/espi/1_1/resource/Batch/RetailCustomer/mock-rc-1</customerResourceURI>` +
          `</Authorization>`,
      );
    }

    // ---- ESPI: usage batch ---------------------------------------------
    // Two paths serve the feed: the canonical one (which may 302 when the
    // redirect knob is on) and its `-landed` twin, the non-redirecting
    // target redirect tests point at.
    if (
      req.method === 'GET' &&
      (url.pathname === '/espi/1_1/resource/Batch/Subscription/mock-sub-1' ||
        url.pathname === '/espi/1_1/resource/Batch/Subscription/mock-sub-1-landed')
    ) {
      if (
        url.pathname === '/espi/1_1/resource/Batch/Subscription/mock-sub-1' &&
        state.batchRedirect
      ) {
        res.writeHead(302, { location: state.batchRedirect });
        return void res.end();
      }
      if (state.revoked || !authorised(req, state)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      if (state.resourceRejectOnce) {
        state.resourceRejectOnce = false;
        res.writeHead(401, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      if (state.async202) {
        res.writeHead(202, { 'content-type': 'application/json', 'retry-after': '30' });
        return void res.end(JSON.stringify({ status: 'processing' }));
      }
      const publishedMin = Number(url.searchParams.get('published-min') || 0);
      const start = Math.max(opts.startEpoch, publishedMin || opts.startEpoch);
      const intervals = Math.max(1, Math.ceil((opts.startEpoch + opts.intervals * HOUR - start) / HOUR));
      res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
      return void res.end(
        buildAtomFeed({
          subscriptionUri: 'http://mock/espi/1_1/resource/Batch/Subscription/mock-sub-1',
          usagePoints: opts.usagePoints,
          startEpoch: start,
          intervals: Math.min(intervals, opts.intervals),
        }),
      );
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://${options.host ?? '127.0.0.1'}:${address.port}`;

  return {
    origin,
    authorizeUrl: `${origin}/oauth/authorize`,
    tokenUrl: `${origin}/oauth/token`,
    opts,
    state,
    setRevoked(v) { state.revoked = v; },
    setRotation(v) { state.rotation = v; },
    setAsync202(v) { state.async202 = v; },
    setOmitResourceUri(v) { state.omitResourceUri = v; },
    setResourceRejectOnce(v) { state.resourceRejectOnce = v; },
    // Server-side early expiry: the utility forgets every access token it
    // issued (refresh tokens stay valid) — the client's copy still looks fresh.
    expireAccessTokens() { state.accessTokens.clear(); },
    // The Authorization resource answers 500 regardless of the token.
    setAuthorizationFail(v) { state.authorizationFail = v; },
    // null = serve in place; a URL = 302 the Authorization resource there.
    setAuthorizationRedirect(v) { state.authorizationRedirect = v; },
    // null = serve in place; a URL = 302 the usage batch there.
    setBatchRedirect(v) { state.batchRedirect = v; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function authorised(req, state) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  return state.accessTokens.has(auth.slice(7));
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const mock = await startMockCustodian({
    port: Number(arg('port', 8099)),
    // Default stays loopback: only the containerised topology test asks for a
    // routable interface, because there the client is a shim in ANOTHER
    // container reaching this one over the compose/LAN network.
    host: arg('host', '127.0.0.1'),
    clientId: arg('client-id', 'mock-client-id'),
    clientSecret: arg('client-secret', 'mock-client-secret'),
    usagePoints: Number(arg('usage-points', 1)),
  });
  console.log(`mock custodian listening on ${mock.origin}`);
  console.log(`  authorizeUrl = ${mock.authorizeUrl}`);
  console.log(`  tokenUrl     = ${mock.tokenUrl}`);
  console.log(`  batch        = ${mock.origin}/espi/1_1/resource/Batch/Subscription/mock-sub-1`);
}
