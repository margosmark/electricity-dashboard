"""Pinned tests for the weekly OEB staleness cron script.

Uses webapp/src/lib/oebRates.fixture.html — the same extracted live-page
fixture the TypeScript parser is pinned to — so both sides parse identical
markup. Offline by design: no network in tests.
"""

import json
import os
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "scripts"))

from check_oeb_staleness import (  # noqa: E402
    parse_oeb_page,
    max_shipped,
    deltas,
    build_report,
    month_date_to_iso,
    main,
)

FIXTURE = os.path.join(REPO, "webapp", "src", "lib", "oebRates.fixture.html")


@pytest.fixture(scope="module")
def fixture_html():
    with open(FIXTURE, encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def parsed(fixture_html):
    return parse_oeb_page(fixture_html)


def test_fixture_parses_clean(parsed):
    date, rates, missing = parsed
    assert date == "2025-11-01"
    assert missing == []
    assert rates is not None


def test_fixture_rate_values_match_shipped(parsed):
    _, rates, _ = parsed
    assert rates["tou"] == {"offPeak": 9.8, "midPeak": 15.7, "onPeak": 20.3}
    assert rates["ulo"] == {
        "overnight": 3.9, "weekendOffPeak": 9.8, "midPeak": 15.7, "onPeak": 39.1,
    }
    assert rates["tiered"]["tier1"] == 12.0
    assert rates["tiered"]["tier2"] == 14.2
    assert rates["tiered"]["thresholdWinter"] == 1000
    assert rates["tiered"]["thresholdSummer"] == 600


def test_month_date_to_iso():
    assert month_date_to_iso("November 1, 2025") == "2025-11-01"
    assert month_date_to_iso("Dec 31, 2024") is None  # month must be full name
    assert month_date_to_iso("garbage") is None


def test_max_shipped():
    data = {"historicalRates": [{"effectiveDate": "2023-11-01"}, {"effectiveDate": "2025-11-01"}]}
    assert max_shipped(data) == "2025-11-01"
    assert max_shipped({}) is None


def test_deltas_only_changed_periods(parsed):
    _, rates, _ = parsed
    bumped = json.loads(json.dumps(rates))
    bumped["tou"]["onPeak"] = 22.5
    changed = deltas(rates, bumped)
    assert changed == [("TOU On-Peak", 20.3, 22.5)]


def test_build_report_contains_action_and_source(parsed):
    _, rates, _ = parsed
    new = json.loads(json.dumps(rates))
    new["effectiveDate"] = "2026-11-01"
    new["tou"]["onPeak"] = 22.5
    report = build_report("2026-11-01", new, "2025-11-01", rates, [])
    assert "*Ontario electricity rates changed*" in report
    assert "2026-11-01" in report and "2025-11-01" in report
    assert "TOU On-Peak: 20.3 → 22.5" in report
    assert "webapp/src/app/api/rates/route.ts" in report
    assert "oeb.ca" in report


def test_main_silent_when_current(parsed, tmp_path, capsys):
    """Fixture == shipped (both 2025-11-01) → no output at all."""
    _, rates, _ = parsed
    html_file = tmp_path / "page.html"
    html_file.write_text(open(FIXTURE, encoding="utf-8").read(), encoding="utf-8")
    rates_file = tmp_path / "rates.json"
    rates_file.write_text(json.dumps({"historicalRates": [rates]}), encoding="utf-8")

    rc = main(["prog", "--html", str(html_file), "--rates", str(rates_file)])
    assert rc == 0
    assert capsys.readouterr().out == ""


def test_main_reports_when_shipped_is_older(parsed, tmp_path, capsys):
    _, rates, _ = parsed
    html_file = tmp_path / "page.html"
    html_file.write_text(open(FIXTURE, encoding="utf-8").read(), encoding="utf-8")
    older = json.loads(json.dumps(rates))
    older["effectiveDate"] = "2024-11-01"
    rates_file = tmp_path / "rates.json"
    rates_file.write_text(json.dumps({"historicalRates": [older]}), encoding="utf-8")

    rc = main(["prog", "--html", str(html_file), "--rates", str(rates_file)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Ontario electricity rates changed" in out
    assert "No price changes" in out  # same values, only the date differs


def test_main_warns_on_unparseable_page(tmp_path, capsys):
    html_file = tmp_path / "broken.html"
    html_file.write_text("<html><body>maintenance</body></html>", encoding="utf-8")
    rates_file = tmp_path / "rates.json"
    rates_file.write_text(json.dumps({"historicalRates": [{"effectiveDate": "2025-11-01"}]}))

    rc = main(["prog", "--html", str(html_file), "--rates", str(rates_file)])
    assert rc == 1
    out = capsys.readouterr().out
    assert out.startswith("⚠️ OEB staleness check failed: effectiveDate not found")
    assert "markup may have changed" in out
