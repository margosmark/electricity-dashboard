# Operations runbook — electricity dashboard

Daily-driver operations for the deploy at `~/electricity-dashboard`
(container `energy-dashboard`, host port **3939** → container 3000).

**Public URL:** https://electricity.markarslan.ca/ (Let's Encrypt TLS, edge
proxy fronting the container; localhost health checks still work at :3939).

## Start / stop / update

```bash
~/bin/deploy-energy-dashboard.sh   # serialized deploy: fetch + reset + rebuild (flock-guarded)
cd ~/electricity-dashboard && docker compose down   # stop
```

The deploy script (`~/bin/deploy-energy-dashboard.sh` on .110) refuses to run
concurrently (`DEPLOY_REFUSED`, exit 3) so sibling agents can't swap the image
mid-verification. `--no-fetch` skips the git step for tar-pushed deploys.

Code delivery on hermescomputer (.110): **native git works** — the host holds a
read-only GitHub deploy key (`~/.ssh/ed25519_deploy`, key id 165177015,
read_only=true, scope limited to this repo) and `~/.ssh/config` pins it for
`github.com`. `git pull` and the deploy script's fetch/reset both work
verbatim, no tar push needed:
`code changes → push to GitHub → ssh hermescomputer '~/bin/deploy-energy-dashboard.sh'`

There is no `.env`, no secrets, no volumes — a rebuild is always safe.

## Health checks

| Check | Command / expectation |
| --- | --- |
| Container up | `docker compose ps` → `energy-dashboard` running |
| Serves the app | `curl -fs http://localhost:3939/` → HTML containing "Ontario Energy Optimizer" |
| Rates API | `curl -fs http://localhost:3939/api/rates` → JSON with `historicalRates` (3 sets) |
| Logs | `docker compose logs -f energy-dashboard` |
| Reparse in browser | Upload modal re-appears only if `localStorage.energy_data` is absent |

## Data model (user-visible)

Nothing is stored server-side. The browser holds:

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
else to back up.

## Data source

Oakville Hydro → download Green Button export (XML, hourly interval readings,
Wh values). The file is parsed in-browser by `parseGreenButtonXML`
(`webapp/src/lib/energy.ts`); unit conversion is Wh→kWh divide-by-1000, and
timestamps are unix UTC converted implicitly by `new Date(...)` to local time
for categorization.

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

Then commit/push (CI runs the same gates on push/PR to main) and rebuild the
container. The `husky` pre-commit hook runs on every local commit.

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

