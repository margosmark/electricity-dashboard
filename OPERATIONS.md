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
