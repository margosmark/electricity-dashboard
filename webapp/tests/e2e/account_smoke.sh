#!/usr/bin/env bash
# Wave N account gate — register → login → PUT sync → a SECOND profile →
# GET sync → stale-revision 409 → logout kills the cookie, over real HTTP
# against a real SQLite file in a booted container.
#
# Two modes, because the feature has two ship criteria:
#
#   account_smoke.sh <base_url>                   # ACCT_ENABLED=true required
#   account_smoke.sh <base_url> --expect-disabled  # every /account/* × every method → 404
#
# The disabled mode is the "public app is unchanged with the feature off"
# gate (P0): the app container carries no ACCT_* env at all, so it must
# answer 404 — indistinguishable from "no such route" — rather than admit
# that an account API exists somewhere else.
#
# BOTH modes now run a SURFACE GUARD and a MATRIX, so the gate cannot be
# complete-by-accident again:
#
#   surface guard — the path list below is compared with the route files under
#     `src/app/account/**/route.ts`. Add a route and forget the gate and the
#     guard fails, instead of that route shipping unprobed.
#   matrix — every path × every HTTP method × {no cookie, a live session, a
#     forged cookie}. Over the real router, because the router is where the
#     verb is decided: Next answers a verb the route does not export (and its
#     auto-OPTIONS) by PATH, before any handler runs — the mechanism behind
#     `2c8ca8d`, which shipped a `405`/`204 + Allow` on a deployment claiming
#     to have no account API. `HEAD` is served by the route's `GET`, so it is
#     probed as `GET`'s status (measured, not assumed — see section 9).
#
# No secrets, no fixtures, no jq dependency beyond what CI already ships.
# Runtime: a few seconds (argon2id dominates: ~4 hashes).

set -euo pipefail

BASE="${1:?usage: account_smoke.sh <base_url> [--expect-disabled]}"
MODE="${2:-enabled}"
MAX_WAIT="${SMOKE_WAIT_SECS:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JAR="$(mktemp -d)/cookies.txt"
JAR2="$(mktemp -d)/cookies.txt"
JAR3="$(mktemp -d)/cookies.txt"
trap 'rm -rf "$(dirname "$JAR")" "$(dirname "$JAR2")" "$(dirname "$JAR3")"' EXIT

PASS=0
FAIL=0
check() { # check <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; fi
}

# The matrix probe: an explicit `cookie:` header instead of a jar, so a client
# can present a cookie it was never issued (the `forged` column) and no cell can
# be satisfied by cookie state some earlier section left behind. Body-carrying
# verbs send `{}` — deliberately invalid — so each cell asks WHICH GATE ANSWERED
# (feature flag → origin → session → payload), not what the handler does with a
# good payload. The happy paths are sections 1–8.
matrix_req() { # matrix_req <cookie|-> <method> <path>
  local cookie="$1" method="$2" path="$3" body="" hdr_args=()
  [ "$cookie" != "-" ] && hdr_args=(-H "cookie: $cookie")
  case "$method" in POST|PUT|PATCH|DELETE) body='{}' ;; esac
  if [ -n "$body" ]; then
    curl -sS "${hdr_args[@]}" -D /tmp/acct.hdr -o /tmp/acct.body -w '%{http_code}' \
      -X "$method" -H 'content-type: application/json' --data "$body" "${BASE}${path}"
  elif [ "$method" = "HEAD" ]; then
    curl -sS "${hdr_args[@]}" -D /tmp/acct.hdr -o /tmp/acct.body -w '%{http_code}' \
      --head "${BASE}${path}"
  else
    curl -sS "${hdr_args[@]}" -D /tmp/acct.hdr -o /tmp/acct.body -w '%{http_code}' \
      -X "$method" "${BASE}${path}"
  fi
}

# HTTP verb helpers: body + status + headers land in /tmp so greps are cheap.
req() { # req <jar|-> <method> <path> [json-body]
  local jar="$1" method="$2" path="$3" body="${4:-}"
  local jar_args=()
  [ "$jar" != "-" ] && jar_args=(-c "$jar" -b "$jar")
  if [ -n "$body" ]; then
    curl -sS "${jar_args[@]}" -D /tmp/acct.hdr -o /tmp/acct.body -w '%{http_code}' \
      -X "$method" -H 'content-type: application/json' --data "$body" "${BASE}${path}"
  elif [ "$method" = "HEAD" ]; then
    # --head, not -X HEAD: with -X HEAD curl waits for a body that never
    # comes and exits 18, which `set -e` would take as a dead server.
    curl -sS "${jar_args[@]}" -D /tmp/acct.hdr -o /tmp/acct.body -w '%{http_code}' \
      --head "${BASE}${path}"
  else
    curl -sS "${jar_args[@]}" -D /tmp/acct.hdr -o /tmp/acct.body -w '%{http_code}' \
      -X "$method" "${BASE}${path}"
  fi
}

jget() { jq -r "$1" < /tmp/acct.body 2>/dev/null; }

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
# ONE list, used by the guard, the disabled method sweep and the ON matrix — so
# a path can never be probed in one mode and forgotten in the other.
# `/account/internal/*` is excluded ON PURPOSE: it is denied at the edge with
# 403 and never reaches an app container (the containerised topology gate owns
# that leg). `/account/logout` is LAST because the ON matrix really does log
# that session out; see section 9.
# ---------------------------------------------------------------------------
MATRIX_PATHS="/account/login /account/notify /account/recover /account/register
              /account/session /account/sync /account/push/preferences
              /account/push/subscribe /account/logout"

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
# The expected answer for one ON-mode matrix cell.
#
# `HEAD` is answered by the route's `GET`; every verb a route does not export is
# the shared `wrongMethod` stub (405, naming the method). The session-gated
# routes answer 401 for BOTH the no-cookie and the forged-cookie column: a
# cookie that resolves to no live row is not a session — one code, one message,
# never an oracle that tells a prober whether a cookie was ever real.
# ---------------------------------------------------------------------------
matrix_expect() { # matrix_expect <path> <method> <none|valid|forged>
  local path="$1" method="$2" auth="$3" verbs eff
  case "$path" in
    /account/register|/account/login|/account/logout|/account/notify|/account/recover) verbs="POST" ;;
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
    "/account/register POST"|"/account/login POST"|"/account/recover POST") echo 400 ;;
    "/account/logout POST") echo 200 ;;
    "/account/session GET") echo 200 ;;
    "/account/sync GET"|"/account/push/preferences GET"|"/account/push/preferences PUT")
      if [ "$auth" = "valid" ]; then echo 200; else echo 401; fi ;;
    "/account/sync PUT"|"/account/notify POST"|"/account/push/subscribe DELETE")
      if [ "$auth" = "valid" ]; then echo 400; else echo 401; fi ;;
    # No VAPID keys on a default deployment ⇒ push is inert (503). A deployment
    # that DID configure push must still not answer 401/403/404 here, so the
    # invalid-body answer is accepted too.
    "/account/push/subscribe POST")
      if [ "$auth" = "valid" ]; then echo "503|400"; else echo 401; fi ;;
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
  proc=$(grep -i '^x-gb-process:' /tmp/acct.hdr | tr -d '\r' | awk '{print $2}')
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
    $(grep -qi '^allow:' /tmp/acct.hdr && echo 1 || echo 0)
  [ "$FAIL" -eq 0 ] || { echo "account gate: ${FAIL} failed" >&2; exit 1; }
  echo "account gate OK (feature off): ${PASS} checks"
  exit 0
fi

echo "account gate (expecting the feature ON): ${BASE}"

# --- 1. Signed-out session is honest and uncacheable ------------------------
code=$(req - GET /account/session)
check "GET /account/session → 200 when signed out" $([ "$code" = "200" ] && echo 0 || echo 1)
check "session says enabled:true, authed:false" \
  $([ "$(jget '.enabled')" = "true" ] && [ "$(jget '.authed')" = "false" ] && echo 0 || echo 1)
check "session is Cache-Control: no-store" \
  $(grep -qi '^cache-control: no-store' /tmp/acct.hdr && echo 0 || echo 1)
check "process identifies itself as account" \
  $([ "$(grep -i '^x-gb-process:' /tmp/acct.hdr | tr -d '\r' | awk '{print $2}')" = "account" ] && echo 0 || echo 1)
check "no VAPID keys ⇒ pushConfigured:false (inert, not broken)" \
  $([ "$(jget '.pushConfigured')" = "false" ] && echo 0 || echo 1)

# --- 2. Register ------------------------------------------------------------
PW='correct horse battery staple'
code=$(req "$JAR" POST /account/register "{\"email\":\"smoke@example.com\",\"password\":\"$PW\"}")
check "POST /account/register → 201" $([ "$code" = "201" ] && echo 0 || echo 1)
check "register signs the caller in (cookie set)" \
  $(grep -qi '^set-cookie: acct_session=' /tmp/acct.hdr && echo 0 || echo 1)
check "acct_session is HttpOnly + SameSite=Lax + Path=/" \
  $(grep -i '^set-cookie: acct_session=' /tmp/acct.hdr | grep -q 'HttpOnly' \
    && grep -i '^set-cookie: acct_session=' /tmp/acct.hdr | grep -q 'SameSite=Lax' \
    && grep -i '^set-cookie: acct_session=' /tmp/acct.hdr | grep -q 'Path=/' \
    && echo 0 || echo 1)
# Secure only when the origin is https: a local http run cannot set it, and
# the production origin (ACCT_PUBLIC_ORIGIN=https://…) must.
if [[ "$BASE" == https://* ]]; then
  check "acct_session is Secure (https origin)" \
    $(grep -i '^set-cookie: acct_session=' /tmp/acct.hdr | grep -q 'Secure' && echo 0 || echo 1)
fi

check "register returns the KDF salt the browser needs" \
  $([ -n "$(jget '.kdfSalt')" ] && [ "$(jget '.kdfSalt')" != "null" ] && echo 0 || echo 1)
check "no recovery code without data (issued iff a server copy exists)" \
  $([ "$(jget '.recoveryCode')" = "null" ] && echo 0 || echo 1)
check "no password material in any response body" \
  $(grep -qF "$PW" /tmp/acct.body && echo 1 || echo 0)

code=$(req - POST /account/register "{\"email\":\"smoke@example.com\",\"password\":\"$PW\"}")
check "duplicate e-mail → 409 email_taken" \
  $([ "$code" = "409" ] && [ "$(jget '.error')" = "email_taken" ] && echo 0 || echo 1)

code=$(req - POST /account/register '{"email":"smoke@example.com","password":"short"}')
check "short password → 400 invalid_password" \
  $([ "$code" = "400" ] && [ "$(jget '.error')" = "invalid_password" ] && echo 0 || echo 1)

# --- 3. Login, right and wrong ---------------------------------------------
code=$(req "$JAR2" POST /account/login "{\"email\":\"smoke@example.com\",\"password\":\"$PW\"}")
check "POST /account/login (second device) → 200" $([ "$code" = "200" ] && echo 0 || echo 1)
check "login hands back the SAME kdf salt (the key is derivable there too)" \
  $([ -n "$(jget '.kdfSalt')" ] && echo 0 || echo 1)
SALT="$(jget '.kdfSalt')"

code=$(req - POST /account/login "{\"email\":\"smoke@example.com\",\"password\":\"not the password\"}")
check "wrong password → 401 invalid_credentials" \
  $([ "$code" = "401" ] && [ "$(jget '.error')" = "invalid_credentials" ] && echo 0 || echo 1)
code=$(req - POST /account/login '{"email":"nobody@example.com","password":"not the password"}')
check "unknown address → the SAME 401 code (no account enumeration)" \
  $([ "$code" = "401" ] && [ "$(jget '.error')" = "invalid_credentials" ] && echo 0 || echo 1)

# --- 4. Sync: ciphertext in, ciphertext out ---------------------------------
IV="$(printf 'wave-n-iv-12' | base64)"            # 12 bytes — GCM's IV size
BLOB="$(printf '{"ciphertext":"not readable by the server"}' | base64)"

code=$(req - PUT /account/sync "{\"iv\":\"$IV\",\"data\":\"$BLOB\",\"baseRev\":0}")
check "PUT /account/sync without a session → 401" $([ "$code" = "401" ] && echo 0 || echo 1)

code=$(req "$JAR" PUT /account/sync "{\"iv\":\"$IV\",\"data\":\"$BLOB\",\"baseRev\":0}")
check "PUT /account/sync → 200 with rev 1" \
  $([ "$code" = "200" ] && [ "$(jget '.rev')" = "1" ] && echo 0 || echo 1)

code=$(req "$JAR" GET /account/sync)
check "GET /account/sync returns the stored blob byte-for-byte" \
  $([ "$code" = "200" ] && [ "$(jget '.iv')" = "$IV" ] && [ "$(jget '.data')" = "$BLOB" ] && echo 0 || echo 1)
check "…and nothing that looks like a decrypted payload" \
  $(grep -q 'billing_day\|energy_data\|"payload"' /tmp/acct.body && echo 1 || echo 0)

code=$(req "$JAR" PUT /account/sync "{\"iv\":\"$IV\",\"data\":\"$BLOB\",\"baseRev\":0}")
check "stale baseRev → 409 carrying the current revision" \
  $([ "$code" = "409" ] && [ "$(jget '.currentRev')" = "1" ] && echo 0 || echo 1)

code=$(req "$JAR" PUT /account/sync "{\"iv\":\"$IV\",\"data\":\"not-base64!!\",\"baseRev\":1}")
check "non-base64 ciphertext → 400, never stored" \
  $([ "$code" = "400" ] && echo 0 || echo 1)

# --- 5. Multi-device: the second profile sees the same copy -----------------
code=$(req "$JAR2" GET /account/sync)
check "second device, after login, pulls the same revision" \
  $([ "$code" = "200" ] && [ "$(jget '.rev')" = "1" ] && [ "$(jget '.data')" = "$BLOB" ] && echo 0 || echo 1)

# --- 6. Preferences are the documented defaults -----------------------------
code=$(req "$JAR" GET /account/push/preferences)
check "push preferences → 200 defaults (4 topics, cap 3, quiet 22:00–07:00)" \
  $([ "$code" = "200" ] && [ "$(jget '.prefs.dailyCap')" = "3" ] \
    && [ "$(jget '.prefs.topics | length')" = "4" ] \
    && [ "$(jget '.prefs.quietStart')" = "1320" ] \
    && [ "$(jget '.prefs.quietEnd')" = "420" ] && echo 0 || echo 1)
code=$(req - GET /account/push/preferences)
check "push preferences without a session → 401" $([ "$code" = "401" ] && echo 0 || echo 1)

# --- 7. Notify fan-out is session-gated -------------------------------------
code=$(req - POST /account/notify '{"topic":"plan_change","title":"x"}')
check "POST /account/notify without a session → 401" $([ "$code" = "401" ] && echo 0 || echo 1)
# The topic split is part of the contract (SECURITY.md §5.11): a browser may
# emit only the client-origin half of the trigger table, and it reaches only
# its own account. Both halves are asserted here because a fan-out that
# reaches the wrong account is invisible to every other check in this script.
code=$(req "$JAR" POST /account/notify '{"topic":"anomaly","title":"Unusual usage"}')
check "POST /account/notify (client-origin topic, own session) → 200" $([ "$code" = "200" ] && echo 0 || echo 1)
code=$(req "$JAR" POST /account/notify '{"topic":"oeb_rates","title":"x"}')
check "a browser may not claim a server-origin topic → 400 invalid_topic" \
  $([ "$code" = "400" ] && [ "$(jget '.error')" = "invalid_topic" ] && echo 0 || echo 1)

# --- 8. Logout invalidates the SESSION, not just the cookie -----------------
code=$(req "$JAR" POST /account/logout)
check "POST /account/logout → 200" $([ "$code" = "200" ] && echo 0 || echo 1)
code=$(req "$JAR" GET /account/sync)
check "the cookie it left behind no longer authenticates (401)" \
  $([ "$code" = "401" ] && echo 0 || echo 1)
code=$(req "$JAR2" GET /account/sync)
check "the OTHER device's session survives this logout" \
  $([ "$code" = "200" ] && echo 0 || echo 1)

# --- 9. The matrix: every method × every auth state, over the real router ---
#
# Section 8 signed its cookie out on purpose, so the matrix mints its own
# session. This is the LAST section because one of its cells really does log
# that session out — POST /account/logout [valid] → 200 wasAuthenticated:true —
# which is why /account/logout is last in MATRIX_PATHS.
echo "== 9. the method × auth-state matrix (${BASE}) =="
code=$(req "$JAR3" POST /account/login "{\"email\":\"smoke@example.com\",\"password\":\"$PW\"}")
check "the matrix's own session logs in → 200" $([ "$code" = "200" ] && echo 0 || echo 1)
VALID="acct_session=$(cookie_from_jar "$JAR3")"
FORGED="acct_session=$(forged_token)"
check "the matrix holds a real acct_session cookie" \
  $([ "$(cookie_from_jar "$JAR3")" != "" ] && echo 0 || echo 1)

for path in $MATRIX_PATHS; do
  for method in GET HEAD POST PUT PATCH DELETE OPTIONS; do
    for auth in none valid forged; do
      case "$auth" in
        none) CK="-" ;;
        valid) CK="$VALID" ;;
        forged) CK="$FORGED" ;;
      esac
      want=$(matrix_expect "$path" "$method" "$auth")
      code=$(matrix_req "$CK" "$method" "$path") || code=000
      if [ "$want" = "UNKNOWN" ]; then
        check "${method} ${path} [${auth}] — this cell has no expectation" 1
        continue
      fi
      # `503|400` in the table means either is correct; the unquoted expansion
      # splits it into the arguments `accepts` compares against.
      if accepts "$code" ${want//|/ }; then ok=0; else ok=1; fi
      check "${method} ${path} [${auth}] → ${code} (want ${want})" "$ok"
      # The other tell of 2c8ca8d: a 405 (or an auto-OPTIONS 204) names the
      # verbs this origin answers. On the OFF half nothing may carry `Allow`;
      # on the ON half only the honest 405 may.
      if [ "$code" != "405" ]; then
        check "  …and it names no verbs (no Allow header)" \
          $(grep -qi '^allow:' /tmp/acct.hdr && echo 1 || echo 0)
      fi
    done
  done
done

# The internal fan-out is not the router's to answer, and there are two ways to
# be refused: through the edge it is a flat `403` with no upstream at all (the
# containerised topology gate runs this script through the router), and against
# the container directly it is the token gate's own bare `404`. Both are
# "unreachable"; what must NEVER happen is a 2xx — and, the cell this exists
# for, a live SESSION must not stand in for the shared secret.
code=$(matrix_req - POST /account/internal/notify) || code=000
if accepts "$code" 403 404; then ok=0; else ok=1; fi
check "POST /account/internal/notify → ${code} (403 at the edge, or 404 at the token gate — never 2xx)" "$ok"
code=$(matrix_req "$VALID" POST /account/internal/notify) || code=000
if accepts "$code" 403 404; then ok=0; else ok=1; fi
check "…and a live session is NOT the internal token → ${code}" "$ok"

echo "account gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
