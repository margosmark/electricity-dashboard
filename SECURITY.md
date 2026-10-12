# Security review — Ontario Energy Optimizer (electricity-dashboard)

Scope: the deployed app at https://electricity.markarslan.ca/ — a Next.js
frontend that parses **untrusted files in the browser** (Green Button XML from
a utility portal, JSON backups picked from disk) and a service worker that
decides what may be cached. Readings live in `localStorage`; the process that
serves the public site still holds **no server-side user data and no account
secrets**. Two sidecars run the same image as separate containers so that
stays true, each with its own env block:

- the Green Button Connect My Data shim (`/greenbutton/*`) holds OAuth
  *credentials* — a client secret and one token file — but never a reading;
- the **optional account server** (`/account/*`, Wave N) holds password
  verifiers, session rows, a VAPID key and the user's dataset **as ciphertext
  it cannot read** (§5). It exists only where `ACCT_ENABLED=true` was given to
  that container; everywhere else `/account/*` answers 404.

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

- **The dashboard process has no accounts and no server-side user rows.**
  Readings live only in `localStorage`; the app container never receives them
  and is given no `ACCT_*` env at all (§5). What the *shim* holds is the OAuth
  token set — one file, mode `0600`, outside the container — plus exactly two
  cookies, both set by `/greenbutton/*` and both HttpOnly: `gb_state` (CSRF,
  10-minute TTL, single-use) and `gb_session` (90-day sliding expiry, a fresh
  secret minted on every successful authorisation). The account server adds a
  third, `acct_session`, under the same contract (§5). So "no cookies" is no
  longer true and this section no longer claims it; "the public app process
  holds nothing to enumerate" is.
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

## 5. The account server (Wave N, optional)

Off by default: `ACCT_ENABLED` defaults to `false` on the `account-server`
service and is absent from every other service, so a deploy of this change
leaves the site exactly as it was — enabling it is one line in the untracked
.env` (`OPERATIONS.md` → Account server). Same image, different process,
different env — which is what makes "who am I" an environment read the
container that serves the public site can never fake (see
`lib/account/config.ts`).

| # | Rule | Status |
|---|---|---|
| 5.1 | Every `/account/*` route answers **404** unless this process was given `ACCT_ENABLED=true`. The dashboard container carries no `ACCT_*`, so even if the router sent it an account request it could not serve one: no database path, no session rows, no VAPID key. The 404 is indistinguishable from "no such route", so it never confirms that an account API exists elsewhere. | *(tested — `account.test.ts` "the feature flag", and `tests/e2e/account_smoke.sh --expect-disabled` over HTTP)* |
| 5.2 | Passwords are **argon2id** at a pinned cost; the server stores a verifier and a KDF salt, never the password. An unknown address costs the same work as a real one and returns the same error code as a wrong password — no stopwatch enumeration, no account existence oracle. | *(tested — `account.test.ts`)* |
| 5.3 | The session is the `acct_session` cookie: **HttpOnly, Secure (https origin), SameSite=Lax**, 24-byte random value, 90-day sliding with rotation. The database stores SHA-256 of the token, never the token. Nothing session-shaped is ever written to `localStorage` — the storage allow-list in `AccountControls.test.tsx` fails the moment a new key appears. | *(tested)* |
| 5.4 | **Readings are encrypted in the browser before upload**: PBKDF2-HMAC-SHA256, 600 000 iterations over a per-user salt → AES-GCM with a fresh 96-bit IV per blob. The server keeps only ciphertext plus a *different* KDF's login verifier, so the two are not interchangeable. A wrong key yields nothing readable — no partial, no plausible. | *(tested — `crypto.test.ts`)* |
| 5.5 | **Residual risk, stated rather than glossed:** an attacker who steals the account database *and* cracks a weak password can derive the blob key too, because the KDF salt is in the same database. E2EE turns a bulk breach into a per-user costly crack; it does not survive weak-password-plus-DB-theft. The mitigations are exactly the ones above: memory-hard verifier, 600k-iteration derivation, and the password never printed, logged or echoed. | *(design; enforced by 5.2/5.4)* |
| 5.6 | The derived key is cached in `localStorage` (`account_blob_key`) so sync survives reloads — the trade is written out in `lib/account/sync.ts`. It never travels to the server (uploads carry ciphertext) and using it still requires the HttpOnly cookie; logout wipes it together with the dataset. | *(tested — `sync.test.ts`)* |
| 5.7 | **Data-loss floor.** Sign-out ends the server session *first* and only then wipes this browser, and it refuses to wipe when the local changes never reached the server. A failed sign-out cannot destroy data; unsynced local data is never discarded. | *(tested — `AccountControls.test.tsx`)* |
| 5.8 | Uploads are explicit: a device that already has data and an empty account is **prompted**, never silently uploaded (and the drawer stays open until it is answered); a stale `baseRev` comes back 409 and becomes a choice instead of an overwrite. The body read is capped at 5 MB. | *(tested — `AccountControls.test.tsx`, `account.test.ts`)* |
| 5.9 | The shim→account fan-out lives at `/account/internal/*`, which nginx `deny all`s before any upstream; it exists only on the compose network and still requires the shared `ACCT_INTERNAL_TOKEN`. | *(config — see `ops/edge/default.conf.template`; the containerised topology gate is `webapp/scripts/e2e-greenbutton-topology.sh`)* |
| 5.10 | Push is opt-in per device and per topic: `Notification.requestPermission()` only after a user gesture; the worker renders the server's title/body as notification text and **never follows a cross-origin URL** carried in a payload; sends are capped per topic, per day, and in quiet hours, with every send logged. | *(tested — `security.test.tsx`, `account.test.ts`)* |
| 5.11 | **A client-origin notification reaches its own account only.** `POST /account/notify` passes the session's account id as an explicit `NotifyTarget`; `fanOut` cannot be called without naming a target, and `{ scope: "all" }` is reachable only from the internal, edge-denied route and the rate watcher. A browser may also emit only `plan_change`/`anomaly` — never the server's topics. | *(tested — `account.test.ts` "session-authed notify", two accounts)* |
| 5.12 | **The three unauthenticated endpoints have an attempt budget** (`login`, `recover`, `register`): a token bucket per e-mail address, per source address and process-wide, checked *before* the argon2 work and answered as 429 + `Retry-After`. A correct password hands the address bucket back. | *(tested — `ratelimit.test.ts`, `account.test.ts`)* |
| 5.13 | **A push endpoint is not a credential and not a secret**, so it is bound to the account that registered it: presenting an endpoint another account already owns is 409, and the SQL refuses to re-point it (`upsertSubscription`). | *(tested — `account.test.ts`)* |

### What a notification may carry (the trade, written out)

The card and the PM ruling both required this to be stated rather than
assumed, and round 1 of the review found it implied instead:

- **The server never sees the dataset.** No readings, no series, no total it
  computed itself — `energy_data` is ciphertext end to end (5.4).
- **A client-origin notification is text the user's own device wrote.** For
  `anomaly` / `plan_change` the browser composes a title and one sentence
  (which may say *"42 kWh, about 2.3x the usual"*) and asks the server to
  relay it, because under E2EE the server cannot compute it. The server sees
  topic, title and body **in flight**, and stores topic + title + outcome in
  `notify_log` — a title can therefore encode a coarse usage-derived fact
  ("Unusual usage on 3 Oct"). That is one line per event for a topic the
  user can turn off; it is a verdict, never a reading.
- **A server-origin notification is built from public state** (the app's
  rate payload, the shim's scalars) and touches no user data at all.
- **The rejected alternative:** strip every figure so nothing derived from
  usage crosses at all. Rejected because a date is already usage-derived and
  a push that says "something is wrong" without saying what is a worse
  promise than an honest one. The boundary above is the replacement for the
  silence.

### Attempt budget, and what is NOT counted on

`POST /account/login`, `/account/recover` and `/account/register` refuse
after a bounded number of attempts (`lib/account/ratelimit.ts`: token
buckets per e-mail address, per source address, and process-wide; 429 with
`Retry-After`), and the check runs *before* the 17 ms argon2 hash so a loop
is refused rather than served. Counters live in the account-server process
(a single Node process); a restart clears them, which costs an attacker
nothing they can use and costs a legitimate user nothing at all.

**The Pangolin PIN gate is not part of this.** Measured from the public
internet on 2026-10-07 with no cookies: `GET /` answered `200` directly
(`x-edge-location: default`, `x-gb-process: app`), with no challenge, no
redirect and no interstitial, and `/account/*` reached the same nginx the
rest of the site uses. Whatever PIN gate exists is not observable from
outside, so `/account/*` must be treated as the only lock. If that changes,
re-measure and amend this paragraph rather than deleting it.

**`ACCT_MAX_ACCOUNTS` squatting** is bounded by three things: the cap itself
(default 10), the per-source registration budget above, and the fact that
every account row carries the e-mail address it was made with. An operator
undoes a squat with one statement — `OPERATIONS.md` → *Removing an account* —
which cascades to sessions, blobs, subscriptions and preferences.

### Residual: a push endpoint is an outbound URL we call

Subscriptions are `https:` (or `webpush:`) URLs, so an authenticated user
can make the account container `POST` to an arbitrary HTTPS address — blind,
body capped at the payload size, rate-capped by the notification policy, and
unable to reach `file:`, `http://169.254…` or any docker-internal service
(`validEndpoint` rejects every non-HTTPS scheme). We accept this: it is the
Web Push protocol as designed, and the fix that would remove it (a
push-service host allow-list) breaks self-hosted push services for no gain
at family scale. It is recorded here so nobody has to rediscover it.

## 6. When you change something here

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
8. Added or changed an `/account/*` route? → it must go through
   `requireEnabled()` / `rejectCrossOrigin()` / `requireSession()` in
   `lib/account/http.ts` (the feature-flag test asserts the 404), read its
   secrets only from `lib/account/config.ts`, and land a case in
   `webapp/tests/e2e/account_smoke.sh` — that gate runs against a booted
   container in CI, in both the feature-off and feature-on states.
9. Added a notification topic, or changed who may emit one? → it belongs in
   `CLIENT_NOTIFY_TOPICS` or `SERVER_NOTIFY_TOPICS` (`lib/account/db.ts`),
   both `notify/route.ts` guards, `push.ts#NotifyTarget`, and the §5
   "what a notification may carry" paragraph above. A topic that reaches a
   route which is not allowed to emit it must fail a test, not a review.
10. Changed a session-affecting route? → only `GET /account/session` may ask
   `requireSession()` to rotate; every other route must keep the default, or
   it will mint a token nobody sets as a cookie (§5 note, round-1 L1).
