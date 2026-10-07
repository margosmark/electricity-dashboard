# Green Button Connect My Data (CMD) — Wave K

Live auto-refresh of Oakville Hydro interval data through the sanctioned
**Connect My Data** OAuth2 channel, with the same zero-data-at-rest design the
manual upload path has always had.

DMD (download-my-data) file drops become optional: authorise once, and the
dashboard pulls fresh ESPI on its own.

**Relationship to Wave J:** `ops/dmd/` drives Oakville Hydro's *web UI* with
Playwright and hands a base64 export to `/import`. That was the best available
path before a sanctioned API existed; CMD replaces it with an OAuth grant, so
once the production loop in §6 is closed the DMD refresh, its portal
credentials and the `/import` paste step can be retired (keep
`/import` — it is still the merge-gated entry point for any file a human
hands over). Both paths write through Wave J's `importPlan.mergeForWrite`, so
they agree on what a merge means.

---

## 1. Status

| Gate | State |
| --- | --- |
| Shim built, OAuth loop closes, feed pipes into localStorage | **DONE — verified** (602 unit/integration tests + `webapp/scripts/e2e-greenbutton-loop.sh`, 29/29 checks against a live `next start` + mock custodian) |
| Shim deployed as its **own container** under `/greenbutton/*` | **DONE — verified** (three containers behind `:3939`; `webapp/scripts/e2e-greenbutton-topology.sh` runs the whole loop through the router: 42/42; see §5) |
| Edge routes `/greenbutton/*` to this host | **DONE — verified empirically** (the edge forwards *every* path to `:3939`, so the split is made on-box; see §5) |
| Oakville Hydro third-party registration | **BLOCKED on Mark** — needs his name + signature on their form (§6) |
| Production loop with Mark's real account | **BLOCKED on §6** |
| Merge semantics shared with Wave J's `/import` | **DONE** — both write through `importPlan.mergeForWrite` (union, incoming wins) |
| Revocation detection from Oakville's own UI | Code + tests done; needs a live account to observe for real |
| Browser connect flow (button → authorize → callback → localStorage) | **DONE — verified in a real browser** (`webapp/scripts/e2e-greenbutton-browser.sh`: the whole Playwright suite — 22/22 — against a *configured* shim, incl. an assertion that no token material is left in browser storage and that `/import` still works with the feature switched on) |
| Operational runbook | DONE (OPERATIONS.md §Green Button) |

Nothing about the feature is switched on until Oakville issues credentials:
`/greenbutton/status` reports `configured: false`, the toolbar renders no
button, and the upload dialog says so in plain language.

Once configured, the control reports exactly three states — surfaced as
`data-gb-state` on its root so tests assert the state machine, not wording:

| State | Toolbar | Meaning |
| --- | --- | --- |
| `disconnected` | **Authorise with Oakville Hydro** | this browser holds no grant |
| `authorised` | **Authorised** | the shim holds a grant; nothing piped yet |
| `synced` | **Live** (+ "Synced … · N KB") | a feed has been piped and ingested |

The state moves `authorised → synced` without a reload: a successful pull
re-reads `/greenbutton/status`, which is what stamps `lastSyncAt`. Disconnect
(the plug button, with a confirmation) wipes the token file on the host and
returns to `disconnected`; it never touches `localStorage.energy_data`.

---

## 2. What the flow looks like

```
browser                    shim (in the app container)              Oakville Hydro
  |                              |                                        |
  | GET /greenbutton/start       |                                        |
  |----------------------------->| new CSRF state (memory + cookie)       |
  |            302               |-------------------------------------->|
  |<-----------------------------|                                        |
  |                                   … customer signs in on their page … |
  | GET /greenbutton/callback?code&state                                   |
  |----------------------------->| state vs cookie + single-use store     |
  |                              | POST /oauth/token (client_secret_basic)|
  |                              |-------------------------------------->|
  |                              | access + refresh + resourceURI         |
  |                              |<---------------------------------------|
  |                              | save token set → file, mode 0600       |
  |            302 /?gb=connected + gb_session cookie                    |
  |<-----------------------------|                                        |
  | GET /greenbutton/usage  (gb_session cookie)                           |
  |----------------------------->| refresh if stale (persist rotation)    |
  |                              | GET <subscriptionUri> Bearer token     |
  |                              |-------------------------------------->|
  |                              |<--- Atom/ESPI, streamed byte-for-byte  |
  |<-----------------------------|                                        |
  | parseGreenButtonUsagePoints()  → merge → localStorage.energy_data     |
```

The shim is six route handlers from the existing Next.js app running in
**its own container** (`greenbutton-shim`), reached only through a local nginx
path router (`edge-router`) that owns host `:3939`:

```
edge-router :3939 ─┬─ /greenbutton*  → greenbutton-shim   (client secret + token mount)
                   └─ everything else → energy-dashboard  (no GB_* env at all)
```

Same code, same image, same domain and certificate — different process, and
the only one that holds OAuth credentials. See §5 for how the split is
proven from the outside.

| Route | Purpose |
| --- | --- |
| `GET /greenbutton/status` | configured / connected / last-sync metadata (scalars only — never the notification URI) |
| `GET /greenbutton/start` | CSRF state → 302 to the custodian's authorize URL |
| `GET /greenbutton/callback` | code exchange, token set → disk, session cookie → app |
| `GET /greenbutton/usage` | **the pipe-through**: ESPI streamed straight to the browser |
| `POST /greenbutton/notify/[token]` | utility's "data changed" webhook; records a timestamp only |
| `POST /greenbutton/disconnect` | wipe the token file + expire the cookie |

Implementation lives in `webapp/src/lib/greenbutton/` (config, oauth, espi,
sync, tokens, session, http) and `webapp/src/app/greenbutton/`.

---

## 3. Where the refresh token lives

**Exactly one place:** a JSON file on .110, outside the container, mode `0600`.

```
host:        /home/hermes/.greenbutton-shim/tokens.json
in container: /var/lib/greenbutton/tokens.json   (bind mount, GB_TOKEN_FILE)
inspect:     sudo ls -l /home/hermes/.greenbutton-shim
```

The host path is `GB_TOKEN_DIR`, pinned in the **untracked `.env`** — never
in `docker-compose.yml`. It sits outside the git worktree on purpose: no
clone, no `git clean -xfd`, no `git add -A` can reach a live refresh token.

It is never:

- in the browser (the browser holds an HttpOnly `gb_session` cookie that
  unlocks *this* service and nothing else — it is not an OAuth credential),
- in a commit (the `.env` and `.greenbutton/` are both gitignored),
- in a log (the edge logs the `/greenbutton/*` **path only** — `log_format
  gb_noquery` drops the query string, so `?code=` never lands anywhere),
- anywhere but the token set itself.

The file's key set is pinned by tests (`PERSISTED_KEYS` in
`webapp/src/lib/greenbutton/tokens.ts`): `accessToken`, `refreshToken`,
`expiresAt`, `scope`, `subscriptionUri`, `authorizationUri`, `sessionToken`,
`obtainedAt`. A test writes a token set and fails if any other key — a
reading, an interval, an XML fragment — ever appears. **That is the
zero-data-at-rest invariant, enforced rather than asserted.**

If the mount is unwritable the store degrades to memory-only, keeps working
for the life of the process, and `/greenbutton/status` reports
`tokenPersistence: "memory"` so the degradation is visible instead of silent.

Refresh tokens are rotated safely: a rotated value is written to disk *before*
the response is returned, so a one-time refresh token (the savagedata
behaviour) can never be burned and lost. Oakville Hydro runs the London Hydro
platform, which does not rotate today — the code handles it anyway, and a test
proves it.

---

## 4. Security model

| Threat | Control |
| --- | --- |
| Someone reads Mark's meter data off the public URL | every data-bearing route requires the `gb_session` cookie minted only by completing the OAuth flow; no cookie → `401 session_required`. Cross-site requests are also refused (`Origin` check). |
| The shim becomes an authenticated SSRF gadget | the base ESPI URI comes from the token file, never from the request; callers may only pass a *relative* suffix matched against `[A-Za-z][A-Za-z0-9]{0,31}(/…){0,3}` — no scheme, no host, no `..`, no query, no percent-encoding. |
| CSRF on the callback | single-use state in memory (10 min TTL) **and** an HttpOnly cookie; both must match. |
| Someone completing a flow with their own Oakville account | they would only ever store *their own* tokens; the event is logged loudly (`token set replaced by a browser without a session`). Residual nuisance, not a data exposure. |
| Garbage POSTs to the notify URI | unguessable path token derived from the client secret (`sha256("greenbutton-notify:"+secret)[:32]`); unknown token → 404. |
| Token endpoint failures mis-classified | `invalid_client` (401) → operator problem, tokens **kept**; `invalid_grant`/`access_denied` (400/403) → grant gone, tokens **wiped** and the UI says "reconnect". |
| Resource/pointer failures mis-classified (Wave K hardening) | Only an explicit rejection of a *freshly-minted* credential wipes the token set: `invalid_grant`, or `401/403` **after** a forced refresh with no cross-origin hop in between. A 5xx or network error while resolving the ESPI pointer, and a 401 caused by fetch stripping `Authorization` on a cross-origin redirect, report `upstream` (502) with tokens **kept** — a custodian hiccup must never read as a revocation. A relative `<resourceURI>` is resolved against the Authorization resource's URL before it is persisted, so it can never poison later syncs with `Invalid URL`. |
| Service worker caching an OAuth redirect | `sw.js` skips `/greenbutton/*` entirely. |

TLS: the shim talks plain HTTPS + `client_secret` to the custodian — no mTLS
certificate is held. **Open item:** Oakville's third-party agreement §2(c) says
the recipient will "maintain unexpired, unrevoked RSA certificates … issued by
an Oakville Hydro supported Certificate Authority". Research says Ontario
utilities do not require mTLS, but if Connectivity Testing asks for a client
certificate, wire it in `webapp/src/lib/greenbutton/oauth.ts` (an `undici`
Agent with the issued cert) and re-run the e2e script.

---

## 5. Hosting — second container behind `/greenbutton/*`

The plan was "a second small container on .110 behind the same domain with a
`/greenbutton/*` path prefix, pending verification that the edge can route
that path". **The edge check came back as measured, not assumed:**

```
$ curl -sS https://electricity.markarslan.ca/greenbutton
→ 404 rendered by the Next.js app (a Next 404 page, not a proxy error)

$ curl -sS https://electricity.markarslan.ca/api/rates | md5sum
$ ssh hermescomputer 'curl -sS http://localhost:3939/api/rates' | md5sum
→ identical payloads (modulo the per-request updatedAt)
```

Every path under `electricity.markarslan.ca` is forwarded to **this host's
port 3939** — including `/greenbutton/*` — and the edge sits on a box we
cannot reach (origin VPS 96.44.170.134, port 22 filtered). So a second
container could only be reached by making the split *on this host*:

| Container | Role | Secrets |
| --- | --- | --- |
| `edge-router` (nginx, `:3939`) | `/greenbutton*` → shim, everything else → app | none |
| `greenbutton-shim` | the six `/greenbutton/*` handlers | `GB_CLIENT_ID` / `GB_CLIENT_SECRET`, token mount |
| `energy-dashboard` | the dashboard | **none** — no `GB_*` env, no token mount |

`ops/edge/default.conf.template` is the whole routing policy; it also turns
`proxy_buffering` **off** for `/greenbutton*` so the ESPI feed still streams
byte for byte through the extra hop.

**Proof, from the public URL:**

```
$ curl -sSI https://electricity.markarslan.ca/greenbutton/status | grep -i x-edge-upstream
X-Edge-Upstream: shim
$ curl -sSI https://electricity.markarslan.ca/ | grep -i x-edge-upstream
X-Edge-Upstream: app
```

The same assertions are checks in `webapp/scripts/e2e-greenbutton-topology.sh`,
which brings the whole three-container shape up on port 3940 (never touching
the live 3939), closes the OAuth loop against the mock custodian and replays
all 26 loop checks through the router: **30/30**.

Why not go further and extract the shim into a minimal non-Next service? The
split already puts the grant outside the public web app's process, which was
the security-relevant property; a second image build costs disk this host
does not have (96% full) and cannot be validated until Oakville issues
credentials. The extraction stays a mechanical follow-up: `src/lib/greenbutton/*`
has no React dependency and the route handlers are plain
`(Request) → Response`.

Rollback (also in `OPERATIONS.md`): `git revert` the topology commit and
re-run the deploy, or move `ports:` back onto `energy-dashboard` and drop the
`edge-router` service — the app's `/greenbutton/*` routes still exist, so the
feature keeps working, just back inside one container.

Registered URLs are unchanged by any of this:

- `redirect_uri`     = `https://electricity.markarslan.ca/greenbutton/callback`
- `notification_uri` = `https://electricity.markarslan.ca/greenbutton/notify/<token>`

---

## 6. Registering with Oakville Hydro — MARK'S STEP

Form: <https://www.oakvillehydro.com/green-button-third-party-registration-form>
(Drupal webform, self-serve, POST to `/green-button-third-party-registration-form`).

**This requires Mark**: it is a legal agreement — a checkbox accepting the
[Green Button Connect My Data Platform Agreement for Registering 3rd
Parties](https://oakvillehydro.com/sites/oakvillehydro/files/2024-08/Green%20Button%20sharing%20Third%20Party%20agreement%20-%20Oakville%20Hydro.pdf)
plus a "power to enter your company into an agreement" Yes/No. The agent will
not accept Terms on his behalf.

### Fields, ready to paste

| Form field | Value |
| --- | --- |
| Legal Company Name | *Mark's name* (individual — the open-green-button precedent registers an individual, not an entity) |
| Third Party Application Name | `Ontario Energy Optimizer` |
| Description/Purpose of Application | `Personal energy-usage analysis for the customer's own household: it imports Green Button interval data into a local dashboard that runs in the customer's own browser. No data leaves the customer's machine; nothing is stored on any server we operate.` |
| First Name / Last Name / Email / Phone | *Mark's details* (email: `me@markarslan.ca`) |
| Third Party Application Description (≤255 chars) | `A privacy-first Ontario energy dashboard. Interval usage is read once through Connect My Data and analysed entirely in your own browser — readings are never stored on our servers.` |
| Application Logo or Icon | `webapp/public/icons/icon-512.png` |
| Type of application | **Web App** |
| Application/Portal Login Page URL | `https://electricity.markarslan.ca/` |
| Third Party Green Button oAuth2 redirect URL | `https://electricity.markarslan.ca/greenbutton/callback` |
| Notification URI | `https://electricity.markarslan.ca/greenbutton/notify/96a1eb36f68816b9606848aa7c628a71` — already pinned in `docker-compose.yml` as `GB_NOTIFY_TOKEN`. **Do not regenerate it**: the form records this URL before Oakville issues the client secret, so it must not be derived from a secret that does not exist yet (verify with `grep -n GB_NOTIFY_TOKEN docker-compose.yml`; `/greenbutton/status` deliberately does **not** publish it — the path token is the only gate on the webhook, M1) |
| Data scope checkboxes | **Usage Information only** (data minimisation — agreement §1: use the data "only to perform its services to the Customer") |
| Power to enter your company into an agreement | **Yes** (Mark) |
| Terms & Conditions checkbox | ticked by Mark |

Scope string we request at authorize time: `FB=1_3_4_5`
(FB_1 Common Data Custodian, FB_3 Core Connect My Data, FB_4 Interval Metering,
FB_5 Interval Electricity Metering). If the platform rejects a scope that
narrow, fall back to the known-good Oakville string used by open-green-button:

```
FB=1_3_4_5_13_15_16_28_31_37_39_51_53_54_55_56_57_58_59_60_61_64_65_69
```

…by setting `GB_SCOPE` in `docker-compose.yml` (no rebuild needed for the env
value, only a `docker compose up -d`).

### After registration

1. Oakville issues `client_id` / `client_secret` → put them in
   `docker-compose.yml` as `GB_CLIENT_ID` / `GB_CLIENT_SECRET` (or an `.env`
   next to it, which compose reads automatically) and `docker compose up -d`.
2. Connectivity Testing must be completed **within 90 days** of acceptance
   (agreement §2). That is the production loop: connect a real Oakville
   account, confirm readings land in localStorage, revoke in Oakville's UI,
   confirm the shim reports `grant_revoked` and wipes its token file.
   `webapp/scripts/e2e-greenbutton-loop.sh` is the smoke test to rerun after
   any change; point `GB_AUTHORIZE_URL` / `GB_TOKEN_URL` at the real endpoints
   for a live variant.
3. If Oakville asks for a sandbox first, use the same flow with their sandbox
   URLs — only the two env vars change.

---

## 7. Terms of service check (Wave J guardrail)

The agreement was read in full. **No clause prohibits automated or
programmatic access** — it is the *Connect My Data* third-party agreement,
whose entire purpose is a machine-to-machine OAuth data feed. There is no STOP
flag.

Obligations that do apply, and how this implementation meets them:

| Clause | Requirement | Here |
| --- | --- | --- |
| §1 Privacy | treat data per Ontario privacy law, secure it, use it only for the customer's services, don't share it | readings are parsed in the browser and stored in that browser's localStorage; the server holds no readings at all |
| §2(c)(d) | RSA ≥2048-bit certs, TLS for all exchanges | TLS 1.2+ to `greenbutton.oakvillehydro.com` (their cert, system CA trust); client-cert question flagged in §4 |
| §2(a) | make no representations on behalf of Oakville Hydro | the UI says "authorise on Oakville Hydro's own page" and never implies endorsement |
| §2(b)(e) | comply with law, industry-standard DoS controls | narrow scope, rate-limited by the single-user design, no credential sharing |
| §3 | notify Oakville immediately of a security incident | runbook note added to OPERATIONS.md |
| §6 | complete Connectivity Testing within 90 days or be terminated | §6 step 2 above |

---

## 8. Deliberate divergence from the OGB (open-green-button) precedent

The reverse-engineering note for this wave suggested the stateless pattern the
precedent uses: encrypt the refresh-token blob with a server-held AES key,
hand the *ciphertext* to the browser (localStorage), and authenticate
`/proxy/usage` with an HMAC proxy token.

Not implemented, on purpose: **the card for this wave states the refresh token
must be "never in the browser"**, and the single-user deployment makes the
server-side file strictly simpler (no AES key, no HMAC pepper, no claim-code
flow, no blob rotation headers to replay). The browser holds only an HttpOnly
session cookie.

Everything else from that note is implemented as specified: same-origin
callback with no claim-code dance, ESPI streamed byte-for-byte, `resourcePath`
SSRF guard, published-max clamped to now (whole-second precision), async 202
handled as `data_pending`, refresh rotation persisted before returning,
parsing always client-side. If the stateless pattern is ever preferred
(multi-user, public deployment), the change is contained in
`webapp/src/lib/greenbutton/{tokens,http}.ts`.

---

## 9. Running / testing

```bash
cd webapp
npm run lint && npm run typecheck && npm run test   # 602 tests
npm run build

# End-to-end OAuth loop against a mock custodian (29 checks):
./scripts/e2e-greenbutton-loop.sh

# Same loop through the CONTAINERISED router topology (42 checks: 4 routing
# + 3 access-log canary + 6 security-header assertions + the 29 above).
# Needs docker; binds :3940, never :3939:
./scripts/e2e-greenbutton-topology.sh

# Just the Wave K suites:
npx vitest run src/lib/greenbutton src/components/GreenButtonSync.test.tsx
```

Manual probe of the deployed (still unconfigured) surface:

```bash
curl -s https://electricity.markarslan.ca/greenbutton/status | jq
# → {"configured": false, "unconfiguredReason": "GB_CLIENT_ID / GB_CLIENT_SECRET are not set…"}
# No `notificationUri` field: the notify path token must never be published
# (finding M1). Read the pinned value from docker-compose.yml instead.
curl -s https://electricity.markarslan.ca/greenbutton/status | jq -e 'has("notificationUri") | not'
# → true
curl -s -o /dev/null -w '%{http_code}\n' https://electricity.markarslan.ca/greenbutton/usage
# → 503 not_configured
```
