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
that enforces it — if you change the code under one of them, CI fails. Read
the test, not just this file.

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

- **No accounts, no server-side user rows.** Readings live only in
  `localStorage`; the server never receives them. What the server *does*
  hold is the shim's OAuth token set — one file, mode `0600`, outside the
  container — plus exactly two cookies, both set by `/greenbutton/*` and
  both HttpOnly: `gb_state` (CSRF, 10-minute TTL, single-use) and
  `gb_session` (90-day sliding expiry, a fresh secret minted on every
  successful authorisation). So "no cookies" is no longer true and this
  section no longer claims it; "nothing to enumerate server-side" still is.
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
  `log_format gb_noquery` (path only), so `?code=` and `?state=` never reach
  the access log. *(tested — `webapp/scripts/e2e-greenbutton-topology.sh`)*
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
