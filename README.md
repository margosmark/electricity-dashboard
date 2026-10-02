# Electricity Dashboard

Advanced analysis of your **Oakville Hydro Green Button** electricity data —
upload the XML export, and the dashboard compares what your usage *would have
cost* on Ontario's three rate plans (Time-of-Use, Tiered, Ultra-Low
Overnight), estimates your always-on "vampire" base load, flags unusual
spikes, and visualizes usage habits with a weekday × hour heatmap and
drill-down zoom (monthly → weekly → daily → hourly).

**Everything is client-side**: your XML is parsed in your browser and cached
in `localStorage` — no server, no database, no data leaving your machine.

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
| Usage chart with weekend bars highlighted (daily view) | Chart tab |
| Zoom: monthly → weekly → daily → hourly (click a bar) | Chart tab |
| Billing-period anchoring to *your* billing day (persisted) | scope buttons |
| "Vampire" always-on load estimate (5th-percentile hourly base) | Insights |
| Usage anomaly detection (per-weekday expected, >1.5× & >5 kWh spikes) | Insights |
| Weekday × hour heatmap of habits | Insights |
| Real Ontario rate history (Nov 2023 / Nov 2024 / Nov 2025 OEB sets) | `/api/rates` |

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
