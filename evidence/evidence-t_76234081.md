# t_76234081 — topology gate red on main → green (79/2 → 220/0)

Branch: `electricity/t_76234081-topology-gate-fix` @ `85b4091` (PR #143, MERGEABLE/CLEAN).
Diff vs main: **4 files, 0 production files** — `webapp/tests/e2e/account_smoke.sh`,
`webapp/scripts/e2e-greenbutton-topology.sh`, `ARCHITECTURE.md`, `evidence/account-route-matrix.md`.

## What was wrong (3 defects, the first hiding the other two)

1. **Route-list drift (card's failure 1).** `MATRIX_PATHS` last touched by #108; #120 added
   `/account/verify`, `/account/recover/verify`, `/account/smtp-events` without updating it.
   Worse than reported: `surface_guard` runs *before* the mode dispatch, so the
   registration-closed sweep never ran at all since #120 — census against a real
   `next start` = **102 pass / 38 stale fail** (35 method cells on the 5 mailbox routes
   that #120 gates on `ACCT_EMAIL_VERIFICATION_ENABLED` — unset in topology, CI and
   compose; plus a stale `202 verification_pending` expectation #120 replaced with
   `404 not_found`; plus the identical-address check keyed on 202).
2. **Canary vs log format (card's failure 2).** Gate grepped for `GET /account/$LOG_TAG`;
   `location /account` has logged `gb_noquery` (no request method) since #120/F3, so the
   check could never pass. Now greps the quoted `"$uri"` path field exactly as gb_noquery
   writes it. Query/IP/cookie canary absence checks untouched — they were passing and are
   the redaction proof.
3. **Found while fixing:** devbox has no `jq` on its default PATH and no sudo —
   `ERROR: jq is required` — previously also hidden by the surface guard (it exited first).

## Fixes

- `surface_guard` now **derives the route list from the route files on disk** (same source
  as `route-matrix.test.ts`), so #121-style additions can't drift; a new route without a
  declared cell fails **by name** (`FAIL: matrix_expect declares no expectation for GET
  /account/device`) instead of an anonymous guard exit. Static list kept only as the
  no-checkout fallback.
- `matrix_expect` declares the flag-off contract for the 5 mailbox routes (every verb →
  bare 404, no `Allow` leak); registration checks assert `404 not_found` + byte-identical
  known/unknown bodies = the no-enumeration property *in this flag state*.
  Flag-ON 202 enumeration contract stays owned by `route-matrix.test.ts` /
  `email-registration.test.ts` (in-process).
- Both gate scripts accept a user-local `~/.local/bin/jq` when the system one is absent
  (CI runners ship jq — unaffected).
- Chosen semantics stated in-script at the canary: path-only presence, because gb_noquery
  records `"$uri"` and deliberately drops method+query; restoring a method-bearing format
  for `/account` was the rejected alternative (would change shipping log format).

## Acceptance — all first-hand

| Gate | Command / where | Result |
|---|---|---|
| topology, 1.30.6 image (acceptance) | devbox, final tree, **default PATH** (jq self-heal proven), `PORT=3942` | **TOPOLOGY OK — 220 passed, 0 failed, rc=0** (`~/t_76234081-final-1306.log`) |
| topology, 1.29.8-ctl control (same tree) | devbox `PORT=3942` | **TOPOLOGY OK — 220 passed, 0 failed, rc=0** (`~/t_76234081-final-ctl.log`) |
| account smoke ON | real `next start`, `--expect-registration-closed` | 139 pass / 1 fail — sole fail `x-edge-location` (set only by nginx; passes in topology) |
| account smoke OFF | no-ACCT server, `--expect-disabled` | **115 / 0, rc=0** |
| new-route flip test | `/account/device/route.ts` added, re-run | **rc=1, fails by name** (guard works), file removed after |
| vitest full | `--testTimeout=30000` | **2086 passed / 6 skipped / 0 failed** (140 files, 2 skipped) |
| bash -n / shellcheck | both scripts | syntax clean; no new findings (remaining are pre-existing file style) |

Production behaviour: **unchanged** — diff has zero production/app/edge-config files
(`git diff --name-only origin/main...HEAD`), gate runs on devbox only.

## Standing checkpoint

This card's gate is now the "run the topology gate before edge deploys" checkpoint
(t_b9356abd covers the dependabot /ops/edge gap separately). Run on devbox:

```
cd <repo> && PORT=3942 GB_TOPO_ROUTER_IMAGE=t_f094da64/edge-router:1.30.6 \
  bash webapp/scripts/e2e-greenbutton-topology.sh
# → TOPOLOGY OK, rc=0. Ports 3940/3941 held by sibling smoke containers; 8099 mock; jq via ~/.local/bin.
```

## Evidence file sha256

```
152d5c5d13ba28c44d8392bab9ec8aaa9c9e86ff115af4773838c097b89292fb  topology-1306-final.log
675f6b1de5db99f00491ee75f7fc3b9417f216ba338fc78c0423328e16ba4916  topology-1298-control-final.log
3960ae61033edc0dee4b587a65490ec396451776abc9aac35eb867e2882b5887  smoke-on-local.log
060747c5eade7cbb32077b8cb18b2ec5c83fe03e8e4f02134047394d3eabe0d2  smoke-off-local.log
7f9da9f16fb2b9bdcff4a5325851e623f392c53b6becfec30bdcf98ffbca9a52  vitest-full.log
```
