# Electricity Dashboard

Advanced analysis of your **Oakville Hydro Green Button** electricity data —
upload the XML export, and the dashboard compares what your usage *would have
cost* on Ontario's three rate plans (Time-of-Use, Tiered, Ultra-Low
Overnight), estimates your always-on "vampire" base load, flags unusual
spikes, and visualizes usage habits with a weekday × hour heatmap and
drill-down zoom (monthly → weekly → daily → hourly).

**Everything is client-side**: your XML is parsed in your browser and cached
in `localStorage` — no server, no database, no data leaving your machine.

Where Oakville Hydro's *Connect My Data* is available, the app can also pull
your readings automatically over OAuth2 instead of making you re-export the
file. Same rule applies: the feed is streamed through and parsed **in your
browser**, and the server keeps only the OAuth token set.
See [GREENBUTTON-CMD.md](GREENBUTTON-CMD.md).

## Quick start

```bash
docker compose up -d
```

Open **http://localhost:3939**, then click *Upload* and pick your Green
Button XML file from Oakville Hydro. Done.

## What you get

| Feature | Where |
| --- | --- |
| Three-plan cost comparison (TOU vs Tiered vs ULO) per period | top cards |
| Auto-refresh from Oakville Hydro (Connect My Data, OAuth2) | toolbar → *Authorise with Oakville Hydro* (once registered) |
| Whole-dataset totals: kWh + per-plan cost + best-vs-worst $ gap, *since your first reading* | totals strip |
| First load opens a data-full window (never a mostly-future billing period) | date range |
| Usage chart with weekend bars highlighted (daily view) | Chart tab |
| Zoom: monthly → weekly → daily → hourly (click a bar) | Chart tab |
| Billing-period anchoring to *your* billing day (persisted) | scope buttons |
| "Vampire" always-on load estimate (5th-percentile hourly base) | Insights |
| Usage anomaly detection (per-weekday expected, >1.5× & >5 kWh spikes) | Insights |
| Weekday × hour heatmap of habits | Insights |
| Real Ontario rate history (Nov 2023 / Nov 2024 / Nov 2025 OEB sets) | `/api/rates` |

## Where your data lives

Nothing about your usage is stored server-side — that rule is the same for
the manual XML upload and for the Connect My Data feed:

| Thing | Where it lives |
| --- | --- |
| Readings / intervals | your browser's `localStorage` only |
| OAuth **refresh token** | one file on the host: `~/electricity-dashboard/.greenbutton/tokens.json`, mode `0600`, outside every container (bind-mounted into the shim as `/var/lib/greenbutton/tokens.json`) |
| OAuth access token | the same file, plus the shim's memory |
| Browser session | an HttpOnly `gb_session` cookie — not an OAuth credential |
| Anything else | nowhere: no database, no logs of token values, no readings on disk |

Full detail: [`webapp/src/lib/greenbutton/README.md`](webapp/src/lib/greenbutton/README.md)
and [`GREENBUTTON-CMD.md`](GREENBUTTON-CMD.md) §3.

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the two generations (Streamlit
  prototype → Next.js webapp) fit together, and the client-side pipeline
- [`OPERATIONS.md`](OPERATIONS.md) — run it, update it, refresh Ontario rates
- [`DECISIONS.md`](DECISIONS.md) — why it's built this way, and what was rejected
- [`REGISTRATION-OAKVILLE.md`](REGISTRATION-OAKVILLE.md) — Mark's step-by-step
  for Oakville Hydro's third-party registration form (every field value,
  copy-paste ready)
- [`GREENBUTTON-REPOINT.md`](GREENBUTTON-REPOINT.md) — the one command that
  switches the shim from unconfigured to a real custodian, the checks it runs
  before it writes anything, and how to roll it back

## Development

```bash
cd webapp
npm ci && npm run dev        # http://localhost:3000, proxies same routes
npm run test                 # vitest
npm run typecheck && npm run lint

# layout gate: the toolbar's dead-band budgets, swept across every
# breakpoint. Needs a server on :3107 — a build plus either
# `npm run start -- -p 3107` or `node .next/standalone/server.js`
# (what CI's container runs)
SMOKE_BASE_URL=http://localhost:3107 npx playwright test toolbar-layout

# dark-mode regression suite: the theme store + toggle pins (vitest), then the
# FOUC, toggle/persistence and per-panel contrast specs against a local
# production build it starts itself. Writes evidence/dark-mode-regression.json.
# Actions is workflow-disabled, so this IS the gate — run it before touching
# globals.css or any themed ink.
npm run test:theme
```

Python parser prototype (legacy, tests only):

```bash
pytest tests/ -v
```

CI is **workflow-disabled** (2026-10-10): GitHub Actions minutes are
exhausted on this account, so every push/PR run died in 3–4s with zero
steps scheduled — the reds in the run history are billing, not test
failures. The gate above IS the gate. `.github/workflows/ci.yml` still
defines the three jobs (`frontend`: lint/typecheck/test/build, `smoke`:
container boot + HTTP + Playwright — carrying the toolbar
layout-regression gate `webapp/tests/e2e/toolbar-layout.spec.ts`, 15 vw/vh
viewports, 90 checks, see `DECISIONS.md` — plus both Lighthouse budgets,
`python`: pytest) for when billing returns. The file's triggers are
`workflow_dispatch`-only as of 2026-10-11, so re-enabling the workflow
cannot fire on push/PR — leave it disabled until Actions minutes are
topped up; the three jobs above stay runnable by hand the moment billing
returns.
