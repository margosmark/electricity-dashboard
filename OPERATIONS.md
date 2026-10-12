# Operations runbook — electricity dashboard

Daily-driver operations for the deploy at `~/electricity-dashboard`.

**Three containers, one host port (3939):**

| Container | Job |
| --- | --- |
| `edge-router` | nginx on host `:3939` — `/greenbutton*` → shim, everything else → app |
| `greenbutton-shim` | the Connect My Data shim; the ONLY container with `GB_*` env and the token mount |
| `energy-dashboard` | the dashboard; no Green Button env, no token mount |

**Public URL:** https://electricity.markarslan.ca/ (Let's Encrypt TLS, edge
proxy fronting `:3939`; localhost health checks still work at :3939).

Which container answered a request: every response carries
`x-gb-process: app` or `x-gb-process: shim` — set **by the serving process**
from its own config — plus `X-Edge-Location: default|greenbutton`, which is
which nginx branch matched. The pair must agree (see §5 of
GREENBUTTON-CMD.md); a location-derived header on its own cannot answer this
question and did not, on 2026-10-07.

## Start / stop / update

```bash
~/bin/deploy-energy-dashboard.sh   # serialized deploy: fetch + reset + rebuild (flock-guarded)
cd ~/electricity-dashboard && docker compose down   # stop
```

The deploy script (`~/bin/deploy-energy-dashboard.sh` on .110) refuses to run
concurrently (`DEPLOY_REFUSED`, exit 3) so sibling agents can't swap the image
mid-verification. `--no-fetch` skips the git step for tar-pushed deploys.

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
| Account API **off** | same URL → `404` with `x-gb-process: app` — indistinguishable from "no such route" |
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
encrypted copy in `.account/accounts.db` is a second source (see
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
| Set credentials after Oakville issues them | put `GB_CLIENT_ID` / `GB_CLIENT_SECRET` in the untracked `.env` (never in `docker-compose.yml`), then `docker compose up -d` — no rebuild |
| Scope no longer accepted by the platform | change `GB_SCOPE`, `docker compose up -d` |
| Turn PKCE on (once Oakville confirms the platform accepts `code_challenge`) | `GB_PKCE=true` in the untracked `.env`, then `docker compose up -d greenbutton-shim` |
| Re-run the full OAuth loop | `cd webapp && ./scripts/e2e-greenbutton-loop.sh` (29 checks, needs docker only for the second) |
| Re-run it through the **containerised router topology** | `cd webapp && ./scripts/e2e-greenbutton-topology.sh` (46 checks, incl. recreating both upstreams under a running router; binds :3940 + :8099, tears itself down) |
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
defaults to `false`, so a deploy of this change is a no-op for the site. To
enable it (and to disable it again), set `ACCT_ENABLED=true` in the untracked
`.env` and `docker compose up -d account-server`; the data file stays on disk
whichever way it is set, and the container stays running either way so the
path answers 404 rather than 502.

```bash
# one-time: turn the feature on. Push keys and the shared shim→account token
# both go in the untracked .env, never in docker-compose.yml.
cd ~/electricity-dashboard/webapp && npx web-push generate-vapid-keys   # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
openssl rand -hex 32                                                     # → ACCT_INTERNAL_TOKEN
cd .. && printf 'ACCT_ENABLED=true
' >> .env
docker compose up -d account-server
docker compose up -d --build edge-router   # the /account locations are BAKED into that image
```

The router rebuild is only needed when `ops/edge/default.conf.template`
changes; the `/account/*` locations shipped with this change, so it is a
one-time step for this upgrade.

| Check | Command / expectation |
| --- | --- |
| Service up | `docker compose ps` → `account-server` running |
| API answers | `curl -fs http://localhost:3939/account/session` → `{"enabled":true,…}` |
| Right container answered | response carries `x-gb-process: account` **and** `X-Edge-Location: account` (a mismatch = the split is inverted, H1's failure mode) |
| Push configured | same payload has `pushConfigured:true` once `VAPID_*` are set; `false` means sync works and notifications are simply inert |
| Data file | `sudo ls -l .account/` → `accounts.db` (created on first register) |

**Backup.** `.account/accounts.db` is user data — ciphertext, but theirs. It
is a bind mount for exactly that reason: include `.account/` next to
`.greenbutton/` in whatever copies this host's state off-box. SQLite runs in
WAL mode here, so a *live* copy of `accounts.db` alone can be behind by the
last few writes — copy `accounts.db`, `accounts.db-wal` and `accounts.db-shm`
together with the service stopped (a second of downtime at family scale):

```bash
cd ~/electricity-dashboard
docker compose stop account-server && sudo cp -a .account "/backup/account-$(date +%F)" && docker compose start account-server
```

Losing the file costs the *server* copy only: every device that still holds
the derived key and its own `localStorage` is unaffected, and re-registering
starts a fresh account.

**Passwords.** There is no SMTP and no reset e-mail. A one-time recovery code
is shown once, at the first upload into an account, and stored only as an
argon2id hash. It is enforced in the UI and in `SECURITY.md` §5:

- code + forgotten password → a new password can be set, but the stored blob
  (encrypted with the old one) is dropped — the code recovers the *account*,
  not the data; re-sync from a device that still has it.
- no code → the server copy is unrecoverable; local data is untouched and a
  new account can be registered.

**VAPID rotation.** Replacing `VAPID_PRIVATE_KEY` invalidates every existing
subscription silently (pushes fail and are dropped as dead on a 410). After a
rotation, sign in → Notifications → turn off, then on, on each device.

**Account ceiling.** `ACCT_MAX_ACCOUNTS` (default 10) bounds registration —
registration is deliberately unauthenticated (no invite loop), so the cap plus
the attempt budget below are what actually bound it. Hitting it returns `403
account_limit`.

**Attempt budget.** `login`, `recover` and `register` refuse after a bounded
number of attempts (token buckets per e-mail, per source address and
process-wide — `webapp/src/lib/account/ratelimit.ts`), answering `429` with a
`Retry-After` header instead of a generic error. Operational notes:

- Counters are **in the account-server process**. `docker compose restart
  account-server` clears them; that is a convenience for you and not a hole,
  because nobody else can restart it.
- A user who mistypes their password eight times in fifteen minutes sees
  `429 rate_limited` for up to a minute or two. It is a refillable budget,
  not a lockout: no state, no unlock procedure, no operator action.
- If you ever need to see why a request was refused, the body carries
  `retryAfterSeconds` and the header carries the same number.

### Removing an account (undoes `ACCT_MAX_ACCOUNTS` squatting)

Registration is open, so a stranger who reaches the endpoint can occupy all
ten slots with junk e-mail addresses. The attempt budget makes that slow, the
cap makes it finite, and this makes it reversible — `sessions`, `blobs`,
`push_subs` and `push_prefs` all carry `ON DELETE CASCADE`, so one statement
cleans the whole account:

```bash
cd ~/electricity-dashboard
docker compose stop account-server
# -cmd is not decoration: sqlite3 starts with foreign_keys OFF, so without
# the PRAGMA this DELETE would leave orphaned sessions/blobs/subscriptions.
sudo sqlite3 -cmd "PRAGMA foreign_keys=ON;" .account/accounts.db \
  "DELETE FROM accounts WHERE email = 'squatter@example.com';"
docker compose start account-server
sudo sqlite3 .account/accounts.db "SELECT id, email, datetime(created_at/1000,'unixepoch') FROM accounts;"
```

Nothing else needs doing: the squatter never held a session that survives the
delete, their ciphertext (if any) goes with the row, and their push
subscriptions are dropped by the cascade. To free every slot at once,
`DELETE FROM accounts;` — every other device keeps its local `localStorage`
copy, because the server copy is the only thing being removed.

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

Then commit/push and rebuild the container. CI's workflow is
**disabled server-side** (2026-10-10, Actions minutes exhausted — push/PR
runs died in 3–4s with zero steps scheduled, so the run-history reds were
billing, not failures; see the header in
`.github/workflows/ci.yml` and the note in README). The gate order above
is the gate, and merges land on local-green. The triggers on main are
`workflow_dispatch`-only as of 2026-10-11, so `gh workflow enable CI`
alone cannot resurrect the push/PR reds — but there is still no CI
budget, so leave the workflow disabled until Actions minutes are topped
up. The `husky` pre-commit hook runs on every local commit.

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

