#!/usr/bin/env python3
"""Weekly staleness watchdog for the DMD refresh on .110.

Installed as a Hermes cron job (no_agent): stdout is delivered verbatim to
Mark's chat and EMPTY stdout sends nothing, so a quiet week means the
pipeline is healthy. Three outcomes:

  * last successful export older than 7 days (or never) -> alert with the
    age, the last recorded exit code and where to look;
  * fresh -> no output at all (watchdog pattern);
  * the check itself could not run -> one-line warning, because a silently
    broken checker is worse than a noisy one.

Mirrors the shape of scripts/check_oeb_staleness.py (the OEB rate checker).

Usage:
  python3 check_dmd_freshness.py            # live check (cron, ssh to .110)
  python3 check_dmd_freshness.py --state F  # read a local last_success.json
  python3 check_dmd_freshness.py --max-days 7
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HOST = "hermescomputer"
REMOTE_STATE = "~/electricity-data/state/last_success.json"
REMOTE_LOG = "~/electricity-data/logs/dmd_refresh.log"
SSH_TIMEOUT = 30


def ssh(command: str) -> tuple[bool, str]:
    """Run one command on .110. (ok, stdout+stderr)."""
    try:
        proc = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST, command],
            capture_output=True, text=True, timeout=SSH_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"ssh failed: {exc}"
    return proc.returncode == 0, (proc.stdout or "") + (proc.stderr or "")


def load_state(path: str) -> tuple[dict | None, str | None]:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except FileNotFoundError:
        return None, None
    except (OSError, json.JSONDecodeError) as exc:
        return None, str(exc)


def parse_when(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def last_log_lines() -> str:
    ok, out = ssh(f"tail -n 6 {REMOTE_LOG} 2>/dev/null || true")
    return out.strip() if ok else ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Weekly staleness watchdog for the DMD refresh on .110")
    ap.add_argument("--state", default=None, help="read a local state file instead of ssh")
    ap.add_argument("--max-days", type=int, default=7)
    args = ap.parse_args(argv)

    if args.state:
        state, err = load_state(args.state)
    else:
        # `cat` exits 1 when the file has never been written — that is the
        # "never succeeded" case, not an unreachable host.
        ok, out = ssh(f"cat {REMOTE_STATE} 2>/dev/null || true")
        if not ok:
            print(f"⚠️ DMD freshness check failed: cannot reach {HOST} ({out.strip()[:200]})")
            return 1
        if not out.strip():
            state, err = None, None
        else:
            try:
                state, err = json.loads(out), None
            except json.JSONDecodeError:
                state, err = None, out[:200]

    now = datetime.now(timezone.utc)

    if err is not None:
        print(f"⚠️ DMD freshness check failed: last_success.json is unreadable ({err})")
        return 1

    if state is None:
        age_days = None
        when = None
    else:
        when = parse_when(state.get("finished_at"))
        if when is None:
            print("⚠️ DMD freshness check failed: last_success.json has no usable "
                  "finished_at timestamp")
            return 1
        age_days = (now - when).total_seconds() / 86400

    if age_days is not None and age_days <= args.max_days:
        return 0  # fresh — silence is the signal

    lines = ["🔌 *Oakville Hydro export is stale*"]
    if when is None:
        lines.append("• The DMD refresh has never completed successfully on .110.")
    else:
        lines.append(f"• Last successful export: *{age_days:.1f} days ago* "
                     f"({when.strftime('%Y-%m-%d %H:%M')} UTC) — limit is "
                     f"{args.max_days} days.")
    if state:
        lines.append(f"• Last file: `{state.get('path', '?').split('/')[-1]}` "
                     f"({state.get('readings', '?')} readings)")
    lines.append("• On .110: `tail -n 30 ~/electricity-data/logs/dmd_refresh.log`")
    lines.append("• Failures (auth / portal redesign / CAPTCHA) are also dumped to "
                 "`~/electricity-data/failed/`.")
    if not args.state:
        tail = last_log_lines()
        if tail:
            lines.append("• Recent log lines:")
            lines += [f"    `{ln}`" for ln in tail.splitlines()[-4:]]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
