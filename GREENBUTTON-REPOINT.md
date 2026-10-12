# The re-point ceremony — unconfigured → Oakville production

**One command, run on day one:**

```bash
cd ~/electricity-dashboard
webapp/scripts/greenbutton-repoint.sh --apply --host hermescomputer \
    --env-file ~/.oakville-creds.env --loop-gate
```

Everything in this document exists to make that command safe to run *once*,
unattended-ish, at the moment Oakville's credentials land — and to make the
same command usable **today**, before they arrive, as a preflight
(`--check`) and a rehearsal (`--rehearse`).

The rest of the Green Button design is in
[GREENBUTTON-CMD.md](GREENBUTTON-CMD.md); the operational surface is in
[OPERATIONS.md](OPERATIONS.md). This file is only about the switch-over.

---

## 1. Why this is a ceremony and not two lines of shell

A re-point is a set of steps that each fail **silently** when done in the
wrong order. Every one of them is a check in the script:

| Silent failure | What it looks like | Check that catches it |
| --- | --- | --- |
| Credentials never reach the container (`.env` key typo, wrong file, no `up -d`) | `/greenbutton/status` says `configured:false` — *identical* to "Oakville has not issued them yet" | step 4 (compose render), step 6 (`docker inspect` the **running** shim) |
| The secret lands in the dashboard container too | nothing visible; the whole four-container split is defeated | step 4 + step 6 (`energy-dashboard` must hold no `GB_CLIENT_*`) |
| The custodian rejects our `client_id`/`client_secret` | the UI says "reconnect", as if the *customer's* grant were gone | step 3 (`invalid_grant` vs `invalid_client` at the token endpoint) |
| The registered notification URI drifted from the running token | Oakville's POSTs 404 forever; nobody notices | step 1 (pinned token), step 6 (registered URI → 200) |
| A gate runs against the mock while the report says "verified against production" | a green report that measured nothing | step 7 (the harness target contract; §6) |
| The router answers `/greenbutton/*` from the wrong container | the dashboard serves the OAuth flow and the shim serves the site | step 6 (`X-Edge-Location` **and** `x-gb-process` must agree) |
| A sandbox URL is used where production was meant (or the reverse) | works until Oakville's platform says `invalid_client`/404 | step 2 (probe), step 4 (endpoint keys must reach the container) |

---

## 2. Inputs — what has to arrive first

| Input | Where it comes from | Goes to |
| --- | --- | --- |
| `client_id` | Oakville Hydro, after the registration form is accepted | `GB_CLIENT_ID` |
| `client_secret` | same | `GB_CLIENT_SECRET` |
| the **exact** scope string | Oakville (point 3 of the 2026-10-07 email). It cannot be discovered by probing: `/oauth/authorize` rejects an unregistered `client_id` *before* it evaluates scope, so valid/bogus/absent all answer the same 302 | `GB_SCOPE` (default `FB=1_3_4_5`; the 24-block fallback is in GREENBUTTON-CMD.md §6) |
| any test/sandbox URLs + the ESPI resource base | Oakville, if they offer a sandbox | `GB_AUTHORIZE_URL` / `GB_TOKEN_URL` |
| confirmation that PKCE (`code_challenge`) is accepted | Oakville | `GB_PKCE=true` (default off — shipping it on risks a flow they reject) |

Everything else is already done and pinned:

- the **notification URI** is registered as
  `…/greenbutton/notify/96a1eb36f68816b9606848aa7c628a71`. `GB_NOTIFY_TOKEN`
  is **pinned in the untracked `.env`**, never derived — the form recorded the
  URL *before* the secret existed, and a secret-derived token would change the
  moment credentials arrive (step 1 refuses a mismatch that would 404 Oakville).
- the redirect URI is registered as
  `https://electricity.markarslan.ca/greenbutton/callback`.

Credentials file (`~/.oakville-creds.env`, mode 0600, **never** in the repo):

```
GB_CLIENT_ID=…
GB_CLIENT_SECRET=…
GB_SCOPE=FB=1_3_4_5
```

The script reads `GB_*` from `--env-file`, `$GB_REPOINT_ENV`, or the
environment — and prints **values never**, only lengths, key names and HTTP
status codes. Placeholder-shaped values (`<…>`, `changeme`, `TODO`, empty)
are refused as `BLOCK` before anything is written.

---

## 3. Modes

| Mode | Writes | Recreates | Runnable |
| --- | --- | --- | --- |
| `--check` (default) | nothing anywhere | nothing | **today** — measures everything that does not need credentials |
| `--rehearse` | only into a throwaway temp file | nothing (it drives a *local* mock-backed stack) | **today** — exercises the whole code path with mock inputs |
| `--apply` | `$HOST:$REPO/.env` (atomic, 0600, backed up) | `docker compose up -d` | the day the credentials land; needs `GB_CONFIRM_GO_LIVE=yes` |
| `--rollback` | same write path, empty credentials | `up -d` | any time — back to `configured:false` |

Useful flags: `--host hermescomputer` (the ssh steps), `--loop-gate`
(also run the HTTP gate), `--with-browser`, `--with-topology`,
`--compose-ref origin/main` (render the compose file a ref ships instead of
the host's working tree — this is how a compose change is rehearsed
**before** it is deployed), `--qa-gate-dir DIR` (§6), `--notify-probe`.

---

## 4. What the steps assert

| Step | Assertion |
| --- | --- |
| 1 inputs | both credentials present and not placeholder-shaped; `GB_NOTIFY_TOKEN` still the **registered** one |
| 2 reachability | `GB_AUTHORIZE_URL` answers like an authorization server (2xx/3xx, not 404); `GB_TOKEN_URL` answers 400/401/403 like a token endpoint. No credentials involved |
| 3 credential validity | a junk `authorization_code` with our `client_id`/`client_secret` must come back **`invalid_grant`** (RFC 6749 §5.2) — `invalid_client`/HTTP 401 means *the custodian rejected our pair*. Both auth styles are probed because `GB_TOKEN_AUTH_STYLE` defaults to `auto` (basic, then form-body) |
| 4 compose render | on the host, `docker compose --env-file <temp> config` with the **post-re-point** env: every `GB_*` key reaches `greenbutton-shim`, `energy-dashboard` and `account-server` reach **none** of them, and a non-production endpoint URL must be explicitly passed (otherwise the container silently inherits the in-code production default). Nothing is written; the real `.env` is only read |
| 5 write + recreate | atomic rewrite of the untracked `.env` (temp file → `chmod 600` → `mv`, unrelated keys preserved, `.env.bak.<epoch>` kept), then `docker compose up -d` — **no `--build`**. The `edge-router` is deliberately **not** restarted: it re-resolves its upstreams per request since the H1 fix (`resolver 127.0.0.11 valid=10s`, ops/edge/default.conf.template), and step 6 verifies the split afterwards instead of assuming it |
| 6 verify | `X-Edge-Location: greenbutton` **and** `x-gb-process: shim` agree; `configured:true` (or, in check/rehearse, the `configured:false` baseline); `notificationUri` is still unpublished (finding M1); unknown notify token → **404**; the running shim holds this exact `client_id`; the running dashboard holds no credentials; with `--notify-probe` the **registered** URI → 200 and `dataAvailableSince` is stamped |
| 7 gates | `e2e-greenbutton-loop.sh` in its **real** target against the deployed stack (`--loop-gate`), the containerised topology gate, the browser gate, and the QA-owned harnesses' pin audit (§6) |
| 8 verdict | every `FAIL`/`BLOCK` re-listed, plus the exact next human step |

Exit codes: `0` all green, `1` a check failed, `2` blocked (missing
credentials / a failed step stopped the write).

---

## 5. Day-one sequence

```
# 0. (now, no credentials needed) preflight + rehearsal
webapp/scripts/greenbutton-repoint.sh --check    --host hermescomputer --loop-gate
webapp/scripts/greenbutton-repoint.sh --rehearse --host hermescomputer --loop-gate

# 1. credentials arrive → put them in ~/.oakville-creds.env (0600), then:
GB_CONFIRM_GO_LIVE=yes webapp/scripts/greenbutton-repoint.sh --apply \
    --host hermescomputer --env-file ~/.oakville-creds.env --loop-gate

# 2. Mark authorises (the ONLY step no agent can do):
#    https://electricity.markarslan.ca → "Authorise with Oakville Hydro" →
#    sign in at Oakville → approve the Usage Information scope.

# 3. hand t_5c16338b to QA: the grant-gated half (connected state, feed
#    pipe-through, notify → refresh, revocation) re-runs there.
```

After step 1 the credential leg is **proven**; after step 2 the product loop
is live. Nothing else changes configuration.

### Rollback

```bash
webapp/scripts/greenbutton-repoint.sh --rollback --host hermescomputer
```
Credentials are emptied from `.env`, the containers are recreated, and step 6
confirms `configured:false` again. The **registered** notification URI and
redirect URI stay on file at Oakville — do not unregister them for a
transient outage; the registration's 90-day connectivity-test clock
(GREENBUTTON-CMD.md §6/§7) keeps running.

---

## 6. Re-pointing the gates (the contract)

A gate that inlines `GB_*` measures the mock no matter what the environment
says — that is how a report can be green and wrong. The split:

| Harness | Re-point mechanism | Status |
| --- | --- | --- |
| `scripts/e2e-greenbutton-loop.sh` | `GB_E2E_TARGET=real` + `GB_CLIENT_ID`/`GB_CLIENT_SECRET`/`GB_AUTHORIZE_URL`/`GB_TOKEN_URL`/`GB_NOTIFY_TOKEN`; `GB_E2E_EXTERNAL=1` to drive the deployed stack; `GB_E2E_ACCOUNT=0` reports the grant-gated sections **SKIP** instead of faking them | **no code edit** |
| `scripts/e2e-greenbutton-browser.sh` | same contract (`GB_E2E_TARGET=real`), `GB_E2E_EXTERNAL=1` for the deployed stack. Refuses a real target with `GB_E2E_ACCOUNT=0`: the spec walks the authorize round trip in a browser, and an anonymous GET of the real `/oauth/authorize` answers `/login` | **no code edit** |
| `tests/e2e/greenbutton-connect.spec.ts` | the storage scan's secret pattern follows `GB_CLIENT_SECRET` (falling back to the mock literal), so a re-pointed run is not vacuous | **no code edit** |
| `scripts/e2e-greenbutton-topology.sh` | needs no re-point: it is mock-by-design (it gates the router/redaction/header shape, where credentials are irrelevant) | unchanged |
| `<qa-workspace>/qa-gate-edge.mjs` | inlines `GB_*` at 3 sites (`:111`, `:112` the `env:` block, `:264` the notify token derived from `mock-client-secret`) | **QA's card — audit below** |
| `<qa-workspace>/qa-gate-browser.mjs` | same at 4 sites (`:66`, `:67`, `:105`, `:178`), and `:105` is `TOKEN_PATTERNS`: it holds the mock secret *value*, so re-pointed the storage scan would look for a string that is not there | **QA's card — audit below** |

`--qa-gate-dir DIR` therefore does not run those two harnesses: it counts
their mock pin sites and reports them **BLOCKED** with the line numbers when
any remain, listing what to change. A vacuous pass is worse than a skip.
(Measured on the copies attached to `t_8cbb5beb`; the re-point is to read
`GB_CLIENT_ID`/`GB_CLIENT_SECRET`/`GB_AUTHORIZE_URL`/`GB_TOKEN_URL`/
`GB_NOTIFY_TOKEN` from the environment, keep the mock values as the *default*
for the mock path, and derive the notify token from whichever secret the run
actually used.)

---

## 7. What cannot be verified without Mark's account

An anonymous `GET /oauth/authorize` on Oakville's platform answers
`/login?authorization_error=true`, so there is **no unattended path back with
`?code=`**, and everything downstream of the code exchange stays unproven
until he signs in once:

- callback → `gb=connected`, session cookie minted (HttpOnly, ≤90 days)
- token file created (mode 0600, token set only, no readings)
- `connected:true` with the cookie / `false` without
- the ESPI feed pipe-through (`stream`, sliding session expiry, 401 without cookie)
- `dataAvailableSince` cleared by the next authenticated sync
- disconnect wiping the grant, and Oakville-side revocation → `grant_revoked`

The loop gate reports exactly these as `SKIP` when run with
`GB_E2E_ACCOUNT=0`, so a 9-check run can never be reported as a 31-check one.
They belong to **t_5c16338b** (QA), which re-runs the same harnesses with a
real grant.

---

## 8. Corrections this supersedes

The re-run instructions previously written on the production gate card
(`t_5c16338b`) were wrong in two ways, both now encoded here:

1. *"the three QA scripts already run unchanged, only the env differs"* —
   false: `GB_*` was inlined at seven sites across four harnesses, so an
   exported environment could not re-point them. §6 is the fix; the two
   QA-owned harnesses are still pinned and are audited, not trusted.
2. *"restart `edge-router` at the same time — it pins upstream IPs with no
   `resolver`"* — stale: H1 is fixed (`resolver 127.0.0.11 valid=10s` +
   variable `proxy_pass`), and the topology gate recreates both upstreams
   under a running router to prove it. The ceremony verifies the split
   instead of restarting anything.

Also: `GB_AUTHORIZE_URL`/`GB_TOKEN_URL` are now named in `docker-compose.yml`
(a two-line change, defaults unchanged) so that step 4 can *observe* which
custodian the container would talk to. Before that, a sandbox re-point fell
back to the in-code production default silently.

---

## 9. How this was exercised (mock / dry-run only)

No real credential, no production write, and no Oakville request beyond the
unauthenticated probes below were part of building this runbook:

- `--check` and `--rehearse` end to end against the mock custodian, including
  the real-target contract in the loop gate (31/31 checks, 0 skipped) and the
  `.env` write path against a throwaway file;
- `--check` with placeholder inputs → refused (`BLOCK`, exit 2);
- `--check` with `--qa-gate-dir` over the QA-owned harnesses → both reported
  `BLOCK` with their pin sites, which is the intended verdict until QA
  re-points them;
- `--compose-ref origin/main` to render the compose file this change ships;
- the containerised topology gate on the deploy host, to prove the loop
  gate's default (mock) path is unchanged.
