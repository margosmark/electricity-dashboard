"""Tests for the missing-XML recovery screen and the bundled sample-data path.

AppTest drives ``app.py`` end to end in a working directory that provably has no
``electricit2024-now.xml``, so the recovery branch is the one under test.
"""

import os

import pytest
from streamlit.testing.v1 import AppTest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_PATH = os.path.join(REPO_ROOT, "app.py")

SAMPLE_BUTTON = "use bundled sample data"


def _app_text(at):
    """Flatten every rendered string the user could read, including buttons."""
    parts = []
    for kind in (
        "title", "markdown", "info", "warning", "error", "success",
        "button", "caption", "header", "subheader", "text", "code",
    ):
        for element in getattr(at, kind, []):
            for attr in ("value", "label"):
                value = getattr(element, attr, None)
                if isinstance(value, str):
                    parts.append(value)
    return "\n".join(parts)


def _run_app(tmp_path, monkeypatch):
    # chdir guarantees the relative electricit2024-now.xml lookup misses,
    # regardless of where the developer happens to run pytest from.
    monkeypatch.chdir(tmp_path)
    at = AppTest.from_file(APP_PATH, default_timeout=60)
    at.run()
    return at


def _sample_button(at):
    return [b for b in at.button if SAMPLE_BUTTON in b.label.lower()]


def test_missing_xml_renders_friendly_recovery_copy(tmp_path, monkeypatch):
    at = _run_app(tmp_path, monkeypatch)

    assert not at.exception, "recovery path must not raise"
    text = _app_text(at)

    # names the file it wants
    assert "electricit2024-now.xml" in text
    # says where to get it
    assert "Oakville Hydro" in text
    assert "Green Button" in text
    # explains why it is not in git
    assert ".gitignore" in text
    assert "PII" in text
    # offers the escape hatch
    assert _sample_button(at), "recovery screen must offer bundled sample data"
    assert "sample" in text.lower()

    # the old dead-end red box is gone
    assert "Error loading data" not in text
    assert not at.error


def test_sample_button_populates_charts_without_real_xml(tmp_path, monkeypatch):
    at = _run_app(tmp_path, monkeypatch)
    assert _sample_button(at)
    assert not at.metric  # nothing rendered before data exists

    _sample_button(at)[0].click()
    at.run()

    assert not at.exception, "sample-data path must render end to end"
    assert at.session_state["use_sample_data"] is True
    assert len(at.metric) == 4  # Total Usage / Cost / Avg Daily / Vampire Draw
    assert len(at.get("plotly_chart")) >= 5
    assert len(at.tabs) == 3
    assert not _sample_button(at), "recovery screen is replaced once data loads"
    # sample-mode banner + way back to the real file
    assert "Bundled sample data in use" in _app_text(at)
    assert any("my real file" in b.label.lower() for b in at.button)


def test_sample_dataframe_parses_and_carries_dashboard_columns(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    from sample_data import load_sample_dataframe

    df = load_sample_dataframe()

    assert len(df) == 120
    assert df["date"].nunique() == 5  # feeds the daily chart / top-5 table
    assert df["is_weekend"].any() and (~df["is_weekend"]).any()  # weekend vs weekday
    assert set(df["hour"].unique()) == set(range(24))  # hourly-average chart
    for column in ("datetime", "usage_kwh", "year", "month", "day",
                   "day_of_week", "is_weekend", "date", "hour"):
        assert column in df.columns
    assert df["datetime"].dt.tz is not None


def test_recovery_copy_is_pure_and_complete():
    from recovery import EXPECTED_XML_FILENAME, recovery_copy

    copy = recovery_copy()
    assert EXPECTED_XML_FILENAME in copy["missing_file"]
    assert "Oakville Hydro" in copy["how_to_get"]
    assert "Green Button" in copy["how_to_get"]
    assert ".gitignore" in copy["why_not_in_git"]
    assert "PII" in copy["why_not_in_git"]
    assert "sample" in copy["demo_offer"].lower()
    assert copy["technical"] == ""

    boom = FileNotFoundError(2, "No such file or directory")
    assert "FileNotFoundError" in recovery_copy(boom)["technical"]
