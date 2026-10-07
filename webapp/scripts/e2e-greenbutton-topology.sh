#!/usr/bin/env bash
# Containerised topology gate — the SAME three-container shape production
# runs, exercised end to end against a mock data custodian:
#
#   curl :3940 → edge-router ─┬─ /greenbutton/* → greenbutton-shim (creds, token file)
#                             └─ everything else → energy-dashboard (no creds)
#
# It reuses the 29 checks in e2e-greenbutton-loop.sh (GB_E2E_EXTERNAL=1) and
# adds what only makes sense at the edge: which location the router matched
# and which container actually answered, whether a credential-bearing query
# string reaches the access log, the baseline security headers on a real
# response, and — the H1 regression — that the split still holds after BOTH
# upstreams are recreated underneath a router that keeps running.
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

# The router runs the BUILT edge-router image (ops/edge/Dockerfile), so the
# gate exercises the nginx config that actually ships to production.
ROUTER_IMAGE="electricity-dashboard-edge-router:latest"
if ! docker image inspect "$ROUTER_IMAGE" >/dev/null 2>&1; then
  echo "ERROR: $ROUTER_IMAGE not built here. Run: docker compose build" >&2
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
  docker rm -f gb-topo-iphold-1 gb-topo-iphold-2 >/dev/null 2>&1 || true
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
# TWO headers, TWO questions — never read one for the other.
#   X-Edge-Location  which location nginx matched (this router's own config)
#   x-gb-process     which container produced the body, read from that
#                    process's own config (getProcessIdentity)
# They must agree: greenbutton<->shim, default<->app. The old header was
# location-derived only, so it claimed `shim` while the app container was
# answering — production ran that way for 31 minutes on 2026-10-07 (H1).
hdr() { # hdr <url> <header-name>
  curl -sSI "$1" | tr -d '\r' |
    awk -v want="$(echo "$2" | tr '[:upper:]' '[:lower:]')" -F': ' \
      'tolower($1) == want { print $2 }'
}

LOC_SHIM="$(hdr "$BASE/greenbutton/status" x-edge-location)"
PROC_SHIM="$(hdr "$BASE/greenbutton/status" x-gb-process)"
[ "$LOC_SHIM" = "greenbutton" ] && [ "$PROC_SHIM" = "shim" ]
check "/greenbutton/* → location=$LOC_SHIM, process=$PROC_SHIM (want greenbutton/shim)" $?

LOC_APP="$(hdr "$BASE/" x-edge-location)"
PROC_APP="$(hdr "$BASE/" x-gb-process)"
[ "$LOC_APP" = "default" ] && [ "$PROC_APP" = "app" ]
check "/ → location=$LOC_APP, process=$PROC_APP (want default/app)" $?

# The app container has NO GB_* environment — only the shim can say configured:true.
STATUS="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS" in *'"configured":true'*) check "credentials live only in the shim container" 0;; *) check "credentials live only in the shim container" 1;; esac
RATES="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/rates")"
[ "$RATES" = "200" ]; check "/api/rates passes through the router ($RATES)" $?

echo
echo "== 0b. the router survives its upstreams being recreated (H1 regression) =="
# The bug this section exists for: nginx resolved each upstream ONCE, at
# config load, so when the app and the shim were recreated (new IPs) while the
# router kept running the split inverted — /greenbutton went to the app and
# the dashboard went to the shim, for as long as the router lived. Two
# stand-ins hold the old addresses so the recreated containers cannot reuse
# them; the router must follow the names, not the addresses it remembers.
ip_of() {
  docker inspect "$1" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}'
}
NET="$(docker inspect gb-topo-router --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
OLD_APP="$(ip_of gb-topo-app)"
OLD_SHIM="$(ip_of gb-topo-shim)"

docker compose -p gb-topo -f "$COMPOSE_FILE" rm -sf energy-dashboard greenbutton-shim >/dev/null 2>&1
docker run -d --name gb-topo-iphold-1 --network "$NET" --entrypoint sleep nginx:1.29-alpine 1800 >/dev/null
docker run -d --name gb-topo-iphold-2 --network "$NET" --entrypoint sleep nginx:1.29-alpine 1800 >/dev/null
docker compose -p gb-topo -f "$COMPOSE_FILE" up -d energy-dashboard greenbutton-shim >/dev/null 2>&1

for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "$BASE/greenbutton/status" >/dev/null 2>&1 && break
  sleep 1
done
NEW_APP="$(ip_of gb-topo-app)"
NEW_SHIM="$(ip_of gb-topo-shim)"
[ -n "$NEW_APP" ] && [ "$NEW_APP" != "$OLD_APP" ] && [ -n "$NEW_SHIM" ] && [ "$NEW_SHIM" != "$OLD_SHIM" ]
check "upstream IPs really changed ($OLD_APP/$OLD_SHIM → $NEW_APP/$NEW_SHIM)" $?

# The resolver is pinned at valid=10s; wait out the cache before asking again.
sleep 12
LOC2="$(hdr "$BASE/greenbutton/status" x-edge-location)"
PROC2="$(hdr "$BASE/greenbutton/status" x-gb-process)"
[ "$LOC2" = "greenbutton" ] && [ "$PROC2" = "shim" ]
check "after recreate, /greenbutton/* → location=$LOC2, process=$PROC2" $?
LOC3="$(hdr "$BASE/" x-edge-location)"
PROC3="$(hdr "$BASE/" x-gb-process)"
[ "$LOC3" = "default" ] && [ "$PROC3" = "app" ]
check "after recreate, / → location=$LOC3, process=$PROC3" $?
STATUS2="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS2" in *'"configured":true'*) check "after recreate, still the shim's body" 0;; *) check "after recreate, still the shim's body" 1;; esac
docker rm -f gb-topo-iphold-1 gb-topo-iphold-2 >/dev/null 2>&1 || true

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

echo
echo "== OAuth credential material never reaches the edge log =="
# Same shape as the canary in the security review, with two DIFFERENT
# markers: $TAG goes in the PATH (it must be logged — that is what makes
# these checks non-vacuous), while the code/state values go only in the
# QUERY and must never appear. Unique per run, so a stale line can neither
# hide nor fake a hit.
TAG="gb-canary-$(date +%s)-$$"
CODE_CANARY="code-$TAG"
STATE_CANARY="state-$TAG"
curl -s -o /dev/null "$BASE/greenbutton/status"
curl -s -o /dev/null "$BASE/greenbutton/$TAG?code=$CODE_CANARY&state=$STATE_CANARY"
sleep 1
ROUTER_LOG="$(docker logs gb-topo-router 2>&1)"
case "$ROUTER_LOG" in
  *"/greenbutton/$TAG"*) check "canary request WAS logged (so the two checks below mean something)" 0 ;;
  *)                     check "canary request WAS logged (so the two checks below mean something)" 1 ;;
esac
case "$ROUTER_LOG" in
  *"$CODE_CANARY"*) check "authorization code never reaches the edge log" 1 ;;
  *)                check "authorization code never reaches the edge log" 0 ;;
esac
case "$ROUTER_LOG" in
  *"$STATE_CANARY"*) check "state value never reaches the edge log" 1 ;;
  *)                 check "state value never reaches the edge log" 0 ;;
esac

echo
echo "== baseline security headers, through the real router =="
HDRS="$(curl -sSI "$BASE/" | tr -d '\r')"
for h in strict-transport-security x-content-type-options referrer-policy x-frame-options; do
  printf '%s\n' "$HDRS" | grep -qi "^$h:"; check "GET / carries $h" $?
done
printf '%s\n' "$HDRS" | grep -qi '^strict-transport-security: *max-age=31536000; *includeSubDomains'
check "HSTS is max-age=31536000; includeSubDomains" $?
printf '%s\n' "$HDRS" | grep -qi '^x-frame-options: *DENY'
check "X-Frame-Options is DENY" $?

exit "$FAIL"
