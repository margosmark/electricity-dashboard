# Operations runbook — electricity dashboard

Daily-driver operations for the deploy at `~/electricity-dashboard`.

**Four containers, one host port (3939):**

| Container | Job |
| --- | --- |
| `edge-router` | nginx on host `:3939` — `/greenbutton*` → shim, `/account/internal/*` denied (403), `/account/*` → account server, everything else → app |
| `greenbutton-shim` | the Connect My Data shim; the ONLY container with `GB_*` env and the token mount |
| `account-server` | the account API (Wave N): the only process with `ACCT_*` that opens the database, plus the VAPID key. Shipped **off** (`ACCT_ENABLED` unset ⇒ every `/account/*` answers 404); see *Account server* below |
| `energy-dashboard` | the dashboard; no Green Button env, no account env, no token mount |

**Public URL:** https://electricity.markarslan.ca/ (Let's Encrypt TLS, edge
proxy fronting `:3939`; localhost health checks still work at :3939).

**Only that origin may serve `upgrade-insecure-requests`.** The CSP is built
in `webapp/src/proxy.ts` and adds the directive for an INVENTORIED HTTPS
origin only — `electricity.markarslan.ca`, the list in that file. It matters
because the directive rewrites every subresource to https: on the plaintext
`:3939` surface the browser then asks for `https://<host>:3939/…`, nothing
listens there, and the app loads as an unhydrated HTML shell (0 interactive
elements, stuck on "PREPARING OPTIMIZER…"). Diagnose with
`curl -sI http://<host>:3939/ | grep -i upgrade` — a hit on a plaintext
surface is the bug. Never scope that directive by `request.url`'s scheme:
edge-router sets `X-Forwarded-Proto: https` for the whole deployment, so
Next sees https even for a direct plaintext LAN hit (measured 2026-10-12).

Which container answered a request: every response carries
`x-gb-process: app`, `shim` or `account` — set **by the serving process**
from its own config — plus `X-Edge-Location: default|greenbutton|account|account-deny`, which is
which nginx branch matched. The pair must agree (see §5 of
GREENBUTTON-CMD.md), with one measured exception worth knowing before you
read a mismatch as an incident: `x-gb-process` is derived from the flag that
tells a process who it is, so while accounts are OFF the account container
answers `/account/*` with `X-Edge-Location: account` **and**
`x-gb-process: app` — it has not been told it is the account server, and
404 with no account API is exactly what an off deployment must look like
(measured 2026-10-12; the pairing `account`↔`account` holds with
`ACCT_ENABLED=true`). A location-derived header on its own cannot answer this
question and did not, on 2026-10-07.

## Start / stop / update

```bash
~/bin/deploy-energy-dashboard.sh   # serialized deploy: fetch + reset + rebuild (flock-guarded)
cd ~/electricity-dashboard && docker compose down   # stop
```

The deploy script (`~/bin/deploy-energy-dashboard.sh` on .110) refuses to run
concurrently (`DEPLOY_REFUSED`, exit 3) so sibling agents can't swap the image
mid-verification. `--no-fetch` skips the git step for tar-pushed deploys. It
also exports `GIT_SHA=$(git rev-parse HEAD)` before the build, so every image
it produces names its own commit at `GET /api/version` (§ Deploying changes) —
the clone is a branch that gets `reset --hard origin/main`, so this export is
the only place the deployed SHA is read. The value is **compiled into the
bundle** by `webapp/scripts/bump-build-info.mjs` (the `prebuild` lifecycle, read
out of the builder stage's environment), not read from the container's
environment at request time — so a container started some way other than this
compose file still names the commit it was built from.

**Check disk before a deploy.** This host runs the **vfs** storage driver
(`/var/lib/docker/vfs/dir` ≈ 92 G), so an image build can eat several GB of
cache and hit `no space left on device` mid-recreate. The old container
survives (the recreate fails before the swap — the site does not go down), but
free the space first:

```bash
df -h /                                     # want ≥ 4 G before deploying
sudo docker builder prune -f                # reclaims GBs, touches no running container
apt-get clean && sudo journalctl --vacuum-size=50M   # a few hundred MB more
```

Code delivery on hermescomputer (.110): **native git works** — the host holds a
read-only GitHub deploy key (`~/.ssh/ed25519_deploy`, key id 165177015,
read_only=true, scope limited to this repo) and `~/.ssh/config` pins it for
`github.com`. `git pull` and the deploy script's fetch/reset both work
verbatim, no tar push needed:
`code changes → push to GitHub → ssh hermescomputer '~/bin/deploy-energy-dashboard.sh'`

A rebuild is always safe. There are no secrets **in the image** and no
database; the one persistent artefact is the Green Button token file
(§ Green Button), bind-mounted from `.greenbutton/` and gitignored. Delete it
and the only cost is re-authorising. Compose *does* read a local `.env` if you
create one for `GB_CLIENT_ID` / `GB_CLIENT_SECRET` — that file must never be
committed.

## Health checks

| Check | Command / expectation |
| --- | --- |
| Containers up | `docker compose ps` → `edge-router`, `energy-dashboard`, `greenbutton-shim` all running |
| Serves the app | `curl -fs http://localhost:3939/` → HTML containing "Ontario Energy Optimizer" |
| Router split works | `curl -sSI http://localhost:3939/` → `x-gb-process: app` + `X-Edge-Location: default`; `/greenbutton/status` → `shim` + `greenbutton`. Mismatch between the two = split inverted |
| Rates API | `curl -fs http://localhost:3939/api/rates` → JSON with `historicalRates` (3 sets) |
| Logs | `docker compose logs -f energy-dashboard` |
| Reparse in browser | Upload modal re-appears only if `localStorage.energy_data` is absent |
| Green Button shim | `curl -fs http://localhost:3939/greenbutton/status` → JSON; `configured:false` until Oakville issues credentials |
| Green Button live | `curl -fs https://electricity.markarslan.ca/greenbutton/status \| jq .configured` → `true` once `GB_CLIENT_ID`/`GB_CLIENT_SECRET` are set |
| Token file | `sudo ls -l .greenbutton/` → `tokens.json`, owner uid 1001, mode `600` (absent until the first authorisation) |
| Account API **on** | `curl -sS -D- https://electricity.markarslan.ca/account/session` → `200` `{"enabled":true,…}` with `x-gb-process: account` (must pair with `X-Edge-Location: account`) |
| Account API **off** | same URL → `404` with `x-gb-process: app` — indistinguishable from "no such route", for **every** method: `curl -sS -o /dev/null -w '%{http_code}' -X GET https://electricity.markarslan.ca/account/login` → `404` (not `405`) and `-X OPTIONS` → `404` (not `204`) |
| Internal fan-out is unreachable | `curl -sS -o /dev/null -w '%{http_code}' https://electricity.markarslan.ca/account/internal/notify` → `403` (denied at the edge; it exists only on the compose network) |

## Data model (user-visible)

Nothing readable is stored server-side: the dashboard process holds no user
data at all, and the optional account server holds a copy only as ciphertext
(`## Account server (Wave N)`). The browser holds:

- `localStorage.energy_data` — the parsed Green Button readings
  (`{timestamp, usage_kwh}` sorted ascending; from the last uploaded XML).
- `localStorage.billing_day` — billing anchor day of month, drives the
  Billing-period view scope.
- `localStorage.extra_charges` — optional bill add-ons typed by the user
  (delivery $/kWh, delivery $/month, regulatory $/kWh, HST %). Seeded empty;
  while every field is empty the estimate stays variable-only. Deliberately
  **local**: `/api/rates` carries OEB commodity rates only, never delivery,
  regulatory, or tax.

**Multi-meter uploads:** a Green Button file with more than one UsagePoint
(multiple meters / rate classes) no longer merges silently — a picker asks for
one point or "Combine all", and only the chosen rows are written to
`energy_data`.

User recovery: re-upload the Oakville Hydro Green Button XML. There is nothing
else to back up — **unless** the account server is in use, in which case the
encrypted copy in the external `ACCT_DATA_DIR/accounts.db` is a second source only after the separately gated account-server activation (see
`## Account server (Wave N)`).

## Data source

Oakville Hydro → download Green Button export (XML, hourly interval readings,
Wh values). The file is parsed in-browser by `parseGreenButtonXML`
(`webapp/src/lib/energy.ts`); unit conversion is Wh→kWh divide-by-1000, and
timestamps are unix UTC converted implicitly by `new Date(...)` to local time
for categorization.

## Green Button live sync (Wave K)

Authorisation refreshes the dashboard's readings automatically through Oakville
Hydro's Connect My Data API instead of a manual XML export. Design, security
model, registration payload and the terms-of-service check all live in
**[GREENBUTTON-CMD.md](GREENBUTTON-CMD.md)**; this section is the operational
part.

**Where the refresh token lives:** `/home/hermes/.greenbutton-shim/tokens.json`
on .110 (mounted **only** into `greenbutton-shim` at
`/var/lib/greenbutton/tokens.json`), mode `0600`, owner uid 1001. It holds
*only* the OAuth token set — never readings. The host path comes from
`GB_TOKEN_DIR` in the **untracked `.env`**, deliberately outside the git
worktree. Inspect with `sudo ls -l /home/hermes/.greenbutton-shim`; wipe with
the UI's **Disconnect** button or by deleting the file and restarting that
container (`docker compose restart greenbutton-shim`).

**The untracked `.env` is required.** `docker-compose.yml` reads
`GB_NOTIFY_TOKEN` (the pinned notification path token) and `GB_TOKEN_DIR`
from it and fails loudly (`${VAR:?…}`) rather than falling back to a default
that silently changes behaviour — so a deploy without `.env` stops with a
clear message instead of registering a derived token that breaks
notifications.

| Task | Command |
| --- | --- |
| Set credentials after Oakville issues them | run the re-point ceremony: `GB_CONFIRM_GO_LIVE=yes webapp/scripts/greenbutton-repoint.sh --apply --host hermescomputer --env-file ~/.oakville-creds.env --loop-gate` — it validates the pair, proves the secret reaches only the shim, writes the untracked `.env` and recreates the containers (no rebuild). Checklist: [GREENBUTTON-REPOINT.md](GREENBUTTON-REPOINT.md). Hand-editing `.env` still works but skips every check |
| Scope no longer accepted by the platform | change `GB_SCOPE`, `docker compose up -d` |
| Turn PKCE on (once Oakville confirms the platform accepts `code_challenge`) | `GB_PKCE=true` in the untracked `.env`, then `docker compose up -d greenbutton-shim` |
| Re-run the full OAuth loop | `cd webapp && ./scripts/e2e-greenbutton-loop.sh` (29 checks, needs docker only for the second) |
| Re-run it through the **containerised router topology** | `cd webapp && ./scripts/e2e-greenbutton-topology.sh` (checks all three upstreams recreated under a running router, plus `/account` routes with the feature off and enabled-but-registration-closed; it does not run authenticated registration/login/sync, which are covered by ephemeral tests in `webapp/src/lib/account/account.test.ts` and `route-matrix.test.ts`; binds :3940 + :8099, tears itself down) |
| Re-run the **browser** connect flow | `cd webapp && ./scripts/e2e-greenbutton-browser.sh` — builds, boots a mock custodian + a *configured* shim on :3941, then runs the whole Playwright suite against it: the Authorise button → authorize → callback → localStorage loop with a "no token material in browser storage" assertion, plus `/import` and the journey specs with the feature switched on |
| Diagnose a "reconnect" complaint | `docker compose logs greenbutton-shim \| grep greenbutton` — look for `invalid_client` (our secret is wrong) vs `invalid_grant` (the grant was revoked) |
| Shim unreachable (`/greenbutton/*` 502) | `docker compose ps` (shim stopped?) then `docker compose logs edge-router` |
| Undo the container split | `git revert` the topology commit + deploy, **or** move `ports:` back to `energy-dashboard`, delete `edge-router`, `docker compose up -d` — the shim's routes still exist inside the app, just without the split |
| Revoke access on Oakville's side | their own portal; the next sync then returns `grant_revoked` and the shim wipes its token file automatically |
| Incident | if customer data is ever exposed or suspected, notify Oakville Hydro **immediately** (agreement §3): summary + facts, number of customers affected, anything relevant |

The browser polls `/greenbutton/usage` on load and every 15 minutes while the
tab is visible. Nothing is stored server-side between those calls.

## Account server (Wave N) — multi-device sync + Web Push

A fourth container (`account-server`), same image, started by `docker compose
up -d`. It is the only process that holds the account database — argon2
verifiers, session rows, the SQLite file — plus `VAPID_*` (the push signing
key); the dashboard container gets none of that, which is why `/account/*`
answers **404** on the public app process by design. (The shim is the one
deliberate exception to "only this container sees `ACCT_*`": it gets
`ACCT_NOTIFY_URL` + `ACCT_INTERNAL_TOKEN` and nothing that opens the
database.) **The feature is off until you turn it on:** `ACCT_ENABLED`
defaults to `false`, and must remain false until the separate activation gates pass. This P0 release deliberately keeps self-service registration closed: `/account/register` returns the same generic `202 verification_pending` response for known/unknown addresses, but sends no mail and stores no pending password. A future flow must verify mailbox ownership before it asks for a password or creates an account. Do not enable this feature from these notes.

Configuration contract (names only; no values belong in source or task notes):

- `ACCT_ENABLED` — defaults to `false`.
- `ACCT_DATA_DIR` — required absolute host bind source outside the checkout; compose mounts it as `/data`. `ACCT_DATA_DIR_HOST` mirrors that source and `ACCT_REPO_HOST_DIR` identifies the checkout (compose defaults it from `PWD`) so startup rejects repository-local sources; the mounted `/data` must be uid 1001-owned, mode 0700 (or stricter). The account process validates the host paths and mount at startup, then repeats ownership/mode checks before serving account routes.
- `ACCT_DB_PATH` — fixed inside the container at `/data/accounts.db`; do not point it into the repository.
- Email boundary keys (not configured by this P0): `ACCT_EMAIL_MODE=off|test|live`; live additionally requires `ACCT_EMAIL_PROVIDER=postmark|resend`, `ACCT_EMAIL_FROM`, and `ACCT_EMAIL_API_KEY_FILE` mounted read-only with mode 0600. Validation does not send mail or read/log the credential. Provider selection, sender/DKIM alignment, secret provisioning, real adapter, verification/recovery endpoints and staging evidence remain activation gates.
- Existing optional keys remain `ACCT_PUBLIC_ORIGIN`, `ACCT_INTERNAL_TOKEN`, `ACCT_MAX_ACCOUNTS`, `ACCT_RATES_URL`, and `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

No user, database, secret, email credential, or external storage is created by this release. The disabled feature remains invisible and durable data is not deleted by switching the flag off. When explicitly enabled after release gates, nginx limits account requests to 60/minute per observed peer (burst 20; max 10 concurrent), rejects bodies above 6 MiB before proxying, and buffers requests at the edge. The account access log records only method, fixed route and status—no source IP, query, referer, cookie or body; error lines are suppressed below `crit` to avoid echoing request targets.


The router rebuild is only needed when `ops/edge/default.conf.template`
changes; the `/account/*` locations shipped with this change, so it is a
one-time step for this upgrade.

| Check | Command / expectation |
| --- | --- |
| Service up | `docker compose ps` → `account-server` running |
| API answers | `curl -fs http://localhost:3939/account/session` → `{"enabled":true,…}` |
| Right container answered | response carries `x-gb-process: account` **and** `X-Edge-Location: account` (a mismatch = the split is inverted, H1's failure mode) |
| Push configured | same payload has `pushConfigured:true` once `VAPID_*` are set; `false` means sync works and notifications are simply inert |
| Data file | `sudo ls -l "$ACCT_DATA_DIR"` → `accounts.db` once account storage has been explicitly provisioned |
| Activation preflight (read-only) | `https://electricity.markarslan.ca/account/preflight` → the three prerequisites (SMTP provisioning, `ACCT_ENABLED`, `ACCT_EMAIL_VERIFICATION_ENABLED`) each shown pass/pending, plus the fail-closed statement and the activation checklist |

**Activation preflight.** `/account/preflight` is the read-only answer to
"why can't this be activated?". It is a **page** served by the account
container (the same shape as `/account/terms`), not an API route, so every
`/account/*` route handler still answers the indistinguishable 404 while
`ACCT_ENABLED` is off — the API contract is untouched. It shows the three
prerequisites as **pass/pending** (never a silent failure), states in plain
language that activation stays fail-closed **until SMTP is live**, and lists
what must be true before activation is even considered. It renders booleans
only: no SMTP host, address, path or credential appears in either language,
and it changes no flag, no SMTP setting, no credential and no account —
`evidence/account-preflight-verify.cjs` asserts all of that against a real
browser in en and fr.

**Backup.** The external `ACCT_DATA_DIR` holds the SQLite database and WAL. It is user data even though the blob is ciphertext. Configure an encrypted, off-host backup and prove a restore before enabling accounts; a file copy is not an acceptable launch backup plan. SQLite is in WAL mode, so a consistent manual copy requires the account service stopped and the database, `-wal`, and `-shm` files copied together. This release does not configure or claim a retention/backup job.

Losing the file costs the server copy only: any device that still holds its local data and key is unaffected. Re-registration remains closed until verified email delivery is implemented.
**Passphrases and recovery.** New credentials require at least 15 characters (maximum 200). This is an offline-ciphertext-theft policy: the password derives both an Argon2id login verifier and the browser-only PBKDF2/AES-GCM key from a public salt; E2EE cannot compensate for a guessable passphrase. Encourage memorable multi-word passphrases, never trim or log them, and preserve existing shorter passwords for login. Recovery codes restore authentication only; changing the password drops ciphertext encrypted under the old key unless a trusted device can re-sync it. They do not decrypt old data.

There is no active email recovery sender. The provider-agnostic outbound boundary currently has no adapter and registration does not deliver mail or accept/store a password. Future recovery email must use a purpose-bound, one-use verification token and may not claim to restore E2EE data.

**Mailbox verification, SMTP contract and rollback.** Public registration and
password recovery are mailbox-proofed before a password verifier or session is
created. The account server requires a complete SMTP contract in its approved
secret mechanism (never in git, cards or chat):

| Variable | Contract |
| --- | --- |
| `ACCT_SMTP_HOST` / `ACCT_SMTP_PORT` | relay host and port; default port is 587 |
| `ACCT_SMTP_TLS_MODE` | `starttls` (default) or `implicit`; certificate verification is always on |
| `ACCT_SMTP_HELO` | stable deployment hostname used in EHLO |
| `ACCT_SMTP_USERNAME` / `ACCT_SMTP_PASSWORD` | optional SMTP AUTH pair, injected as secrets together |
| `ACCT_SMTP_FROM` | exact aligned From mailbox on the dedicated sender subdomain |
| `ACCT_SMTP_REPLY_TO` | monitored Reply-To mailbox |
| `ACCT_SMTP_EVENTS_SECRET` | HMAC secret for signed relay bounce/complaint POSTs to `/account/smtp-events` |

`ACCT_EMAIL_VERIFICATION_ENABLED` defaults to `false` and is independent of
`ACCT_ENABLED`. When either flag is false, email-dependent registration,
recovery and verification routes return indistinguishable 404s without creating
accounts, sessions, tokens or outbox rows. When it is true, the complete SMTP
contract is required; missing or invalid SMTP configuration fails closed with
`503 email_unavailable`. The link GET is scanner-safe; only the explicit
verification POST consumes its one-use, 30-minute, purpose-bound token. Tokens
are SHA-256 hashed at rest and never logged. A relay's permanent SMTP failure
or a signed bounce/complaint adds the address to the suppression table without
exposing it to the caller. Signed events use `HMAC-SHA256(timestamp + "." + rawBody)`,
a five-minute clock window, and a replay table.

The sender must have strict DKIM/DMARC alignment and the Reply-To must be
monitored before public enablement. The external release gate is Mark's
non-secret provisioning attestation; this code candidate does not claim a
controlled-mailbox send until that attestation and staging proof exist.

To roll back, set `ACCT_ENABLED=false` and recreate only `account-server`; all
account paths return indistinguishable 404s and no email is sent. To disable
mail while retaining an already-enabled account database, remove the SMTP
secret set and restart: registration/recovery return `503 email_unavailable`,
while existing sign-in/sync behavior remains available. Do not delete the
ciphertext database during an SMTP incident.

**Passwords and E2EE boundary.** A recovery link can set a new authentication
verifier, but the stored blob (encrypted with the old password) is dropped —
mailbox proof recovers the *account*, not the data; re-sync from a device that
still has it. A recovery event never returns or derives the blob data key.

**VAPID rotation.** Replacing `VAPID_PRIVATE_KEY` invalidates every existing
subscription silently (pushes fail and are dropped as dead on a 410). After a
rotation, sign in → Notifications → turn off, then on, on each device.

**Account ceiling.** `ACCT_MAX_ACCOUNTS` (default 10) bounds registration —
registration is deliberately unauthenticated (no invite loop), so the cap plus
the attempt budget below are what actually bound it. Hitting it returns `403
account_limit`.

**Attempt budget.** `login`, `recover` and `register` refuse after a bounded
number of attempts (token buckets per e-mail, per trusted ingress address and
process-wide — `webapp/src/lib/account/ratelimit.ts`), answering `429` with a
`Retry-After` header instead of a generic error. Operational notes:

**VAPID rotation.** Replacing `VAPID_PRIVATE_KEY` invalidates existing push subscriptions; after a rotation, users re-enable notifications on their devices.

- Counters are **in the account-server process**. `docker compose restart
  account-server` clears them; that is a convenience for you and not a hole,
  because nobody else can restart it.
- A user who mistypes their password eight times in fifteen minutes sees
  `429 rate_limited` for up to a minute or two. It is a refillable budget,
  not a lockout: no state, no unlock procedure, no operator action.
- If you ever need to see why a request was refused, the body carries
  `retryAfterSeconds` and the header carries the same number.

### Removing an account (operator maintenance)

Account deletion is an operator-only maintenance action, not a public endpoint. The schema cascades deletion through sessions, ciphertext, subscriptions, preferences, and notification metadata. Stop the service, delete the account row with foreign keys enabled, verify the dependent counts, then restart it. Use the provisioned external `ACCT_DATA_DIR`; never assume data lives in the checkout.

```bash
cd ~/electricity-dashboard
docker compose stop account-server
sudo sqlite3 -cmd "PRAGMA foreign_keys=ON;" "$ACCT_DATA_DIR/accounts.db" \
  "DELETE FROM accounts WHERE email = 'address@example.com';"
sudo sqlite3 "$ACCT_DATA_DIR/accounts.db" "SELECT id,email FROM accounts;"
docker compose start account-server
```

The P0 release does not enable registration or create account storage. For databases provisioned later, the deletion cascade is covered by integration tests; do not delete durable account data as a rollback action.

## Rate data updates

Ontario OEB rates live in `webapp/src/app/api/rates/route.ts` as a
`historicalRates` array (one `RateSet` per effective date: TOU, Tiered, ULO).
**When the OEB announces new rates (typically each November 1):** append a new
entry with the correct `effectiveDate`; do not edit past entries — historical
cost math keys off them. Deploy with the normal rebuild. Source:
https://www.oeb.ca/consumer-information-and-protection/electricity-rates

### Staleness checks (two independent layers)

The OEB page is HTML only — no JSON (Drupal `?_format=json` → 406), no RSS,
no CORS headers (probed 2026-10-02). Both layers below parse the same page
with equivalent logic, pinned to `webapp/src/lib/oebRates.fixture.html`:

1. **In-app banner (client, once per tab session).** `next.config.ts` exposes
   a stateless same-origin rewrite `/oeb-rates-page` (transport only — all
   parse/compare logic stays client-side in `src/hooks/useRateStaleness.ts`).
   When OEB's effectiveDate is newer than the shipped set, an orange banner
   (`RateStalenessBanner`) renders persistently with per-period deltas, a
   sample impact computed from the user's last ~30 days, and a deep link to
   edit the rates file. Failures degrade to no banner — never blocks render.
   `/api/rates` carries `ratesSourceVersion` (FNV-1a over the rate array) and
   `lastChecked` (build constant — bump when you re-verify/append).

2. **Weekly gateway cron (server, authoritative).**
   `scripts/check_oeb_staleness.py` (installed at
   `~/.hermes/profiles/soft-dev/scripts/`, job `47a3720dc33f`, Mondays 9am,
   `no_agent`) compares live OEB vs the deployed `/api/rates`:
   - current → empty stdout → nothing delivered (watchdog pattern);
   - stale → WhatsApp bullet report with ¢/kWh deltas + update instructions;
   - fetch/parse failure → one-line ⚠️ warning (a silent broken checker is
     worse than a noisy one).
   Tests: `tests/test_oeb_staleness.py` (offline, fixture-pinned).

## Deploying changes

Gate order before pushing (mirrors CI):

```bash
cd webapp && npm run lint && npm run typecheck && npm run test && npm run build
cd .. && pytest tests/ -v        # only if root parser changed
```

Then commit/push and rebuild the container. Every image stamps the commit it
was built from — the deploy runbook exports `GIT_SHA=$(git rev-parse HEAD)`
and `docker-compose.yml` forwards it as a build arg — so the deployed app
names its own build at `GET /api/version` (`{"sha": …, "buildId": …}`, with
`"unknown"` for a local build):

```bash
curl -s http://10.10.11.110:3939/api/version   # → {"sha":"<the deployed commit>",…}
```

The SHA is **compiled into the bundle**, not read at runtime: `GIT_SHA` reaches
`webapp/scripts/bump-build-info.mjs` (wired into `prebuild`) in the builder
stage's environment, and that script writes the committed constant
`webapp/src/lib/buildInfo.generated.ts` (`'unknown'` — the placeholder a fresh
clone carries — when nothing supplies it). So the answer is a literal in the
emitted server chunk, the image config declares no stamp at all, and
`docker run -e NEXT_PUBLIC_BUILD_SHA=deadbeef… <image>` still answers the commit
the image was built from. A build with `GIT_SHA` set dirties exactly that one
tracked file (the `public/sw.js` precedent) — restore it and stage by name,
never `git add -A`.

Read that instead of inferring identity from built bytes. A wrong `sha` means
the container was not recreated by the deploy; `buildId` changes on every
build, so it distinguishes a rebuild of the same commit. CI's workflow is
**disabled server-side** (2026-10-10, Actions minutes exhausted — push/PR
runs died in 3–4s with zero steps scheduled, so the run-history reds were
billing, not failures; see the header in
`.github/workflows/ci.yml` and the note in README). The gate order above
is the gate, and merges land on local-green. The triggers on main are
`workflow_dispatch`-only as of 2026-10-11, so `gh workflow enable CI`
alone cannot resurrect the push/PR reds — but there is still no CI
budget, so leave the workflow disabled until Actions minutes are topped
up. The `husky` pre-commit hook runs on every local commit.

### Local previews carry the same stamp

A local production-mode preview built with a bare `npm run build` answers
`{"sha":"unknown"}` at `/api/version`, so no exact-SHA claim about it can be
checked (seen in QA, 2026-10-24). Build the preview the way the image is
built:

```bash
cd webapp && PORT=3210 npm run preview   # exports GIT_SHA=$(git rev-parse HEAD), builds, serves
curl -s http://127.0.0.1:3210/api/version   # → {"sha":"<the commit you built>",…}
```

`webapp/scripts/preview-prod.sh` does the export, so the served preview
names its own commit. Do not weaken CSP or run `next dev` to make a preview
work — build it in production mode and read `/api/version` to prove which
build answered.

## Known sharp edges

- **Port collision:** 3939 is the host port; if another service takes it,
  change only the left side of `"3939:3000"` in `docker-compose.yml`.
- **Legacy tree confusion:** root `app.py`/`parser.py` is the frozen Streamlit
  prototype. Running it (`streamlit run app.py`) needs the repo `.venv` and a
  local `electricit2024-now.xml` next to it — it is not part of the deployment.
- **Timezone:** reading categorization uses the browser's local timezone
  (America/Toronto host). TOU windows (7–11/11–17/17–19, winter/summer split
  Nov 1–Apr 30) assume Ontario local time — viewing from another TZ shifts
  bar boundaries.
- **Next.js version:** pin bumps must come with the advisory they fix (the
  16.3.0 bump was security-driven, see DECISIONS.md).
- **Disk full on .110 during a rebuild:** docker there runs the `vfs` storage
  driver, so every build layer is a full file copy and `no space left on device`
  surfaces deep inside `RUN npm run build`. Check `df -h /` first; if it is at
  100%, `docker builder prune -f` (build cache only — never touches running
  containers) reclaimed ~26 GB on 2026-10-02.

## DMD automation (Wave J) — refresh without a manual export

`ops/dmd/` keeps Mark's data fresh by driving Oakville Hydro's **own web UI**
with Mark's **own** credentials, on `.110`, twice a week. No other account is
ever touched, no credential enters this repo or the container image, and the
result lands in the browser through the same path a hand upload takes.

### The portal, as actually probed (2026-10-06, unauthenticated)

```
https://greenbutton.oakvillehydro.com/      302 → /home
                                            302 → /login?authorization_error=true
                                            302 → myaccount.oakvillehydro.com/page/login?r=<return>
```

- Angular Material login: `#mat-input-0` (Email Address), `#mat-input-1`
  (Password), submit button labelled **SIGN IN**, inside `form.login-form`.
- **No interactive CAPTCHA on the login page** (probe returned `captcha: []`).
  The only reCAPTCHA references are Firebase App Check / `RECAPTCHA_SETTINGS`
  — invisible token minting, not a challenge a human solves.
- The Green Button host is a separate Spring Boot app (it serves a JSON 404
  body and sets a `SESSION` cookie); everything under it is auth-gated, so
  the post-login DOM **cannot** be inspected without credentials.
- `selectors.json` therefore carries the login selectors (verified) and
  **provisional** post-login selectors (heuristic, unverified).

**First authenticated run must be `dmd_refresh.py --recon`**, which logs in
and dumps url/links/buttons + a DOM artifact to
`~/electricity-data/failed/<ts>-recon/`. Pin the real selectors in
`selectors.json` from that dump before trusting the crontab entry.

### Files

| Path | Role |
| --- | --- |
| `ops/dmd/dmd_refresh.py` | the automation (Playwright, headless) |
| `ops/dmd/selectors.json` | the whole flow as data — a portal redesign is an edit here, not a code change |
| `ops/dmd/dmd_export_b64.py` | base64 hand-off helper for `/import` |
| `ops/dmd/check_dmd_freshness.py` | staleness watchdog (installed below) |
| `ops/dmd/install.sh` | idempotent .110 setup |
| `ops/dmd/tests/` | unit + mock-portal end-to-end suite |

### Credentials (hard requirements)

- Live only in `~/electricity-dashboard/ops/dmd/.env` on .110 — **chmod 600**.
- Gitignored twice over (root `.gitignore` `.env` + an explicit
  `ops/dmd/.env` line) and outside the Docker build context, which is
  `./webapp` only.
- `dmd_refresh.py` refuses to start (exit 8) when the file is group/world
  readable **or tracked by git** (`git ls-files`, not `.gitignore`, is the
  authority). No value is ever printed: error messages name the key, never
  the content, and the suite asserts the password never reaches logs, state
  or the inbox.
- Session state: Playwright's context is in-memory; the browser profile lives
  under `TMPDIR=/run/dmd-browser` (tmpfs) and is deleted at process exit.
  No trace, no video, and **screenshots are only ever taken of post-login
  pages**, so no artifact can carry a typed password.
- Setup: `bash ops/dmd/install.sh` (creates the template if absent; it never
  fills values in). Entering the credentials is a human step on .110.

### Schedule

```
0 4 * * 1,4  /usr/bin/flock -n /tmp/dmd-refresh.lock python3 ~/electricity-dashboard/ops/dmd/dmd_refresh.py >> ~/electricity-data/logs/cron.out 2>&1
```

Mon + Thu 04:00 America/Toronto (off-peak, 2× weekly). `flock -n` means a run
that somehow outlives its window is skipped rather than stacked.
**Provisional** — confirm with Mark before treating it as final.

### Failure visibility

- Every run appends to `~/electricity-data/logs/dmd_refresh.log` and exits
  non-zero on any problem (table below). Structural/auth/challenge failures
  additionally dump the post-login DOM + screenshot to
  `~/electricity-data/failed/<ts>-<code>/`.
- **Staleness watchdog:** `check_dmd_freshness.py` is installed at
  `~/.hermes/profiles/soft-dev/scripts/` (copy from `ops/dmd/` when it
  changes) and runs as Hermes cron job **`1b7177616200`**, daily 07:30,
  `no_agent`, delivering to Mark's WhatsApp. Empty stdout = nothing sent
  (watchdog pattern); it reports when the last success is older than 7 days
  or has never happened, and one-lines a ⚠️ if the check itself fails.
  Until the first successful export it will report daily — that is the
  outstanding gate, not a bug.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | a new export was filed |
| 2 | bad usage / unreadable `selectors.json` |
| 3 | authentication rejected |
| 4 | download identical to the previous success (no new data) |
| 5 | interactive challenge — CAPTCHA or MFA; a human is required |
| 6 | portal structure changed; `selectors.json` needs the `--recon` dump |
| 7 | payload is not importable Green Button XML (nothing written) |
| 8 | environment problem: `.env` missing, too permissive, or git-tracked |

Files are named `greenbutton_<UTC>.xml`, chmod 600, and **never overwritten**
(`-1`, `-2` suffixes on collision). State lives in
`~/electricity-data/state/last_success.json` (sha256, byte count, reading
count, timestamp).

### Ingestion into the browser (client-only, no backend)

The app has no server-side ingest and must not grow one, so the handoff is:

```bash
# on .110
python3 ~/electricity-dashboard/ops/dmd/dmd_export_b64.py          # summary
python3 ~/electricity-dashboard/ops/dmd/dmd_export_b64.py --b64    # payload
```

then either **drop the XML file** onto `https://electricity.markarslan.ca/import`
or **paste** the base64 there (`?d=<base64>` deep links work for small files).

`/import` parses with `parseGreenButtonUsagePoints` — the app's own parser, so
a file that loads there loads in the upload modal too — and writes
`localStorage.energy_data` + clears the example-data flag, the same two keys
`commitReadings` touches, then navigates to `/` so every hook re-seeds from
storage. **With readings already present it never writes**: it shows a review
(`webapp/src/lib/importPlan.ts`, unit-tested) with existing/incoming/overlap/
net-new counts and two explicit choices — *Merge* (union, the file wins an
overlapping timestamp) or *Replace* — plus Cancel. Tests: `importPlan.test.ts`
(pure) and `tests/e2e/import.spec.ts` (runs in CI's smoke job).

### ToS / ethical guardrail

This automates **Mark's own account** through the **same web UI a human uses**
— no API bypass, no credential sharing, no other customer's data, 2 runs per
week. Guardrails, in force:

1. Oakville Hydro publishes **no terms-of-use page** (`/terms-of-use` → 404;
   the footer links only Privacy Policy and Accessibility). If a terms page
   appears, or the post-login UI carries terms that prohibit automated access
   to Download My Data, **STOP and flag to Mark before the next run** — do not
   silently continue.
2. **CAPTCHA:** if an interactive challenge appears the script exits 5 and
   does not proceed. No CAPTCHA-solving service, ever. (Invisible reCAPTCHA
   tokens are not a challenge and are not defeated.)
3. **MFA:** an OTP step also exits 5. We do not read Mark's second factor.
4. Rate: 2 sessions/week, one at a time (`flock`), sequential page loads at
   human pacing — no parallel requests, no endpoint hammering.

### Gate status

| Gate | Status |
| --- | --- |
| Script runs green on the real portal | **BLOCKED on Mark entering credentials once on .110**, then `--recon` to pin post-login selectors, then one supervised run |
| Fresh XML parses cleanly through the app's parser | automated for synthetic input (`tests/e2e/import.spec.ts`, CI); **real export verified on first ingestion at `/import`** |
| Ingestion into localStorage verified on the deployed instance | `/import` e2e spec against the built container |
| Cron visible in crontab | `crontab -l` shows the `dmd_refresh.py` line after `install.sh` |
| Runbook documented | this section |
| Mechanics of the whole flow | **verified** against `ops/dmd/tests/mock_portal.py` — every exit code above is exercised end to end on .110 |

