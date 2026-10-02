# Operations runbook — electricity dashboard

Daily-driver operations for the deploy at `~/electricity-dashboard`
(container `energy-dashboard`, host port **3939** → container 3000).

**Public URL:** https://electricity.markarslan.ca/ (Let's Encrypt TLS, edge
proxy fronting the container; localhost health checks still work at :3939).

## Start / stop / update

```bash
cd ~/electricity-dashboard
docker compose up -d --build     # build & (re)start; restart policy: always
docker compose down              # stop
git pull && docker compose up -d --build   # update after pulling
```

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
