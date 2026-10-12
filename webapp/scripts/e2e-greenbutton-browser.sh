#!/usr/bin/env bash
# Wave K / t_500e6614 — BROWSER gate for the Green Button connect flow.
#
# The HTTP gate (e2e-greenbutton-loop.sh) proves the shim's routes; the
# browser gate proves the half only a browser can: the toolbar button → the
# custodian's authorize endpoint → back through the registered redirect_uri →
# the piped feed ingested by the EXISTING localStorage path, with no token
# material left anywhere the page can read.
#
# It boots the same stack the HTTP gate does (mock custodian + `next start`
# with GB_* pointing at it) and then runs the whole Playwright suite against
# it, so the manual DMD import (`/import`, upload modal, journey specs) is
# re-verified WITH the feature switched on — not merely assumed unchanged.
#
# GB_E2E_REQUIRED=1 makes greenbutton-connect.spec.ts FAIL instead of skip if
# the server it is pointed at is not configured: a gate that can silently
# skip is not a gate.
#
# RE-POINTING: GB_E2E_TARGET=real drives a custodian that is not the mock and
# inlines nothing — see the loop gate's header for the contract. Because the
# connect spec walks the authorize round trip IN A BROWSER, a real target also
# needs a grant that can be completed: with GB_E2E_ACCOUNT=0 (Oakville before
# Mark authorises, where /oauth/authorize answers /login) the run is REFUSED
# rather than reported red for a step nobody can perform unattended. That leg
# belongs to the QA card (t_5c16338b), after his account is connected.
#
# Usage: webapp/scripts/e2e-greenbutton-browser.sh   (from anywhere; it cds)
#   GB_E2E_SKIP_BUILD=1   reuse the existing .next (faster inner loop)
#   PORT / MOCK_PORT      override the defaults (3941 / 8099)
#   GB_E2E_EXTERNAL=1     drive an already-running stack at BASE (no build, no
#                         launch) — the only useful shape for a real target

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
cd "$WEBAPP"

PORT="${PORT:-3941}"
MOCK_PORT="${MOCK_PORT:-8099}"
BASE="${BASE:-http://localhost:$PORT}"
MOCK="http://localhost:$MOCK_PORT"
WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
TOKEN_FILE="${TOKEN_FILE:-$WORK/tokens.json}"
TARGET="${GB_E2E_TARGET:-mock}"
ACCOUNT="${GB_E2E_ACCOUNT:-1}"
EXTERNAL="${GB_E2E_EXTERNAL:-}"
PASS=0
FAIL=0

# --- re-point input gate ----------------------------------------------------
if [ "$TARGET" = "real" ]; then
  MISSING=""
  for v in GB_CLIENT_ID GB_CLIENT_SECRET GB_AUTHORIZE_URL GB_TOKEN_URL; do
    if [ -z "${!v:-}" ]; then MISSING="$MISSING $v"; fi
  done
  if [ -n "$MISSING" ]; then
    echo "ERROR: GB_E2E_TARGET=real but unset:$MISSING" >&2
    exit 1
  fi
  if [ "$ACCOUNT" != "1" ]; then
    cat >&2 <<'EOF'
ERROR: the browser gate walks the authorize round trip in a real browser, so a
       real target (GB_E2E_TARGET=real) with GB_E2E_ACCOUNT=0 cannot complete:
       an anonymous GET of the real /oauth/authorize answers /login and there
       is no unattended path back with ?code=. Refusing to report a red for a
       step nobody can perform — connect the customer account first, then run
       this gate (QA card t_5c16338b owns that leg).
EOF
    exit 1
  fi
  if [ -n "$EXTERNAL" ]; then
    echo "== external real target: driving the running stack at $BASE =="
  else
    echo "== real target: launching a local stack against $GB_AUTHORIZE_URL =="
  fi
fi

port_pid() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

check() {
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"
  fi
}

cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null; fi
  if [ -n "${MOCK_PID:-}" ]; then kill -- -"$MOCK_PID" 2>/dev/null || kill "$MOCK_PID" 2>/dev/null; fi
  wait 2>/dev/null
  local holder
  holder="$(port_pid "$PORT")"
  if [ -n "$holder" ]; then kill "$holder" 2>/dev/null; fi
  if [ "$FAIL" -eq 0 ]; then
    printf '\nBROWSER E2E OK — %d checks passed\n' "$PASS"
  else
    printf '\nBROWSER E2E FAILED — %d passed, %d failed\n' "$PASS" "$FAIL"
    printf '  playwright: %s\n  app log: %s\n  mock log: %s\n' "$WORK/pw.log" "$WORK/app.log" "$WORK/mock.log"
  fi
}
trap cleanup EXIT

if [ -z "$EXTERNAL" ]; then
  if [ -z "$(port_pid "$PORT")" ]; then :; else
    if curl -fsS --max-time 2 "$BASE/greenbutton/status" >/dev/null 2>&1; then
      echo "ERROR: something already answers on $PORT (a previous run did not clean up)." >&2
      echo "       free it first:  pkill -f 'next[ ]start -p $PORT'" >&2
      exit 1
    fi
  fi
fi

# A stale build would gate yesterday's code, so build unless told otherwise.
if [ -z "${GB_E2E_SKIP_BUILD:-}" ] && [ -z "$EXTERNAL" ]; then
  echo "== npm run build =="
  if ! npm run build >"$WORK/build.log" 2>&1; then
    echo "build failed:" >&2; tail -40 "$WORK/build.log" >&2; exit 1
  fi
fi
if [ -z "$EXTERNAL" ] && [ ! -f .next/BUILD_ID ]; then
  echo "ERROR: no production build at $WEBAPP/.next — run \`npm run build\` first." >&2
  exit 1
fi

if [ -z "$EXTERNAL" ]; then
  if [ "$TARGET" = "mock" ]; then
    echo "== starting mock custodian on $MOCK_PORT =="
    setsid node scripts/mock-custodian.mjs --port "$MOCK_PORT" >"$WORK/mock.log" 2>&1 &
    MOCK_PID=$!

    echo "== starting next start on $PORT (configured shim, mock custodian) =="
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
  else
    # Real target, locally built stack: the caller's GB_* pass through
    # untouched. Only the loop-back addresses belong to this script.
    GB_AUTHORIZE_URL="$GB_AUTHORIZE_URL" \
    GB_TOKEN_URL="$GB_TOKEN_URL" \
    GB_CLIENT_ID="$GB_CLIENT_ID" \
    GB_CLIENT_SECRET="$GB_CLIENT_SECRET" \
    GB_SCOPE="${GB_SCOPE:-FB=1_3_4_5}" \
    GB_NOTIFY_TOKEN="${GB_NOTIFY_TOKEN:-}" \
    GB_REDIRECT_URI="${GB_REDIRECT_URI:-$BASE/greenbutton/callback}" \
    GB_PUBLIC_ORIGIN="${GB_PUBLIC_ORIGIN:-$BASE}" \
    GB_TOKEN_FILE="$TOKEN_FILE" \
    setsid npx next start -p "$PORT" >"$WORK/app.log" 2>&1 &
    APP_PID=$!
  fi
else
  echo "== external mode: the stack at $BASE is already running =="
fi

for _ in $(seq 1 90); do
  curl -fsS "$BASE/greenbutton/status" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "$BASE/greenbutton/status" >/dev/null 2>&1; then
  echo "server never came up"; cat "$WORK/app.log" 2>/dev/null; FAIL=$((FAIL + 1)); exit 1
fi

STATUS="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS" in *'"configured":true'*) check "shim reports configured" 0;; *) check "shim reports configured" 1;; esac
case "$STATUS" in *"$BASE/greenbutton/callback"*) check "redirect_uri is this stack's /greenbutton/callback" 0;; *) check "redirect_uri is this stack's /greenbutton/callback" 1;; esac

echo
echo "== playwright suite against the configured stack =="
# GB_CLIENT_SECRET rides along so the spec's storage scan matches the secret
# THIS run holds instead of the mock literal (a re-pointed run would otherwise
# scan for a string that is not there — see the spec's TOKEN_PATTERNS).
SMOKE_BASE_URL="$BASE" GB_E2E_REQUIRED=1 GB_CLIENT_SECRET="${GB_CLIENT_SECRET:-mock-client-secret}" \
  npx playwright test 2>&1 | tee "$WORK/pw.log"
PW_STATUS=${PIPESTATUS[0]}
check "playwright suite green (exit $PW_STATUS)" "$PW_STATUS"

# The connect-flow spec must have actually RAN — a skip here would mean the
# gate quietly did nothing. The list reporter marks a passing test with ✓
# and a skipped one with -, so require the former on a line naming the file.
CONNECT_LINE="$(grep -E 'greenbutton-connect\.spec\.ts' "$WORK/pw.log" | head -3 | tr '\n' ' ')"
case "$CONNECT_LINE" in
  *"✓"*) check "connect-flow spec ran and passed" 0;;
  *)     check "connect-flow spec ran and passed (saw: ${CONNECT_LINE:-nothing})" 1;;
esac

exit "$FAIL"
