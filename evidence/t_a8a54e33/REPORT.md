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
