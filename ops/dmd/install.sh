#!/usr/bin/env bash
# Idempotent setup for the DMD refresh on hermescomputer (.110).
#
# Safe to re-run. It never touches credentials it did not find: .env is only
# ever created from .env.example, and filling it in is a human step (see
# OPERATIONS.md). Exit 0 = ready; non-zero = something to fix first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_ROOT="${DMD_DATA_ROOT:-$HOME/electricity-data}"
CRON_LOCK="/tmp/dmd-refresh.lock"
CRON_MARKER="dmd_refresh.py"

echo "== directories (0700: Mark's own consumption data)"
for d in inbox logs state failed; do
  mkdir -p "$DATA_ROOT/$d"
  chmod 700 "$DATA_ROOT/$d"
done

echo "== python deps (playwright + chromium)"
if ! python3 -c 'import playwright' >/dev/null 2>&1; then
  python3 -m pip install --user -r "$HERE/requirements.txt"
fi
if ! python3 -c 'from playwright.sync_api import sync_playwright' >/dev/null 2>&1; then
  echo "FAIL: playwright import broken" >&2
  exit 1
fi
python3 -m playwright install chromium >/dev/null

echo "== credentials file"
ENV_FILE="$HERE/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$HERE/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   created $ENV_FILE from the template — FILL IN DMD_USERNAME/DMD_PASSWORD"
else
  chmod 600 "$ENV_FILE"
  echo "   $ENV_FILE already present (permissions forced to 600)"
fi
if ! grep -q '^DMD_USERNAME=.' "$ENV_FILE" || ! grep -q '^DMD_PASSWORD=.' "$ENV_FILE"; then
  echo "   WARNING: credentials are still empty — the refresh cannot log in yet."
fi

echo "== dry run of the safety gate (no browser, no network)"
python3 "$HERE/dmd_refresh.py" --help >/dev/null

echo "== cron (Mon + Thu 04:00 America/Toronto, off-peak, flock-guarded)"
if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
  echo "   already installed:"
  crontab -l | grep -F "$CRON_MARKER" | sed 's/^/     /'
else
  ENTRY="0 4 * * 1,4 /usr/bin/flock -n $CRON_LOCK python3 $HERE/dmd_refresh.py >> $DATA_ROOT/logs/cron.out 2>&1"
  { crontab -l 2>/dev/null || true; echo "# Wave J: own-account Green Button DMD refresh (ops/dmd)"; echo "$ENTRY"; } | crontab -
  echo "   installed: $ENTRY"
fi

echo
echo "Ready. Verify with:"
echo "  python3 $HERE/dmd_refresh.py --recon     # after credentials exist"
echo "  crontab -l | grep dmd_refresh"
echo "  tail -f $DATA_ROOT/logs/dmd_refresh.log"
