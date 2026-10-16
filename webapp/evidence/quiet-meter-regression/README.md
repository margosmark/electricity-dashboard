# Quiet Meter behavioural regression — evidence (t_f6c32622)

Real-app browser regression over the accepted Quiet Meter redesign. Everything here
was produced by the running production build, not the static design artifact.

## The one command

```
webapp/scripts/e2e-quiet-meter-regression.sh
```

Builds (unless `E2E_QM_SKIP_BUILD=1`), boots `next start` on `PORT` (default 3210),
runs `tests/e2e/quiet-meter-regression.spec.ts` against it, writes the four
screenshots + `geometry.json` into this directory, and exits non-zero if any check
fails. `E2E_QM_BASE=http://host:port` drives an already-running stack instead.

## What the run asserted (9/9 passed — twice in a row: 45.7s, then 23.4s)

| # | Check |
|---|---|
| 1 | Exactly Overview / Plans / Money exist as tabs; no Usage tab; `#tab=usage` cold link lands on Overview, not a resurrected panel |
| 2 | Selecting a tab swaps exactly its panel (one `role=tabpanel` at a time, `aria-controls`/`aria-labelledby` wired); Arrow/Home/End move focus **and** selection; one roving tab stop |
| 3 | Light ↔ dark repaints the document (background **and** `--ink` token differ), choice survives reload, zero console/page errors |
| 4 | Period heading; exactly four summary figures, each checked against its own source (dataset strip kWh, efficiency strip `data-cents`, projection banner amount, plan card window cost); projected amount carries the inline **Provisional** marker; days-measured ≤ days-in-month |
| 5 | Rate-by-month: axis gridlines read 0,2,4,…,14; every mark is `tabindex=0` + `role=img` + self-naming; focus **and** hover drive the live readout; the semantic table's rows correspond 1:1, in order, to the marks |
| 6 | Your plan / Needs attention: cheapest alternative **is** the argmin of the window costs, saving = current − argmin (never negative, $0.00 when already on the winner); whole-dataset chips carry the same argmin property and the best-vs-worst figure is argmax − argmin; clean state renders no attention item and says so |
| 7 | Rate-alert state (injected through the app's own `oeb_staleness_check` session contract): exactly one attention item, owning a remedy link; in Money the alert is announced (`role=alert`) and ordered **decomposition → alert → pace** |
| 8 | Projection gate closed (real upload of `tests/fixtures/utility-hydro-one.xml`, readings end 2025-12-10): `data-state="gated"`, no invented amount or Provisional marker, tile shows `—` plus the gate's own reason |
| 9 | 390×844 dark **and** light: no document horizontal overflow, no interactive target under 44px, three tabs still in the strip — plus the four screenshots |

## Evidence

| File | Viewport / theme |
|---|---|
| `overview-1440-light.png` | 1440×900 light |
| `overview-1440-dark.png` | 1440×900 dark |
| `overview-390-light.png` | 390×844 light |
| `overview-390-dark.png` | 390×844 dark |
| `geometry.json` | per-viewport overflow + undersized-target counts, the served build identity, and the console-error exemptions this run relied on |

All four are the Overview tab in the full seeded data state (example readings +
24 closed bills + a live current month), captured from the live app.

## Identity of what was tested

`geometry.json.servedBuild` is the `/api/version` answer at capture time;
`gitHead` is the commit the tree was at. They are recorded rather than assumed
because `.next` in this worktree is shared with other agents' runs and was
rebuilt several times during this task (BUILD_ID `XOqXaJ…` → `lPso68…` →
`630hOX…` → `oxaN0sP…`). The captured run: buildId `oxaN0sPwNpcOxte2xxxi5`,
served SHA `efe1e4f6672355349ae280cb6fa197243351bd08` = the tree's HEAD, with no
modified source files at capture time — only untracked evidence.

## Console-error policy

Uncaught page errors and console errors fail the run. Two exemptions, both
deployment topology rather than UI behaviour, both printed in
`geometry.json.consoleErrorExemptions`:

- resource loads outside the app (a third-party feed outage is not a UI defect);
- `/account/session` and `/account/notify` answering **404** on a bare
  `next start` that has no account backend. Only those two paths, only a 404.

## Production changes

None. This run owns `tests/e2e/quiet-meter-regression.spec.ts`,
`scripts/e2e-quiet-meter-regression.sh` and this evidence directory only.
