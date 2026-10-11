#!/usr/bin/env bash
# HTTP smoke: boot-state assertions against an already-running container.
# Usage: http_smoke.sh [base_url]   (default http://localhost:3000)
# No secrets; pure GET checks. Total runtime: a few seconds.
set -euo pipefail

BASE="${1:-${SMOKE_BASE_URL:-http://localhost:3000}}"
MAX_WAIT="${SMOKE_WAIT_SECS:-30}"

fail() { echo "FAIL: $1" >&2; exit 1; }

# --- Wait for the server to accept connections ---------------------------
for i in $(seq 1 "${MAX_WAIT}"); do
  if curl -fsS -o /dev/null --max-time 2 "${BASE}/"; then break; fi
  [ "$i" = "${MAX_WAIT}" ] && fail "server did not come up within ${MAX_WAIT}s at ${BASE}"
  sleep 1
done

# --- GET / : 200 + app identity ------------------------------------------
code=$(curl -s -o /tmp/smoke_index.html -w '%{http_code}' "${BASE}/")
[ "$code" = "200" ] || fail "GET / returned ${code}, expected 200"
grep -q "Ontario Energy Optimizer" /tmp/smoke_index.html \
  || fail "GET / body missing 'Ontario Energy Optimizer'"
grep -q 'rel="manifest"' /tmp/smoke_index.html \
  || fail "GET / body missing manifest link (PWA installability)"

# --- GET /api/rates : 200 + the three versioned rate sets ----------------
code=$(curl -s -o /tmp/smoke_rates.json -w '%{http_code}' "${BASE}/api/rates")
[ "$code" = "200" ] || fail "GET /api/rates returned ${code}, expected 200"
python3 - <<'PY' || fail "/api/rates payload unexpected"
import json
d = json.load(open('/tmp/smoke_rates.json'))
rates = d.get('historicalRates')
assert isinstance(rates, list) and len(rates) == 3, f"expected 3 rate sets, got {rates!r}"
assert rates[-1]['effectiveDate'] == '2025-11-01', rates[-1]
assert rates[-1]['tou']['onPeak'] == 20.3, rates[-1]['tou']
print("rates ok:", [r['effectiveDate'] for r in rates])
PY

# --- PWA assets ------------------------------------------------------------
code=$(curl -s -o /tmp/smoke_manifest.json -w '%{http_code}' "${BASE}/manifest.webmanifest")
[ "$code" = "200" ] || fail "GET /manifest.webmanifest returned ${code}, expected 200"
grep -q "Ontario Energy Optimizer" /tmp/smoke_manifest.json \
  || fail "manifest body missing app name"
grep -q "icon-512.png" /tmp/smoke_manifest.json \
  || fail "manifest missing 512px icon (installability requirement)"

code=$(curl -s -D /tmp/smoke_sw.headers -o /tmp/smoke_sw.js -w '%{http_code}' "${BASE}/sw.js")
[ "$code" = "200" ] || fail "GET /sw.js returned ${code}, expected 200"
grep -qi "cache-control: no-cache" /tmp/smoke_sw.headers \
  || fail "sw.js missing Cache-Control: no-cache (stale-escape hazard)"
grep -qE "oeo-v1-[a-z0-9]+" /tmp/smoke_sw.js \
  || fail "sw.js body missing a per-build cache version marker (oeo-v1-<build>)"
# The committed placeholder is NOT a per-build stamp: serving it means
# `prebuild` never ran, so CACHE_NAME is identical to the previous deploy and
# installed PWAs keep their stale shell — the stale-chunk failure mode.
if grep -q "const VERSION = 'oeo-v1-local'" /tmp/smoke_sw.js; then
  fail "sw.js is the committed placeholder (oeo-v1-local): the prebuild stamp did not run, so CACHE_NAME did not change for this deploy"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/icons/icon-192.png")
[ "$code" = "200" ] || fail "GET /icons/icon-192.png returned ${code}, expected 200"
code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/icons/icon-512.png")
[ "$code" = "200" ] || fail "GET /icons/icon-512.png returned ${code}, expected 200"

echo "HTTP smoke OK: /, /api/rates, manifest, sw.js, icons all 200 with expected content"
