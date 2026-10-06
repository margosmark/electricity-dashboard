# ops/dmd — automated Green Button "Download My Data"

Keeps Mark's electricity-dashboard data fresh without manual XML exports.
Runs **on hermescomputer (.110)**, uses **Mark's own utility credentials**,
and touches **no other account**.

The full runbook — credential handling, exit codes, the ToS/CAPTCHA guardrails
and the ingestion path into the browser — lives in
[`OPERATIONS.md`](../../OPERATIONS.md) under **DMD automation**. Read that
before changing anything here.

## Files

| File | What it is |
| --- | --- |
| `dmd_refresh.py` | The automation: login → walk the portal → download the XML → file it non-destructively. Exit codes 0/2/3/4/5/6/7/8 are the contract. |
| `selectors.json` | The whole post-login flow as data. A portal redesign is fixed here, not in code. |
| `dmd_export_b64.py` | Hand-off helper: base64s the newest export so it can be pasted into the app's `/import` page (client-only, no backend). |
| `check_dmd_freshness.py` | Staleness watchdog, installed as a `no_agent` Hermes cron job that notifies Mark's chat when the last success is >7 days old. |
| `install.sh` | Idempotent .110 setup: data dirs, `.env` template at 0600, chromium, crontab entry. |
| `.env.example` | Template for the credentials file. **Never fill this in and commit it.** |
| `tests/` | Unit tests (pure helpers) + an end-to-end suite that drives the real script against a local mock portal, covering every exit code. |

## Tests

```bash
# pure helpers — no browser needed
python3 -m pytest ops/dmd/tests/test_dmd_refresh.py -v

# full end-to-end incl. login/download/dedupe/failure paths (needs playwright
# + chromium; runs on .110)
python3 -m pytest ops/dmd/tests -v
```

CI does not run these on purpose: they are host-side automation, not app
code, and the e2e half needs a browser. Run them on .110 before trusting a
change to `dmd_refresh.py` or `selectors.json`.
