#!/usr/bin/env bash
# Wave K gate: drive the REAL OAuth loop through the REAL server process.
#
# Starts (1) the mock data custodian and (2) `next start` pointed at it, then
# walks the whole flow over HTTP exactly as a browser would:
#
#   status → start → authorize → callback → status → usage → notify →
#   disconnect → status
#
# and asserts the parts that matter: only a token set reaches disk, the feed
# is streamed (not buffered), a session cookie is required to read it, and
# revocation leaves nothing behind.
#
# This is the stand-in for gate 1 ("shim against the SANDBOX authorizeUrl with
# a dummy user"), which needs Oakville Hydro to issue credentials first.
#
# TWO TARGETS — the gate is RE-POINTED BY ENVIRONMENT, never by editing this
# file (getting that wrong is how a "green" run ends up measuring the mock):
#
#   GB_E2E_TARGET=mock (default)
#       Launch the mock custodian on $MOCK_PORT and `next start` pointed at it.
#       Nothing else is required.
#
#   GB_E2E_TARGET=real
#       Drive a custodian that is NOT the mock — Oakville production, or their
#       sandbox — and inline NOTHING. Required: GB_CLIENT_ID, GB_CLIENT_SECRET,
#       GB_AUTHORIZE_URL, GB_TOKEN_URL, and GB_NOTIFY_TOKEN (the registered
#       path token; GB_E2E_NOTIFY_DERIVE=1 derives it from the secret instead,
#       for a sandbox that has no registered URI yet). Combined with
#       GB_E2E_EXTERNAL=1 this drives the DEPLOYED stack, which is what the
#       re-point ceremony (scripts/greenbutton-repoint.sh) does.
#
#   GB_E2E_ACCOUNT=0
#       No human can complete the authorize round trip on this target (an
#       anonymous GET of the real /oauth/authorize answers /login, so there is
#       no unattended path back with ?code=). The sections that need a real
#       grant are then reported SKIP — never silently passed — and the run
#       still proves the parts that need only credentials: configured:true, the
#       302 to the custodian, the credential-validity probe at the token
#       endpoint, and the notify-token gate. Default 1: with the mock, or with
#       Mark's account available, everything runs.
#
# Usage: webapp/scripts/e2e-greenbutton-loop.sh   (from anywhere; it cds itself)
#
# External mode (containerised topology): GB_E2E_EXTERNAL=1 plus
#   TOKEN_FILE               where the running stack keeps its token file
#   GB_E2E_TOKEN_READ_CMD    how to read that file's contents (see below)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
cd "$WEBAPP"

PORT="${PORT:-3940}"
MOCK_PORT="${MOCK_PORT:-8099}"
BASE="${BASE:-http://localhost:$PORT}"
MOCK="http://localhost:$MOCK_PORT"
WORK="$(mktemp -d)"
# GB_E2E_EXTERNAL=1: drive a stack that is ALREADY running — the containerised
# router topology (webapp/scripts/e2e-greenbutton-topology.sh) — instead of
# launching `mock custodian + next start` here. The checks are identical;
# only who owns the processes (and therefore TOKEN_FILE) changes.
EXTERNAL="${GB_E2E_EXTERNAL:-}"
TOKEN_FILE="${TOKEN_FILE:-$WORK/tokens.json}"
JAR="$WORK/cookies.txt"
TARGET="${GB_E2E_TARGET:-mock}"
ACCOUNT="${GB_E2E_ACCOUNT:-1}"
PASS=0
FAIL=0
SKIP=0

# How this script reads the token file's contents. Plain `cat` locally; in
# external mode the file lives inside a container, is owned by that
# container's uid and is mode 0600 BY DESIGN — so the gate reads it through
# the container instead of relaxing the permission it is about to assert.
token_contents() {
  if [ -n "${GB_E2E_TOKEN_READ_CMD:-}" ]; then
    sh -c "$GB_E2E_TOKEN_READ_CMD"
  else
    cat "$TOKEN_FILE"
  fi
}

port_pid() { # pid of whatever is listening on $1 (own processes only)
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

check() { # check <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"
  fi
}

# A check that CANNOT be made on this target. Counted and printed, never
# passed: an unreported skip is indistinguishable from a green run.
skip() { # skip <how-many> <label>
  SKIP=$((SKIP + $1)); printf '  SKIP  %s (%s check%s — needs a real grant)\n' "$2" "$1" "$([ "$1" = 1 ] && echo "" || echo s)"
}

# --- real-target input gate -------------------------------------------------
# Fail BEFORE starting anything (and never fall back to the mock): a run that
# silently measured the mock while claiming to test Oakville is the exact
# failure this gate exists to prevent.
if [ "$TARGET" = "real" ]; then
  MISSING=""
  for v in GB_CLIENT_ID GB_CLIENT_SECRET GB_AUTHORIZE_URL GB_TOKEN_URL; do
    if [ -z "${!v:-}" ]; then MISSING="$MISSING $v"; fi
  done
  if [ -z "${GB_NOTIFY_TOKEN:-}" ] && [ -z "${GB_E2E_NOTIFY_DERIVE:-}" ]; then
    MISSING="$MISSING GB_NOTIFY_TOKEN (or set GB_E2E_NOTIFY_DERIVE=1)"
  fi
  if [ -n "$MISSING" ]; then
    echo "ERROR: GB_E2E_TARGET=real but unset:$MISSING" >&2
    echo "       Refusing to fall back to the mock custodian." >&2
    exit 1
  fi
  # The notify token is the only gate on the webhook and the registered URI
  # carries it, so a derived value against a real custodian is refused unless
  # explicitly asked for.
  NOTIFY_TOKEN="${GB_NOTIFY_TOKEN:-$(printf '%s' "greenbutton-notify:$GB_CLIENT_SECRET" | sha256sum | cut -c1-32)}"
  REDIRECT="${GB_REDIRECT_URI:-https://electricity.markarslan.ca/greenbutton/callback}"
else
  NOTIFY_TOKEN="$(printf '%s' "greenbutton-notify:mock-client-secret" | sha256sum | cut -c1-32)"
  REDIRECT="$BASE/greenbutton/callback"
fi

cleanup() {
  # Kill the whole process GROUP, not just the launcher: `npx next start`
  # forks a next-server child that survives a plain kill and then silently
  # answers the NEXT run's requests out of a deleted temp dir.
  # In external mode this script owns nothing, so it kills nothing.
  if [ -z "$EXTERNAL" ]; then
    if [ -n "${APP_PID:-}" ]; then kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null; fi
    if [ -n "${MOCK_PID:-}" ]; then kill -- -"$MOCK_PID" 2>/dev/null || kill "$MOCK_PID" 2>/dev/null; fi
    wait 2>/dev/null
    # Belt and braces: `npx next start` double-forks, so the group kill can
    # miss the server that actually holds the port. Find it by its listener.
    local holder
    holder="$(port_pid "$PORT")"
    if [ -n "$holder" ]; then kill "$holder" 2>/dev/null; fi
  fi
  if [ "$FAIL" -eq 0 ]; then
    printf '\nE2E OK — %d checks passed' "$PASS"
    if [ "$SKIP" -gt 0 ]; then printf ', %d skipped (see SKIP lines above)' "$SKIP"; fi
    printf '\n'
  else
    printf '\nE2E FAILED — %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    printf '  app log: %s\n  mock log: %s\n' "$WORK/app.log" "$WORK/mock.log"
  fi
}
trap cleanup EXIT

# Fail loudly instead of letting a stale process from an earlier run answer
# this one's requests (that produced 3 phantom failures before this check).
# External mode skips this: there the stack is supposed to be already up.
if [ -z "$EXTERNAL" ] && curl -fsS --max-time 2 "$BASE/greenbutton/status" >/dev/null 2>&1; then
  echo "ERROR: something already answers on $PORT (a previous run did not clean up)." >&2
  echo "       free it first:  pkill -f 'next[ ]start -p $PORT'" >&2
  exit 1
fi

if [ -z "$EXTERNAL" ] && [ "$TARGET" = "mock" ]; then
  echo "== starting mock custodian on $MOCK_PORT =="
  setsid node scripts/mock-custodian.mjs --port "$MOCK_PORT" >"$WORK/mock.log" 2>&1 &
  MOCK_PID=$!

  echo "== starting next start on $PORT =="
  GB_AUTHORIZE_URL="$MOCK/oauth/authorize" \
  GB_TOKEN_URL="$MOCK/oauth/token" \
  GB_CLIENT_ID="mock-client-id" \
  GB_CLIENT_SECRET="mock-client-secret" \
  GB_REDIRECT_URI="$BASE/greenbutton/callback" \
  GB_PUBLIC_ORIGIN="$BASE" \
  GB_TOKEN_FILE="$TOKEN_FILE" \
  GB_SCOPE="FB=1_3_4_5" \
  setsid npx next start -p "$PORT" >"$WORK/app.log" 2>&1 &
  APP_PID=$!
elif [ -z "$EXTERNAL" ]; then
  # Real target, locally built stack: the caller's GB_* are passed through
  # UNTOUCHED — only the loop-back addresses this script owns are added, and
  # GB_SCOPE/token URLs are never substituted. Nothing here can silently point
  # the stack at the mock.
  echo "== starting next start on $PORT against the REAL custodian ($GB_AUTHORIZE_URL) =="
  GB_AUTHORIZE_URL="$GB_AUTHORIZE_URL" \
  GB_TOKEN_URL="$GB_TOKEN_URL" \
  GB_CLIENT_ID="$GB_CLIENT_ID" \
  GB_CLIENT_SECRET="$GB_CLIENT_SECRET" \
  GB_SCOPE="${GB_SCOPE:-FB=1_3_4_5}" \
  GB_NOTIFY_TOKEN="$NOTIFY_TOKEN" \
  GB_REDIRECT_URI="$REDIRECT" \
  GB_PUBLIC_ORIGIN="${GB_PUBLIC_ORIGIN:-$BASE}" \
  GB_TOKEN_FILE="$TOKEN_FILE" \
  setsid npx next start -p "$PORT" >"$WORK/app.log" 2>&1 &
  APP_PID=$!
else
  echo "== external mode: driving the already-running stack at $BASE =="
fi

for _ in $(seq 1 90); do
  curl -fsS "$BASE/greenbutton/status" >/dev/null 2>&1 && break
  sleep 1
done

if ! curl -fsS "$BASE/greenbutton/status" >/dev/null 2>&1; then
  echo "server never came up"; cat "$WORK/app.log" 2>/dev/null; FAIL=$((FAIL + 1)); exit 1
fi

echo
echo "== 1. status before authorisation =="
STATUS0="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS0" in *'"configured":true'*) check "configured" 0;; *) check "configured" 1;; esac
case "$STATUS0" in *'"connected":false'*) check "not connected yet" 0;; *) check "not connected yet" 1;; esac

if [ "$TARGET" = "real" ]; then
  echo
  echo "== 1b. the custodian accepts OUR credentials (needs no customer account) =="
  # A junk authorization_code with GOOD client credentials must come back
  # `invalid_grant` (RFC 6749 §5.2). HTTP 401, or `invalid_client`, means the
  # custodian rejected client_id/client_secret — the one failure no amount of
  # re-authorising in the UI can fix. Both auth styles are probed because
  # tokenAuthStyle defaults to `auto` (basic, then form-body on invalid_client).
  # Credentials go in the CHILD ENVIRONMENT, never argv, and only the
  # custodian's error CODE is printed — a token-endpoint body can echo the
  # request parameters straight back.
  PROBE="$(GB_CLIENT_ID="$GB_CLIENT_ID" GB_CLIENT_SECRET="$GB_CLIENT_SECRET" \
           GB_TOKEN_URL="$GB_TOKEN_URL" GB_REDIRECT_URI="$REDIRECT" python3 - <<'PY' 2>/dev/null
import base64, json, os, urllib.error, urllib.parse, urllib.request
url = os.environ["GB_TOKEN_URL"]
cid, secret = os.environ["GB_CLIENT_ID"], os.environ["GB_CLIENT_SECRET"]
base = {"grant_type": "authorization_code", "code": "e2e-junk-code",
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
        if isinstance(parsed, dict):
            code = parsed.get("error", "") if isinstance(parsed.get("error", ""), str) else ""
    except Exception:
        pass
    print(f"{style}|{status}|{code}")
PY
)"
  printf '%s\n' "$PROBE" | while IFS='|' read -r style status code; do
    printf '        token probe (%s): HTTP %s error=%s\n' "$style" "${status:-?}" "${code:-<none>}"
  done
  # `PROOF` only turns 1 on a positive answer — a probe that never reached the
  # custodian (DNS, TLS, 502) must not read as "credentials accepted".
  PROOF=0
  REJECTED=0
  while IFS='|' read -r style status code; do
    [ -z "${style:-}" ] && continue
    case "$code" in
      invalid_grant|access_denied) PROOF=1; REJECTED=0; break;;
      invalid_client) REJECTED=1;;
      *) if [ "${status:-0}" = "401" ]; then REJECTED=1; fi;;
    esac
  done <<<"$PROBE"
  if [ "$REJECTED" = 1 ]; then
    check "custodian accepts our client credentials (invalid_grant, not invalid_client/401)" 1
  else
    check "custodian accepts our client credentials (invalid_grant, not invalid_client/401)" "$([ "$PROOF" = 1 ] && echo 0 || echo 1)"
  fi
fi

echo "== 2. start → 302 to the custodian, state cookie set =="
START_HEADERS="$(curl -sS -D- -o /dev/null -c "$JAR" "$BASE/greenbutton/start")"
AUTH_URL="$(printf '%s' "$START_HEADERS" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
case "$START_HEADERS" in *'302'*) check "start answers 302" 0;; *) check "start answers 302" 1;; esac
case "$AUTH_URL" in *"/oauth/authorize"*) check "redirects to the custodian authorize URL" 0;; *) check "redirects to the custodian authorize URL" 1;; esac
grep -q "gb_state" "$JAR"; check "gb_state cookie written" $?
if [ "$TARGET" = "real" ]; then
  # The container's env, not the author's memory: this is what catches a
  # copy-paste that left authorizeUrl pointing at dev/a mock/a sandbox.
  WANT_HOST="$(printf '%s' "$GB_AUTHORIZE_URL" | awk -F/ '{print $3}')"
  AUTH_HOST="$(printf '%s' "$AUTH_URL" | awk -F/ '{print $3}')"
  [ -n "$WANT_HOST" ] && [ "$AUTH_HOST" = "$WANT_HOST" ]
  check "authorize redirect goes to the CONFIGURED host ($AUTH_HOST, want $WANT_HOST)" $?
fi

if [ "$ACCOUNT" = "1" ]; then
  echo "== 3. custodian redirects back with a code =="
  AUTH_HEADERS="$(curl -sS -D- -o /dev/null --max-redirs 0 -b "$JAR" -c "$JAR" "$AUTH_URL")"
  CB_URL="$(printf '%s' "$AUTH_HEADERS" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  case "$CB_URL" in "$BASE/greenbutton/callback"?code=*) check "callback URL targets our registered redirect_uri" 0;; *) check "callback URL targets our registered redirect_uri" 1;; esac
  case "$CB_URL" in *state=*) check "state echoed back" 0;; *) check "state echoed back" 1;; esac

  echo "== 4. callback exchanges the code =="
  CB_HEADERS="$(curl -sS -D- -o /dev/null -b "$JAR" -c "$JAR" "$CB_URL")"
  case "$CB_HEADERS" in *'gb=connected'*) check "redirects into the app as connected" 0;; *) check "redirects into the app as connected" 1;; esac
  grep -q "gb_session" "$JAR"; check "session cookie minted" $?
  # The session must be minted for at most 90 days — a decade was the finding
  # (a leaked cookie granting /greenbutton/usage until 2036).
  SESSION_LINE="$(printf '%s' "$CB_HEADERS" | grep -i '^set-cookie: *gb_session=' | head -1)"
  GB_MAX_AGE="$(printf '%s' "$SESSION_LINE" | grep -oi 'Max-Age=[0-9]*' | head -1 | cut -d= -f2)"
  printf '%s' "$SESSION_LINE" | grep -qi 'HttpOnly'; check "gb_session is HttpOnly" $?
  if [ -n "$GB_MAX_AGE" ] && [ "$GB_MAX_AGE" -le 7776000 ]; then
    check "gb_session expires within 90 days (Max-Age=$GB_MAX_AGE)" 0
  else
    check "gb_session expires within 90 days (Max-Age=${GB_MAX_AGE:-missing})" 1
  fi
  [ -f "$TOKEN_FILE" ]; check "token file created" $?
  [ "$(stat -c %a "$TOKEN_FILE" 2>/dev/null)" = "600" ]; check "token file mode 0600" $?
  TOKEN_BODY="$(token_contents 2>"$WORK/token-read.err")"
  if [ -z "$TOKEN_BODY" ] && [ -s "$WORK/token-read.err" ]; then
    # Surface WHY the read failed — an empty body alone is indistinguishable
    # from a genuinely empty file, and this gate must never pass vacuously.
    printf '  (token read failed: %s)\n' "$(tr '\n' ' ' < "$WORK/token-read.err" | cut -c1-300)"
  fi
  [ -n "$TOKEN_BODY" ]; check "token file readable by the gate" $?
  KEYS="$(printf '%s' "$TOKEN_BODY" | python3 -c "import json,sys;print(','.join(sorted(json.load(sys.stdin).keys())))" 2>/dev/null)"
  case "$KEYS" in *accessToken*refreshToken*sessionToken*) check "only the token set on disk ($KEYS)" 0;; *) check "only the token set on disk ($KEYS)" 1;; esac
  if printf '%s' "$TOKEN_BODY" | grep -qi "IntervalReading"; then HAS_READINGS=1; else HAS_READINGS=0; fi
  check "no readings on disk" "$HAS_READINGS"

  echo "== 5. status = connected, and only with the cookie =="
  STATUS1="$(curl -fsS -b "$JAR" "$BASE/greenbutton/status")"
  case "$STATUS1" in *'"connected":true'*) check "connected with cookie" 0;; *) check "connected with cookie" 1;; esac
  STATUS2="$(curl -fsS "$BASE/greenbutton/status")"
  case "$STATUS2" in *'"connected":false'*) check "not connected without cookie" 0;; *) check "not connected without cookie" 1;; esac

  echo "== 6. the feed pipes through =="
  HTTP_CODE="$(curl -sS -o "$WORK/feed.xml" -w '%{http_code}' -b "$JAR" "$BASE/greenbutton/usage")"
  [ "$HTTP_CODE" = "200" ]; check "usage answers 200" $?
  READINGS="$(grep -o "<espi:IntervalReading>" "$WORK/feed.xml" | wc -l | tr -d ' ')"
  [ "$READINGS" -gt 0 ]; check "feed carries $READINGS IntervalReadings" $?
  PIPE="$(curl -sSI -b "$JAR" "$BASE/greenbutton/usage" | tr -d '\r' | grep -i '^x-greenbutton-pipe:' | awk '{print $2}')"
  [ "$PIPE" = "stream" ]; check "response is streamed, not buffered" $?
  # Sliding expiry: an authenticated read re-issues the cookie for the SAME
  # window it was minted with, so expiry tracks use rather than a fixed date.
  USAGE_MAX_AGE="$(curl -sSI -b "$JAR" "$BASE/greenbutton/usage" | tr -d '\r' | grep -i '^set-cookie: *gb_session=' | grep -oi 'Max-Age=[0-9]*' | head -1 | cut -d= -f2)"
  [ -n "$USAGE_MAX_AGE" ] && [ "$USAGE_MAX_AGE" = "$GB_MAX_AGE" ]; check "gb_session slides on an authenticated read (Max-Age=${USAGE_MAX_AGE:-missing}, minted $GB_MAX_AGE)" $?
  HTTP_NOCOOKIE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/greenbutton/usage")"
  [ "$HTTP_NOCOOKIE" = "401" ]; check "no cookie → 401" $?
else
  skip 2 "custodian redirect back with a code"
  skip 7 "callback code exchange + token file"
  skip 2 "connected-state session gate"
  skip 6 "ESPI feed pipe-through"
fi

echo "== 7. notification webhook =="
NOTIFY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/atom+xml' \
  --data '<feed><entry><link href="http://localhost/espi/1_1/resource/Batch/Subscription/1"/></entry></feed>' \
  "$BASE/greenbutton/notify/$NOTIFY_TOKEN")"
[ "$NOTIFY_CODE" = "200" ]; check "registered notify URI accepted (200)" $?
BAD_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data '<feed/>' "$BASE/greenbutton/notify/wrong-token")"
[ "$BAD_CODE" = "404" ]; check "unknown notify token rejected (404)" $?
STATUS3="$(curl -fsS -b "$JAR" "$BASE/greenbutton/status")"
case "$STATUS3" in *'"dataAvailableSince":"'*) check "data-available marker recorded" 0;; *) check "data-available marker recorded" 1;; esac

if [ "$ACCOUNT" = "1" ]; then
  echo "== 8. disconnect wipes everything =="
  DISC_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -b "$JAR" -c "$JAR" "$BASE/greenbutton/disconnect")"
  [ "$DISC_CODE" = "200" ]; check "disconnect accepted" $?
  [ ! -f "$TOKEN_FILE" ]; check "token file deleted" $?
  HTTP_AFTER="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/greenbutton/usage")"
  [ "$HTTP_AFTER" = "401" ]; check "usage refuses after disconnect" $?
else
  skip 3 "disconnect wipes the grant"
fi

exit "$FAIL"
