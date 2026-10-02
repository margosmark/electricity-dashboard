# Wave G — verification evidence (deployed stack)

Harness: `evidence/wave-g-verify.cjs` · Results: `evidence/wave-g-verification.json` (**33/33 checks pass**).

Reproduce from the worktree root:

```sh
TZ=America/Toronto NODE_PATH=webapp/node_modules node evidence/wave-g-verify.cjs
```

The script drives a real Chromium against `https://electricity.markarslan.ca`,
and performs a real `~/bin/deploy-energy-dashboard.sh` mid-run to prove the
service-worker update path.

## Gates

| Gate | Result |
|---|---|
| `npx vitest run` | **442/442** (26 files) |
| `npx tsc --noEmit` | **0 errors** |
| `npx eslint` | **0 problems** |
| `npm run build` | **exit 0** (Next.js 16.3.0, `prebuild` stamp ran) |
| CI on `origin/main` | green for `8f6647a`, `ed7f1b5`, `88d0e4e`, `962e879` |
| Deploy | `DEPLOY_OK at d95a66e` |

Commits: `8f6647a` (wave), `ed7f1b5` (harness), `88d0e4e` (Cancel fix found
while verifying), `962e879` (sw.js contract doc), `d95a66e` (fixtures findings).

## 1. Service-worker cache versioning (item 5)

`/sw.js` is byte-different per build; the browser installs the new worker and
`activate` drops every cache that does not start with the new `VERSION`.

| Deploy | Commit | `webapp/` context changed? | `const VERSION` |
|---|---|---|---|
| pre-wave | `b1b8f23` | — | `oeo-v1` (static, never changed) |
| 1 | `8f6647a` | yes | `oeo-v1-muri3l79` |
| 2 | `ed7f1b5` | no (evidence lives outside `webapp/`) | `oeo-v1-muri3l79` — identical artifact, correctly *not* re-installed |
| 3 | `88d0e4e` | yes (`Dashboard.tsx`) | `oeo-v1-murij9oo` |
| 4 | `962e879` | yes (`public/sw.js`) | `oeo-v1-murioyfb` |
| 5 | `d95a66e` | yes (`tests/fixtures/README.md`) | `oeo-v1-muritfqd` |

- `evidence/wave-g-sw-before.js` — the worker served **before this wave**,
  `oeo-v1`, sha256 `257c0b06ca451e992e2c772d5d37edc175b3a5d9f463bb108b4b48a20069ac02`
  (3 942 bytes, captured 17:52 EDT from the live URL; restored byte-identical
  from `git show b1b8f23:webapp/public/sw.js`).
- `evidence/wave-g-sw-after.js` — what that URL serves now,
  `oeo-v1-muritfqd`, sha256 differs.
- The rebuild-only-on-source-change behaviour above is Docker layer caching,
  not a bug: identical sources are an identical artifact and an installed PWA
  has nothing to re-install. The version *must* change exactly when the bundle
  changes, and does.
- Browser proof of the swap (final run): installed `oeo-v1-murioyfb-*` →
  deploy 5 → `updatefound` fired → caches re-keyed to
  `oeo-v1-muritfqd-shell` / `-runtime` and the old ones were deleted.
  Screenshots: `wave-g-sw-installed-before.png`, `wave-g-sw-updated-after.png`.

## 2. Backup / restore round-trip (item 1)

- Real Oakville Hydro export loads: **2 184 readings**.
- Export → `ontario-energy-optimizer.backup` **v1**, `payload.energy_data`
  carries all 2 184 rows (`wave-g-backup-export.local.json`, gitignored — real
  meter data).
- Stored data clobbered, then imported → restored snapshot is
  **byte-for-byte identical** (`JSON.stringify` equality), app usable, no
  first-run modal.
- Hostile backup (bad timestamp, `billing_day: "first"`) → rejected with
  `Row 1 has an invalid timestamp (got "not-a-number").` and the 2 184 rows
  stayed untouched.
- Screenshot: `wave-g-backup-roundtrip.png`.

## 3. DST boundaries (item 3)

Asserted through the app's own CSV export (`tou_category`, `ulo_category`):

- **Spring-forward 2026-03-08** (Sunday): exactly **23** hourly readings
  (143 for the file), CSV shows 23 rows, every row classified
  (`Off-Peak/Overnight`). Screenshot `wave-g-dst-spring.png`,
  rows `wave-g-dst-spring-forward.csv`.
- **Fall-back 2026-11-01** (Sunday): exactly **25** hourly readings (97 for
  the file); local **01:00 occurs twice** as `2026-11-01T05:00:00.000Z` and
  `2026-11-01T06:00:00.000Z`; every row classified. Screenshot
  `wave-g-dst-fall.png`, rows `wave-g-dst-fall-back.csv`.
- Unit coverage (independent `Intl` wall-clock reference, `TZ=America/Toronto`)
  lives in `webapp/src/lib/dstBoundary.test.ts`.

## 4. Tolerant parsing of real exports (item 4)

| Sample | Readings | First reading |
|---|---|---|
| Hydro One DMD (`powerOfTenMultiplier -3`) | 48 | **3.9546 kWh** (was 3 954.6 kWh before the fix) |
| Toronto Hydro DMD (15-minute) | 96 | 0.489 kWh |
| `espi:`-prefixed Connect feed (daily) | 514 | 34 kWh |

- Uploaded into the deployed app, values read back out of `localStorage`.
- A saved web page instead of an export →
  `That looks like a web page, not an export.` + the login-page explanation +
  a "Download My Data" next step, inside the modal (not a bare alert).
  Screenshot `wave-g-parse-diagnostic.png`.

## 5. Season band (item 6)

- Dataset 2026-04-20 → 2026-05-10 uploaded → **two chips**
  (`❄ Winter · Nov 1 – Apr 30`, `☀ Summer · May 1 – Oct 31`) and **two**
  `ReferenceArea` bands drawn over the bars.
- Tiered card shows the seasonal threshold in force: `Tier 1 cut-off 600 kWh/mo`
  (summer), `window spans both seasons`, `other window: 1,000 kWh/mo`.
- Screenshot: `wave-g-season-band.png`.

**Real Oakville file — season span (the task asked for this note):** the one
genuine Oakville Hydro 60-minute export available here spans **2026-07-02 →
2026-10-01, 2 184 hourly readings**, i.e. entirely inside the summer window
(May 1 – Oct 31). It does **not** cross Apr 30 / May 1 or Nov 1, so the
boundary itself is covered by `webapp/src/lib/season.test.ts` (synthetic
Apr 28 – May 3 and Oct 31 – Nov 2 runs, plus the hourly/monthly cases) and by
the browser check above on a dataset that does cross the boundary.

## Privacy

The backup export contains the owner's real meter readings, so it is written as
`evidence/wave-g-backup-export.local.json` and `evidence/*.local.json` is
gitignored. Nothing under `evidence/` reintroduces meter XML: the root
`.gitignore` rule `*.xml` (with the narrow `webapp/tests/fixtures/*.xml`
exception) still stands.
