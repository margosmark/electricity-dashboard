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

## Development

```bash
cd webapp
npm ci && npm run dev        # http://localhost:3000, proxies same routes
npm run test                 # vitest
npm run typecheck && npm run lint
```

Python parser prototype (legacy, tests only):

```bash
pytest tests/ -v
```

CI runs the webapp gate (lint/typecheck/test/build) plus the Python test job
on every push/PR to `main`.
