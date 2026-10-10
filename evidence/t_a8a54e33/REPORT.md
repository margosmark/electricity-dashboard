# t_a8a54e33 — Durable versioned storage layer: verification report

Branch: `electricity/t_a8a54e33-electricity-webapp-p1-durable-versioned`
Run: 2026-10-02 (EDT) · Stack: `webapp/` only (no Python source touched)

## What shipped

| File | Change |
|---|---|
| `webapp/src/lib/storage.ts` | **New** storage service: versioned key `energy_data_v2`, payload `{version, uploadedAt, source, points}`, migrate-on-read from legacy `energy_data` (v1 bare array), `billing_day` read/write, export/import serialization + validation, scoped reset. Every failure returns a discriminated union `{ok:true,value,warnings} \| {ok:false,reason:'quota'\|'corrupt',detail}` — nothing is swallowed. |
| `webapp/src/components/Dashboard.tsx` | All `localStorage` calls removed from the component; wired to `storage.ts`. Visible `role="alert"` notice row on any failed read/write; Export button (JSON download); Import button in nav **and** in the upload modal; `emergencyReset` replaced by a two-step confirm dialog that removes only this app's keys (never `localStorage.clear()`). |
| `webapp/src/lib/storage.test.ts` | **New** — 16 tests. |
| `webapp/src/components/Dashboard.test.tsx` | +2 tests (corrupt-data notice, two-step scoped reset). |

## Gates (final run)

| Gate | Baseline (pm) | After | Verdict |
|---|---|---|---|
| `npm run test` (vitest) | 56 passed / 2 files | **74 passed / 3 files** (+18, ≥ +6 required) | PASS, exit 0 |
| `tsc --noEmit` | clean | **clean**, exit 0 | PASS |
| `eslint .` | 0 errors / 10 warnings | **0 errors / 9 warnings**, exit 0 | PASS |
| `next build` | ✓ | **✓** (Next.js 16.3.0, Turbopack) | PASS |
| `pytest tests` | 7 passed | **7 passed in 0.23s** | PASS (no Python touched) |

New tests cover the acceptance list: migration v1→v2, corrupt-JSON path (v2 + legacy), quota path (mocked `setItem` throwing), export→import round-trip (48 points preserved), `billing_day` persistence, plus schema rejection, reset scoping and migration-under-quota.

## Headless journeys (Chromium via Playwright, prod `next start` on :3111)

`journey-report.json` — **31/31 checks passed, 0 failed, 0 console errors**, exit 0.

| # | Journey | Key evidence (numbers) | Screenshot |
|---|---|---|---|
| J1 | upload XML → chart renders | 768 points parsed → persisted under `energy_data_v2` (`version=2 source=xml-upload`); 1 monthly bar default, **33 daily bars** in YTD view; legacy key not written; unrelated key untouched | `j1-01-upload-modal.png`, `j1-02-chart-after-upload.png` |
| J2 | reload → data survives | no upload modal; **33 daily bars, pixel-identical to pre-reload** (`equal=true`); 768 points in storage | `j2-reload-survives.png` |
| J3 | export file → clear → import → identical chart | export 53,013 B JSON (`version=2 source=manual-export`, 768 points); two-step reset keeps data until confirm; after confirm: our keys = 0 left, `unrelated_app_key` survives; re-import restores 768 points and **33-bar fingerprint `equal=true`** | `j3-01-before-reset.png`, `j3-02-reset-confirm.png`, `j3-03-after-import.png` |
| J4 | reset → back to upload modal | modal reappears; `energy_data_v2`/`energy_data`/`billing_day` all absent; `unrelated_app_key=keep-me` still present | `j4-reset-back-to-upload-modal.png` |
| J5 | legacy v1 key migrates on read | seeded `energy_data` (49 pts) + `billing_day=20` → chart renders, `energy_data` removed, `energy_data_v2.version=2 source=legacy-migration`, billing-day input `20`, **no notice row** | `j5-legacy-migration.png` |
| J6 | quota failure → visible error row (real Chromium quota) | storage ceiling measured at **5,242,872 B**, 10,000 B headroom left; upload write threw `QuotaExceededError` → row shows **"Data too large for browser storage — export and clear old data"** + detail; `energy_data_v2` never silently written; chart still renders in-memory and Export stays enabled | `j6-quota-error-row.png` |

## Reproduce

```bash
cd webapp && npm ci && npm run build && npx next start -p 3111 &
cd ../evidence/t_a8a54e33 && node journeys.cjs     # needs playwright 1.63 (chromium-1234/1243 cached)
```

---

# Post-merge re-run (t_1969b89e — landed on main)

The branch was merged into main, which had moved42 commits (Wave R IA shell,
Wave K CMD, dependabot majors). Every gate below was re-run against the
**merged** tree; the journeys were re-run against a fresh `next start` build
of it.

| Gate | main before merge | merged | Verdict |
|---|---|---|---|
| `npx vitest run` | 965 tests — 964 passed, 1 pre-existing `SeasonBand` timeout | **983 passed / 0 failed** (965 + the 18 storage tests) | PASS |
| `npm run lint` | clean | **clean** | PASS |
| `tsc --noEmit` | clean | **clean** | PASS |
| `next build` | ✓ | **✓** | PASS |
| Playwright e2e smoke (real Chromium vs `next start` :3111) | not run (CI billing-blocked) | **21 passed / 3 skipped / 0 failed** | PASS |
| journeys (this folder, re-run) | — | **31/31, 0 console errors** | PASS |

`grep -rn "localStorage" webapp/src` shows no raw `setItem('energy_data'` left:
readings are written by `lib/storage.ts` — from `useEnergyData` (upload, sync,
import), from `/import`, and from Wave G's backup import.

Numbers that moved with the new shell (harness updated, not the feature):

- the chart lives on the **Usage** tab since Wave R, so `journeys.cjs` opens it
  before counting bars;
- YTD/daily draws **34 daily bars** (was 33 — the window is 32 days of hourly
  data, cut on today's clock);
- an upload's payload `source` is **`upload`**, the hook's own vocabulary
  (`xml-upload` was the old component's literal).

Everything else is the same evidence as the branch run: 768 points persisted,
export 53,013 B, two-step reset scoped to this app's keys, legacy v1 migration,
and the quota row on a real Chromium quota.

**Coexistence with Wave G** (task item 4): `lib/backup.ts` is untouched and
still owns the full-profile document. `useEnergyData.importBackupFile` now
accepts BOTH documents — the profile JSON and the readings-only export
`storage.ts` writes — and routes the readings + billing day through
`storage.ts`, so there is no second writer of those keys. `extra_charges` and
`plan_timeline` stay with their own hooks.

The e2e specs moved with the same contract: they read rows from
`energy_data_v2` (a null-safe `?.points`), and the upload input is addressed by
its `aria-label` now that the modal carries a second (JSON import) file input.
