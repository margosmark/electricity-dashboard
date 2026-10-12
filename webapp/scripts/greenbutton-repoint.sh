#!/usr/bin/env bash
# Green Button re-point ceremony — the ONE command that switches the shim from
# "unconfigured / mock" to a real custodian (Oakville Hydro production, or
# their sandbox) and proves what it switched to.
#
# Why a ceremony rather than two `docker compose` lines: a re-point is a
# set of things that each fail SILENTLY when done in the wrong order —
#
#   * credentials that never reached the container (a key name typo in .env
#     renders as "configured:false" and looks exactly like "Oakville has not
#     issued them yet")
#   * the secret leaking into the wrong container (the whole point of the
#     four-container split is that the dashboard holds no credentials)
#   * a gate run against the mock while the report says "verified against
#     production" (the harnesses used to inline GB_* — see GREENBUTTON-REPOINT.md)
#   * the notify webhook silently 404ing Oakville, because the registered path
#     token and the running one drifted apart
#   * a credential the custodian rejects (invalid_client), misread as "the
#     customer needs to re-authorise"
#
# Every one of those is a check below. Nothing here prints a secret value: the
# script reports lengths, key names and HTTP status codes.
#
# MODES
#   --check      (default) validate + probe + render + read-only verify. Writes
#                nothing anywhere, recreates nothing. Runnable today, before
#                Oakville issues anything, and again afterwards.
#   --rehearse   the WHOLE ceremony with mock inputs, against a local mock
#                custodian: exercises the same code path as --apply (the env
#                write, the render assertions, the target contract in the
#                harnesses) while touching neither production nor Oakville.
#   --apply      do it for real on the deploy host. Requires real credentials
#                and GB_CONFIRM_GO_LIVE=yes.
#   --rollback   put the host back to configured:false (credentials removed,
#                containers recreated, split re-verified).
#
# OPTIONS
#   --env-file FILE   credentials as KEY=VALUE (default $GB_REPOINT_ENV, else
#                     the process environment). Values are never echoed.
#   --host HOST       deploy host for the ssh steps (default: $GB_REPOINT_HOST,
#                     else none — host steps are then reported BLOCKED)
#   --repo PATH       repo path on that host (default /home/hermes/electricity-dashboard)
#   --origin URL      public origin under test (default https://electricity.markarslan.ca)
#   --loop-gate       also run scripts/e2e-greenbutton-loop.sh (real/external)
#   --with-topology   also run scripts/e2e-greenbutton-topology.sh (needs docker)
#   --with-browser    also run scripts/e2e-greenbutton-browser.sh (slow; needs
#                     a completable grant — refused on a real target without one)
#   --qa-gate-dir DIR also AUDIT (and, when clean, run) the QA-owned harnesses
#                     qa-gate-edge.mjs / qa-gate-browser.mjs in DIR
#   --compose-ref REF render the compose file at git REF on the host (e.g.
#                     origin/main, or a PR branch) instead of the working tree —
#                     read-only, and the way to rehearse a compose change
#                     before it is deployed
#   --notify-probe    allow the notify-token leg in --apply/--rehearse verify
#                     (it stamps dataAvailableSince on the running shim)
#   -h | --help
#
# Usage:
#   webapp/scripts/greenbutton-repoint.sh --check --host hermescomputer
#   webapp/scripts/greenbutton-repoint.sh --rehearse --host hermescomputer
#   webapp/scripts/greenbutton-repoint.sh --apply --host hermescomputer \
#       --env-file ~/.oakville-creds.env --loop-gate

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
REPO_LOCAL="$(cd "$WEBAPP/.." && pwd)"

MODE="check"
ENV_FILE="${GB_REPOINT_ENV:-}"
HOST="${GB_REPOINT_HOST:-}"
HOST_REPO="${GB_REPOINT_REPO:-/home/hermes/electricity-dashboard}"
ORIGIN="${GB_REPOINT_ORIGIN:-https://electricity.markarslan.ca}"
QA_GATE_DIR=""
COMPOSE_REF="${GB_REPOINT_COMPOSE_REF:-}"
RUN_LOOP=0
RUN_TOPO=0
RUN_BROWSER=0
NOTIFY_PROBE=0

PROD_AUTHORIZE="https://greenbutton.oakvillehydro.com/oauth/authorize"
PROD_TOKEN="https://greenbutton.oakvillehydro.com/oauth/token"
# The token the registration form already records. Re-generating it breaks the
# notification URI Oakville has on file (GREENBUTTON-CMD.md §6).
REGISTERED_NOTIFY_TOKEN="96a1eb36f68816b9606848aa7c628a71"

WORK="$(mktemp -d)"
chmod 700 "$WORK"
STEP=0
FAIL=0
BLOCK=0
declare -a REPORT=()

while [ $# -gt 0 ]; do
  case "$1" in
    --check|--rehearse|--apply|--rollback) MODE="${1#--}"; shift;;
    --env-file) ENV_FILE="${2:-}"; shift 2;;
    --host) HOST="${2:-}"; shift 2;;
    --repo) HOST_REPO="${2:-}"; shift 2;;
    --origin) ORIGIN="${2:-}"; shift 2;;
    --qa-gate-dir) QA_GATE_DIR="${2:-}"; shift 2;;
    --compose-ref) COMPOSE_REF="${2:-}"; shift 2;;
    --loop-gate) RUN_LOOP=1; shift;;
    --with-topology) RUN_TOPO=1; shift;;
    --with-browser) RUN_BROWSER=1; shift;;
    --notify-probe) NOTIFY_PROBE=1; shift;;
    -h|--help) sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

if [ "$MODE" = "rehearse" ] && [ -n "$ENV_FILE" ]; then
  echo "note: --rehearse ignores --env-file (mock inputs are the point)" >&2
  ENV_FILE=""
fi
if [ "$MODE" = "apply" ] && [ "${GB_CONFIRM_GO_LIVE:-}" != "yes" ]; then
  echo "BLOCKED: --apply needs GB_CONFIRM_GO_LIVE=yes in the environment." >&2
  echo "         (It writes credentials to $HOST:$HOST_REPO/.env and recreates containers.)" >&2
  exit 2
fi
# --apply's job is to prove the go-live state, and the notify leg is part of
# that proof: it stamps dataAvailableSince on the running shim (transient
# state, cleared by the next authenticated sync), so it is on by default there
# and opt-in elsewhere.
if [ "$MODE" = "apply" ] && [ "$NOTIFY_PROBE" = 0 ]; then
  NOTIFY_PROBE=1
  echo "note: --apply runs the registered notify-URI probe (stamps dataAvailableSince)"
fi

# ---------------------------------------------------------------- reporting --
step() { STEP=$((STEP + 1)); printf '\n== %d. %s ==\n' "$STEP" "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; REPORT+=("PASS|$1"); }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; REPORT+=("FAIL|$1"); }
warn() { printf '  NOTE  %s\n' "$1"; REPORT+=("NOTE|$1"); }
skipped() { printf '  SKIP  %s\n' "$1"; REPORT+=("SKIP|$1"); }
blocked() { BLOCK=$((BLOCK + 1)); printf '  BLOCK %s\n' "$1"; REPORT+=("BLOCK|$1"); }
cond() { # cond <label> <exit-status>
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}
# Never print a secret: length + a short fingerprint only.
fingerprint() { printf 'len=%s sha256=%s' "$(printf '%s' "$1" | wc -c | tr -d ' ')" "$(printf '%s' "$1" | sha256sum | cut -c1-8)"; }

is_placeholder() {
  case "$1" in
    ""|*"<"*|*">"*|*"..."*) return 0;;
  esac
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *changeme*|*placeholder*|*your-*|*example*|*"xxx"*|*todo*|*tbd*) return 0;;
  esac
  return 1
}

env_file_value() { # env_file_value <file> <key>
  [ -f "$1" ] || return 1
  grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -1 |
    sed -e "s/^[[:space:]]*$2=//" -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*$//'
}

set_input() { # set_input <VARNAME> <default> [file-only]
  local name="$1" def="${2:-}" fileonly="${3:-}"
  local from_env="${!name:-}" from_file=""
  if [ -n "$ENV_FILE" ]; then from_file="$(env_file_value "$ENV_FILE" "$name" || true)"; fi
  if [ -n "$fileonly" ]; then
    printf -v "$name" '%s' "${from_file:-$def}"
  else
    printf -v "$name" '%s' "${from_env:-${from_file:-$def}}"
  fi
  export "$name"
}

printf 'Green Button re-point ceremony — mode=%s host=%s origin=%s\n' "$MODE" "${HOST:-<none>}" "$ORIGIN"
printf 'workspace=%s\n' "$WORK"

# --rehearse needs a custodian to probe and to complete an authorize flow, so
# this mode brings up the local mock and points the inputs at it. The mock is
# a full OAuth2 custodian, which is what makes the rehearsal end-to-end: the
# loop gate runs its REAL-target path against it.
MOCK_PID=""
if [ "$MODE" = "rehearse" ]; then
  MOCK_PORT="${MOCK_PORT:-8098}"
  setsid node "$WEBAPP/scripts/mock-custodian.mjs" --port "$MOCK_PORT" >"$WORK/mock.log" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 30); do
    curl -sS -m 2 "http://127.0.0.1:$MOCK_PORT/oauth/authorize" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
trap 'rm -rf "$WORK"; if [ -n "$MOCK_PID" ]; then kill -- -"$MOCK_PID" 2>/dev/null || kill "$MOCK_PID" 2>/dev/null; fi' EXIT

# ------------------------------------------------------------------ 1. inputs
step "inputs (credentials present, and not placeholders)"
if [ "$MODE" = "rehearse" ]; then
  # Mock inputs — the mock custodian's OWN client pair, so the credential
  # probe can succeed and the whole ceremony is exercisable end to end.
  GB_CLIENT_ID="mock-client-id"
  GB_CLIENT_SECRET="mock-client-secret"
  GB_SCOPE="FB=1_3_4_5"
  GB_AUTHORIZE_URL="http://127.0.0.1:${MOCK_PORT}/oauth/authorize"
  GB_TOKEN_URL="http://127.0.0.1:${MOCK_PORT}/oauth/token"
  GB_NOTIFY_TOKEN="$(printf '%s' "greenbutton-notify:$GB_CLIENT_SECRET" | sha256sum | cut -c1-32)"
  GB_PKCE="false"
  ok "rehearsal inputs are the mock custodian's (no real value is used or written)"
elif [ "$MODE" = "rollback" ]; then
  GB_CLIENT_ID=""; GB_CLIENT_SECRET=""; GB_SCOPE=""; GB_AUTHORIZE_URL=""; GB_TOKEN_URL=""; GB_PKCE=""
  ok "--rollback: the ceremony writes empty credentials (back to configured:false)"
else
  set_input GB_CLIENT_ID ""
  set_input GB_CLIENT_SECRET ""
  set_input GB_SCOPE "FB=1_3_4_5"
  set_input GB_AUTHORIZE_URL "$PROD_AUTHORIZE"
  set_input GB_TOKEN_URL "$PROD_TOKEN"
  set_input GB_PKCE "false"
  # PINNED, never derived: the form already records this token, and deriving a
  # new one would leave Oakville POSTing to a URL we 404 (GREENBUTTON-CMD.md §6).
  set_input GB_NOTIFY_TOKEN "$REGISTERED_NOTIFY_TOKEN"

  for pair in "GB_CLIENT_ID:$GB_CLIENT_ID" "GB_CLIENT_SECRET:$GB_CLIENT_SECRET"; do
    name="${pair%%:*}"; value="${pair#*:}"
    if is_placeholder "$value"; then
      blocked "$name is not set (or is still a placeholder) — the custodian has not issued it yet"
    else
      ok "$name present ($(fingerprint "$value"))"
    fi
  done
  for pair in "GB_SCOPE:$GB_SCOPE" "GB_AUTHORIZE_URL:$GB_AUTHORIZE_URL" "GB_TOKEN_URL:$GB_TOKEN_URL"; do
    name="${pair%%:*}"; value="${pair#*:}"
    if is_placeholder "$value"; then blocked "$name is empty"; else ok "$name=$value"; fi
  done
  if [ "$GB_NOTIFY_TOKEN" != "$REGISTERED_NOTIFY_TOKEN" ]; then
    if [ "$MODE" = "check" ]; then
      warn "GB_NOTIFY_TOKEN differs from the token the registration form recorded ($REGISTERED_NOTIFY_TOKEN)"
      warn "  → confirm Oakville has the NEW URI on file before this webhook matters"
    else
      bad "GB_NOTIFY_TOKEN differs from the registered token — --apply would register a 404 for Oakville"
    fi
  else
    ok "GB_NOTIFY_TOKEN still the registered one ($REGISTERED_NOTIFY_TOKEN)"
  fi
fi

# ----------------------------------------------------------------- 2. probe
# Read-only. Answers "is the host behind this URL the custodian we think it
# is" before any credential is involved — a wrong authorizeUrl is the failure
# that otherwise shows up as "Oakville rejects our client" at go-live.
step "custodian reachability (no credentials involved)"
probe_get() { # probe_get <url> → "status|content-type|redirect-host"
  curl -sS -m 20 -o /dev/null -w '%{http_code}|%{content_type}|%{redirect_url}' "$1" 2>/dev/null || printf '000||'
}
probe_post() { # probe_post <url> → "status|content-type"
  curl -sS -m 20 -o /dev/null -w '%{http_code}|%{content_type}' -X POST \
    -H 'content-type: application/x-www-form-urlencoded' --data 'grant_type=authorization_code&code=x' "$1" 2>/dev/null || printf '000|'
}
for pair in "authorize:$GB_AUTHORIZE_URL" "token:$GB_TOKEN_URL"; do
  kind="${pair%%:*}"; url="${pair#*:}"
  if [ -z "$url" ]; then skipped "$kind endpoint not configured"; continue; fi
  hostpart="$(printf '%s' "$url" | awk -F/ '{print $3}')"
  if [ "$kind" = "authorize" ]; then
    RES="$(probe_get "$url")"; status="${RES%%|*}"; rest="${RES#*|}"; ctype="${rest%%|*}"; redir="${rest#*|}"
    rhost="$(printf '%s' "$redir" | awk -F/ '{print $3}')"
    case "$status" in
      2*|3*) ok "authorize endpoint answers ($hostpart: HTTP $status${rhost:+, → $rhost})";;
      000)   bad "authorize endpoint unreachable ($hostpart: no HTTP response)";;
      *)     bad "authorize endpoint answered HTTP $status at $hostpart — wrong host, or not an AS";;
    esac
  else
    RES="$(probe_post "$url")"; status="${RES%%|*}"; ctype="${RES#*|}"
    case "$status" in
      400|401|403) ok "token endpoint answers like an OAuth AS ($hostpart: HTTP $status, $ctype)";;
      000)         bad "token endpoint unreachable ($hostpart: no HTTP response)";;
      *)           bad "token endpoint answered HTTP $status at $hostpart (want 400/401/403)";;
    esac
  fi
done

# -------------------------------------------------- 3. credential validity
# The distinction the whole error taxonomy rests on (oauth.ts): a rejected
# client_id/secret is invalid_client / 401 and NOTHING the user can fix; a
# rejected grant is invalid_grant and is exactly what a junk code should give.
step "the custodian accepts OUR credentials (junk code must give invalid_grant)"
if is_placeholder "$GB_CLIENT_ID" || is_placeholder "$GB_CLIENT_SECRET"; then
  blocked "no credentials to validate yet"
else
  GPROBE="$(GB_CLIENT_ID="$GB_CLIENT_ID" GB_CLIENT_SECRET="$GB_CLIENT_SECRET" \
           GB_TOKEN_URL="$GB_TOKEN_URL" GB_REDIRECT_URI="$ORIGIN/greenbutton/callback" \
           python3 - <<'PY' 2>/dev/null
import base64, json, os, urllib.error, urllib.parse, urllib.request
url = os.environ["GB_TOKEN_URL"]
cid, secret = os.environ["GB_CLIENT_ID"], os.environ["GB_CLIENT_SECRET"]
base = {"grant_type": "authorization_code", "code": "repoint-junk-code",
        "redirect_uri": os.environ["GB_REDIRECT_URI"]}
def post(style):
    data = dict(base)
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    if style == "basic":
        headers["Authorization"] = "Basic " + base64.b64encode(f"{cid}:{secret}".encode()).decode()
    else:
        data["client_id"], data["client_secret"] = cid, secret
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read(4096)
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096)
    except Exception:
        return 0, b""
for style in ("basic", "body"):
    status, body = post(style)
    code = ""
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict) and isinstance(parsed.get("error", ""), str):
            code = parsed["error"]
    except Exception:
        pass
    # Only the custodian's error CODE is ever printed.
    print(f"{style}|{status}|{code}")
PY
)"
  printf '%s\n' "$GPROBE" | sed 's/^/         probe /'
  PROOF=0; REJECTED=""
  while IFS='|' read -r style status code; do
    [ -z "${style:-}" ] && continue
    case "$code" in
      invalid_grant|access_denied) PROOF=1; break;;
      invalid_client) REJECTED="${REJECTED}${style}=invalid_client ";; 
      *) if [ "${status:-0}" = "401" ]; then REJECTED="${REJECTED}${style}=401 "; fi;;
    esac
  done <<<"$GPROBE"
  if [ "$PROOF" = 1 ]; then
    ok "client_id/client_secret accepted by the token endpoint (invalid_grant on a junk code)"
  elif [ -n "$REJECTED" ]; then
    bad "the custodian REJECTED our client credentials ($REJECTED) — check the pair Oakville issued"
  else
    bad "credential validity UNVERIFIED (no invalid_grant, no invalid_client — see the probe lines above)"
  fi
fi

# -------------------------------------------------------------- 4. render
# What the CONTAINERS would actually get. This is the step that catches a
# .env key typo, and the step that proves the secret stays in the shim.
step "compose render (what each container would receive; nothing is written)"
if [ -z "$HOST" ]; then
  blocked "no --host: the render check needs the deploy host's docker compose"
elif [ "$MODE" = "rollback" ]; then
  skipped "render check is not meaningful for --rollback (empty credentials)"
else
  {
    printf 'GB_CLIENT_ID=%q\n' "$GB_CLIENT_ID"
    printf 'GB_CLIENT_SECRET=%q\n' "$GB_CLIENT_SECRET"
    printf 'GB_SCOPE=%q\n' "$GB_SCOPE"
    printf 'GB_AUTHORIZE_URL=%q\n' "$GB_AUTHORIZE_URL"
    printf 'GB_TOKEN_URL=%q\n' "$GB_TOKEN_URL"
    printf 'GB_PKCE=%q\n' "${GB_PKCE:-false}"
    printf 'GB_NOTIFY_TOKEN=%q\n' "$GB_NOTIFY_TOKEN"
    printf 'REPO=%q\n' "$HOST_REPO"
    printf 'COMPOSE_REF=%q\n' "$COMPOSE_REF"
    cat <<'REMOTE'
set -uo pipefail
cd "$REPO" || exit 3
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
if [ -n "$COMPOSE_REF" ]; then
  # Render the compose file a REF ships, not the working tree: read-only, and
  # the only way to rehearse a compose change before it is deployed.
  case "$COMPOSE_REF" in origin/*) git -C "$REPO" fetch --quiet origin 2>/dev/null || true;; esac
  git -C "$REPO" show "$COMPOSE_REF:docker-compose.yml" > "$TMP/docker-compose.yml" || { echo "FAIL|cannot read docker-compose.yml at $COMPOSE_REF"; exit 6; }
  COMPOSE_FILE="$TMP/docker-compose.yml"
  echo "NOTE|rendering docker-compose.yml from ref $COMPOSE_REF"
else
  COMPOSE_FILE="$REPO/docker-compose.yml"
fi
# The new values layered over the host's real .env, so the render shows the
# post-re-point state — and touches nothing.
[ -f .env ] && grep -vE '^(GB_CLIENT_ID|GB_CLIENT_SECRET|GB_SCOPE|GB_AUTHORIZE_URL|GB_TOKEN_URL|GB_PKCE|GB_NOTIFY_TOKEN)=' .env > "$TMP/env" || : > "$TMP/env"
{
  printf 'GB_CLIENT_ID=%s\n' "$GB_CLIENT_ID"
  printf 'GB_CLIENT_SECRET=%s\n' "$GB_CLIENT_SECRET"
  printf 'GB_SCOPE=%s\n' "$GB_SCOPE"
  printf 'GB_AUTHORIZE_URL=%s\n' "$GB_AUTHORIZE_URL"
  printf 'GB_TOKEN_URL=%s\n' "$GB_TOKEN_URL"
  printf 'GB_PKCE=%s\n' "$GB_PKCE"
  printf 'GB_NOTIFY_TOKEN=%s\n' "$GB_NOTIFY_TOKEN"
} >> "$TMP/env"
chmod 600 "$TMP/env"
docker compose -f "$COMPOSE_FILE" --env-file "$TMP/env" config --format json > "$TMP/render.json" 2>"$TMP/err" || { cat "$TMP/err" >&2; exit 4; }
WANT_ID="$GB_CLIENT_ID" WANT_SECRET="$GB_CLIENT_SECRET" WANT_SCOPE="$GB_SCOPE" \
WANT_AUTH="$GB_AUTHORIZE_URL" WANT_TOKEN="$GB_TOKEN_URL" WANT_NOTIFY="$GB_NOTIFY_TOKEN" \
python3 - "$TMP/render.json" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
svc = d["services"]
def env(s):
    return {k: str(v) for k, v in (svc.get(s, {}).get("environment") or {}).items()}
shim, app, acct = env("greenbutton-shim"), env("energy-dashboard"), env("account-server")
def rep(label, got, want):
    if want == "":
        # Length only: `got` can be a secret.
        print(f"NOTE|{label}: compose value is empty (container len={len(got)})")
    elif got == want:
        print(f"PASS|{label} reaches the container")
    else:
        print(f"FAIL|{label}: container would get a DIFFERENT value (container len={len(got)}, input len={len(want)})")
rep("GB_CLIENT_ID", shim.get("GB_CLIENT_ID", ""), os.environ["WANT_ID"])
rep("GB_CLIENT_SECRET", shim.get("GB_CLIENT_SECRET", ""), os.environ["WANT_SECRET"])
rep("GB_SCOPE", shim.get("GB_SCOPE", ""), os.environ["WANT_SCOPE"])
rep("GB_NOTIFY_TOKEN", shim.get("GB_NOTIFY_TOKEN", ""), os.environ["WANT_NOTIFY"])
for key, want_key, prod in (("GB_AUTHORIZE_URL", "WANT_AUTH", "https://greenbutton.oakvillehydro.com/oauth/authorize"),
                            ("GB_TOKEN_URL", "WANT_TOKEN", "https://greenbutton.oakvillehydro.com/oauth/token")):
    want = os.environ[want_key]
    got = shim.get(key)
    if got == want:
        print(f"PASS|{key} reaches the container ({got})")
    elif got is None and want == prod:
        print(f"NOTE|{key} is not named in compose; the container inherits the in-code default, which IS this value ({want})")
    elif got is None:
        print(f"FAIL|{key} is not passed to the container and would fall back to PRODUCTION ({prod}) — a sandbox re-point would silently hit production")
    else:
        print(f"FAIL|{key}: container would get {got!r}, ceremony meant {want!r}")
# The containment property the four-container split exists for.
for name, e in (("energy-dashboard", app), ("account-server", acct)):
    leaked = [k for k in ("GB_CLIENT_ID", "GB_CLIENT_SECRET", "GB_NOTIFY_TOKEN") if e.get(k)]
    print(("FAIL|" if leaked else "PASS|") + f"{name} holds no Green Button secret" + (f" (found {leaked})" if leaked else ""))
print(f"PASS|shim container_name is {svc['greenbutton-shim'].get('container_name')!r}")
PY
REMOTE
  } | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" bash -s 2>"$WORK/render.err" >"$WORK/render.out"
  RC=$?
  # Print the remote verdicts through our own counters so the report is one list.
  while IFS='|' read -r tag msg; do
    case "$tag" in
      PASS) ok "render: $msg";;
      FAIL) bad "render: $msg";;
      NOTE) warn "render: $msg";;
      "") ;;
      *) printf '  %s\n' "$tag|$msg";;
    esac
  done <"$WORK/render.out"
  if [ "$RC" -ne 0 ]; then
    bad "render check could not complete on $HOST (exit $RC): $(tail -3 "$WORK/render.err" | tr '\n' ' ')"
  elif ! grep -qE '^(PASS|FAIL)\|' "$WORK/render.out"; then
    bad "render check produced no verdicts (see $WORK/render.out)"
  fi
fi

# ------------------------------------------------------- 5. write + recreate
step "write the untracked .env and recreate the containers (no rebuild)"
if [ "$MODE" = "check" ]; then
  skipped "read-only mode: nothing is written, nothing is recreated"
  printf '        plan: ssh %s \x27%s/.env\x27 — atomic rewrite, mode 0600, other keys preserved;\n' "${HOST:-<host>}" "$HOST_REPO"
  printf '              docker compose up -d (no --build); the edge-router is NOT restarted —\n'
  printf '              it re-resolves upstreams per request since the H1 fix (resolver 127.0.0.11)\n'
elif [ "$MODE" = "rehearse" ]; then
  # The write path itself, exercised against a THROWAWAY file: same grep/printf/
  # chmod/mv sequence as --apply, so a quoting or ordering bug shows up here.
  printf 'GB_TOKEN_DIR=/tmp/not-real\nGB_NOTIFY_TOKEN=deadbeef\nEXISTING_KEY=kept\n' > "$WORK/env.fixture"
  {
    printf 'GB_CLIENT_ID=%q\n' "$GB_CLIENT_ID"
    printf 'GB_CLIENT_SECRET=%q\n' "$GB_CLIENT_SECRET"
    printf 'GB_SCOPE=%q\n' "$GB_SCOPE"
    printf 'GB_NOTIFY_TOKEN=%q\n' "$GB_NOTIFY_TOKEN"
    printf 'TARGET=%q\n' "$WORK/env.fixture"
    cat <<'REMOTE'
set -uo pipefail
ENV="$TARGET"; umask 077
TMP="$ENV.tmp.$$"
grep -vE '^(GB_CLIENT_ID|GB_CLIENT_SECRET|GB_SCOPE|GB_AUTHORIZE_URL|GB_TOKEN_URL|GB_PKCE)=' "$ENV" > "$TMP"
{
  printf 'GB_CLIENT_ID=%s\n' "$GB_CLIENT_ID"
  printf 'GB_CLIENT_SECRET=%s\n' "$GB_CLIENT_SECRET"
  printf 'GB_SCOPE=%s\n' "$GB_SCOPE"
} >> "$TMP"
chmod 600 "$TMP"; mv "$TMP" "$ENV"
echo "PASS|env write is atomic and preserves unrelated keys ($(grep -c . "$ENV") lines after)"
echo "PASS|env file mode is $(stat -c %a "$ENV")"
[ "$(grep -c '^EXISTING_KEY=kept$' "$ENV")" = 1 ] && echo "PASS|pre-existing keys survive the rewrite" || echo "FAIL|pre-existing keys were lost"
echo "PASS|credentials land under their compose key names ($(grep -oE '^GB_(CLIENT_ID|CLIENT_SECRET)=' "$ENV" | tr '\n' ' '))"
REMOTE
  } | bash -s >"$WORK/write.out" 2>&1
  while IFS='|' read -r tag msg; do
    case "$tag" in PASS) ok "rehearsal write: $msg";; FAIL) bad "rehearsal write: $msg";; *) printf '  %s\n' "$tag|$msg";; esac
  done <"$WORK/write.out"
  skipped "the real .env on ${HOST:-<host>} was NOT written (rehearsal)"
  skipped "no container was recreated (rehearsal)"
elif [ -z "$HOST" ]; then
  blocked "--apply/--rollback need --host"
elif [ "$FAIL" -gt 0 ]; then
  # A failed credential probe or render must not be followed by a write.
  blocked "--apply stopped: an earlier step failed, and writing credentials on top of that is how a broken re-point reaches production"
else
  {
    printf 'GB_CLIENT_ID=%q\n' "$GB_CLIENT_ID"
    printf 'GB_CLIENT_SECRET=%q\n' "$GB_CLIENT_SECRET"
    printf 'GB_SCOPE=%q\n' "$GB_SCOPE"
    printf 'GB_AUTHORIZE_URL=%q\n' "$GB_AUTHORIZE_URL"
    printf 'GB_TOKEN_URL=%q\n' "$GB_TOKEN_URL"
    printf 'GB_PKCE=%q\n' "${GB_PKCE:-false}"
    printf 'REPO=%q\n' "$HOST_REPO"
    cat <<'REMOTE'
set -uo pipefail
cd "$REPO" || exit 3
[ -f .env ] || { echo "FAIL|$REPO/.env does not exist — it holds GB_NOTIFY_TOKEN and GB_TOKEN_DIR; create it first (OPERATIONS.md)"; exit 4; }
umask 077
cp .env ".env.bak.$(date +%s)" && echo "PASS|backed up the current .env (.env.bak.<epoch>)"
TMP=".env.tmp.$$"
grep -vE '^(GB_CLIENT_ID|GB_CLIENT_SECRET|GB_SCOPE|GB_AUTHORIZE_URL|GB_TOKEN_URL|GB_PKCE)=' .env > "$TMP"
{
  printf 'GB_CLIENT_ID=%s\n' "$GB_CLIENT_ID"
  printf 'GB_CLIENT_SECRET=%s\n' "$GB_CLIENT_SECRET"
  printf 'GB_SCOPE=%s\n' "$GB_SCOPE"
  printf 'GB_AUTHORIZE_URL=%s\n' "$GB_AUTHORIZE_URL"
  printf 'GB_TOKEN_URL=%s\n' "$GB_TOKEN_URL"
  printf 'GB_PKCE=%s\n' "$GB_PKCE"
} >> "$TMP"
chmod 600 "$TMP"
mv "$TMP" .env
echo "PASS|.env rewritten atomically (mode $(stat -c %a .env)); keys now: $(grep -oE '^[A-Z_]+=' .env | tr -d '=' | tr '\n' ' ')"
docker compose up -d >/dev/null 2>&1 || { echo "FAIL|docker compose up -d failed"; exit 5; }
echo "PASS|docker compose up -d (no --build) — $(docker compose ps --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')"
REMOTE
  } | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" bash -s 2>"$WORK/apply.err" >"$WORK/apply.out"
  RC=$?
  while IFS='|' read -r tag msg; do
    case "$tag" in PASS) ok "$msg";; FAIL) bad "$msg";; NOTE) warn "$msg";; "") ;; *) printf '  %s\n' "$tag|$msg";; esac
  done <"$WORK/apply.out"
  [ "$RC" -eq 0 ] || bad "apply step exited $RC: $(tail -3 "$WORK/apply.err" | tr '\n' ' ')"
fi

# -------------------------------------------------------------- 6. verify
# Read-only against the running stack. The two identity headers must agree —
# that pair is what catches the router answering from the wrong container.
step "verify the target ($ORIGIN)"
if [ -z "$HOST" ]; then
  blocked "no --host: nothing to verify"
else
  # --apply is the only mode that has just written credentials, so it is the
  # only mode where configured:true is expected. check/rehearse measure the
  # PRE-go-live baseline instead, where configured:false is the pass.
  if [ "$MODE" = "apply" ]; then EXPECT_CONFIGURED=1; else EXPECT_CONFIGURED=0; fi
  printf '  (%s mode: expecting configured:%s on the host)\n' "$MODE" "$([ "$EXPECT_CONFIGURED" = 1 ] && echo true || echo "false — the pre-go-live baseline")"
fi
if [ -n "$HOST" ]; then
  {
    printf 'WANT_ORIGIN=%q\n' "$ORIGIN"
    printf 'WANT_ID=%q\n' "$GB_CLIENT_ID"
    printf 'WANT_NOTIFY=%q\n' "$GB_NOTIFY_TOKEN"
    printf 'NOTIFY_PROBE=%q\n' "$NOTIFY_PROBE"
    printf 'EXPECT_CONFIGURED=%q\n' "$EXPECT_CONFIGURED"
    printf 'REPO=%q\n' "$HOST_REPO"
    cat <<'REMOTE'
set -uo pipefail
B=http://localhost:3939
hdr() { curl -sSI -m 10 "$1" 2>/dev/null | tr -d '\r' | awk -v w="$(echo "$2" | tr 'A-Z' 'a-z')" -F': ' 'tolower($1)==w{print $2}'; }
LOC="$(hdr "$B/greenbutton/status" x-edge-location)"
PROC="$(hdr "$B/greenbutton/status" x-gb-process)"
if [ "$LOC" = greenbutton ] && [ "$PROC" = shim ]; then
  echo "PASS|router split agrees on the shim (X-Edge-Location=$LOC, x-gb-process=$PROC)"
else
  echo "FAIL|router split disagrees: X-Edge-Location=$LOC, x-gb-process=$PROC (want greenbutton/shim)"
fi
ST="$(curl -fsS -m 10 "$B/greenbutton/status" 2>/dev/null || echo '{}')"
CONFIGURED=0; case "$ST" in *'"configured":true'*) CONFIGURED=1;; esac
if [ "$EXPECT_CONFIGURED" = 1 ]; then
  if [ "$CONFIGURED" = 1 ]; then
    echo "PASS|/greenbutton/status reports configured:true"
  else
    echo "FAIL|/greenbutton/status still reports configured:false (the containers did not pick the credentials up)"
  fi
else
  if [ "$CONFIGURED" = 0 ]; then
    echo "PASS|pre-go-live baseline holds: configured:false (credentials were not written by this mode)"
  else
    echo "FAIL|configured:true while this mode wrote nothing — a PREVIOUS re-point is still live; run --rollback or --apply"
  fi
fi
case "$ST" in
  *notificationUri*) echo "FAIL|/greenbutton/status publishes notificationUri (M1: it must not)";;
  *)                 echo "PASS|/greenbutton/status publishes no notificationUri";;
esac
echo "NOTE|redirectUri=$(printf '%s' "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("redirectUri",""))' 2>/dev/null)"
# The token gate turns on with the credentials: while unconfigured the shim
# short-circuits to 200, so a 404 assertion here would be meaningless noise.
if [ "$CONFIGURED" = 1 ]; then
  BAD="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST --data '<feed/>' "$B/greenbutton/notify/wrong-token")"
  [ "$BAD" = 404 ] && echo "PASS|unknown notify token → 404" || echo "FAIL|unknown notify token → $BAD (want 404)"
else
  echo "SKIP|notify-token gate (unconfigured shim answers 200 for every token)"
fi
# What the RUNNING containers hold — the render check's claim, re-read from the
# processes themselves.
SHIM_ENV="$(docker inspect greenbutton-shim --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)"
APP_ENV="$(docker inspect energy-dashboard --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)"
if [ "$EXPECT_CONFIGURED" = 1 ]; then
  shim_id="$(printf '%s' "$SHIM_ENV" | grep -c "^GB_CLIENT_ID=$WANT_ID$" || true)"
  [ "$shim_id" = 1 ] && echo "PASS|the RUNNING shim holds this exact client_id" || echo "FAIL|the RUNNING shim does not hold this client_id"
else
  echo "SKIP|shim client_id check (this mode wrote no credentials)"
fi
leak="$(printf '%s' "$APP_ENV" | grep -cE '^GB_CLIENT_(ID|SECRET)=.+' || true)"
[ "$leak" = 0 ] && echo "PASS|the RUNNING dashboard container holds no credentials" || echo "FAIL|the dashboard container holds $leak credential variable(s)"
if [ "$NOTIFY_PROBE" = 1 ] && [ "$CONFIGURED" = 1 ]; then
  CODE="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/atom+xml' \
    --data '<feed><entry><link href="http://localhost/espi/1_1/resource/Batch/Subscription/1"/></entry></feed>' \
    "$B/greenbutton/notify/$WANT_NOTIFY")"
  [ "$CODE" = 200 ] && echo "PASS|the registered notify URI is accepted (200)" || echo "FAIL|registered notify URI answered $CODE (Oakville's POSTs would not be taken)"
  ST2="$(curl -fsS -m 10 "$B/greenbutton/status" 2>/dev/null || echo '{}')"
  case "$ST2" in
    *'"dataAvailableSince":"'*) echo "PASS|dataAvailableSince stamped by the notify webhook";;
    *) echo "FAIL|notify webhook did not stamp dataAvailableSince";;
  esac
else
  echo "SKIP|registered notify URI POST (--notify-probe not set: it stamps dataAvailableSince)"
fi
REMOTE
  } | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" bash -s 2>"$WORK/verify.err" >"$WORK/verify.out"
  RC=$?
  while IFS='|' read -r tag msg; do
    case "$tag" in PASS) ok "verify: $msg";; FAIL) bad "verify: $msg";; NOTE) warn "verify: $msg";; SKIP) skipped "verify: $msg";; "") ;; *) printf '  %s\n' "$tag|$msg";; esac
  done <"$WORK/verify.out"
  [ "$RC" -eq 0 ] || bad "verify step exited $RC: $(tail -3 "$WORK/verify.err" | tr '\n' ' ')"
fi

# -------------------------------------------------------------- 7. gates
step "gates"
if [ "$RUN_LOOP" != 1 ]; then
  skipped "e2e-greenbutton-loop.sh (--loop-gate)"
elif is_placeholder "$GB_CLIENT_ID" || is_placeholder "$GB_CLIENT_SECRET"; then
  blocked "--loop-gate needs credentials; the same command re-runs it the moment they land"
elif [ "$MODE" = "rehearse" ]; then
  # The REAL-target path of the gate, driven against the mock custodian: no
  # mock is started by the gate itself, nothing is inlined, and the authorize
  # round trip completes, so every account-gated check runs too. The redirect
  # URI is the LOCAL stack's own callback, which is this rehearsal's
  # "registered" value.
  REHEARSE_BASE="http://localhost:${PORT:-3940}"
  printf '  → %s/e2e-greenbutton-loop.sh (GB_E2E_TARGET=real, mock custodian on :%s)\n' "$HERE" "$MOCK_PORT"
  BASE="$REHEARSE_BASE" GB_E2E_TARGET=real GB_E2E_ACCOUNT=1 \
    GB_CLIENT_ID="$GB_CLIENT_ID" GB_CLIENT_SECRET="$GB_CLIENT_SECRET" GB_SCOPE="$GB_SCOPE" \
    GB_AUTHORIZE_URL="$GB_AUTHORIZE_URL" GB_TOKEN_URL="$GB_TOKEN_URL" \
    GB_NOTIFY_TOKEN="$GB_NOTIFY_TOKEN" \
    GB_REDIRECT_URI="$REHEARSE_BASE/greenbutton/callback" GB_PUBLIC_ORIGIN="$REHEARSE_BASE" \
    "$HERE/e2e-greenbutton-loop.sh" 2>&1 | tee "$WORK/loop.log"
  LOOP_RC=${PIPESTATUS[0]}
  cond "loop gate green, real-target path ($(grep -c '^  PASS' "$WORK/loop.log" || true) checks, $(grep -c '^  SKIP' "$WORK/loop.log" || true) skipped, exit $LOOP_RC)" "$LOOP_RC"
else
  # The deployed stack, driven from here. GB_E2E_ACCOUNT=0 unless the caller
  # says otherwise: an anonymous GET of the real /oauth/authorize answers
  # /login, so the grant-gated checks are reported SKIP rather than faked.
  printf '  → %s/e2e-greenbutton-loop.sh (GB_E2E_TARGET=real, external stack at %s)\n' "$HERE" "$ORIGIN"
  BASE="$ORIGIN" GB_E2E_TARGET=real GB_E2E_EXTERNAL=1 GB_E2E_ACCOUNT="${GB_E2E_ACCOUNT:-0}" \
    GB_CLIENT_ID="$GB_CLIENT_ID" GB_CLIENT_SECRET="$GB_CLIENT_SECRET" GB_SCOPE="$GB_SCOPE" \
    GB_AUTHORIZE_URL="$GB_AUTHORIZE_URL" GB_TOKEN_URL="$GB_TOKEN_URL" \
    GB_NOTIFY_TOKEN="$GB_NOTIFY_TOKEN" GB_REDIRECT_URI="$ORIGIN/greenbutton/callback" \
    GB_E2E_TOKEN_READ_CMD="${GB_E2E_TOKEN_READ_CMD:-}" TOKEN_FILE="${GB_E2E_TOKEN_FILE:-$WORK/tokens.json}" \
    "$HERE/e2e-greenbutton-loop.sh" 2>&1 | tee "$WORK/loop.log"
  LOOP_RC=${PIPESTATUS[0]}
  cond "loop gate green, credential leg only ($(grep -c '^  PASS' "$WORK/loop.log" || true) checks, $(grep -c '^  SKIP' "$WORK/loop.log" || true) skipped pending the customer account, exit $LOOP_RC)" "$LOOP_RC"
fi
if [ "$RUN_TOPO" = 1 ]; then
  if command -v docker >/dev/null 2>&1; then
    "$HERE/e2e-greenbutton-topology.sh" 2>&1 | tee "$WORK/topo.log"
    cond "topology gate green (exit ${PIPESTATUS[0]})" "${PIPESTATUS[0]}"
  else
    warn "topology gate needs docker on this runner — run it on the deploy host"
  fi
else
  skipped "e2e-greenbutton-topology.sh (--with-topology)"
fi
if [ "$RUN_BROWSER" = 1 ]; then
  "$HERE/e2e-greenbutton-browser.sh" 2>&1 | tee "$WORK/browser.log"
  cond "browser gate green (exit ${PIPESTATUS[0]})" "${PIPESTATUS[0]}"
else
  skipped "e2e-greenbutton-browser.sh (--with-browser)"
fi
# The QA-owned harnesses are not in this repo. They are runnable, but their
# mock pins make a green run meaningless: qa-gate-edge.mjs inlines GB_* at 4
# sites, qa-gate-browser.mjs at 5 (and its storage scan looks for the mock
# secret VALUE, so re-pointed it would scan for a string that is not there).
# Refusing to report them is the point — a vacuous pass is worse than a skip.
if [ -n "$QA_GATE_DIR" ]; then
  for f in qa-gate-edge.mjs qa-gate-browser.mjs; do
    p="$QA_GATE_DIR/$f"
    if [ ! -f "$p" ]; then blocked "$f not found in $QA_GATE_DIR"; continue; fi
    n="$(grep -cE 'mock-client-(id|secret)' "$p" || true)"
    if [ "${n:-0}" -gt 0 ]; then
      blocked "$f still pins the mock at $n site(s) ($(grep -nE 'mock-client-(id|secret)' "$p" | cut -d: -f1 | tr '\n' ' ')) — re-point it (GREENBUTTON-REPOINT.md §6) before its verdict counts"
    else
      ok "$f carries no mock pins"
    fi
  done
else
  skipped "--qa-gate-dir (QA-owned qa-gate-*.mjs)"
fi

# -------------------------------------------------------------- 8. verdict
step "verdict"
printf '  mode=%s  steps=%s  failed=%s  blocked=%s\n' "$MODE" "$STEP" "$FAIL" "$BLOCK"
for entry in "${REPORT[@]}"; do
  case "${entry%%|*}" in FAIL|BLOCK) printf '  %-5s %s\n' "${entry%%|*}" "${entry#*|}";; esac
done
if [ "$MODE" = "apply" ] && [ "$FAIL" -eq 0 ]; then
  printf '\nNEXT (the only step no agent can do):\n'
  printf '  1. Mark opens %s, clicks "Authorise with Oakville Hydro", signs in at Oakville\n' "$ORIGIN"
  printf '     and approves the Usage Information scope.\n'
  printf '  2. Then hand t_5c16338b to QA: it re-runs the four gates with a real grant\n'
  printf '     (connected state, feed pipe-through, notify refresh, revocation).\n'
elif [ "$MODE" != "apply" ] && [ "$BLOCK" -gt 0 ]; then
  printf '\nBLOCKED steps are expected until Oakville issues the credentials: this run\n'
  printf 'measured everything that does not need them. Re-run the same command the\n'
  printf 'moment they arrive — it is the go-live command.\n'
fi
if [ "$FAIL" -gt 0 ]; then exit 1; fi
# BLOCKed = the ceremony could not answer a question (no credentials yet, or a
# step stopped the write). Exit 2 in every mode: a preflight that is not ready
# is not a green preflight.
if [ "$BLOCK" -gt 0 ]; then exit 2; fi
exit 0
