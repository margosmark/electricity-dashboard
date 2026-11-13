#!/usr/bin/env bash
# Dark-mode regression suite — the ONE command that runs every dark-mode pin.
#
# Why this exists: the dark-mode gates live in three different layers, and the
# browser layer is Playwright, which this repo only ever ran inside the Docker
# smoke job (workflow_disabled — Actions minutes are exhausted, so the smoke
# job does not run for anyone). A gate nobody can run is not a gate, and the
# dark-mode defect class (a themed ink on a slab that does not flip) kept
# coming back through exactly that hole: t_fbf590fa, t_3e571ddb.
#
# What it runs, in order:
#
#   1. THE UNIT PINS  (`src/lib/theme.test.ts`, `src/components/ThemeToggle
#      .test.tsx`) — the store's writes (attribute, colorScheme, meta, storage)
#      and the radiogroup's semantics/keys. Fast, no browser.
#   2. THE BROWSER PINS, against a real production build:
#        - tests/e2e/theme.spec.ts          the FOUC guard (4 cold/override paths)
#        - tests/e2e/theme-toggle.spec.ts   the control → attribute → storage →
#                                           reload path, sampled pre-paint
#        - tests/e2e/theme-contrast.spec.ts the per-panel contrast budget, both
#                                           themes, all four tabs
#
# The evidence file (evidence/dark-mode-regression.json) is written by the
# contrast walk itself, so the recorded numbers are the numbers the gate
# asserted — not a second, differently-instrumented measurement.
#
# Usage: webapp/scripts/e2e-theme-regression.sh       (from anywhere; it cds)
#   E2E_THEME_SKIP_BUILD=1   reuse the existing .next (faster inner loop)
#   E2E_THEME_SKIP_UNIT=1    skip the vitest pins (browser gate only)
#   PORT                     override 3111
#   E2E_THEME_BASE           drive an already-running stack (no build/launch)
#   E2E_THEME_EVIDENCE       where to write the JSON (default evidence/…)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$WEBAPP/.." && pwd)"
cd "$WEBAPP"

PORT="${PORT:-3111}"
BASE="${E2E_THEME_BASE:-http://localhost:$PORT}"
EVIDENCE="${E2E_THEME_EVIDENCE:-$REPO/evidence/dark-mode-regression.json}"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

# The Playwright config falls back to channel 'chrome' when PW_CHROMIUM_PATH is
# unset; on this box both exist, and the env var keeps the run off a download.
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
    printf '\nDARK-MODE REGRESSION OK — %d checks passed\n' "$PASS"
  else
    printf '\nDARK-MODE REGRESSION FAILED — %d passed, %d failed\n' "$PASS" "$FAIL"
    printf '  playwright: %s\n  app log: %s\n' "$WORK/pw.log" "$WORK/app.log"
  fi
}
trap cleanup EXIT

EXTERNAL="${E2E_THEME_BASE:-}"

# --- 1. the unit pins -------------------------------------------------------
if [ -z "${E2E_THEME_SKIP_UNIT:-}" ]; then
  echo "== vitest: the theme store + the toggle =="
  if npx vitest run src/lib/theme.test.ts src/components/ThemeToggle.test.tsx \
      >"$WORK/unit.log" 2>&1; then
    UNIT_LINE="$(grep -E '^ *Tests +[0-9]+ passed' "$WORK/unit.log" | tail -1)"
    check "unit pins green (${UNIT_LINE:-?})" 0
  else
    check "unit pins green" 1
    tail -30 "$WORK/unit.log"
  fi
fi

# --- 2. a real production build to walk -------------------------------------
if [ -z "$EXTERNAL" ]; then
  if [ -n "$(port_pid "$PORT")" ]; then
    echo "ERROR: something already answers on $PORT (a previous run did not clean up)." >&2
    echo "       free it first:  pkill -f 'next[ ]start -p $PORT'" >&2
    exit 1
  fi
  if [ -z "${E2E_THEME_SKIP_BUILD:-}" ]; then
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
  # setsid: the server becomes its own process-group leader, so the cleanup
  # trap can kill the whole group (npx → node → next) instead of orphaning the
  # child that actually holds the port.
  setsid npx --no-install next start -p "$PORT" >"$WORK/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$BASE/" 2>/dev/null && break
    sleep 1
  done
  if ! curl -fsS -o /dev/null "$BASE/"; then
    echo "server never came up on $BASE"; tail -20 "$WORK/app.log" 2>/dev/null
    check "the app answers on $BASE" 1
    exit 1
  fi
  check "the app answers on $BASE" 0
else
  echo "== external stack: $BASE =="
fi

# The evidence file is written by the spec (THEME_EVIDENCE_JSON) — run from a
# clean slate so a stale file can never be mistaken for this run's numbers.
mkdir -p "$(dirname "$EVIDENCE")"
rm -f "$EVIDENCE"

# --- 3. the browser pins ----------------------------------------------------
echo
echo "== playwright: theme, theme-toggle, theme-contrast =="
SMOKE_BASE_URL="$BASE" THEME_EVIDENCE_JSON="$EVIDENCE" \
  npx playwright test theme theme-toggle theme-contrast 2>&1 | tee "$WORK/pw.log"
PW_STATUS=${PIPESTATUS[0]}
check "playwright suite green (exit $PW_STATUS)" "$PW_STATUS"

# A spec that silently SKIPS (or is never collected) would leave the gate
# green over an unmeasured page — the exact failure this suite exists to
# prevent, so each file has to show a ✓ and no skipped test.
for spec in theme.spec.ts theme-toggle.spec.ts theme-contrast.spec.ts; do
  RAN="$(grep -cE "✓.*$spec" "$WORK/pw.log")"
  SKIPPED="$(grep -cE "^ +- +[0-9]+ .*$spec" "$WORK/pw.log")"
  if [ "$RAN" -ge 1 ] && [ "$SKIPPED" -eq 0 ]; then
    check "$spec ran ($RAN test(s), 0 skipped)" 0
  else
    check "$spec ran (saw $RAN test(s), $SKIPPED skipped)" 1
  fi
done

# The budget itself, as measured — so the run reports the numbers and not just
# a colour of green.
if [ -f "$EVIDENCE" ]; then
  check "the per-panel budget was recorded to $EVIDENCE" 0
  python3 - "$EVIDENCE" <<'PY' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
for theme, walk in d["themes"].items():
    panels = len(walk["measured"])
    nodes = sum(walk["measured"].values())
    print(f"  budget [{theme}]: {panels} panels / {nodes} text nodes measured, "
          f"{len(walk['findings'])} pairing(s) under AA")
PY
else
  check "the per-panel budget was recorded to $EVIDENCE" 1
fi

exit "$FAIL"
