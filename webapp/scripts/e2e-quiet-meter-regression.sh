#!/usr/bin/env bash
# QUIET METER behavioural regression — the ONE command for t_f6c32622.
#
# Runs the real production build in a browser and holds the redesign to its
# behavioural contract: the four-tab strip (Overview / Analytics / Plans /
# Money — no Usage tab, `#tab=usage` lands on Analytics) with ARIA keyboard
# navigation, both themes painting without console/page errors, the Overview's
# source-derived figures (argmin verdict, inline provisional marker, the
# 0,2,…,14 rate grid with focusable marks and a semantic companion table),
# attention items that only appear for real conditions and always carry a
# remedy, the Money tab's decomposition → alert → pace ordering, and the
# 390×844 geometry floor (no horizontal overflow, no target under 44px).
#
# It also writes durable evidence — four app screenshots (1440×900 and
# 390×844, light and dark) plus geometry.json — under
# webapp/evidence/quiet-meter-regression/.
#
# Usage:  webapp/scripts/e2e-quiet-meter-regression.sh        (from anywhere; it cds)
#   E2E_QM_SKIP_BUILD=1    reuse the existing .next (faster inner loop)
#   PORT                   override 3210
#   E2E_QM_BASE            drive an already-running stack (no build/launch)
#   E2E_QM_EVIDENCE        where the screenshots + JSON land
#
# Exit code is non-zero if any check fails.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$WEBAPP/.." && pwd)"
cd "$WEBAPP"

PORT="${PORT:-3210}"
BASE="${E2E_QM_BASE:-http://localhost:$PORT}"
EVIDENCE="${E2E_QM_EVIDENCE:-$REPO/webapp/evidence/quiet-meter-regression}"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

# Same browser strategy as e2e-theme-regression.sh: never download a browser,
# use the system one this box already has.
export PW_CHROMIUM_PATH="${PW_CHROMIUM_PATH:-/usr/bin/google-chrome}"

check() { # check <label> <exit-status>
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"
  fi
}

port_pid() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null; fi
  wait 2>/dev/null
  local holder
  holder="$(port_pid "$PORT")"
  if [ -n "$holder" ]; then kill "$holder" 2>/dev/null; fi
  if [ "$FAIL" -eq 0 ]; then
    printf '\nQUIET METER REGRESSION OK — %d checks passed\n' "$PASS"
  else
    printf '\nQUIET METER REGRESSION FAILED — %d passed, %d failed\n' "$PASS" "$FAIL"
    printf '  playwright: %s\n  app log: %s\n' "$WORK/pw.log" "$WORK/app.log"
  fi
}
trap cleanup EXIT

EXTERNAL="${E2E_QM_BASE:-}"

# --- 1. a real production build to walk -------------------------------------
if [ -z "$EXTERNAL" ]; then
  if [ -n "$(port_pid "$PORT")" ]; then
    echo "ERROR: something already answers on $PORT (a previous run did not clean up)." >&2
    echo "       free it first:  pkill -f 'next[ ]start -p $PORT'" >&2
    exit 1
  fi
  if [ -z "${E2E_QM_SKIP_BUILD:-}" ]; then
    echo "== npm run build =="
    if ! npm run build >"$WORK/build.log" 2>&1; then
      echo "build failed:" >&2; tail -40 "$WORK/build.log" >&2; exit 1
    fi
  fi
  if [ ! -f .next/BUILD_ID ]; then
    echo "ERROR: no production build at $WEBAPP/.next — run \`npm run build\` first." >&2
    exit 1
  fi

  echo "== next start on $PORT =="
  setsid npx --no-install next start -p "$PORT" >"$WORK/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$BASE/" 2>/dev/null && break
    sleep 1
  done
  if ! curl -fsS -o /dev/null "$BASE/" 2>/dev/null; then
    echo "server never came up on $BASE" >&2; tail -20 "$WORK/app.log" 2>/dev/null >&2
    check "the app answers on $BASE" 1
    exit 1
  fi
  check "the app answers on $BASE" 0
else
  echo "== external stack: $BASE =="
fi

VERSION_JSON="$(curl -fsS "$BASE/api/version" 2>/dev/null || echo '{}')"
BUILD_ID="$(printf '%s' "$VERSION_JSON" | sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$VERSION_JSON" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
echo "   served build: buildId=${BUILD_ID:-?} sha=${SHA:-?} (git HEAD $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?'))"
check "the running build answers /api/version" "$([ -n "$BUILD_ID" ] && echo 0 || echo 1)"

# A stale evidence directory would let this run inherit a previous run's
# screenshots, so start clean.
mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE"/overview-*.png "$EVIDENCE"/geometry.json

# --- 2. the browser contract ------------------------------------------------
# The source commit under test goes into the evidence next to the build the
# server reports, so a screenshot can never be blamed on the wrong tree.
QM_GIT_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
echo
echo "== playwright: tests/e2e/quiet-meter-regression.spec.ts (HEAD ${QM_GIT_SHA:0:12}) =="
SMOKE_BASE_URL="$BASE" QM_EVIDENCE_DIR="$EVIDENCE" QM_GIT_SHA="$QM_GIT_SHA" \
  npx playwright test tests/e2e/quiet-meter-regression.spec.ts 2>&1 | tee "$WORK/pw.log"
PW_STATUS=${PIPESTATUS[0]}
check "playwright suite green (exit $PW_STATUS)" "$PW_STATUS"

# A silently skipped (or uncollected) spec would leave the gate green over a
# page nothing measured — the exact hole this suite exists to close. The list
# reporter's summary line is the count of record, not the per-test glyphs.
SUMMARY="$(grep -E '^ *[0-9]+ (passed|failed)' "$WORK/pw.log" | tail -1 || true)"
SKIPPED_COUNT="$(grep -oE '[0-9]+ skipped' "$WORK/pw.log" | tail -1 | grep -oE '[0-9]+' || echo 0)"
if [ -n "$SUMMARY" ] && [ "${SKIPPED_COUNT:-0}" -eq 0 ]; then
  check "the spec ran (${SUMMARY// /}, 0 skipped)" 0
else
  check "the spec ran (summary: ${SUMMARY:-none}, ${SKIPPED_COUNT:-?} skipped)" 1
fi

# --- 3. the evidence the run promised ---------------------------------------
for shot in overview-1440-light.png overview-1440-dark.png overview-390-light.png overview-390-dark.png; do
  if [ -s "$EVIDENCE/$shot" ]; then
    check "screenshot $shot exists ($(stat -c%s "$EVIDENCE/$shot") bytes)" 0
  else
    check "screenshot $shot exists" 1
  fi
done
if [ -s "$EVIDENCE/geometry.json" ]; then
  check "geometry.json recorded ($EVIDENCE/geometry.json)" 0
else
  check "geometry.json recorded" 1
fi

exit "$FAIL"
