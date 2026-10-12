# Security review — Ontario Energy Optimizer (electricity-dashboard)

Scope: the deployed app at https://electricity.markarslan.ca/ — a Next.js
frontend that parses **untrusted files in the browser** (Green Button XML from
a utility portal, JSON backups picked from disk) and a service worker that
decides what may be cached. There is no account system and **no server-side
user data** on this branch or in this deployment: readings live only in
`localStorage` — the optional account server that would change this exists as
built-but-unmerged branch code and is parked, and the full state of that is
recorded in one place, [ACCOUNT-SERVER-AUDIT.md](ACCOUNT-SERVER-AUDIT.md).
Alongside it runs the
Green Button Connect My Data shim (`/greenbutton/*`), which holds OAuth
*credentials* — a client secret and one token file — but never a reading.

This checklist is executable: every line marked *(tested)* names the test
that enforces it. Read the test, not just this file.

**How the gate actually runs today (2026-10-12).** The tests are real and
they fail when the property breaks — but the *workflow* is
`.github/workflows/ci.yml`, which is currently `on: workflow_dispatch` only,
because this account's Actions minutes ran out and push/PR runs died in 3-4s
with zero steps executed (billing, not test failures). So enforcement today
is:

```
cd webapp && npm run lint && npm run typecheck && npm run test && npm run build
```

plus the e2e specs in `webapp/tests/e2e/` against a booted server. The husky
pre-commit hook covers lint + typecheck on staged files, not the test suite.
This section used to say "if you change the code under one of them, CI
fails", which was true when the triggers existed and is not true now —
restoring them is one line (`on: [push, pull_request]`) plus
`gh workflow enable CI`.

## 1. Parsing untrusted XML (Green Button / ESPI)

| # | Rule | Status |
|---|---|---|
| 1.1 | The XML parser is a **data** parser (`fast-xml-parser`), never a DOM/HTML parser. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `srcdoc`, `createContextualFragment`, `eval`, `new Function` anywhere in `webapp/src`. | *(tested — source scan)* |
| 1.2 | Feed-derived strings (UsagePoint id, labels, file names) render only through React text nodes / attributes, which escape markup. A feed carrying `<img onerror=…>` shows up as **visible text**. | *(tested — hostile feed rendered through `UsagePointPicker`)* |
| 1.3 | **External entities (XXE) are refused.** `fast-xml-parser` throws `"External entities are not supported"` — no file or network fetch ever happens. | *(tested)* |
| 1.4 | **Entity expansion is bounded.** A billion-laughs document parses to a small object; no megabyte string, no hang. | *(tested)* |
| 1.5 | Non-numeric `<value>` / `<start>` content can never become `NaN` — a single poisoned reading would silently zero every total it touches. Bad readings are dropped, the rest of the file still loads. | *(tested)* |
| 1.6 | Namespace prefixes are stripped before lookup (`removeNSPrefix: true`), so `espi:IntervalReading` and `IntervalReading` behave identically. | *(tested — utility samples)* |

## 2. Parsing untrusted JSON (backup import)

| # | Rule | Status |
|---|---|---|
| 2.1 | The file must carry our `schema` marker **and** an integer `version` this build understands. Anything else is refused with a message that says what was expected. Newer versions are refused, never half-imported. | *(tested — `backup.test.ts`)* |
| 2.2 | **No prototype pollution.** Import copies only whitelisted keys via explicit property reads; `__proto__` / `constructor` / `prototype` payloads in the file are never assigned to anything, and `Object.prototype` is asserted clean afterwards. | *(tested)* |
| 2.3 | Import is **all-or-nothing**: every row and field is validated before the first `localStorage` write, so a rejected file leaves the existing profile byte-identical. | *(tested — `useEnergyData.backup.test.ts`)* |
| 2.4 | Unknown top-level and nested keys are dropped, never carried into app state. | *(tested)* |

## 3. Service worker (cache poisoning / staleness)

The worker (`webapp/public/sw.js`) is executed against hostile synthetic
requests in the test, not merely read:

| # | Rule | Status |
|---|---|---|
| 3.1 | Non-GET requests (`POST/PUT/DELETE/PATCH`) return immediately — `respondWith` is never called, so nothing user-specific can enter a cache. | *(tested)* |
| 3.2 | Cross-origin requests are ignored (`url.origin !== self.location.origin`). | *(tested)* |
| 3.3 | The **only** API path ever intercepted or cached is the exact pathname `/api/rates` (a public, static OEB rate snapshot). `/api/user`, `/api/backup`, `/api/session`, `/api/rates/extra` pass through untouched. | *(tested)* |
| 3.4 | No `importScripts`, no `eval`, no `new Function` — the worker cannot pull remote code. | *(tested)* |
| 3.5 | Cache names are version-prefixed (`oeo-v<N>-…`) so old caches are dropped on activate. | *(tested)* |
| 3.6 | `sw.js` is served `Cache-Control: no-cache, no-store, must-revalidate` (see `next.config.ts`), so a deploy is visible to installed clients. | *(HTTP smoke)* |

Residual note: `/api/rates` is deliberately cached. It contains only OEB
commodity rates — no user input goes to it, and its response is not rendered
as HTML.

## 4. What is out of scope (and why)

- **No accounts, no server-side user rows.** Readings live in
  `localStorage` and are never sent to our server. What the server *does*
  hold is the shim's OAuth token set — one file, mode `0600`, outside the
  container — plus exactly two cookies, both set by `/greenbutton/*` and
  both HttpOnly: `gb_state` (CSRF, 10-minute TTL, single-use) and
  `gb_session` (90-day sliding expiry, a fresh secret minted on every
  successful authorisation). So "no cookies" is no longer true and this
  section no longer claims it; "nothing to enumerate server-side" still is.
  Two honest exceptions to "readings never leave the browser", both
  browser-local and both documented here so nobody has to find them:
  1. **Cache Storage, not just localStorage.** The service worker stages a
     full ESPI feed under `oeo-gb-staged` for periodic sync. That cache is
     deliberately exempt from the version scrub, so it outlives deploys —
     which is why disconnect now deletes it (`useDashboard.ts`, along with
     `oeo-gb-cursor`). A feed staged while the app was closed no longer
     survives the user revoking the authorisation.
  2. **Open-Meteo.** `lib/openMeteo.ts` sends the DATE RANGE covered by the
     user's readings to `archive-api.open-meteo.com` for weather context.
     That is a date range, never readings, and the coordinates are a fixed
     Toronto city centre rather than the premises — but a request does leave
     the browser, so this file should not be read as "nothing is sent".
- **Content-Security-Policy**: set per-response by `webapp/src/proxy.ts`,
  with `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
  `form-action 'self'` and a `connect-src` that names only this origin plus
  the Open-Meteo archive API. It matters more than usual here because
  `/oeb-rates-page` proxies `www.oeb.ca` onto OUR origin: without it, an
  injection on that page is same-origin script with the readings in reach.
  It stops an injected `<script src="https://…">` from any other origin,
  `<object>`/`<base>` hijacks, framing, and exfiltration over `connect-src`
  — all verified in a real browser, not just read from the header.

  **It does NOT stop an inline `<script>` payload, and that is stated here on
  purpose rather than left for someone to discover.** `script-src` carries
  `'unsafe-inline'` because `/`, `/import` and the 404 are prerendered
  (`○ Static`) so a per-request nonce cannot exist: measured against a booted
  production build, a nonce policy left Next's RSC flight payload with
  `nonce="$undefined"` and blocked it — hydration dies, which is worse than
  the gap it closes. (Pinning sha256 hashes instead does not work either: the
  hashes are per-page and per-build — measured, `/` has 5 inline scripts,
  `/import` 6, the 404 5 plus a style — so every deploy changes them and a
  regeneration step would have to be wired into the build.) The inline gap is
  covered by the other half of the same defence: there is no HTML sink to
  inject into, enforced by a source scan that fails on `innerHTML`,
  `dangerouslySetInnerHTML`, `eval` and friends
  (`webapp/src/lib/security.test.tsx`). Policy and scan are one guard each
  for one half of one threat.

  *(tested — `webapp/tests/e2e/csp.spec.ts`, which loads the real production
  build in Chromium. Test 1 requires hydration to complete with ZERO CSP
  violations across the whole session; test 2 injects an external script and
  requires both a `script-src` violation report AND an empty response list.
  Both were checked against a build with the header removed and fail, so
  neither is vacuous.)*
- **Rate limiting**: two `limit_req` zones in
  `ops/edge/default.conf.template` — `gb_strict` (30 r/m, burst 10) on the two
  endpoints that have neither a session nor a state check to fall back on
  (`/greenbutton/start`, which mints a CSRF state on every hit, and
  `/greenbutton/notify/`, which accepts a body nginx admits at 64 MB), and
  `gb_soft` (300 r/m, burst 100) on the rest. The soft number is deliberately
  high: one connect flow makes ~19 of these requests, so a tighter limit would
  throttle the user rather than the attacker — and a limit that fires on the
  user stops being a limit. Before this, the only throttle in the stack was
  the app's own client-side 15-minute refresh interval, which a caller is free
  to ignore. `lib/greenbutton/session.ts` also caps the parked CSRF-state map
  as an in-process backstop for a deployment with no router at all. *(tested —
  `e2e-greenbutton-topology.sh` asserts the strict zone fires AND that the
  soft zone does not, on a run that has just made ~19 legitimate requests.)*
- **Access and error logs**: `ops/edge/default.conf.template` gives every
  location a log format that records `$uri` only — path, no query, no
  `$http_referer`. That matters twice: the OAuth callback's `?code=` and
  `?state=`, and `/import?d=<base64>`, whose payload IS the meter readings.
  The notify path token is further redacted by a dedicated format
  (`/greenbutton/notify/<redacted>`), and the two locations whose URI holds a
  secret raise their own `error_log` to `crit` — nginx error lines carry
  `$request` with the query string, so a tripped rate limit or a proxy failure
  would otherwise write the credential straight back out. *(tested —
  `e2e-greenbutton-topology.sh`: canary query strings, the referer hop, and
  the notify token are each asserted absent from the router log.)*
- **Transport**: TLS via Let's Encrypt at the edge proxy (measured: TLS1.3
  preferred, TLS1.2 ECDHE-GCM only, TLS1.0/1.1 rejected, weak suites
  refused). The edge also 302s http→https — but a redirect is a request,
  not a guarantee, so every https response additionally carries
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin` and `X-Frame-Options: DENY`, set in
  `webapp/next.config.ts` so they ship with the build instead of depending
  on a proxy config we do not control. *(tested —
  `webapp/src/lib/transport-headers.test.ts`)*
- **OAuth / Green Button**: a code is single-use, short-TTL, bound to a
  cookie-checked `state`, and redeemable only with our client secret; the
  `redirect_uri` is built from env on both legs and no client can influence
  it. PKCE (RFC 7636, S256) is implemented and carried end to end — verifier
  parked with the state, challenge on the authorize URL, `code_verifier` on
  the exchange — and is **opt-in** (`GB_PKCE`, default off) until Oakville
  Hydro confirms the London-Hydro platform accepts the parameters. *(tested —
  `oauthFlow.test.ts`)* At the edge, `/greenbutton/*` is logged with
  `log_format gb_noquery` (path only), so the query string of the request
  being logged cannot reach the access log.

  **The `Referer` hop (fixed 2026-10-12).** That format was not actually
  enough. `/greenbutton/callback` answers `302 → https://…/?gb=connected`,
  and that redirect is SAME-ORIGIN, so `strict-origin-when-cross-origin`
  sends the full callback URL — `?code=…&state=…` — as `Referer` on the
  follow-up. The follow-up lands in `location /`, which had no `access_log`
  override and therefore inherited nginx's stock `combined` format (which
  includes `$http_referer`). `gb_noquery` could not help: the leak was a
  header on a *different* request, not a query on the logged one. The fix is
  `add_header Referrer-Policy "no-referrer"` on `location =
  /greenbutton/callback`, which stops the referer being sent at all.
  *(tested — `webapp/scripts/e2e-greenbutton-topology.sh`; the notify path
  token is likewise redacted by a dedicated `gb_notify` format.)*
- **CSV export**: every exported field is a number or a fixed enum label, so
  spreadsheet formula injection (`=cmd|…`) is not reachable from feed content.

## 5. When you change something here

1. Touched the XML parser, the backup import, or `sw.js`? → update the
   matching `*(tested)*` test in the same change.
2. Added a new way to render feed content? → prove it renders as text with a
   hostile payload (copy the `UsagePointPicker` case).
3. Added a new `caches.open` / `cache.put` in the worker? → add it to the
   allow-list assertion in `never caches any API endpoint other than
   /api/rates`.
4. Bumped the backup schema? → add the migration/refusal test next to
   `BACKUP_VERSION`.
5. Changed the headers in `next.config.ts`, `SESSION_MAX_AGE`, or the
   cookie attributes? → `webapp/src/lib/transport-headers.test.ts` pins all
   three; a regression should fail that test, not wait for a reviewer.
6. Touched the authorize / callback / token-exchange leg? →
   `webapp/src/lib/greenbutton/oauthFlow.test.ts` runs the real loop against
   a mock custodian, PKCE included. Extend it rather than asserting the
   shape of a URL by hand.
7. Moved a secret out of git (notify token, token dir, client credentials)? →
   it belongs in the untracked `.env`, and `docker-compose.yml` must fail
   loudly (`${VAR:?…}`) rather than quietly falling back to a default that
   silently changes behaviour.
