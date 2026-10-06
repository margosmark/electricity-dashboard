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
# Rerun it unchanged after registration by pointing the GB_* variables at the
# real authorizeUrl/tokenUrl instead of the mock.
#
# Usage: webapp/scripts/e2e-greenbutton-loop.sh   (from anywhere; it cds itself)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
cd "$WEBAPP"

PORT="${PORT:-3940}"
MOCK_PORT="${MOCK_PORT:-8099}"
BASE="http://localhost:$PORT"
MOCK="http://localhost:$MOCK_PORT"
WORK="$(mktemp -d)"
TOKEN_FILE="$WORK/tokens.json"
JAR="$WORK/cookies.txt"
PASS=0
FAIL=0

check() { # check <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"
  fi
}

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  wait 2>/dev/null
  if [ "$FAIL" -eq 0 ]; then
    printf '\nE2E OK — %d checks passed\n' "$PASS"
  else
    printf '\nE2E FAILED — %d passed, %d failed\n' "$PASS" "$FAIL"
    printf '  app log: %s\n  mock log: %s\n' "$WORK/app.log" "$WORK/mock.log"
  fi
}
trap cleanup EXIT

echo "== starting mock custodian on $MOCK_PORT =="
node scripts/mock-custodian.mjs --port "$MOCK_PORT" >"$WORK/mock.log" 2>&1 &
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
npx next start -p "$PORT" >"$WORK/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 90); do
  curl -fsS "$BASE/greenbutton/status" >/dev/null 2>&1 && break
  sleep 1
done

if ! curl -fsS "$BASE/greenbutton/status" >/dev/null 2>&1; then
  echo "server never came up"; cat "$WORK/app.log"; FAIL=$((FAIL + 1)); exit 1
fi

echo
echo "== 1. status before authorisation =="
STATUS0="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS0" in *'"configured":true'*) check "configured" 0;; *) check "configured" 1;; esac
case "$STATUS0" in *'"connected":false'*) check "not connected yet" 0;; *) check "not connected yet" 1;; esac

echo "== 2. start → 302 to the custodian, state cookie set =="
START_HEADERS="$(curl -sS -D- -o /dev/null -c "$JAR" "$BASE/greenbutton/start")"
AUTH_URL="$(printf '%s' "$START_HEADERS" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
case "$START_HEADERS" in *'302'*) check "start answers 302" 0;; *) check "start answers 302" 1;; esac
case "$AUTH_URL" in *"/oauth/authorize"*) check "redirects to the custodian authorize URL" 0;; *) check "redirects to the custodian authorize URL" 1;; esac
grep -q "gb_state" "$JAR"; check "gb_state cookie written" $?

echo "== 3. custodian redirects back with a code =="
AUTH_HEADERS="$(curl -sS -D- -o /dev/null --max-redirs 0 -b "$JAR" -c "$JAR" "$AUTH_URL")"
CB_URL="$(printf '%s' "$AUTH_HEADERS" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
case "$CB_URL" in "$BASE/greenbutton/callback"?code=*) check "callback URL targets our registered redirect_uri" 0;; *) check "callback URL targets our registered redirect_uri" 1;; esac
case "$CB_URL" in *state=*) check "state echoed back" 0;; *) check "state echoed back" 1;; esac

echo "== 4. callback exchanges the code =="
CB_HEADERS="$(curl -sS -D- -o /dev/null -b "$JAR" -c "$JAR" "$CB_URL")"
case "$CB_HEADERS" in *'gb=connected'*) check "redirects into the app as connected" 0;; *) check "redirects into the app as connected" 1;; esac
grep -q "gb_session" "$JAR"; check "session cookie minted" $?
[ -f "$TOKEN_FILE" ]; check "token file created" $?
[ "$(stat -c %a "$TOKEN_FILE" 2>/dev/null)" = "600" ]; check "token file mode 0600" $?
KEYS="$(python3 -c "import json,sys;print(','.join(sorted(json.load(open(sys.argv[1])).keys())))" "$TOKEN_FILE" 2>/dev/null)"
case "$KEYS" in *accessToken*refreshToken*sessionToken*) check "only the token set on disk ($KEYS)" 0;; *) check "only the token set on disk ($KEYS)" 1;; esac
grep -qi "IntervalReading" "$TOKEN_FILE"; test $? -ne 0; check "no readings on disk" $?

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
HTTP_NOCOOKIE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/greenbutton/usage")"
[ "$HTTP_NOCOOKIE" = "401" ]; check "no cookie → 401" $?

echo "== 7. notification webhook =="
NOTIFY_TOKEN="$(printf '%s' "greenbutton-notify:mock-client-secret" | sha256sum | cut -c1-32)"
NOTIFY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/atom+xml' \
  --data '<feed><entry><link href="http://localhost/espi/1_1/resource/Batch/Subscription/1"/></entry></feed>' \
  "$BASE/greenbutton/notify/$NOTIFY_TOKEN")"
[ "$NOTIFY_CODE" = "200" ]; check "registered notify URI accepted (200)" $?
BAD_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data '<feed/>' "$BASE/greenbutton/notify/wrong-token")"
[ "$BAD_CODE" = "404" ]; check "unknown notify token rejected (404)" $?
STATUS3="$(curl -fsS -b "$JAR" "$BASE/greenbutton/status")"
case "$STATUS3" in *'"dataAvailableSince":"'*) check "data-available marker recorded" 0;; *) check "data-available marker recorded" 1;; esac

echo "== 8. disconnect wipes everything =="
DISC_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -b "$JAR" -c "$JAR" "$BASE/greenbutton/disconnect")"
[ "$DISC_CODE" = "200" ]; check "disconnect accepted" $?
[ ! -f "$TOKEN_FILE" ]; check "token file deleted" $?
HTTP_AFTER="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/greenbutton/usage")"
[ "$HTTP_AFTER" = "401" ]; check "usage refuses after disconnect" $?

exit "$FAIL"
