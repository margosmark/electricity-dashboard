# Account-server state audit — where Wave N actually stands

**One place for the whole truth.** `SECURITY.md` and `ARCHITECTURE.md` each carry
exactly one scoped sentence about accounts and point here; the Wave N design cards
carry the design. Do not restate this file anywhere else.

Audited: **2026-10-07 (EDT)** against `origin/main` `b290721`, the three Wave N
branches, and the live deployment on `.110` / `electricity.markarslan.ca`.
Card: `t_95f5ffbe`.

> **UPDATE 2026-10-11 (t_0db3808c): PR #28 is MERGED.** Wave N's code now
> lives on `main` — the "zero account code on `main`" measurements in §1 below
> are the record of what was true when this audit was written, not a claim
> about today's tree. What did **not** change is the deployment: `ACCT_ENABLED`
> is still unset, so `/account/*` answers **404** on
> `electricity.markarslan.ca` and the site behaves exactly as it did before
> the merge. Going live is a separate, explicit decision (untracked `.env`
> with `ACCT_ENABLED=true` + `VAPID_*`), per §6's merge-order rule: this file
> stays the place where the *state* is written down.
>
> **UPDATE 2026-10-12 (t_49579c75): DEPLOYED, still OFF.** `main@a06d70d` is
> running on `.110` — **four** containers (`energy-dashboard`,
> `greenbutton-shim`, `account-server`, `edge-router`), all rebuilt from that
> commit, so the Wave N edge template is live: `/account/*` →
> `X-Edge-Location: account` and `/account/internal/*` → **403** at the edge
> with no upstream contact (measured from the public URL, both the 403 and the
> location header). The feature itself is still off — `ACCT_ENABLED` is unset,
> `/account/session` answers **404** and `.account/` holds no database — so
> every "not deployed / nothing reaches the account server" claim in §1 below
> still describes the *user-visible* state; what changed is the container and
> the route, not the surface. Enabling (or not) is Mark's call: see
> `OPERATIONS.md` → *Account server*. The containerised gate now covers this
> leg — `webapp/scripts/e2e-greenbutton-topology.sh` checks feature-off and
> enabled-but-registration-closed routes through the router. It does not run
> authenticated registration/login/sync; those lifecycles are covered by
> ephemeral tests in `webapp/src/lib/account/account.test.ts` and
> `route-matrix.test.ts`.

---

## TL;DR

**Verdict (Mark's, restated): CMD live-sync is the primary path. The account
server is OPTIONAL — it buys multi-device sync and closed-tab push — and it stays
PARKED until Mark explicitly asks for it. Nothing about it is deployed, and
nothing about it is on `main`.**

| Surface | State | How I know |
| --- | --- | --- |
| Repo `main` (`b290721`) | **Zero** account code, routes, env or dependencies | `git ls-tree` / `git grep` over `origin/main`: 0 hits for `account/`, `acct_session`, `ACCT_ENABLED`, `VAPID` |
| Branches | A **complete, twice-security-reviewed build** — 3 Wave N branches, 1 of them in a PR | PR **#28 OPEN** @ `9c682f8`, 4 commits, 53 files, **+8676 / −208**; 2 stacked branches off its head, no PR |
| Deployment (`.110` + public origin) | **Not deployed.** 3 containers, not 4; `/account/*` 404 | `docker ps`, `.env` key names, and 4 live HTTP probes below |
| Docs on `main` | Truthful today; previously unscoped | This file + one scoped sentence each in `SECURITY.md` / `ARCHITECTURE.md` |

**Nothing to delete on `main`** — the "residual flag-gated code" case the card
anticipated does not exist. The parked artifact is the *branches*, and keeping
them is a deliberate choice (§7).

---

## 1. What is in the repo on `main` — measured, not assumed

All commands run against `origin/main` `b290721` (312 tracked files).

| Check | Command | Result |
| --- | --- | --- |
| Any account path | `git ls-tree -r --name-only origin/main \| grep -iE 'account\|acct'` | **0 files** |
| Session cookie | `git grep -in 'acct_session' origin/main` | **0 matches** |
| Feature flag | `git grep -in 'ACCT_ENABLED' origin/main` | **0 matches** |
| Push keys | `git grep -in 'VAPID' origin/main` | **0 matches** |
| Card IDs in repo files | `git grep -icE 't_[0-9a-f]{8}' origin/main` | **7 files, 6 distinct cards** — all 6 resolve on the board (§5) |

### Route inventory (`webapp/src/app/**` on `main` — all 12 files)

```
api/rates/route.ts                     greenbutton/status/route.ts
greenbutton/callback/route.ts          greenbutton/usage/route.ts
greenbutton/disconnect/route.ts        import/page.tsx
greenbutton/notify/[token]/route.ts    layout.tsx · page.tsx
greenbutton/start/route.ts             favicon.ico · globals.css   (not routes)
```

**There is no `webapp/src/app/account/` on `main`** — no `/account/session`,
`/account/login`, `/account/sync`, `/account/notify`, `/account/internal`.

### Container / edge inventory (`main`)

| File | Contents |
| --- | --- |
| `docker-compose.yml` | **3 services**: `energy-dashboard`, `greenbutton-shim`, `edge-router`. `grep -c account-server` → **0** |
| `ops/edge/default.conf.template` | **2 locations**: `location /greenbutton` → shim, `location /` → app. **No `/account` block, no `/account/internal` deny** |
| `webapp/package.json` dependencies | **9 runtime deps** (`clsx`, `date-fns`, `fast-xml-parser`, `lucide-react`, `next`, `react`, `react-dom`, `recharts`, `tailwind-merge`) — **no `argon2`, no `web-push`** |

### Docs on `main` that mention an account server

Three, and all three already frame it as *not built*:

| File | What it says |
| --- | --- |
| `DECISIONS.md` (Wave M row) | "a server-side account for real push (that is Wave N's separate product decision, **queued not assumed**)" |
| `evidence/wave-m-notes.md` | "With no account server the only channels are…"; "a local account server is Wave N's separate product call" |
| `SECURITY.md` / `ARCHITECTURE.md` | flat "no account system / no backend storage" — previously unscoped; each now carries one scoped sentence plus a link to this file (the other two edits in this PR) |

---

## 2. What exists — but only on branches

All three branches **contain `origin/main`** (verified with
`git merge-base --is-ancestor origin/main <branch>`), so none of them is stale.

| Branch | Head | In a PR? | What it adds over `main` |
| --- | --- | --- | --- |
| `electricity/t_12fee1f7-wave-n-accounts` | `9c682f8` | **PR #28 — OPEN** | **10** `/account/*` route files; `webapp/src/lib/account/*` (`auth`, `client`, `config`, `crypto`, `db`, `http`, `push`, `ratelimit`, `services`, `sync` + 4 test files); `AccountControls` / `AccountTriggers` / `useAccount`; `docker-compose.yml` **+`account-server`**; edge template **+`/account/*` locations**; `ci.yml`; `tests/e2e/account_smoke.sh`; 5 top-level docs |
| `electricity/t_6cf4a757-plan-change-notify` | `373fdcb` | **No PR** | `AccountPlanTrigger` (+test) — posts Wave M's plan-change notice to `POST /account/notify`. Stacked on `9c682f8` |
| `electricity/t_f0ce5f7d-alerts-drawer` | `06cdcae` | **No PR** | Merged Alerts drawer, `NotificationSettings` moved out of `AccountControls`, `useAccountFeature`, `lib/account/topics.ts`. Stacked on `9c682f8` |

**PR #28 facts** (`gh pr view 28`, 2026-10-07): state **OPEN**, `mergedAt: null`,
head `9c682f8`, 4 commits (`2b89cb2`, `6e84e23`, `42d2535`, `9c682f8`),
53 files, +8676 / −208, opened by `margosmark` at 2026-10-07T16:33:36Z.
Review history: security **CHANGES REQUESTED** (round 1) → fixes → security
**APPROVED** (round 2, execution lens). It has **never been merged and never
been deployed.**

---

## 3. What the four cards claimed (and their real status)

They did **not** vanish from the database — `kanban_show` resolves all four on
the `electricity` board today. What vanished was their column on the visible
board (3 are `done`, 1 is `blocked`).

| Card | Status | What its completion summary claims | Where the artifact is |
| --- | --- | --- | --- |
| `t_12fee1f7` — Wave N option card → build | **done** | "P0–P4 built and verified": `ACCT_ENABLED` defaults `false`, E2EE sync, Web Push with caps/quiet hours; gates reported **eslint 0, tsc clean, vitest 837/49, `next build` clean, `account_smoke.sh` 32/32 ON + 5/5 OFF**; explicitly *not* verified: CI (billing) and docker topology | Branch + **PR #28** |
| `t_f0ce5f7d` — merged Alerts drawer | **done** | Built on `06cdcae`, reported **eslint 0, tsc clean, vitest 869/869, `account_smoke` 32/32 + 5/5, Playwright 21 passed / 3 skipped**; patch attached to the card | Branch only, **no PR** |
| `t_6cf4a757` — `plan_change` producer | **done** | Built `AccountPlanTrigger` @ `373fdcb`, reported **vitest 852/852, eslint 0, tsc clean**; security review **APPROVED** after live HTTP probes | Branch only, **no PR** |
| `t_49579c75` — deploy + containerised topology gate | **blocked** | Blocked at precondition 1 (PR #28 not merged; CI billing-red). Precondition 2 (disk: 20 G free on `.110`) **passes**. Recorded the pre-deploy baseline curls and the "check #4 404→403 is the only discriminating probe" trap | Nothing to point at — this is the card that would prove deployment |

**Every one of those "verified" gate numbers is a claim about a *branch*, not
about `main` and not about production.** None of it is in the running site.

---

## 4. What is actually deployed — measured 2026-10-07 22:03 EDT

### The checkout and containers on `.110` (`hermescomputer`)

```
~/electricity-dashboard  →  main @ 9ae35a3   (origin/main is b290721 — the delta is docs-only)
account routes in checkout: 0
account-server in compose:  0
.env key names: GB_NOTIFY_TOKEN GB_TOKEN_DIR      (ACCT_* keys: 0, VAPID_* keys: 0)
.account/ directory: does not exist
```

`docker ps` — the electricity containers (of 10 total on the host):

```
edge-router        Up 19 hours   electricity-dashboard-edge-router:latest
energy-dashboard   Up 10 hours   electricity-dashboard-energy-dashboard:latest
greenbutton-shim   Up 10 hours   electricity-dashboard-energy-dashboard:latest
```

**Three, not four. There is no `account-server` container.**

### Live HTTP on `https://electricity.markarslan.ca` (same timestamp)

| Probe | Status | `x-gb-process` | `x-edge-location` | Reads as |
| --- | --- | --- | --- | --- |
| `GET /` | **200** | `app` | `default` | normal |
| `GET /greenbutton/status` | **200** | `shim` | `greenbutton` | normal |
| `GET /account/session` | **404** | `app` | `default` | no account route in the app |
| `GET /account/internal/notify` | **404** | `app` | `default` | **the Wave N edge deny was never baked into the running router** — that probe answers **403 only after** the new template ships. 404 here is the discriminating evidence that Wave N is absent |

**Conclusion: without credentials the account server is not deployed — and
today it is not deployed *at all*, credentials or not.** No `ACCT_*`/`VAPID_*`
env exists on the host, no account DB exists, and the running router has no
`/account` location.

---

## 5. Bookkeeping holes (so nobody chases ghosts)

| Claim to check | Finding |
| --- | --- |
| "The four Wave N cards vanished" | **False.** `t_12fee1f7` (done), `t_f0ce5f7d` (done), `t_6cf4a757` (done), `t_49579c75` (blocked) all resolve on the board. Only their *visible column* went away. |
| "Docs/comments still reference cards that are gone" | **No ghost in the repo, and none of the Wave N cards is referenced there.** `git grep -E 't_[0-9a-f]{8}'` over `origin/main` hits **7 files / 6 distinct cards** (`t_0be81e60`, `t_500e6614`, `t_58afdb97`, `t_7833d76f`, `t_b0d80b86`, `t_f1c6dca5` — evidence records and two test/script headers); **all 6 resolve on this board** (4 `done`, 2 `blocked`: `t_b0d80b86` Wave M, `t_f1c6dca5` the parked/rejected Wave J DMD card). A specific-ID grep for `t_12fee1f7`, `t_f0ce5f7d`, `t_6cf4a757`, `t_49579c75`, `t_fe024c44` over `origin/main` **and** all 21 remote branches returns **nothing** — the Wave N cards are referenced only from other cards. |
| Card IDs referenced **between board cards** but absent from the `electricity` board | 6: `t_3cdcde85` (M100), `t_807d8bad` (M101), `t_f0aca8b9` (M94), `t_a8a54e33` ("[electricity][webapp P1]…"), `t_e28ddaa0` ("[electricity][streamlit P1]…") **all resolve on the `fintrack` board** — three are fin_tracker cards, two are electricity cards re-homed there. **`t_9e49c3c1` resolves on neither board**; its only referent (`t_9b3de81d`) already carries its own in-text correction pointing at `t_f0aca8b9`. |
| Related oddity (not a ghost) | Three fin_tracker-content cards sit on the `electricity` board: `t_214c3269` (M101), `t_d3d1bc3e` (M100), `t_9b3de81d` (M99). Their companion IDs are cross-board references, not missing records. |

---

## 6. Verdict

**The CMD live-sync path (Wave K connect + Wave M background refresh, no
accounts) is the primary path and is what is deployed.** The account server
exists only as reviewed, unmerged branch code; it is **optional**, it is the
answer to exactly two needs — *multi-device state* and *push with the tab
closed* — and it **stays parked until Mark explicitly requests it.**

Park means, concretely:

1. `main` stays account-free (it already is — nothing had to be removed).
2. PR **#28 stays open and unmerged**, labelled **PARKED** in its own thread
   ([comment on #28](https://github.com/margosmark/electricity-dashboard/pull/28#issuecomment-6050871939))
   so nobody merges it by reflex. The two stacked branches stay pushed as the
   reviewed continuation.
3. `t_49579c75` (deploy + containerised topology gate) stays **blocked**; it
   cannot run until there is something to deploy.
4. No account work is queued, and Wave J DMD scraping stays parked as Mark
   rejected it.

**To unpark**, in order: Mark's explicit go → rebase/merge PR #28 (CI billing
fixed, or gates replicated locally per the Wave K precedent) → rebase the two
stacked branches → an explicit enable decision (`ACCT_ENABLED=true` + `VAPID_*`
in the untracked `.env`) → `t_49579c75` proves the four-container topology and
the first tab-closed push.

**Merge-order rule for the two paragraphs this PR edits:** PR #28 rewrites the
*same* opening paragraphs of `SECURITY.md` and `ARCHITECTURE.md` (it describes
the account server as present). **If PR #28 ever merges, its wording wins** and
the two scoped sentences here resolve to it — that is the correct order, because
by then the account server will exist. Whichever lands second rebases; the
sentence in the audit file is the one that stays authoritative either way.

---

## 7. The deliberate choice on residual code

The card asked: *if residual account code exists on `main` but is not routable,
delete it or document why it stays.*

**There is none to delete** (§1 — every *account-code* grep is 0: paths,
`acct_session`, `ACCT_ENABLED`, `VAPID`). So the deliberate choice is
about the branches, and it is: **keep them.**

- They are **not on `main`**, so they are not a supply-chain surface for
  anything that consumes `main`, and they cannot ship by accident: `ACCT_ENABLED`
  defaults `false` *and* the code is absent from the deployable ref entirely.
- PR #28 carries **two security review rounds** (one CHANGES REQUESTED, one
  APPROVED with live HTTP probes) over +8676 lines. Deleting that discards a
  reviewed design for no safety gain — the design's home is the card
  (`t_12fee1f7`) plus these branches.
- Dead code is a supply-chain surface **in the tree you ship**. `main` is the
  tree we ship, and it is clean. A parked branch costs nothing to a consumer and
  is cheap to delete later if Mark ever decides the option is dead for good.

If that decision ever flips, the deletion is one command per branch — recorded
here so the choice stays deliberate rather than accidental.

---

## 8. CI state

GitHub Actions is **red repo-wide for billing**, unchanged as of 2026-10-07:

- Latest runs on `main` and on PR #28 fail in **~4 s** with **0 steps executed**
  on all three jobs (`Frontend`, `E2E Smoke`, `Python`) — run `37661456781`,
  jobs listed with `steps=0`.
- The billing message itself is quoted in the repo's own
  `evidence/wave-m-notes.md`: *"The job was not started because recent account
  payments have failed or your spending limit needs to be increased."*
- `main` has **no branch protection** (`GET .../branches/main/protection` →
  **403** "Upgrade to GitHub Pro or make this repository public"), so merges are
  **not** CI-gated — every merge is a human click, red CI or not. Fixing
  `Settings → Billing & plans` remains Mark's.

**This PR's gates were therefore replicated locally** (Wave K precedent — same
lockfile, `npm ci` in a fresh worktree, run 2026-10-07 22:05–22:20 EDT):

| CI job | Local result |
| --- | --- |
| Frontend (lint, typecheck, test, build) | `eslint` **0 problems / 0 warnings across 127 files** (exit 0), `tsc --noEmit` **clean** (exit 0), `vitest run` **711 passed / 711, 43 files** (exit 0), `next build` **clean** — 10 routes + `_not-found`, **no `/account/*` route registered** |
| Python (parser tests) | `pytest tests/ -q` → **33 passed** |
| E2E Smoke (docker boot, HTTP, upload flow, PWA) | Docker boot **not run** — no docker on this LXC (unchanged `Dockerfile`, docs-only diff). Everything else in that job replicated against a real `next start` on `127.0.0.1:3198`: `http_smoke.sh` **OK** (`/`, `/api/rates`, manifest, `sw.js`, icons), `npx playwright test` → **21 passed / 3 skipped / 0 failed** (the 3 skips are the Green Button shim specs, which need a configured shim — skipped in CI's shape too) |
| Lighthouse budgets (part of the smoke job) | **not run** — needs the booted container |
