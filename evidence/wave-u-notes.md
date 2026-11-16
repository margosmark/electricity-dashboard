# Wave U — English ↔ French, one deploy, no URL routing

**What shipped** — the whole app is bilingual. French is opt-in via a
toolbar toggle (`src/components/LocaleToggle.tsx`) next to the answer
chip: a real `<button>`, in the tab order, `aria-pressed`, `lang` on the
visible code. The locale lives in `localStorage` under `oeo_locale`,
default English. There is **no `/fr/` URL prefix, no Accept-Language
sniffing, no RTL**.

| Piece | File |
|---|---|
| Locale store + `t()` + formatters | `src/i18n/index.ts` |
| Provider (mounted in `app/layout.tsx`) | `src/i18n/I18nProvider.tsx` |
| Toggle | `src/components/LocaleToggle.tsx` |
| Hand-edited sources `{"en", "fr"}` per surface | `src/i18n/areas/{shell,overview,usage,plans,money}.json` |
| Generated catalogs (**never hand-edit**) | `src/i18n/en.json`, `src/i18n/fr.json` — **948 keys each, parity-asserted** |
| Merge + validation (`--check` fails when stale) | `webapp/scripts/i18n-merge.mjs` |
| Contract tests | `src/i18n/i18n.test.tsx` (25), `src/lib/i18nClassifier.test.ts` |
| Workflow + honest gaps | `I18N.md` |

## The numbers a reviewer should check

From `wave-u-verification.json` — **82/82** on the **deployed** stack
(`http://dashboard.example.internal:3939`, deploy `5de8229`, recorded as
`deployedCommit`) against Mark's real 2-year export (sha256
`e292de50a560f56e…`, 6,424,909 bytes — never committed; pass
`WAVE_U_XML` yourself to re-run). The same script ran **82/82** on the
local build first (`wave-u-verification-local.json`). The checks are
coverage-shaped, not "some French exists":

- **Default is English, and nothing is stored until the user acts** — a
  fresh context has no `oeo_locale`; the toggle mounts before any upload.
- **The toggle is a real control** — `<button>`, Tab-reachable, Enter
  flips it, the choice **persists across a full reload**, and switching
  back restores English.
- **Every named surface flips** — tab labels (`Overview/Usage/Plans/
  Money` → `Aperçu/Consommation/Grilles/Coûts`), the best-choice banner
  (`THE BEST CHOICE IS` → `LE MEILLEUR CHOIX EST`), OEB plan names,
  money-table headers (`Vous avez payé`, `Couverture des données`),
  chart titles/subtitles + their `aria-label`s, the tab strip's
  `aria-label` (`Sections du tableau de bord`), efficiency verdict
  chips, accrual-pace labels, rate-period names, upload surfaces.
- **fr-CA formats** — `5,24 $` (symbol after, narrow nbsp), `16,3 ¢`
  (comma decimal + space), French percentage space, French month names;
  the **same value in English keeps the `$` prefix**.
- **Canonical data does NOT move** — the best-plan identity and every
  `data-plan-id` (`TOU`/`Tiered`/`ULO`) are byte-identical across the
  switch; only the localized view changes.
- **a11y unchanged in both languages** — the toggle's accessible name
  flips (`Switch to French` → `Passer à l'anglais`), and all 12
  aria-labelled controls keep their names in FR.

Screenshots from the deployed stack: `wave-u-desktop-english.png`,
`wave-u-desktop-french.png`, `wave-u-desktop-french-money.png` (1440),
`wave-u-mobile-{english,french,french-money}.png` (390); `-local`
variants are the local-build run.

## OEB terminology — and one honest deviation from the brief

The task brief listed the plan names as "Prix à l'horaire", "Prix aux
paliers", "Prix ultra-bas de nuit". Those **do not appear** on the OEB's
French pages. Re-fetched `oeb.ca/fr` (Oct 2026) — the live wording is:

| English | OEB français (shipped) |
|---|---|
| Time-of-Use | tarification selon l'heure de consommation |
| Tiered | tarification par paliers |
| Ultra-Low Overnight | tarif d'électricité de nuit très bas |
| Off-peak / Mid-peak / On-peak | Période creuse / normale / de pointe |

The app uses the OEB's published wording, not calques. If Mark prefers
the brief's wording it is one line per entry in `src/i18n/index.ts`.

## CMD agreements: is there a bilingualism rule to match?

No. The OEB's Green Button framework (ERO notice 013-1874) contains no
French-language requirement for DMD/CMD authorization agreements; the
French Language Services Act binds Ontario government services, not
distributors' customer agreements. Our connect flow is translated
because the toggle demands full coverage — not because a rule requires
it. (Verify note recorded in `I18N.md`.)

## Canonical data stays untranslated — and the classifier accepts both

Plan ids, rate-set names and raw payloads are data the code and regexes
key off, so they stay English; `planLabel()`/`periodLabel()` give the
localized *view*. The classifier (`lib/planTimeline.ts`,
`lib/moneyViz.ts`) gained **French anchors** (`Période creuse`,
`Période de pointe`, `BLOC 1`, `Palier 2`, …) so a bilingual Oakville
export classifies honestly instead of reading as `unknown`. Oakville's
actual DMD feed emits English only — verified against Mark's own export
— so the anchors are future-proofing, pinned by
`lib/i18nClassifier.test.ts` so they cannot rot.

## Gates run locally before the push

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run test` (vitest) | **1168 passed, 6 skipped**, 67 files |
| `npm run build` | `next build` OK (11 routes, proxy middleware) |
| `node evidence/wave-u-verify.cjs` (local) | 82/82 |
| `node evidence/wave-u-verify.cjs` (deployed `5de8229`) | **82/82** |
| CI | skipped by convention — Actions billing dead; gates run locally |
| deploy | `~/bin/deploy-energy-dashboard.sh` → `DEPLOY_OK at 5de8229` |

## Known gaps (honest list, in `I18N.md`)

Server-rendered strings that never see the toggle: the browser-tab
`metadata` title, PWA manifest + service-worker strings, the
`Not Found` HTTP body, and a server-side startup warning. Everything
else found by a source sweep was either canonical data with a `*_KEY`
companion (translated at the render layer) or not prose at all.

## Re-running

```bash
# the deployed stack (what wave-u-verification.json is from):
WAVE_U_XML=/path/to/2-year-export.xml TZ=America/Toronto \
  WAVE_U_BASE_URL=http://dashboard.example.internal:3939/ node evidence/wave-u-verify.cjs

# the local build:
WAVE_U_XML=… WAVE_U_BASE_URL=http://127.0.0.1:3939/ WAVE_U_SUFFIX=-local \
  node evidence/wave-u-verify.cjs

# the catalog merge check (CI-equivalent for i18n files):
node webapp/scripts/i18n-merge.mjs --check
```
