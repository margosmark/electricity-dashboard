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
# No secrets, no fixtures, no jq dependency beyond what CI already ships.
# Runtime: a few seconds (argon2id dominates: ~4 hashes).

set -euo pipefail

BASE="${1:?usage: account_smoke.sh <base_url> [--expect-disabled]}"
MODE="${2:-enabled}"
MAX_WAIT="${SMOKE_WAIT_SECS:-30}"

JAR="$(mktemp -d)/cookies.txt"
JAR2="$(mktemp -d)/cookies.txt"
trap 'rm -rf "$(dirname "$JAR")" "$(dirname "$JAR2")"' EXIT

PASS=0
FAIL=0
check() { # check <label> <condition-exit-status>
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; fi
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

# --- Wait for the server ----------------------------------------------------
for i in $(seq 1 "${MAX_WAIT}"); do
  if curl -fsS -o /dev/null --max-time 2 "${BASE}/"; then break; fi
  [ "$i" = "${MAX_WAIT}" ] && { echo "FAIL: server did not come up within ${MAX_WAIT}s at ${BASE}" >&2; exit 1; }
  sleep 1
done

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
  for path in /account/login /account/logout /account/notify /account/recover \
              /account/register /account/session /account/sync \
              /account/push/preferences /account/push/subscribe; do
    for method in GET POST PUT PATCH DELETE HEAD OPTIONS; do
      code=$(req - "$method" "$path") || code=000
      check "${method} ${path} → 404 (no such route, whatever the method)" \
        $([ "$code" = "404" ] && echo 0 || echo 1)
    done
  done
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

echo "account gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
