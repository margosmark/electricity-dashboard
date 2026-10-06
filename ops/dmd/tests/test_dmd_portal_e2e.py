"""End-to-end test of dmd_refresh against the local mock portal.

This is what proves the automation mechanics — login, step engine, download
capture, non-destructive filing, dedupe and every failure exit code — without
ever touching Oakville Hydro or needing real credentials.

Needs Playwright + its chromium (present on .110; skipped elsewhere):

    python3 -m pytest ops/dmd/tests -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
DMD = HERE.parent / "dmd_refresh.py"
FIXTURE = HERE / "fixtures" / "greenbutton_synthetic.xml"

if importlib.util.find_spec("playwright") is None:
    pytest.skip("playwright not installed", allow_module_level=True)

sys.path.insert(0, str(HERE))
import mock_portal  # noqa: E402

MOCK_USER = os.environ.get("MOCK_USER", "owner@example.com")
MOCK_PASS = os.environ.get("MOCK_PASS", "correct-horse-battery")


@pytest.fixture(scope="module")
def portal():
    server = mock_portal.serve(0)
    port = server.server_address[1]
    yield f"http://127.0.0.1:{port}/"
    server.shutdown()


def make_env_file(tmp_path: Path, user: str = MOCK_USER, password: str = MOCK_PASS,
                  mode: int = 0o600) -> Path:
    env = tmp_path / ".env"
    env.write_text(
        f"DMD_USERNAME={user}\n"
        f"DMD_PASSWORD={password}\n"
        f"DMD_INBOX={tmp_path / 'inbox'}\n"
        f"DMD_STATE_DIR={tmp_path / 'state'}\n"
        f"DMD_LOG_DIR={tmp_path / 'logs'}\n"
        f"DMD_FAIL_DIR={tmp_path / 'failed'}\n"
    )
    os.chmod(env, mode)
    return env


def run_refresh(env_file: Path, portal_url: str, *extra: str) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(DMD), "--env-file", str(env_file),
         "--portal-url", portal_url, "--quiet", *extra],
        capture_output=True, text=True, timeout=300,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_first_run_files_the_download(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "ok"
    env_file = make_env_file(tmp_path)
    code, out = run_refresh(env_file, portal)

    assert code == 0, out
    inbox = tmp_path / "inbox"
    files = sorted(inbox.glob("*.xml"))
    assert len(files) == 1, out
    assert files[0].read_bytes() == FIXTURE.read_bytes()
    # Non-destructive permissions: the export is Mark's own data.
    assert oct(files[0].stat().st_mode & 0o777) == "0o600"

    state = json.loads((tmp_path / "state" / "last_success.json").read_text())
    assert state["sha256"]
    assert state["readings"] == 4
    assert state["path"].endswith(".xml")


def test_second_identical_run_reports_no_new_data(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "ok"
    env_file = make_env_file(tmp_path)
    first, _ = run_refresh(env_file, portal)
    second, out = run_refresh(env_file, portal)

    assert first == 0, out
    assert second == 4, out
    # Still exactly one file: the duplicate was never written.
    assert len(list((tmp_path / "inbox").glob("*.xml"))) == 1
    # And it was logged, so a stale-data alarm can be explained later.
    log = (tmp_path / "logs" / "dmd_refresh.log").read_text()
    assert "no new data" in log


def test_rejected_credentials_exit_3(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "ok"
    env_file = make_env_file(tmp_path, password="wrong-password")
    code, out = run_refresh(env_file, portal)
    assert code == 3, out
    assert not list((tmp_path / "inbox").glob("*.xml"))
    # The refusal must not echo the credential that failed.
    assert "wrong-password" not in out


def test_captcha_aborts_with_exit_5(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "captcha"
    env_file = make_env_file(tmp_path)
    code, out = run_refresh(env_file, portal)
    assert code == 5, out
    assert "CAPTCHA" in out
    # Nothing is downloaded and a post-login artifact is filed for review.
    assert not list((tmp_path / "inbox").glob("*.xml"))


def test_mfa_aborts_with_exit_5(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "mfa"
    env_file = make_env_file(tmp_path)
    code, out = run_refresh(env_file, portal)
    assert code == 5, out
    assert "multi-factor" in out


def test_missing_entry_point_exits_6_with_artifacts(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "structure"
    env_file = make_env_file(tmp_path)
    code, out = run_refresh(env_file, portal)
    assert code == 6, out
    assert "selectors.json" in out
    dumps = list((tmp_path / "failed").glob("*"))
    assert dumps, "a structure failure must leave a DOM dump to repair from"
    assert (dumps[0] / "page.html").exists()


def test_unimportable_payload_exits_7(tmp_path, portal):
    """A 200 that is HTML rather than Green Button XML must not be filed."""
    os.environ["MOCK_SCENARIO"] = "htmlpayload"
    env_file = make_env_file(tmp_path)
    code, out = run_refresh(env_file, portal)
    assert code == 7, out
    assert not list((tmp_path / "inbox").glob("*.xml"))


def test_world_readable_env_exits_8_before_any_browser(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "ok"
    env_file = make_env_file(tmp_path, mode=0o644)
    code, out = run_refresh(env_file, portal)
    assert code == 8, out
    assert "chmod 600" in out


def test_credentials_never_reach_the_log_or_state(tmp_path, portal):
    os.environ["MOCK_SCENARIO"] = "ok"
    env_file = make_env_file(tmp_path)
    run_refresh(env_file, portal)

    for path in list((tmp_path / "logs").glob("**/*")) + \
            list((tmp_path / "state").glob("**/*")) + \
            list((tmp_path / "inbox").glob("**/*")):
        if path.is_file():
            assert MOCK_PASS not in path.read_text(errors="ignore"), path
            assert MOCK_USER not in path.read_text(errors="ignore"), path

    os.environ["MOCK_SCENARIO"] = "ok"
