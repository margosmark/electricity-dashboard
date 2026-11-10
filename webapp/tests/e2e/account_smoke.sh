#!/usr/bin/env bash
# Wave N account gate — registration-closed HTTP routing checks.
#
# Modes:
#   account_smoke.sh <base_url>                         # registration-closed checks
#   account_smoke.sh <base_url> --expect-disabled       # app process answers 404 for every account route
#   account_smoke.sh <base_url> --expect-registration-closed
#
# The registration-closed mode deliberately does not create accounts or claim
# delivery: it proves enumeration-safe pending responses and route behavior.
# Authenticated registration/login/sync lifecycle behavior is covered by
# ephemeral fixtures in src/lib/account/account.test.ts and route-matrix.test.ts.

set -euo pipefail

BASE="${1:?usage: account_smoke.sh <base_url> [--expect-disabled]}"
MODE="${2:---expect-registration-closed}"
MAX_WAIT="${SMOKE_WAIT_SECS:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JAR="$(mktemp -d)/cookies.txt"
JAR2="$(mktemp -d)/cookies.txt"
JAR3="$(mktemp -d)/cookies.txt"

# Where every response of this gate is written down.
#
# These dumps used to be two FIXED paths under the shared /tmp (named
# `acct.hdr` and `acct.body` there).
# A shared sticky /tmp is name-addressed, not run-addressed: a file left behind
# by another, privileged run stays root-owned 0644, and neither `>`, `unlink`
# nor `mktemp`-style replacement can take that name back — so curl fails on the
# FIRST request of this script with
#
#     curl: (23) Failed writing received data to disk/application
#
# and `set -e` aborts the whole gate before a single cell is counted (the
# topology gate then reports the early exit as one anonymous failure). A
# private mktemp -d directory belongs to this run alone: no stale file from
# another run, no collision with a concurrent run, no privilege question.
SCRATCH="$(mktemp -d)"
HDR="$SCRATCH/headers"
BODY="$SCRATCH/body"
trap 'rm -rf "$SCRATCH" "$(dirname "$JAR")" "$(dirname "$JAR2")" "$(dirname "$JAR3")"' EXIT

PASS=0
FAIL=0
check() { # check <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; fi
}

# ONE place every request of this gate is written down: headers land in $HDR,
# the body in $BODY, the HTTP status is echoed for the caller.
#
# A transport or output failure is a REPORTED CELL, never an abort. curl's own
# exit status here is not evidence about the server, so the dumps are cleared
# (a previous response must never be read as this one), `000` is echoed — which
# every expectation in this script already treats as "not the answer I want" —
# and the reason is printed to stderr for the operator. Without this, `set -e`
# kills the script at its first request and the gate reports one anonymous
# early exit instead of the cells that actually failed.
curl_dump() { # curl_dump <method> <path> <curl options…>
  local method="$1" path="$2"
  shift 2
  local out="" rc=0
  out="$(curl -sS -D "$HDR" -o "$BODY" -w '%{http_code}' "$@")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s' "$out"
    return 0
  fi
  { : >"$HDR" && : >"$BODY"; } 2>/dev/null || true
  printf '  note  curl %s %s failed (exit %d) — dumps cleared, cell reports 000\n' \
    "$method" "$path" "$rc" >&2
  printf '000'
  return 0
}

# The route probe sends `{}` for body-carrying verbs. The closed-registration
# branch below checks the signed-out route surface only; authenticated behavior
# is not exercised by this HTTP smoke script.
matrix_req() { # matrix_req <cookie|-> <method> <path>
  local cookie="$1" method="$2" path="$3" body="" hdr_args=()
  [ "$cookie" != "-" ] && hdr_args=(-H "cookie: $cookie")
  case "$method" in POST|PUT|PATCH|DELETE) body='{}' ;; esac
  if [ -n "$body" ]; then
    curl_dump "$method" "$path" "${hdr_args[@]}" -X "$method" \
      -H 'content-type: application/json' --data "$body" "${BASE}${path}"
  elif [ "$method" = "HEAD" ]; then
    curl_dump "$method" "$path" "${hdr_args[@]}" --head "${BASE}${path}"
  else
    curl_dump "$method" "$path" "${hdr_args[@]}" -X "$method" "${BASE}${path}"
  fi
}

# HTTP verb helpers: body + status + headers land in $HDR/$BODY so greps are cheap.
req() { # req <jar|-> <method> <path> [json-body]
  local jar="$1" method="$2" path="$3" body="${4:-}"
  local jar_args=()
  [ "$jar" != "-" ] && jar_args=(-c "$jar" -b "$jar")
  if [ -n "$body" ]; then
    curl_dump "$method" "$path" "${jar_args[@]}" -X "$method" \
      -H 'content-type: application/json' --data "$body" "${BASE}${path}"
  elif [ "$method" = "HEAD" ]; then
    # --head, not -X HEAD: with -X HEAD curl waits for a body that never
    # comes and exits 18, which `set -e` would take as a dead server.
    curl_dump "$method" "$path" "${jar_args[@]}" --head "${BASE}${path}"
  else
    curl_dump "$method" "$path" "${jar_args[@]}" -X "$method" "${BASE}${path}"
  fi
}

jget() { jq -r "$1" < "$BODY" 2>/dev/null; }

# True when $1 equals any of the remaining arguments — for the cells whose
# contract has more than one correct answer (see `matrix_expect`).
accepts() { local code="$1"; shift; local w; for w in "$@"; do [ "$code" = "$w" ] && return 0; done; return 1; }

# The `acct_session` value curl stored in a jar (netscape format: name is
# field 6, value field 7).
cookie_from_jar() { awk -v n='acct_session' '$6 == n { print $7 }' "$1" | tail -1; }

# A cookie that was never issued to anybody: no row can exist behind it.
forged_token() { printf '%s%s' "$(date +%s%N)" "$$" | sha256sum | cut -c1-48; }

# ---------------------------------------------------------------------------
# The surface
#
# ONE list, used by the guard, the disabled method sweep and the enabled,
# registration-closed signed-out route sweep — so a path can never be probed in
# one mode and forgotten.
# `/account/internal/*` is excluded ON PURPOSE: it is denied at the edge with
# 403 and never reaches an app container (the containerised topology gate owns
# that leg).
# ---------------------------------------------------------------------------
MATRIX_PATHS="/account/login /account/notify /account/recover /account/register
              /account/session /account/sync /account/push/preferences
              /account/push/subscribe /account/logout
              /account/verify /account/smtp-events /account/recover/verify"

# The paths this script probes and the route files on disk must be the SAME
# set. A new `/account/*` route that nobody adds here would otherwise ship
# outside the gate — the whole reason this guard exists. Skipped (with a note)
# when the script is run from outside a checkout, e.g. against a deployment.
surface_guard() {
  local dir="$SCRIPT_DIR/../../src/app/account"
  if [ ! -d "$dir" ]; then
    echo "  note  route surface not checked (no checkout next to this script)"
    return 0
  fi
  local on_disk declared
  on_disk=$(cd "$dir" && find . -name route.ts \
    | sed -e 's#^\./##' -e 's#/route\.ts$##' -e 's#^#/account/#' \
    | grep -v '^/account/internal/' | sort)
  declared=$(printf '%s\n' $MATRIX_PATHS | sort)
  if [ "$on_disk" != "$declared" ]; then
    echo "FAIL: the route files and this gate's path list disagree" >&2
    diff <(printf '%s\n' "$on_disk") <(printf '%s\n' "$declared") >&2 || true
    exit 1
  fi
  echo "  note  surface guard: $(printf '%s\n' "$declared" | wc -l) app-owned /account routes, all probed"
}

# ---------------------------------------------------------------------------
# The expected answer for one enabled-but-registration-closed, signed-out route cell.
# `HEAD` is answered by the route's `GET`; every verb a route does not export is
# the shared `wrongMethod` stub (405, naming the method). Session-gated routes
# answer 401 in this signed-out sweep.
#
# The MAILBOX family (9f08acc — register, recover, verify, recover/verify,
# smtp-events) is gated by ACCT_EMAIL_VERIFICATION_ENABLED, and every
# environment this HTTP gate runs in boots it OFF (docker-compose.yml, the
# topology compose and CI's ON container all default it to `false`, and the
# section below asserts that state before it probes anything). The flag is a
# hard gate: each handler returns 404 before it reads the request, and the
# `wrongEmailMethod` stubs return 404 as well — so EVERY verb on those five
# paths is 404 here, not the 405 an enabled flag would name. The verified flow
# itself (202 verification_pending, 400 invalid_verification, honest 405
# wrong-method) is asserted in-process by route-matrix.test.ts against a
# fixture server with the flag ON and SMTP configured; this gate's job over
# HTTP is the state that ships.
# ---------------------------------------------------------------------------
matrix_expect() { # matrix_expect <path> <method>
  local path="$1" method="$2" verbs eff
  case "$path" in
    /account/register|/account/recover|/account/verify|/account/recover/verify|/account/smtp-events)
      echo 404; return ;;
    /account/login|/account/logout|/account/notify) verbs="POST" ;;
    /account/session) verbs="GET" ;;
    /account/sync|/account/push/preferences) verbs="GET PUT" ;;
    /account/push/subscribe) verbs="POST DELETE" ;;
    *) echo "UNKNOWN"; return ;;
  esac
  eff="$method"
  [ "$method" = "HEAD" ] && eff="GET"
  case " $verbs " in
    *" $eff "*) : ;;
    *) echo 405; return ;;
  esac
  case "$path $eff" in
    "/account/login POST") echo 400 ;;
    "/account/logout POST") echo 200 ;;
    "/account/session GET") echo 200 ;;
    "/account/sync GET"|"/account/push/preferences GET"|"/account/push/preferences PUT"|\
    "/account/sync PUT"|"/account/notify POST"|"/account/push/subscribe DELETE"|\
    "/account/push/subscribe POST") echo 401 ;;
    *) echo "UNKNOWN" ;;
  esac
}

# --- Wait for the server ----------------------------------------------------
for i in $(seq 1 "${MAX_WAIT}"); do
  if curl -fsS -o /dev/null --max-time 2 "${BASE}/"; then break; fi
  [ "$i" = "${MAX_WAIT}" ] && { echo "FAIL: server did not come up within ${MAX_WAIT}s at ${BASE}" >&2; exit 1; }
  sleep 1
done

surface_guard

if [ "$MODE" = "--expect-disabled" ]; then
  echo "account gate (expecting the feature OFF): ${BASE}"
  for path in /account/session /account/sync /account/push/preferences; do
    code=$(req - GET "$path")
    check "GET ${path} → 404 (feature off in this process)" $([ "$code" = "404" ] && echo 0 || echo 1)
  done
  code=$(req - POST /account/register '{"email":"nobody@example.com","password":"correct horse battery staple"}')
  check "POST /account/register → 404 (no account API in the public app)" \
    $([ "$code" = "404" ] && echo 0 || echo 1)
  # The identity header must say WHO answered: the process with no ACCT_* is
  # the app, and that is the half of the H1 contract this side can prove.
  proc=$(grep -i '^x-gb-process:' "$HDR" | tr -d '\r' | awk '{print $2}' || true)
  check "x-gb-process: app on an account path (process identity, not path)" \
    $([ "$proc" = "app" ] && echo 0 || echo 1)
  # Every METHOD, on every app-owned /account/* path — not just the verb each
  # handler implements. The routes are registered in the bundle in BOTH
  # processes, and Next routes by path: it answers a method the route does
  # not export (and its auto-OPTIONS) itself, BEFORE any handler's
  # feature-flag check can 404. Until the `wrongMethod` stubs landed
  # (t_4eac9fde) GET /account/login therefore answered 405 and OPTIONS
  # 204 + Allow — admitting an account API on a deployment that claims to
  # have none. /account/internal/* is skipped on purpose: that path is
  # denied at the edge with 403, so it is not this process's answer to give.
  for path in $MATRIX_PATHS; do
    for method in GET POST PUT PATCH DELETE HEAD OPTIONS; do
      code=$(matrix_req - "$method" "$path") || code=000
      check "${method} ${path} → 404 (no such route, whatever the method)" \
        $([ "$code" = "404" ] && echo 0 || echo 1)
    done
  done
  # …and no cookie may change that answer. The full method × auth-state OFF
  # matrix runs in-process (`src/lib/account/route-matrix.test.ts`); over HTTP
  # this is the representative sweep, with a cookie the server never issued.
  FORGED="acct_session=$(forged_token)"
  for path in $MATRIX_PATHS; do
    for method in GET POST; do
      code=$(matrix_req "$FORGED" "$method" "$path") || code=000
      check "${method} ${path} [forged cookie] → 404 (a cookie cannot reveal a route)" \
        $([ "$code" = "404" ] && echo 0 || echo 1)
    done
  done
  # The header tells the 2c8ca8d story: a `405`, or an auto-`OPTIONS 204`, would
  # have carried `Allow` — a machine-readable list of the verbs this origin
  # answers, the one thing an OFF deployment must never emit.
  code=$(matrix_req - DELETE /account/session) || code=000
  check "DELETE /account/session → 404 (not 405)" $([ "$code" = "404" ] && echo 0 || echo 1)
  check "…and the answer carries no Allow header" \
    $(grep -qi '^allow:' "$HDR" && echo 1 || echo 0)
  [ "$FAIL" -eq 0 ] || { echo "account gate: ${FAIL} failed" >&2; exit 1; }
  echo "account gate OK (feature off): ${PASS} checks"
  exit 0
fi

if [ "$MODE" = "--expect-registration-closed" ]; then
  echo "account gate (feature enabled, registration closed): ${BASE}"
  code=$(req - GET /account/session)
  # The observed values are interpolated into the labels: this single request
  # feeds three cells, and a static label (the old wording) turned one
  # transient non-200 into three unexplained reds — with no status, header or
  # body to tell 429 from 502 from an off process.
  ACCT_PROC="$(grep -i '^x-gb-process:' "$HDR" | tr -d '\r' | awk '{print $2}')"
  ACCT_EDGE="$(grep -i '^x-edge-location:' "$HDR" | tr -d '\r' | awk '{print $2}')"
  check "GET /account/session → $code (want 200) from enabled account process" $([ "$code" = "200" ] && echo 0 || echo 1)
  check "session reports enabled and signed out (enabled=$(jget '.enabled'), authed=$(jget '.authed'))" \
    $([ "$(jget '.enabled')" = "true" ] && [ "$(jget '.authed')" = "false" ] && echo 0 || echo 1)
  check "account identity headers agree (x-gb-process=$ACCT_PROC, x-edge-location=$ACCT_EDGE)" \
    $([ "$ACCT_PROC" = "account" ] && [ "$ACCT_EDGE" = "account" ] && echo 0 || echo 1)

  # The state every cell in this section assumes, asserted FIRST so a server
  # booted with ACCT_EMAIL_VERIFICATION_ENABLED=true fails ONE named cell here
  # instead of twenty puzzling ones below. The shipping default — and every
  # environment this HTTP gate runs in (docker-compose.yml, the topology
  # compose, CI's ON container) — has the mailbox-verification flag OFF, and
  # 9f08acc made that flag a hard gate: the mailbox routes answer 404 before
  # they read a thing. The verified flow itself (202 verification_pending,
  # 400 invalid_verification, honest 405 wrong-method) lives in
  # src/lib/account/route-matrix.test.ts, which boots the flag ON with SMTP.
  code=$(req - GET /account/verify)
  check "GET /account/verify → 404 (mailbox-verification flag OFF — the state this section asserts)" \
    $([ "$code" = "404" ] && echo 0 || echo 1)

  attacker='attacker-owned-password'
  code=$(req - POST /account/register "{\"email\":\"known@example.com\",\"password\":\"$attacker\"}")
  known_body=$(cat "$BODY")
  check "registration closed outright → 404 (flag OFF never falls back to unverified signup)" \
    $([ "$code" = "404" ] && echo 0 || echo 1)
  check "registration creates no session cookie" \
    $(grep -qi '^set-cookie: acct_session=' "$HDR" && echo 1 || echo 0)
  check "response never echoes password or claims email was sent" \
    $(grep -qF "$attacker" "$BODY" && echo 1 || echo 0)

  code=$(req - POST /account/register '{"email":"unknown@example.com"}')
  check "unknown address gets identical status and body (no enumeration)" \
    $([ "$code" = "404" ] && [ "$(cat "$BODY")" = "$known_body" ] && echo 0 || echo 1)
  check "unknown address also creates no session cookie" \
    $(grep -qi '^set-cookie: acct_session=' "$HDR" && echo 1 || echo 0)

  for path in $MATRIX_PATHS; do
    for method in GET POST PUT PATCH DELETE HEAD OPTIONS; do
      # nginx's public account limiter is 60r/m with burst=20. Pace the
      # complete registration-closed matrix below that sustained rate rather
      # than weakening the production edge control to make this gate pass.
      sleep 1.1
      want=$(matrix_expect "$path" "$method")
      code=$(matrix_req - "$method" "$path") || code=000
      if accepts "$code" ${want//|/ }; then ok=0; else ok=1; fi
      check "${method} ${path} [signed out] → ${code} (want ${want})" "$ok"
      if [ "$code" != "405" ]; then
        check "  …and it names no verbs (no Allow header)" \
          $(grep -qi '^allow:' "$HDR" && echo 1 || echo 0)
      fi
    done
  done
  [ "$FAIL" -eq 0 ] || { echo "account gate: ${FAIL} failed" >&2; exit 1; }
  echo "account gate OK (registration closed): ${PASS} checks"
  exit 0
fi

echo "account gate (legacy authenticated fixture mode is unsupported; use --expect-registration-closed): ${BASE}" >&2
exit 2
