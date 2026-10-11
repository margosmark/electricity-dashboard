"""Unit tests for dmd_export_b64's payload handling (no network, no browser).

The e2e that covers this script (webapp/tests/e2e/import.spec.ts) only runs in
the docker smoke path, so without these the script has no gate in the local
`pytest` run at all. They pin the three payload facts 93eee50 fixed:

  * --b64 round-trips byte-for-byte;
  * --url QUOTES the payload — raw base64 carries '+', which arrives at
    /import as a SPACE and silently corrupts the import (230 '+' in
    synthetic.xml; raw link => 0 rows, encoded link => 68 rows, measured);
  * --url refuses payloads over the 8000-char edge budget — the old 100_000
    guard printed links the deployed nginx answers with 414.

Run from the repo root:  python3 -m pytest ops/dmd/tests -v
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dmd_export_b64 as de  # noqa: E402


def _xml(tmp_path: Path, data: bytes) -> Path:
    path = tmp_path / "export.xml"
    path.write_bytes(data)
    return path


def test_b64_payload_round_trips(tmp_path: Path, capsys) -> None:
    data = bytes(range(256)) * 3  # every byte value, twice-over padding edges
    assert de.main(["--file", str(_xml(tmp_path, data)), "--b64"]) == 0
    out = capsys.readouterr().out.strip()
    assert base64.b64decode(out) == data


def test_url_payload_is_quoted_not_raw(tmp_path: Path, capsys) -> None:
    data = bytes(range(256)) * 3
    raw = base64.b64encode(data).decode()
    # The fixture must contain the poison: raw '+' in a query decodes to SPACE.
    assert "+" in raw and "/" in raw
    assert de.main(["--file", str(_xml(tmp_path, data)), "--url"]) == 0
    url = capsys.readouterr().out.strip()
    assert "?d=" in url
    query = url.split("?d=", 1)[1]
    # No base64 metacharacter survives unescaped …
    assert not ({"+", "/", "="} & set(query))
    # … and the link still decodes back to the exact payload.
    assert unquote(query) == raw


def test_url_refuses_payloads_over_the_edge_budget(tmp_path: Path, capsys) -> None:
    # 7000 ASCII bytes -> 9336 base64 chars -> >8000 quoted: over budget.
    path = _xml(tmp_path, b"A" * 7000)
    assert de.URL_SAFE_B64_CHARS == 8_000, "the 93eee50 budget, not the old 100_000"
    assert de.main(["--file", str(path), "--url"]) == 2
    err = capsys.readouterr().err
    assert "refusing --url" in err
    assert "8000-char URL budget" in err
