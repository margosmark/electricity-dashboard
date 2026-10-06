"""Unit tests for dmd_refresh's pure helpers (no browser, no network).

Run from the repo root:  python3 -m pytest ops/dmd/tests -v
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dmd_refresh as dr  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "greenbutton_synthetic.xml"


# --------------------------------------------------------------------------
# .env parsing + the credential-hygiene gate
# --------------------------------------------------------------------------

def test_parse_env_file_ignores_comments_and_quotes(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        '# credentials\n'
        'DMD_USERNAME=owner@example.com\n'
        'DMD_PASSWORD="with spaces and = signs"\n'
        '\n'
        'DMD_START_URL=https://example.test/\n'
        'NOT_AN_ASSIGNMENT\n'
    )
    values = dr.parse_env_file(env)
    assert values["DMD_USERNAME"] == "owner@example.com"
    assert values["DMD_PASSWORD"] == "with spaces and = signs"
    assert values["DMD_START_URL"] == "https://example.test/"
    assert "NOT_AN_ASSIGNMENT" not in values


def test_env_file_world_readable_is_refused(tmp_path):
    env = tmp_path / ".env"
    env.write_text("DMD_USERNAME=a\nDMD_PASSWORD=b\n")
    os.chmod(env, 0o644)
    with pytest.raises(dr.DmdError) as exc:
        dr.assert_env_is_private(env)
    assert exc.value.code == dr.EXIT_ENV
    # The refusal must name the fix, not leak the values.
    assert "chmod 600" in str(exc.value)
    assert "with spaces" not in str(exc.value)


def test_env_file_0600_is_accepted(tmp_path):
    env = tmp_path / ".env"
    env.write_text("DMD_USERNAME=a\nDMD_PASSWORD=b\n")
    os.chmod(env, 0o600)
    dr.assert_env_is_private(env)  # no raise


def test_missing_env_file_is_exit_env(tmp_path):
    with pytest.raises(dr.DmdError) as exc:
        dr.assert_env_is_private(tmp_path / ".env")
    assert exc.value.code == dr.EXIT_ENV


def test_load_env_reports_missing_keys_without_printing_values(tmp_path):
    env = tmp_path / ".env"
    env.write_text("DMD_USERNAME=only-a-user\n")
    os.chmod(env, 0o600)
    with pytest.raises(dr.DmdError) as exc:
        dr.load_env(env)
    assert exc.value.code == dr.EXIT_ENV
    assert "DMD_PASSWORD" in str(exc.value)
    assert "only-a-user" not in str(exc.value)


def test_load_env_tracked_by_git_is_refused(tmp_path):
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    env = tmp_path / ".env"
    env.write_text("DMD_USERNAME=u\nDMD_PASSWORD=p\n")
    os.chmod(env, 0o600)
    subprocess.run(["git", "add", ".env"], cwd=tmp_path, check=True)
    with pytest.raises(dr.DmdError) as exc:
        dr.assert_env_is_private(env)
    assert exc.value.code == dr.EXIT_ENV
    assert "TRACKED" in str(exc.value)


# --------------------------------------------------------------------------
# Green Button payload gate
# --------------------------------------------------------------------------

def test_fixture_is_accepted_and_counted():
    rows, problem = dr.inspect_greenbutton_xml(FIXTURE.read_text(encoding="utf-8"))
    assert problem is None
    assert rows == 4


def test_namespaced_and_bare_documents_both_accepted():
    bare = "<feed><IntervalBlock><IntervalReading><v>1</v></IntervalReading></IntervalBlock></feed>"
    ns = "<feed><espi:IntervalBlock><espi:IntervalReading><v>1</v></espi:IntervalReading></espi:IntervalBlock></feed>"
    for doc in (bare, ns):
        rows, problem = dr.inspect_greenbutton_xml(doc)
        assert problem is None, doc
        assert rows == 1


def test_html_error_page_is_rejected():
    rows, problem = dr.inspect_greenbutton_xml("<html><body>Sign in failed</body></html>")
    assert rows == 0
    assert problem is not None


def test_unbalanced_xml_is_rejected():
    rows, problem = dr.inspect_greenbutton_xml(
        "<feed><IntervalReading><v>1</v></IntervalBlock></feed>"
    )
    assert rows == 0
    assert problem is not None and "unbalanced" in problem


def test_document_without_readings_is_rejected():
    rows, problem = dr.inspect_greenbutton_xml("<?xml version='1.0'?><feed><entry/></feed>")
    assert rows == 0
    assert problem is not None and "Interval" in problem


# --------------------------------------------------------------------------
# Non-destructive filing
# --------------------------------------------------------------------------

def test_unique_path_never_overwrites(tmp_path):
    first = dr.unique_path(tmp_path, "greenbutton_20261006T040000Z", ".xml")
    first.write_text("a")
    second = dr.unique_path(tmp_path, "greenbutton_20261006T040000Z", ".xml")
    second.write_text("b")
    third = dr.unique_path(tmp_path, "greenbutton_20261006T040000Z", ".xml")
    third.write_text("c")
    assert [p.name for p in sorted(tmp_path.iterdir())] == [
        "greenbutton_20261006T040000Z-1.xml",
        "greenbutton_20261006T040000Z-2.xml",
        "greenbutton_20261006T040000Z.xml",
    ]
    assert first.read_text() == "a"


def test_sha256_stable():
    assert dr.sha256_bytes(b"abc") == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


# --------------------------------------------------------------------------
# Step engine config
# --------------------------------------------------------------------------

def test_step_from_dict_defaults():
    step = dr.Step.from_dict({"action": "click", "selectors": ["text=Go"]})
    assert step.action == "click"
    assert step.optional is False
    assert step.timeout_ms == 15000
    assert step.name == "click"


def test_shipped_selectors_json_is_well_formed():
    import json

    cfg = json.loads((Path(dr.DEFAULT_SELECTORS)).read_text(encoding="utf-8"))
    assert cfg["login"]["password"], "login.password selectors are required"
    assert cfg["steps"], "the flow must have at least one step"
    assert cfg["steps"][-1]["action"] == "download"
    # The CAPTCHA list must only name CHALLENGES a human would see. An
    # invisible reCAPTCHA Enterprise token (Firebase App Check mints one on
    # the Oakville login page) is not a challenge, and a selector broad
    # enough to match it would abort every legitimate run with exit 5.
    for sel in cfg["captcha"]:
        assert (
            "iframe" in sel or sel.startswith("#challenge-form") or sel.startswith(".g-recaptcha")
            or "data-hcaptcha" in sel
        ), f"captcha selector {sel!r} is not an interactive challenge widget"


def test_env_defaults_live_under_electricity_data():
    env = dr.Env(username="u", password="p")
    assert str(env.inbox).endswith("electricity-data/inbox")
    assert str(env.state_dir).endswith("electricity-data/state")
    assert str(env.log_dir).endswith("electricity-data/logs")
