# Decision log — why the electricity dashboard is built this way

Short, dated, in newest-first order. Each entry: the decision, why, and what
was rejected.

| Date | Decision | Why | Rejected |
| --- | --- | --- | --- |
| 2026 (CI wave, #2) | Two-job CI: webapp (lint/typecheck/vitest/build) + Python (pytest for `parser.py`) | The repo carries both the legacy Streamlit parser and the live webapp; each layer is gated by the tests that own it | Single combined job (slower, mixes toolchains) |
| Mid-2026 | Weekend bars in the daily view get orange-highlighted by `getBarColor` (PR #1, `feature/weekend-bar-colors`) | Weekend consumption patterns differ; color makes weekly rhythm visible at a glance | Separate toggle/legend — visual, zero UI cost |
| Mid-2026 (be3fdf6) | Comprehensive test suite + `husky` pre-commit hook | Money-adjacent math (rate comparisons drive real spend decisions); regressions in `classifyTOU`/tier proration would be silent otherwise | Manual verification only |
| Mid-2026 (d57c49c) | Bumped Next.js to 16.3.0 purely for security advisories | Self-hosted container with `restart: always` running unattended; patch level matters more than feature parity | Staying on the older major |
| Mid-2026 (fd1465c) | `.worktrees/` ignored for kanban worktree-per-task isolation | Bot tasks on this board run in git worktrees; worktree dirs must never be committed | Per-task clones (heavier) |
| Design-time | Next.js webapp replaces the Streamlit prototype; Streamlit kept but frozen | Streamlit can't do client-side file parsing + persistent local state in a deployable single container; Next.js standalone works in compose with no backend | Rewriting Streamlit further; adding a DB |
| Design-time | **No server-side data storage at all** — uploads parse in-browser, cache to `localStorage` | Privacy: hydro consumption data never leaves the machine; zero server state to secure or back up | Upload endpoint + Postgres (a finance-grade backend is wrong for one-user notes) |
| Design-time | Rate history as versioned `RateSet`s in `/api/rates`, matched per reading date | Ontario rates change annually (e.g. ULO on-peak 24→28.6→39.1¢/kWh across the three sets); per-date matching makes historical cost math reproducible instead of rewritten on each update | One current rate constant (wrong retroactively) |
| Design-time | Compute all three plans (TOU, Tiered, ULO) per interval regardless of selected plan | The product's whole point is *comparison*; a readings-time single-plan pipeline would need a recompute per plan switch | Computing only the selected plan |
| Design-time | Tier thresholds prorated `(days/30.4)` per aggregation bucket | OEB tiered thresholds are monthly allowances;Two-tier math must respect bucket length or short months overcharge tier2 | Fixed monthly threshold on any bucket |
| Design-time | "Vampire" base load = 5th-percentile hourly draw, not the minimum | A single minimum hour is noise (one sensor hiccup); the 5th percentile is a stable "always-on" estimate | min() as in the Streamlit prototype |
| Design-time | All analytics as pure functions in `lib/energy.ts`; `Dashboard.tsx` only state/markup | Testability without rendering; the dashboard stays a thin shell | Mixing math into components |
| Design-time | Neobrutalist UI language (thick borders, hard shadows, yellow highlights) | Deliberate visual identity (the repo predates it: `b4ae405` era); no design-system dependency to maintain | shadcn/Tailwind default look |
