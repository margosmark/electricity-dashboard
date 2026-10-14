#!/usr/bin/env bash
# Containerised topology gate — the SAME four-container shape production
# runs, exercised end to end against a mock data custodian:
#
#   curl :3940 → edge-router ─┬─ /greenbutton/*      → greenbutton-shim (creds, token file)
#                             ├─ /account/internal/* → DENIED here (403, no upstream)
#                             ├─ /account/*          → account-server  (verifiers, VAPID key)
#                             └─ everything else     → energy-dashboard (no creds)
#
# It reuses the checks in e2e-greenbutton-loop.sh (GB_E2E_EXTERNAL=1) and
# adds what only makes sense at the edge: which location the router matched
# and which container actually answered, whether a credential-bearing query
# string reaches the access log, the baseline security headers on a real
# response, and — the H1 regression — that the split still holds after ALL
# THREE upstreams are recreated underneath a router that keeps running.
#
# Wave N added the third pair (`X-Edge-Location: account` ↔
# `x-gb-process: account`) and the one location with NO upstream at all
# (`/account/internal/*` → 403 from nginx). The account leg runs in BOTH
# states, because "off" is what ships by default: off first (the public
# surface unchanged), then with ACCT_ENABLED=true, where the pairing and the
# closed, enumeration-safe registration surface (`tests/e2e/account_smoke.sh`)
# run through the router. The enabled leg only checks the signed-out session,
# generic registration-pending responses and registration-closed route methods;
# it does NOT exercise authenticated registration/login/sync lifecycle.
# Those lifecycle fixtures live in webapp/src/lib/account/account.test.ts and
# route-matrix.test.ts.
#
# Nothing in this script touches the live stack: the router/mock use dedicated
# configurable host ports, and every container name is prefixed gb-topo-.
#
# Usage: webapp/scripts/e2e-greenbutton-topology.sh   (from anywhere; it cds)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$WEBAPP/.." && pwd)"
COMPOSE_FILE="$REPO/ops/edge/topology-test.compose.yml"
PORT="${PORT:-3940}"
MOCK_PORT="${GB_TOPO_MOCK_PORT:-8099}"
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

IMAGE="${GB_TOPO_APP_IMAGE:-electricity-dashboard-energy-dashboard:latest}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ERROR: $IMAGE not built here. Run: docker compose build" >&2
  exit 1
fi

# The router runs the BUILT edge-router image (ops/edge/Dockerfile), so the
# gate exercises the nginx config that actually ships to production.
ROUTER_IMAGE="${GB_TOPO_ROUTER_IMAGE:-electricity-dashboard-edge-router:latest}"
if ! docker image inspect "$ROUTER_IMAGE" >/dev/null 2>&1; then
  echo "ERROR: $ROUTER_IMAGE not built here. Run: docker compose build" >&2
  exit 1
fi

# The shim runs as uid 1001 and must be able to create tokens.json in here;
# the e2e script then asserts mode 0600 and reads it back as this user.
TOKEN_DIR="$(mktemp -d)"
chmod 777 "$TOKEN_DIR"

# The account server runs as the same uid (1001 `nextjs`) and creates its
# SQLite file — plus the `-wal`/`-shm` siblings — INSIDE this mount, so the
# directory has to be writable by it. Throwaway like TOKEN_DIR: the closed
# registration flow touches no rows, and the temporary tree is deleted after.
ACCT_DIR="$(mktemp -d)"
chmod 700 "$ACCT_DIR"
# The host operator is normally non-root, so host chown cannot assign uid
# 1001. Use the already-built app image as a disposable root helper: the bind
# mount is only this unique throwaway directory, and account-server still
# enforces its uid/mode contract independently at startup.
if ! docker run --rm --user 0 --entrypoint sh \
  -v "$ACCT_DIR:/data" "$IMAGE" \
  -c 'chown 1001:1001 /data && chmod 700 /data'; then
  echo "ERROR: could not provision disposable account data directory as uid 1001" >&2
  rm -rf "$TOKEN_DIR" "$ACCT_DIR"
  exit 1
fi

# The mock has to be reachable from TWO places with ONE URL: the shim
# container (over the network) and the curl "browser" running on this host.
HOST_IP="${GB_TOPO_HOST_IP:-$(hostname -I | awk '{print $1}')}"
export GB_TOPO_TOKEN_DIR="$TOKEN_DIR"
export GB_TOPO_ACCT_DIR="$ACCT_DIR"
export GB_TOPO_REPO_DIR="$REPO"
# The shipping default, stated explicitly rather than relied on as a compose
# default: section 0d flips this and recreates the container.
export GB_TOPO_ACCT_ENABLED=false

cleanup() {
  docker rm -f gb-topo-iphold-1 gb-topo-iphold-2 gb-topo-iphold-3 >/dev/null 2>&1 || true
  if [ "$FAIL" -eq 0 ]; then
    docker compose -p gb-topo -f "$COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1
    rm -rf "$TOKEN_DIR" "$ACCT_DIR"
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

for p in "$PORT" "$MOCK_PORT"; do
  if ss -ltnH "sport = :$p" | grep -q .; then
    echo "ERROR: host port $p is already in use — free it first." >&2
    exit 1
  fi
done

echo "== bringing up the topology stack (router:$PORT mock:$MOCK_PORT) =="
export GB_TOPO_PORT="$PORT" GB_TOPO_MOCK_PORT="$MOCK_PORT"
export GB_TOPO_APP_IMAGE="$IMAGE" GB_TOPO_ROUTER_IMAGE="$ROUTER_IMAGE"
export GB_TOPO_MOCK_ORIGIN="http://$HOST_IP:$MOCK_PORT"
export GB_TOPO_PUBLIC_ORIGIN="http://localhost:$PORT"
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
echo "== 0. the router really is splitting the path (three ways) =="
# TWO headers, TWO questions — never read one for the other.
#   X-Edge-Location  which location nginx matched (this router's own config)
#   x-gb-process     which container produced the body, read from that
#                    process's own config (getProcessIdentity)
# They must agree: greenbutton<->shim, account<->account, default<->app. The
# old header was location-derived only, so it claimed `shim` while the app
# container was answering — production ran that way for 31 minutes on
# 2026-10-07 (H1).
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

# Wave N's third location. The account container is started OFF
# (ACCT_ENABLED=false, the shipping default) and getProcessIdentity() keys on
# that same flag — it is the one answer nginx cannot forge — so while the
# feature is off the process truthfully says `app`: it has NOT been told it is
# the account server. Both halves are asserted anyway, because "the router
# matched /account AND that container answers 404" is what makes the homepage
# byte-identical to pre-Wave-N. The PAIRING (account ↔ account) is only
# meaningful with the flag on — section 0d proves it there.
LOC_ACCT="$(hdr "$BASE/account/session" x-edge-location)"
PROC_ACCT="$(hdr "$BASE/account/session" x-gb-process)"
CODE_ACCT="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/account/session")"
[ "$LOC_ACCT" = "account" ]
check "/account/* → location=$LOC_ACCT (want account — Wave N's location shipped)" $?
[ "$CODE_ACCT" = "404" ] && [ "$PROC_ACCT" = "app" ]
check "feature OFF: /account/session → $CODE_ACCT, process=$PROC_ACCT (want 404/app)" $?

# The ONE location with no upstream. /account/internal/* is the shim→account
# fan-out, denied at the edge so a stolen ACCT_INTERNAL_TOKEN still has no path
# from the internet. 403 + `X-Edge-Location: account-deny` is the answer, and
# the ABSENCE of `x-gb-process` is the proof that `deny all` never proxied: any
# container that answered would have set that header. Read the line above
# together with this one — the SAME container answers 404 on /account/session,
# so a 403 here cannot mean "the account API is simply closed".
DENY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/account/internal/notify")"
DENY_LOC="$(hdr "$BASE/account/internal/notify" x-edge-location)"
DENY_PROC="$(hdr "$BASE/account/internal/notify" x-gb-process)"
[ "$DENY_CODE" = "403" ] && [ "$DENY_LOC" = "account-deny" ]
check "POST /account/internal/notify → $DENY_CODE at location=$DENY_LOC (want 403/account-deny)" $?
[ -z "$DENY_PROC" ]
check "the deny is nginx's own answer (no x-gb-process upstream header)" $?

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
# the dashboard went to the shim, for as long as the router lived. Stand-ins
# hold the old addresses so the recreated containers cannot reuse them; the
# router must follow the names, not the addresses it remembers.
#
# ALL THREE upstreams now, not two: Wave N added a third, and the inversion is
# per-upstream — an account container left talking to a stale address would put
# the password verifiers' API behind the wrong process just as quietly.
ip_of() {
  docker inspect "$1" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}'
}
NET="$(docker inspect gb-topo-router --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
RECREATE_SVCS=(energy-dashboard greenbutton-shim account-server)
RECREATE_CTRS=(gb-topo-app gb-topo-shim gb-topo-account)
OLD_IPS=()
for c in "${RECREATE_CTRS[@]}"; do OLD_IPS+=("$(ip_of "$c")"); done

docker compose -p gb-topo -f "$COMPOSE_FILE" rm -sf "${RECREATE_SVCS[@]}" >/dev/null 2>&1
# One stand-in per freed address: a container that reuses an old IP would make
# the "the address really changed" check vacuous.
for i in "${!RECREATE_CTRS[@]}"; do
  docker run -d --name "gb-topo-iphold-$((i + 1))" --network "$NET" --entrypoint sleep nginx:1.29-alpine 1800 >/dev/null
done
docker compose -p gb-topo -f "$COMPOSE_FILE" up -d "${RECREATE_SVCS[@]}" >/dev/null 2>&1

for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "$BASE/greenbutton/status" >/dev/null 2>&1 && break
  sleep 1
done
NEW_IPS=()
CHANGED=0
for i in "${!RECREATE_CTRS[@]}"; do
  NEW_IPS+=("$(ip_of "${RECREATE_CTRS[$i]}")")
  [ -n "${NEW_IPS[$i]}" ] && [ "${NEW_IPS[$i]}" != "${OLD_IPS[$i]}" ] || CHANGED=1
done
check "upstream IPs really changed (${OLD_IPS[*]} → ${NEW_IPS[*]})" $CHANGED

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
LOC4="$(hdr "$BASE/account/session" x-edge-location)"
PROC4="$(hdr "$BASE/account/session" x-gb-process)"
CODE4="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/account/session")"
[ "$LOC4" = "account" ] && [ "$CODE4" = "404" ]
check "after recreate, /account/* → location=$LOC4, $CODE4 (still off, still routed)" $?
STATUS2="$(curl -fsS "$BASE/greenbutton/status")"
case "$STATUS2" in *'"configured":true'*) check "after recreate, still the shim's body" 0;; *) check "after recreate, still the shim's body" 1;; esac
docker rm -f gb-topo-iphold-1 gb-topo-iphold-2 gb-topo-iphold-3 >/dev/null 2>&1 || true

echo
echo "== 0d. the account leg, feature ON: the third pair has to agree =="
# Off is what ships; ON is the state the pairing claim is about, and the flag
# is read from the container's own environment — so the gate recreates the
# account container underneath the RUNNING router (which also re-proves the
# resolver follows the third upstream's name, the H1 failure mode).
export GB_TOPO_ACCT_ENABLED=true
docker compose -p gb-topo -f "$COMPOSE_FILE" up -d account-server >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "$BASE/account/session" >/dev/null 2>&1 && break
  sleep 1
done
ON_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/account/session")"
ON_BODY="$(curl -sS --max-time 5 "$BASE/account/session")"
ON_LOC="$(hdr "$BASE/account/session" x-edge-location)"
ON_PROC="$(hdr "$BASE/account/session" x-gb-process)"
[ "$ON_CODE" = "200" ]
check "ACCT_ENABLED=true: /account/session → $ON_CODE (the feature answers)" $?
case "$ON_BODY" in
  *'"enabled":true'*'"authed":false'*) check "…and the payload is the signed-out session (enabled:true, authed:false)" 0 ;;
  *)                                   check "…and the payload is the signed-out session (enabled:true, authed:false)" 1 ;;
esac
[ "$ON_LOC" = "account" ] && [ "$ON_PROC" = "account" ]
check "/account/* → location=$ON_LOC, process=$ON_PROC (THE pairing: account/account)" $?
# The fan-out secret only exists while the feature does, so this is the check
# that matters: the deny must hold in the state where there is something to
# reach behind it.
DENY2="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/account/internal/notify")"
[ "$DENY2" = "403" ]
check "feature ON: /account/internal/notify is still $DENY2 at the edge" $?

echo
echo "== the closed-registration account surface through the REAL router =="
# The public registration endpoint must remain generic and must never create
# an account or issue a session before verified mailbox ownership. Authenticated
# database/sync behavior is covered by ephemeral fixtures in
# src/lib/account/account.test.ts and route-matrix.test.ts.
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for registration-closed account route checks" >&2
  FAIL=$((FAIL + 1))
else
  ACCT_LOG="$(mktemp)"
  "$WEBAPP/tests/e2e/account_smoke.sh" "$BASE" --expect-registration-closed 2>&1 | tee "$ACCT_LOG"
  ACCT_STATUS=${PIPESTATUS[0]}
  N_PASS="$(grep -c '^  PASS' "$ACCT_LOG" || true)"
  N_FAIL="$(grep -c '^  FAIL' "$ACCT_LOG" || true)"
  PASS=$((PASS + N_PASS))
  FAIL=$((FAIL + N_FAIL))
  if [ "$ACCT_STATUS" -ne 0 ] && [ "$N_FAIL" -eq 0 ]; then
    # It died before it could count (server never came up, jq missing…).
    FAIL=$((FAIL + 1))
  fi
  rm -f "$ACCT_LOG"
fi

echo
echo "== the OAuth/ESPI checks, through the router =="
LOOP_LOG="$(mktemp)"
# The token file inside the shim container is uid 1001 / mode 0600 by
# design, so the gate reads it THROUGH the container rather than through a
# permission it is in the middle of asserting.
GB_E2E_EXTERNAL=1 PORT="$PORT" MOCK_PORT="$MOCK_PORT" TOKEN_FILE="$TOKEN_DIR/tokens.json" \
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
echo "== public account edge size/rate/privacy controls =="
# Exercise nginx's 6 MiB body cap with a unique marker. A 413 plus the edge
# location header and absence of the account-process identity proves nginx
# rejected it before the request reached the app container.
BODY_FILE="$(mktemp)"
BODY_CANARY="acct-body-$(date +%s)-$$"
head -c 6291457 /dev/zero >"$BODY_FILE"
BODY_CODE="$(curl -sS --max-time 15 -D /tmp/acct-edge.hdr -o /tmp/acct-edge.body \
  -w '%{http_code}' -H 'content-type: application/octet-stream' \
  --data-binary "@$BODY_FILE" "$BASE/account/session?body=$BODY_CANARY")"
rm -f "$BODY_FILE"
BODY_EDGE="$(grep -i '^x-edge-location:' /tmp/acct-edge.hdr | tr -d '\r' | awk '{print $2}')"
BODY_APP="$(grep -i '^x-gb-process:' /tmp/acct-edge.hdr | tr -d '\r' | awk '{print $2}')"
check "body >6 MiB rejected as 413 at account ingress" "$([ "$BODY_CODE" = 413 ] && echo 0 || echo 1)"
check "oversized body response is edge-owned, not app-owned" \
  "$([ "$BODY_EDGE" = account ] && [ "$BODY_APP" != account ] && echo 0 || echo 1)"

# After the paced route sweep the bucket has recovered. More than the
# configured burst in one instant must yield explicit client 429 responses,
# never an upstream-looking 503.
RATE_429=0
RATE_503=0
for _ in $(seq 1 25); do
  CODE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$BASE/account/session")"
  [ "$CODE" = 429 ] && RATE_429=$((RATE_429 + 1))
  [ "$CODE" = 503 ] && RATE_503=$((RATE_503 + 1))
done
check "rapid /account burst receives explicit 429 rate-limit response" \
  "$([ "$RATE_429" -gt 0 ] && [ "$RATE_503" -eq 0 ] && echo 0 || echo 1)"

# Put unique markers in a URI (to prove this exact request was logged), query,
# spoofable forwarding header, and cookie. Only the path marker may appear in
# the router's access log; all other values are secret-bearing canaries.
LOG_TAG="acct-log-$(date +%s)-$$"
QUERY_CANARY="query-$LOG_TAG"
IP_CANARY="198.51.100.$(( $$ % 200 + 1 ))"
COOKIE_CANARY="cookie-$LOG_TAG"
curl -sS --max-time 5 -o /dev/null \
  -H "X-Forwarded-For: $IP_CANARY" \
  -H "Cookie: acct_session=$COOKIE_CANARY" \
  "$BASE/account/$LOG_TAG?probe=$QUERY_CANARY" || true
sleep 1
ACCOUNT_LOG="$(docker logs gb-topo-router 2>&1)"
case "$ACCOUNT_LOG" in
  *"GET /account/$LOG_TAG"*) check "unique account canary request itself is present in router log" 0 ;;
  *) check "unique account canary request itself is present in router log" 1 ;;
esac
for CANARY in "$QUERY_CANARY" "$IP_CANARY" "$COOKIE_CANARY"; do
  case "$ACCOUNT_LOG" in
    *"$CANARY"*) check "account query/IP/cookie canary is absent from router log" 1 ;;
    *) check "account query/IP/cookie canary is absent from router log" 0 ;;
  esac
done

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
echo "== the REFERER hop (fixed 2026-10-12) =="
# `gb_noquery` alone was never enough: the callback 302s to `/?gb=connected`,
# which is SAME-ORIGIN, so a browser echoes the full callback URL as
# `Referer` on that follow-up. The follow-up is logged by `location /`,
# which inherits nginx's stock `combined` format — and that DOES include
# `$http_referer`. Prove the header is suppressed on the callback itself,
# then follow the redirect the way a browser would and assert nothing
# credential-bearing came along for the ride.
REF_CANARY="ref-$TAG"
CB_HDRS="$(curl -sSI "$BASE/greenbutton/callback?code=$REF_CANARY" | tr -d '\r')"
printf '%s\n' "$CB_HDRS" | grep -qi '^referrer-policy: *no-referrer'
check "callback sets Referrer-Policy: no-referrer" $?
case "$CB_HDRS" in
  *"$REF_CANARY"*) check "callback response does not echo the code back to the client" 1 ;;
  *)               check "callback response does not echo the code back to the client" 0 ;;
esac
# Follow the redirect with a Referer the way a browser would, then look for
# the code in BOTH the router log and the app container's own log — the leak
# lands on `location /`, so checking only the router's greenbutton scope
# would have passed while production kept leaking.
curl -s -o /dev/null -H "Referer: $BASE/greenbutton/callback?code=$REF_CANARY&state=x" \
  "$BASE/?gb=connected"
sleep 1
case "$(docker logs gb-topo-router 2>&1)$(docker logs gb-topo-app 2>&1)" in
  *"$REF_CANARY"*) check "authorization code never reaches any log via \$http_referer" 1 ;;
  *)               check "authorization code never reaches any log via \$http_referer" 0 ;;
esac

echo
echo "== notify token path redaction =="
# The notify token is a PATH SEGMENT, so `$uri` — the exact field gb_noquery
# records — would print it. It must come out redacted instead.
NOTE_TOKEN="tok-$TAG-not-a-real-secret"
curl -s -o /dev/null -X POST "$BASE/greenbutton/notify/$NOTE_TOKEN"
sleep 1
ROUTER_LOG2="$(docker logs gb-topo-router 2>&1)"
case "$ROUTER_LOG2" in
  *"/greenbutton/notify/<redacted>"*) check "notify path logged with the token REDACTED" 0 ;;
  *)                                 check "notify path logged with the token REDACTED" 1 ;;
esac
case "$ROUTER_LOG2" in
  *"$NOTE_TOKEN"*) check "notify token never reaches the edge log" 1 ;;
  *)               check "notify token never reaches the edge log" 0 ;;
esac

echo
echo "== baseline security headers, CSP and rate limit, through the real router =="
HDRS="$(curl -sSI "$BASE/" | tr -d '\r')"
for h in strict-transport-security x-content-type-options referrer-policy x-frame-options; do
  printf '%s\n' "$HDRS" | grep -qi "^$h:"; check "GET / carries $h" $?
done
printf '%s\n' "$HDRS" | grep -qi '^strict-transport-security: *max-age=31536000; *includeSubDomains'
check "HSTS is max-age=31536000; includeSubDomains" $?
printf '%s\n' "$HDRS" | grep -qi '^x-frame-options: *DENY'
check "X-Frame-Options is DENY" $?

# server_tokens off — the version must not be advertised. The grep is inverted
# on purpose: matching `nginx/<digits>` means the version IS exposed, which is
# the failure case. (An earlier revision of this line passed `$?` straight to
# `check`, so a CORRECT response — `Server: nginx` — failed the check.)
if printf '%s\n' "$HDRS" | grep -qi '^server: *nginx/[0-9]'; then
  check "Server header hides the nginx version" 1
else
  check "Server header hides the nginx version" 0
fi

# CSP is what contains `/oeb-rates-page`, which proxies www.oeb.ca onto OUR
# origin, a few lines from the readings in localStorage.
printf '%s\n' "$HDRS" | grep -qi '^content-security-policy:'
check "GET / carries Content-Security-Policy" $?
printf '%s\n' "$HDRS" | grep -qi "content-security-policy:.*object-src 'none'"
check "CSP sets object-src 'none'" $?
printf '%s\n' "$HDRS" | grep -qi "content-security-policy:.*base-uri 'none'"
check "CSP sets base-uri 'none'" $?
printf '%s\n' "$HDRS" | grep -qi "content-security-policy:.*connect-src 'self' https://archive-api.open-meteo.com"
check "CSP connect-src names only self + Open-Meteo" $?
printf '%s\n' "$HDRS" | grep -qi '^content-security-policy:.*default-src .self.'
check "CSP default-src is 'self'" $?
printf '%s\n' "$HDRS" | grep -qi '^permissions-policy: *camera=()'
check "GET / carries Permissions-Policy" $?
printf '%s\n' "$HDRS" | grep -qi '^cross-origin-opener-policy: *same-origin'
check "GET / carries Cross-Origin-Opener-Policy" $?

# The rate limit guarding the genuinely unauthenticated endpoints. The two
# zones are `gb_strict` (30r/m, burst=10) on `/greenbutton/start` and
# `/greenbutton/notify/`, and `gb_soft` (300r/m, burst=100) on the rest —
# high enough that one connect flow (~19 requests) never trips it, so honest
# traffic is never the thing being refused. 15 against the strict zone must
# reach the ceiling AT THE ROUTER rather than the shim.
for i in $(seq 1 15); do
  curl -s -m 5 -o /dev/null "$BASE/greenbutton/start" || true
done
sleep 1
case "$(docker logs gb-topo-router 2>&1)" in
  *"limiting requests"*) check "rate limit engages on /greenbutton/start" 0 ;;
  *)                     check "rate limit engages on /greenbutton/start" 1 ;;
esac
# And the soft zone must NOT have fired — if it did, this gate (which makes
# ~19 legitimate requests above) would itself be the thing being throttled.
case "$(docker logs gb-topo-router 2>&1)" in
  *'by zone "gb_soft"'*) check "gb_soft never fires on legitimate traffic" 1 ;;
  *)                     check "gb_soft never fires on legitimate traffic" 0 ;;
esac

exit "$FAIL"
