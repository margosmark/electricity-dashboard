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
| Shim built, OAuth loop closes, feed pipes into localStorage | **DONE — verified** (609 unit/integration tests + `webapp/scripts/e2e-greenbutton-loop.sh`, 29/29 checks against a live `next start` + mock custodian) |
| Shim deployed as its **own container** under `/greenbutton/*` | **DONE — verified** (four containers behind `:3939`; `webapp/scripts/e2e-greenbutton-topology.sh` runs the whole loop through the router — including a recreate of all three upstreams under a running router, plus Wave N's `/account` leg in both flag states: 102/102 on `.110` 2026-10-12; see §5) |
| Edge routes `/greenbutton/*` to this host | **DONE — verified empirically** (the edge forwards *every* path to `:3939`, so the split is made on-box; see §5) |
| Third-party registration with the utility | handled **privately** — the registration runbook lives outside this repo (§6) |
| Production loop with a real account | **BLOCKED on issued credentials** (§6) |
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
                   ├─ /account/*     → account-server     (Wave N; `deny all` on /account/internal)
                   └─ everything else → energy-dashboard  (no GB_* env, no ACCT_* env)
```

Same code, same image, same domain and certificate — different processes, and
each holds only its own secret set. See §5 for how the split is proven from
the outside.

**Zero data at rest, for the shim — still true after Wave N.** The shim pipes
ESPI to the browser and keeps scalars only (`lastSyncAt`, `lastSyncBytes`,
`dataAvailableSince` — see
`lib/greenbutton/session.ts`). The browser is what encrypts: by the time
anything is stored in the account server, the readings are an AES-GCM blob the
server cannot open. Wave N is not licence to start persisting readings in the
shim — if a reading ever lands in `.greenbutton/tokens.json` or in the shim's
session state, that is a regression against this document.

| Route | Purpose |
| --- | --- |
| `GET /greenbutton/status` | configured / connected / last-sync metadata (scalars only — never the notification URI) |
| `GET /greenbutton/start` | CSRF state → 302 to the custodian's authorize URL |
| `GET /greenbutton/callback` | code exchange, token set → disk, session cookie → app |
| `GET /greenbutton/usage` | **the pipe-through**: ESPI streamed straight to the browser |
| `POST /greenbutton/notify/[token]` | utility's "data changed" webhook; records a timestamp only, and (Wave N) tells the account server *that* the data moved — over the compose network, with a shared token, carrying scalars only |
| `POST /greenbutton/disconnect` | wipe the token file + expire the cookie |

Implementation lives in `webapp/src/lib/greenbutton/` (config, oauth, espi,
sync, tokens, session, http) and `webapp/src/app/greenbutton/`.

---

## 3. Where the refresh token lives

**Exactly one place:** a JSON file on .110, outside the container, mode `0600`.

```
host:        ~/.greenbutton-shim/tokens.json
in container: /var/lib/greenbutton/tokens.json   (bind mount, GB_TOKEN_FILE)
inspect:     sudo ls -l ~/.greenbutton-shim
```

The host path is `GB_TOKEN_DIR`, pinned in the **untracked `.env`** — never
in `docker-compose.yml`. It sits outside the git worktree on purpose: no
clone, no `git clean -xfd`, no `git add -A` can reach a live refresh token.

It is never:

- in the browser (the browser holds an HttpOnly `gb_session` cookie that
  unlocks *this* service and nothing else — it is not an OAuth credential),
- in a commit (the `.env` and `.greenbutton/` are both gitignored),
- in a log (the edge logs the `/greenbutton/*` **path only** — `log_format
  gb_noquery` drops the query string. The one place a query string could
  still arrive is the `Referer` on the callback's `302` to `/?gb=connected`;
  that is closed by `Referrer-Policy: no-referrer` on the exact callback
  location — see SECURITY.md §4 for why `gb_noquery` alone did not cover it),
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
cannot reach (origin VPS 192.0.2.1, port 22 filtered). So a second
container could only be reached by making the split *on this host*:

| Container | Role | Secrets |
| --- | --- | --- |
| `edge-router` (nginx, `:3939`) | `/greenbutton*` → shim, everything else → app | none |
| `greenbutton-shim` | the six `/greenbutton/*` handlers | `GB_CLIENT_ID` / `GB_CLIENT_SECRET`, token mount |
| `energy-dashboard` | the dashboard | **none** — no `GB_*` env, no token mount |

`ops/edge/default.conf.template` is the whole routing policy; it also turns
`proxy_buffering` **off** for `/greenbutton*` so the ESPI feed still streams
byte for byte through the extra hop. It is baked into the router's image
(`ops/edge/Dockerfile`) rather than bind-mounted, so editing it and running
`docker compose up -d --build` actually recreates the router.

**Proof, from the public URL — two headers, two questions:**

```
$ curl -sSI https://electricity.markarslan.ca/greenbutton/status | grep -iE 'x-edge-location|x-gb-process'
X-Edge-Location: greenbutton
x-gb-process: shim
$ curl -sSI https://electricity.markarslan.ca/ | grep -iE 'x-edge-location|x-gb-process'
X-Edge-Location: default
x-gb-process: app
```

`X-Edge-Location` is *which location nginx matched*; `x-gb-process` is *which
container produced the body*, read from that process's own config
(`getProcessIdentity`, derived from `GB_TOKEN_FILE`). They must agree —
`greenbutton`+`app` or `default`+`shim` means the split is inverted.

The single header this replaced, `X-Edge-Upstream`, was set per **location**
and therefore proved nothing: it read `shim` while the app container was
serving the request, for the 31 minutes on 2026-10-07 when nginx's
startup-time upstream cache had the split backwards (security finding H1 —
the secret-bearing container was serving the public dashboard and the OAuth
flow ran in the secret-less one).

The same assertions are checks in `webapp/scripts/e2e-greenbutton-topology.sh`,
which brings the whole three-container shape up on port 3940 (never touching
the live 3939), **recreates both upstreams underneath a still-running router**
— the H1 regression: nginx must follow the names, not the addresses it
remembers — closes the OAuth loop against the mock custodian and replays all
29 loop checks through the router: **46/46**.

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

## 6. Registering with the utility — private runbook

Third-party registration with the data custodian — the legal agreement, the
form fields, personal contact details and the step-by-step sequence — is a
**private runbook** kept outside this repository; it is not reproduced here.
Only the generic mechanics the rest of this document depends on are kept:

- **Scope** requested at authorize time: `FB=1_3_4_5` (FB_1 Common Data
  Custodian, FB_3 Core Connect My Data, FB_4 Interval Metering, FB_5
  Interval Electricity Metering). If the platform rejects a scope that
  narrow, fall back to the known-good 24-block string
  `FB=1_3_4_5_13_15_16_28_31_37_39_51_53_54_55_56_57_58_59_60_61_64_65_69`
  — set `GB_SCOPE` in `docker-compose.yml` (an env value; `docker compose
  up -d`, no rebuild).
- **Notification URI**: `https://electricity.markarslan.ca/greenbutton/notify/<GB_NOTIFY_TOKEN>`.
  The path token is a **secret** pinned in the untracked `.env`
  (`GB_NOTIFY_TOKEN`) — never derived from the client secret (the registered
  URL predates the secret), never published (`/greenbutton/status` does not
  expose it), and never stored in this repository.
- **When credentials arrive**: run the re-point ceremony once —
  [GREENBUTTON-REPOINT.md](GREENBUTTON-REPOINT.md) is the checklist, driven by
  `webapp/scripts/greenbutton-repoint.sh` (start with `--check`; it reads the
  registered token from `GB_REGISTERED_NOTIFY_TOKEN`, supplied from the
  operator's secret store).
- Data scope at authorize time is **Usage Information only** — data
  minimisation: use the data only to perform its services to the customer.

---

## 7. Terms of service check (Wave J guardrail)

The agreement was read in full. **No clause prohibits automated or
programmatic access** — it is the *Connect My Data* third-party agreement,
whose entire purpose is a machine-to-machine OAuth data feed. There is no STOP
flag.

Obligations that do apply, and how this implementation meets them:

| Clause | Requirement | Here |
| --- | --- | --- |
| §1 Privacy | treat data per Ontario privacy law, secure it, use it only for the customer's services, don't share it | readings are parsed in the browser and stored in that browser's localStorage; the shim holds no readings at all, and the optional account server (Wave N) holds them only as ciphertext it cannot open (`SECURITY.md` §5) |
| §2(c)(d) | RSA ≥2048-bit certs, TLS for all exchanges | TLS 1.2+ to `greenbutton.oakvillehydro.com` (their cert, system CA trust); client-cert question flagged in §4 |
| §2(a) | make no representations on behalf of Oakville Hydro | the UI says "authorise on Oakville Hydro's own page" and never implies endorsement |
| §2(b)(e) | comply with law, industry-standard DoS controls | narrow scope, rate-limited by the single-user design, no credential sharing |
| §3 | notify Oakville immediately of a security incident | runbook note added to OPERATIONS.md |
| §6 | complete Connectivity Testing within 90 days or be terminated | private runbook (§6) — the 90-day clock is tracked outside this repo |

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
npm run lint && npm run typecheck && npm run test   # 609 tests
npm run build

# End-to-end OAuth loop against a mock custodian (29 checks):
./scripts/e2e-greenbutton-loop.sh

# Same loop against a REAL custodian (Oakville, or their sandbox) — nothing is
# inlined, and the grant-gated sections report SKIP rather than pass when no
# customer account is connected yet:
GB_E2E_TARGET=real GB_E2E_EXTERNAL=1 BASE=https://electricity.markarslan.ca \
  GB_E2E_ACCOUNT=0 GB_CLIENT_ID=… GB_CLIENT_SECRET=… GB_SCOPE=… \
  GB_AUTHORIZE_URL=… GB_TOKEN_URL=… GB_NOTIFY_TOKEN=… \
  ./scripts/e2e-greenbutton-loop.sh

# The re-point ceremony (preflight now, one command at go-live) — see
# GREENBUTTON-REPOINT.md:
./scripts/greenbutton-repoint.sh --check --host hermescomputer --loop-gate
./scripts/greenbutton-repoint.sh --rehearse --host hermescomputer --loop-gate

# Same loop through the CONTAINERISED router topology (46 checks: 4 routing
# + 4 upstream-recreate + 3 access-log canary + 6 security-header assertions
# + the 29 above). Needs docker; binds :3940, never :3939:
./scripts/e2e-greenbutton-topology.sh

# Just the Wave K suites:
npx vitest run src/lib/greenbutton src/components/GreenButtonSync.test.tsx
```

Manual probe of the deployed (still unconfigured) surface:

```bash
curl -s https://electricity.markarslan.ca/greenbutton/status | jq
# → {"configured": false, "unconfiguredReason": "GB_CLIENT_ID / GB_CLIENT_SECRET are not set…"}
# No `notificationUri` field: the notify path token must never be published
# (finding M1). Read the pinned value from the untracked `.env`
# (`GB_NOTIFY_TOKEN`) instead — it is never in the repo.
curl -s https://electricity.markarslan.ca/greenbutton/status | jq -e 'has("notificationUri") | not'
# → true
curl -s -o /dev/null -w '%{http_code}\n' https://electricity.markarslan.ca/greenbutton/usage
# → 503 not_configured
```
