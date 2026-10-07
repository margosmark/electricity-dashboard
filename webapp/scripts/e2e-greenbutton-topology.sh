#!/usr/bin/env bash
# Containerised topology gate — the SAME three-container shape production
# runs, exercised end to end against a mock data custodian:
#
#   curl :3940 → edge-router ─┬─ /greenbutton/* → greenbutton-shim (creds, token file)
#                             └─ everything else → energy-dashboard (no creds)
#
# It reuses the 25 checks in e2e-greenbutton-loop.sh (GB_E2E_EXTERNAL=1) and
# adds the routing assertions that only make sense here: which container
# actually answered.
#
# Nothing in this script touches the live stack: the router binds 3940, the
# mock 8099, and every container name is prefixed gb-topo-.
#
# Usage: webapp/scripts/e2e-greenbutton-topology.sh   (from anywhere; it cds)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$WEBAPP/.." && pwd)"
COMPOSE_FILE="$REPO/ops/edge/topology-test.compose.yml"
PORT="${PORT:-3940}"
BASE="http://localhost:$PORT"
PASS=0
FAIL=0

check() { # check <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"
  fi
}

IMAGE="electricity-dashboard-energy-dashboard:latest"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ERROR: $IMAGE not built here. Run: docker compose build" >&2
  exit 1
fi

# The shim runs as uid 1001 and must be able to create tokens.json in here;
# the e2e script then asserts mode 0600 and reads it back as this user.
TOKEN_DIR="$(mktemp -d)"
chmod 777 "$TOKEN_DIR"

# The mock has to be reachable from TWO places with ONE URL: the shim
# container (over the network) and the curl "browser" running on this host.
HOST_IP="${GB_TOPO_HOST_IP:-$(hostname -I | awk '{print $1}')}"
export GB_TOPO_TOKEN_DIR="$TOKEN_DIR"
export GB_TOPO_MOCK_ORIGIN="http://$HOST_IP:8099"

cleanup() {
  if [ "$FAIL" -eq 0 ]; then
    docker compose -p gb-topo -f "$COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1
    rm -rf "$TOKEN_DIR"
    printf '\nTOPOLOGY OK — %d checks passed\n' "$PASS"
  else
    printf '\nTOPOLOGY FAILED — %d passed, %d failed\n' "$PASS" "$FAIL"
    printf '  token dir (kept for inspection): %s\n' "$TOKEN_DIR"
    printf '  --- container logs ---\n'
    docker compose -p gb-topo -f "$COMPOSE_FILE" logs --tail 30 2>&1 | sed 's/^/  /'
    docker compose -p gb-topo -f "$COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT

for p in "$PORT" 8099; do
  if ss -ltnH "sport = :$p" | grep -q .; then
    echo "ERROR: host port $p is already in use — free it first." >&2
    exit 1
  fi
done

echo "== bringing up the topology stack (router:$PORT mock:8099) =="
if ! docker compose -p gb-topo -f "$COMPOSE_FILE" up -d; then
  echo "ERROR: compose up failed" >&2
  FAIL=$((FAIL + 1)); exit 1
fi

for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "$BASE/greenbutton/status" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS --max-time 2 "$BASE/greenbutton/status" >/dev/null 2>&1; then
  echo "ERROR: stack never became ready" >&2
  FAIL=$((FAIL + 1)); exit 1
fi

echo
echo "== 0. the router really is splitting the path =="
UP_SHIM="$(curl -sSI "$BASE/greenbutton/status" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-edge-upstream"{print $2}')"
[ "$UP_SHIM" = "shim" ]; check "/greenbutton/* answered by the shim container ($UP_SHIM)" $?
UP_APP="$(curl -sSI "$BASE/" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-edge-upstream"{print $2}')"
[ "$UP_APP" = "app" ]; check "/ answered by the app container ($UP_APP)" $?
# The app container has NO GB_* environment — only the shim can say configured:true.
STATUS="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS" in *'"configured":true'*) check "credentials live only in the shim container" 0;; *) check "credentials live only in the shim container" 1;; esac
RATES="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/rates")"
[ "$RATES" = "200" ]; check "/api/rates passes through the router ($RATES)" $?

echo
echo "== the OAuth/ESPI checks, through the router =="
LOOP_LOG="$(mktemp)"
# The token file inside the shim container is uid 1001 / mode 0600 by
# design, so the gate reads it THROUGH the container rather than through a
# permission it is in the middle of asserting.
GB_E2E_EXTERNAL=1 PORT="$PORT" TOKEN_FILE="$TOKEN_DIR/tokens.json" \
  GB_E2E_TOKEN_READ_CMD="docker exec gb-topo-shim cat /var/lib/greenbutton/tokens.json" \
  "$HERE/e2e-greenbutton-loop.sh" 2>&1 | tee "$LOOP_LOG"
LOOP_STATUS=${PIPESTATUS[0]}
N_PASS="$(grep -c '^  PASS' "$LOOP_LOG" || true)"
N_FAIL="$(grep -c '^  FAIL' "$LOOP_LOG" || true)"
PASS=$((PASS + N_PASS))
FAIL=$((FAIL + N_FAIL))
if [ "$LOOP_STATUS" -ne 0 ] && [ "$N_FAIL" -eq 0 ]; then
  # The loop died before it could count anything (server never came up…).
  FAIL=$((FAIL + 1))
fi
rm -f "$LOOP_LOG"

exit "$FAIL"
