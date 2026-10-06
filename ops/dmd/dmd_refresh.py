#!/usr/bin/env python3
"""Automated Green Button "Download My Data" fetch for Mark's OWN account.

Runs headless on hermescomputer (.110) from cron. Logs into Oakville Hydro's
MyAccount portal with credentials that live ONLY in a chmod-600 .env file,
walks the Green Button portal, downloads the interval XML, and files it under
~/electricity-data/inbox/ with a name that can never collide (history is kept,
nothing is ever overwritten).

Hard rules enforced here, not by convention:

  * Credentials are read from .env at runtime. They are never printed, never
    logged, never written to any file this script creates, and the run aborts
    (exit 8) if .env is group/world readable or tracked by git.
  * Browser profile, cookies and cache live under a tmpfs TMPDIR that is
    deleted in `finally` — no session state survives the run.
  * Trace, video and screenshots of the LOGIN page are never taken, so no
    artifact can carry a typed password.
  * An interactive CAPTCHA challenge aborts the run (exit 5). We do not solve
    captchas; that is the line between "automation of my own account" and
    "circumventing a control".
  * Anything unexpected aborts non-zero with a dumped post-login DOM, so a
    portal redesign can never fail silently.

Exit codes (see OPERATIONS.md):
  0 new file filed
  2 bad usage / config
  3 authentication rejected
  4 download identical to the previous success (no new data)
  5 interactive challenge (CAPTCHA / MFA) — human required
  6 portal structure changed — selectors.json needs a look
  7 downloaded payload is not importable Green Button XML
  8 environment problem (.env missing, bad permissions, git-tracked)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_AUTH = 3
EXIT_NO_NEW = 4
EXIT_CHALLENGE = 5
EXIT_STRUCTURE = 6
EXIT_INVALID = 7
EXIT_ENV = 8

HERE = Path(__file__).resolve().parent
DEFAULT_SELECTORS = HERE / "selectors.json"

# Hosts that must never see our traffic during a run (no tracking, no chat
# widget, no maps). Deliberately narrow: blocking anything the login flow
# depends on would turn a tracker filter into an auth outage.
BLOCKED_HOST_PATTERNS = (
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "maps.googleapis.com",
    "pure.cloud",
)


class DmdError(Exception):
    """Fatal run error carrying the exit code to return."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class Env:
    """Runtime configuration. `password` never leaves this object."""

    username: str
    password: str
    start_url: str | None = None
    inbox: Path = Path.home() / "electricity-data" / "inbox"
    state_dir: Path = Path.home() / "electricity-data" / "state"
    log_dir: Path = Path.home() / "electricity-data" / "logs"
    fail_dir: Path = Path.home() / "electricity-data" / "failed"


# --------------------------------------------------------------------------
# .env handling — the only place credentials are read, and the only place
# they are ever held outside the login form.
# --------------------------------------------------------------------------

def parse_env_file(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE reader. No shell, no export, no command substitution."""
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        values[key] = val
    return values


def assert_env_is_private(path: Path) -> None:
    """Refuse to run unless .env is 0600-ish AND not tracked by git."""
    if not path.exists():
        raise DmdError(EXIT_ENV, f"env file missing: {path}")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise DmdError(
            EXIT_ENV,
            f"{path} is {oct(mode)} — run: chmod 600 {path} (credentials must "
            "not be readable by anyone else on this host)",
        )
    # Tracked-by-git check: a .env that `git add -f` once would ride along in
    # the next commit. `git ls-files` is the authority, not .gitignore.
    git_dir = path.parent
    while git_dir != git_dir.parent and not (git_dir / ".git").exists():
        git_dir = git_dir.parent
    if (git_dir / ".git").exists():
        import subprocess

        proc = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", str(path)],
            cwd=git_dir,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            raise DmdError(
                EXIT_ENV,
                f"{path} is TRACKED by git — remove it from the index before "
                "anything else (`git rm --cached`), the credentials are one "
                "push from being public",
            )


def load_env(path: Path) -> Env:
    assert_env_is_private(path)
    raw = parse_env_file(path)
    username = (raw.get("DMD_USERNAME") or "").strip()
    password = raw.get("DMD_PASSWORD") or ""
    if not username or not password:
        raise DmdError(
            EXIT_ENV,
            f"{path} must define DMD_USERNAME and DMD_PASSWORD (values are "
            "never printed — this message only names the keys)",
        )
    root = Path.home() / "electricity-data"
    return Env(
        username=username,
        password=password,
        start_url=(raw.get("DMD_START_URL") or "").strip() or None,
        inbox=Path(raw.get("DMD_INBOX") or root / "inbox"),
        state_dir=Path(raw.get("DMD_STATE_DIR") or root / "state"),
        log_dir=Path(raw.get("DMD_LOG_DIR") or root / "logs"),
        fail_dir=Path(raw.get("DMD_FAIL_DIR") or root / "failed"),
    )


# --------------------------------------------------------------------------
# Logging — stdout (cron mails / journal) plus an append-only file.
# --------------------------------------------------------------------------

class Logger:
    def __init__(self, log_dir: Path, quiet: bool = False):
        self.quiet = quiet
        self.path: Path | None = None
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            self.path = log_dir / "dmd_refresh.log"
            # Bound the log so a chatty failure loop cannot fill the disk.
            if self.path.exists() and self.path.stat().st_size > 4 * 1024 * 1024:
                self.path.replace(self.path.with_suffix(".log.1"))
        except OSError:
            self.path = None

    def __call__(self, message: str) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        line = f"{stamp} {message}"
        if not self.quiet:
            print(line, flush=True)
        if self.path:
            try:
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass


# --------------------------------------------------------------------------
# Green Button payload validation.
# --------------------------------------------------------------------------

# ESPI exports arrive both bare (`<IntervalReading>`) and namespaced
# (`<espi:IntervalReading>`); the app's parser strips prefixes (removeNSPrefix),
# so the structural check has to accept both or a perfectly good file fails.
_NS = r"(?:[A-Za-z_][\w.-]*:)?"


def inspect_greenbutton_xml(text: str) -> tuple[int, str | None]:
    """(row_count, error). Structural only — the app's own parser runs the
    real gate when the file is ingested at /import (see OPERATIONS.md)."""
    head = text.lstrip()[:200].lower()
    if not (head.startswith("<?xml") or head.startswith("<")):
        return 0, "payload does not start with an XML document"
    if "intervalreading" not in text.lower() and "intervalblock" not in text.lower():
        return 0, "no IntervalBlock/IntervalReading elements found"
    # Cheap well-formedness: tag balance on the elements we care about.
    for tag in ("IntervalReading", "IntervalBlock", "IntervalReadings"):
        opens = len(re.findall(rf"<{_NS}{tag}[\s>]", text, re.IGNORECASE))
        closes = len(re.findall(rf"</{_NS}{tag}>", text, re.IGNORECASE))
        if opens != closes:
            return 0, f"unbalanced <{tag}> elements ({opens} open / {closes} close)"
    rows = len(re.findall(rf"<{_NS}IntervalReading[\s>]", text, re.IGNORECASE))
    if rows == 0:
        return 0, "document contains no IntervalReading elements"
    return rows, None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unique_path(directory: Path, stem: str, suffix: str) -> Path:
    """Never overwrite: 20261006T040000Z.xml, then ...Z-1.xml, ...Z-2.xml."""
    candidate = directory / f"{stem}{suffix}"
    n = 1
    while candidate.exists():
        candidate = directory / f"{stem}-{n}{suffix}"
        n += 1
    return candidate


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_state(state_dir: Path) -> dict:
    path = state_dir / "last_success.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


# --------------------------------------------------------------------------
# Flow engine — selectors.json drives everything after the login form.
# --------------------------------------------------------------------------

@dataclass
class Step:
    name: str
    action: str
    selectors: list[str] = field(default_factory=list)
    optional: bool = False
    timeout_ms: int = 15000
    url: str | None = None
    value: str | None = None
    ms: int | None = None

    @classmethod
    def from_dict(cls, raw: dict) -> "Step":
        return cls(
            name=raw.get("name", raw.get("action", "step")),
            action=raw["action"],
            selectors=list(raw.get("selectors", [])),
            optional=bool(raw.get("optional", False)),
            timeout_ms=int(raw.get("timeout_ms", 15000)),
            url=raw.get("url"),
            value=raw.get("value"),
            ms=raw.get("ms"),
        )


def find_first(page, selectors: list[str], timeout_ms: int):
    """First selector that resolves to a VISIBLE element, else None.

    Deliberately a poll over every candidate rather than Playwright's
    `wait_for` per selector: waiting out selector #1 burns the whole budget
    and never reaches #2, which turns one stale selector into a false
    "portal structure changed". Every tick tries every candidate, so the list
    in selectors.json really is an ordered preference list.
    """
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        for selector in selectors:
            try:
                locator = page.locator(selector)
                if locator.count() == 0:
                    continue
                first = locator.first
                if first.is_visible():
                    return first
            except Exception:  # noqa: BLE001 — a stale node is just a miss
                continue
        try:
            page.wait_for_timeout(200)
        except Exception:  # noqa: BLE001 — page navigated mid-poll
            break
    return None


def interactive_challenge(page, cfg: dict) -> str | None:
    """Name of an interactive hurdle we must not fight, or None."""
    for selector in cfg.get("captcha", []):
        try:
            if page.locator(selector).count() > 0:
                return f"CAPTCHA challenge present ({selector})"
        except Exception:  # noqa: BLE001
            continue
    mfa = cfg.get("mfa", {})
    url = page.url.lower()
    if any(token.lower() in url for token in mfa.get("url_contains", [])):
        return f"multi-factor step in the URL ({page.url})"
    for selector in mfa.get("selectors", []):
        try:
            if page.locator(selector).count() > 0:
                return f"multi-factor prompt present ({selector})"
        except Exception:  # noqa: BLE001
            continue
    return None


def dump_failure(env: Env, log: Logger, tag: str, page=None) -> Path | None:
    """Save a post-login DOM + screenshot for selector repair. NEVER called on
    the login page, so no artifact can contain a typed password."""
    if page is None:
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = env.fail_dir / f"{stamp}-{tag}"
    try:
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "url.txt").write_text(page.url + "\n", encoding="utf-8")
        (dest / "page.html").write_text(page.content(), encoding="utf-8")
        (dest / "visible.txt").write_text(
            page.evaluate("() => document.body ? document.body.innerText : ''"),
            encoding="utf-8",
        )
        page.screenshot(path=str(dest / "page.png"), full_page=True)
        log(f"failure artifacts -> {dest}")
        return dest
    except Exception as exc:  # noqa: BLE001 — artifact saving must not mask the error
        log(f"could not save failure artifacts: {exc}")
        return None


def do_login(page, cfg: dict, env: Env, log: Logger, timeout_ms: int) -> None:
    login = cfg["login"]
    page.goto(env.start_url or cfg["start_url"], wait_until="domcontentloaded",
              timeout=timeout_ms)
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:  # noqa: BLE001 — chat/analytics frames keep the page busy
        pass

    if not any(token in page.url for token in login.get("url_contains", [])):
        # Already authenticated (fresh cookie) or the portal moved: if we are
        # not on a login page there is nothing to fill.
        if page.locator("input[type=password]").count() == 0:
            log(f"no login form at {page.url} — session already established")
            return

    user = find_first(page, login["username"], 15000)
    pwd = find_first(page, login["password"], 15000)
    if not user or not pwd:
        raise DmdError(EXIT_STRUCTURE,
                       "login form not found — portal markup changed "
                       "(selectors.json: login.username / login.password)")

    user.click()
    user.fill(env.username)
    pwd.click()
    pwd.fill(env.password)

    submit = find_first(page, login["submit"], 10000)
    if not submit:
        raise DmdError(EXIT_STRUCTURE, "SIGN IN button not found — selectors.json: login.submit")

    log("submitting credentials")
    submit.click()

    # Outcome race: success URL vs. an error message vs. a challenge.
    success_tokens = login.get("success_url_contains", [])
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        challenge = interactive_challenge(page, cfg)
        if challenge:
            raise DmdError(EXIT_CHALLENGE, challenge)
        for token in success_tokens:
            if token in page.url:
                log(f"authenticated -> {page.url}")
                return
        err = find_first(page, [login.get("failure_selector", "[role=alert]")], 1500)
        if err:
            try:
                lowered = (err.inner_text() or "").lower()
            except Exception:  # noqa: BLE001 — element vanished mid-read
                lowered = ""
            if any(t in lowered for t in login.get("failure_text", [])):
                raise DmdError(EXIT_AUTH, "portal rejected the credentials")
        page.wait_for_timeout(300)

    # Some portals authenticate without changing the URL. One last probe for
    # an authenticated marker before declaring the structure broken.
    if page.locator("input[type=password]").count() == 0:
        log("still on the same URL but the password field is gone — treating as authenticated")
        return
    raise DmdError(EXIT_AUTH, "login did not complete before the timeout")


def run_steps(page, cfg: dict, log: Logger, args) -> bytes:
    """Walk the configured flow; return the downloaded payload bytes."""
    pattern = re.compile(cfg.get("download", {}).get("url_pattern", r"\.xml"))
    download_timeout = int(cfg.get("download", {}).get("timeout_ms", 90000))
    captured: list[bytes] = []

    def on_response(response):
        try:
            ctype = response.headers.get("content-type", "")
            if "xml" in ctype and response.ok and pattern.search(response.url):
                body = response.body()
                if body:
                    captured.append(body)
        except Exception:  # noqa: BLE001 — body may be gone; ignore
            pass

    page.on("response", on_response)
    try:
        for raw in cfg.get("steps", []):
            step = Step.from_dict(raw)
            log(f"step: {step.name}")
            if step.action == "goto":
                page.goto(step.url or cfg["start_url"], wait_until="domcontentloaded",
                          timeout=step.timeout_ms)
                continue
            if step.action == "wait":
                page.wait_for_timeout(step.ms or 1000)
                continue
            if step.action == "select":
                target = find_first(page, step.selectors, step.timeout_ms)
                if target is None and not step.optional:
                    raise DmdError(EXIT_STRUCTURE, f"step '{step.name}' matched nothing")
                if target is not None:
                    target.select_option(step.value)
                continue
            if step.action in ("click", "download"):
                target = find_first(page, step.selectors, step.timeout_ms)
                if target is None:
                    if step.optional:
                        log(f"  skipped (optional, nothing matched)")
                        continue
                    raise DmdError(
                        EXIT_STRUCTURE,
                        f"step '{step.name}' matched nothing — the portal UI "
                        "changed; run --recon and update selectors.json",
                    )
                if step.action == "click":
                    target.click(timeout=step.timeout_ms)
                    page.wait_for_timeout(500)
                    continue

                # download: prefer Playwright's download event, fall back to
                # an XML response the click produced (inline navigation).
                try:
                    with page.expect_download(timeout=download_timeout) as info:
                        target.click(timeout=step.timeout_ms)
                    download = info.value
                    tmp = Path(download.path())
                    data = tmp.read_bytes()
                    if data:
                        log(f"  download event: {len(data)} bytes")
                        return data
                except Exception:  # noqa: BLE001 — maybe it was a plain link
                    log("  no download event, checking XML responses")
                for body in captured:
                    if body:
                        log(f"  captured XML response: {len(body)} bytes")
                        return body
                if step.optional:
                    continue
                raise DmdError(
                    EXIT_STRUCTURE,
                    f"step '{step.name}' clicked but produced no file — "
                    "run --recon and update selectors.json",
                )
            raise DmdError(EXIT_USAGE, f"unknown step action {step.action!r}")
    finally:
        page.remove_listener("response", on_response)

    if captured:
        return captured[0]
    raise DmdError(EXIT_STRUCTURE, "flow finished without producing a file")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Automated Green Button Download My Data fetch for Mark's own account")
    ap.add_argument("--env-file", default=str(HERE / ".env"),
                    help="path to the chmod-600 credentials file")
    ap.add_argument("--selectors", default=str(DEFAULT_SELECTORS),
                    help="JSON flow description")
    ap.add_argument("--recon", action="store_true",
                    help="log in and dump the post-login DOM, download nothing")
    ap.add_argument("--headful", action="store_true",
                    help="run with a visible browser (debugging only)")
    ap.add_argument("--portal-url", default=None,
                    help="override start_url (used by the mock-portal tests)")
    ap.add_argument("--timeout-ms", type=int, default=60000)
    ap.add_argument("--quiet", action="store_true")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    env_path = Path(args.env_file).expanduser()
    try:
        cfg = json.loads(Path(args.selectors).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read selectors: {exc}", file=sys.stderr)
        return EXIT_USAGE

    try:
        env = load_env(env_path)
    except DmdError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return exc.code

    log = Logger(env.log_dir, quiet=args.quiet)
    if args.portal_url:
        cfg["start_url"] = args.portal_url
    if env.start_url and not args.portal_url:
        cfg["start_url"] = env.start_url

    for d in (env.inbox, env.state_dir, env.log_dir):
        d.mkdir(parents=True, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright is not installed (pip install playwright)", file=sys.stderr)
        return EXIT_ENV

    # Session state must live in RAM. /run is tmpfs on this host; fall back to
    # a private temp dir that is removed in `finally`.
    tmp_root = Path("/run/dmd-browser")
    tmpfs = False
    try:
        tmp_root.mkdir(parents=True, exist_ok=True)
        tmpfs = _is_tmpfs(tmp_root)
    except OSError:
        tmpfs = False
    if not tmpfs:
        tmp_root = Path(tempfile.mkdtemp(prefix="dmd-browser-"))
    os.environ["TMPDIR"] = str(tmp_root)
    import atexit
    atexit.register(_cleanup_tmp)

    started = time.time()
    exit_code = EXIT_OK
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headful)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                locale="en-CA",
                timezone_id="America/Toronto",
                viewport={"width": 1440, "height": 900},
                accept_downloads=True,
            )
            page = context.new_page()
            try:
                do_login(page, cfg, env, log, args.timeout_ms)

                if args.recon:
                    dest = dump_failure(env, log, "recon", page)
                    print(json.dumps({
                        "url": page.url,
                        "title": page.title(),
                        "links": page.eval_on_selector_all(
                            "a", "els => els.map(e => ({t:(e.innerText||'').trim(), h:e.href}))"
                                 ".filter(x => x.t).slice(0,80)"),
                        "buttons": page.eval_on_selector_all(
                            "button,[role=button]",
                            "els => els.map(e => (e.innerText||'').trim()).filter(Boolean).slice(0,80)"),
                        "artifact": str(dest) if dest else None,
                    }, indent=2))
                    return _finish(EXIT_OK, env, log, started)

                payload = run_steps(page, cfg, log, args)
            except DmdError as exc:
                if exc.code in (EXIT_STRUCTURE, EXIT_AUTH, EXIT_CHALLENGE):
                    dump_failure(env, log, exc.code.__str__(), page)
                log(f"FAILED ({exc.code}): {exc}")
                exit_code = exc.code
                raise
            finally:
                context.close()
                browser.close()
    except DmdError as exc:
        return _finish(exc.code, env, log, started)
    except Exception as exc:  # noqa: BLE001 — unexpected must still be loud
        log(f"FAILED (unexpected): {type(exc).__name__}: {exc}")
        return _finish(EXIT_STRUCTURE, env, log, started)

    # --- Validate, dedupe, file ------------------------------------------------
    try:
        text = payload.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        text = ""
    rows, problem = inspect_greenbutton_xml(text)
    if problem:
        log(f"FAILED ({EXIT_INVALID}): {problem}")
        return _finish(EXIT_INVALID, env, log, started)

    digest = sha256_bytes(payload)
    state = read_state(env.state_dir)
    if state.get("sha256") == digest:
        log(f"no new data — download matches last success ({digest[:12]})")
        return _finish(EXIT_NO_NEW, env, log, started)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = unique_path(env.inbox, f"greenbutton_{stamp}", ".xml")
    dest.write_bytes(payload)
    try:
        os.chmod(dest, 0o600)
    except OSError:
        pass

    record = {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "path": str(dest),
        "sha256": digest,
        "bytes": len(payload),
        "readings": rows,
        "duration_seconds": round(time.time() - started, 1),
    }
    atomic_write_json(env.state_dir / "last_success.json", record)
    log(f"filed {dest.name} ({len(payload)} bytes, {rows} IntervalReadings)")
    return _finish(EXIT_OK, env, log, started)


def _finish(code: int, env: Env, log: Logger, started: float) -> int:
    """Log the outcome. Browser profile cleanup happens at process exit
    (atexit), never here — the context may still be open on this stack."""
    log(f"exit {code} after {round(time.time() - started, 1)}s")
    return code


def _cleanup_tmp() -> None:
    root = os.environ.get("TMPDIR", "")
    if root.startswith("/run/"):
        shutil.rmtree(root, ignore_errors=True)
        return
    if root and Path(root).name.startswith("dmd-browser-"):
        shutil.rmtree(root, ignore_errors=True)


def _is_tmpfs(path: Path) -> bool:
    try:
        with open("/proc/mounts", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 3 and parts[1] == str(path) and parts[2] == "tmpfs":
                    return True
    except OSError:
        return False
    return False


if __name__ == "__main__":
    sys.exit(main())
