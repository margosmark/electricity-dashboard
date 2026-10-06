#!/usr/bin/env python3
"""Base64-encode the newest DMD export so the browser can ingest it.

The dashboard is client-only: there is no backend to POST to, and there must
never be one (that is the app's zero-backend invariant). So the handoff from
.110 to the browser is this CLI plus the app's `/import` page:

    1. `dmd_export_b64.py` reads the newest XML from ~/electricity-data/inbox
    2. it emits base64 (stdout or --out FILE)
    3. you paste that into https://electricity.markarslan.ca/import
       (or drop the XML file straight onto that page — it accepts both)
    4. `/import` parses it with the app's own parser, shows a merge review
       when readings already exist, and writes `localStorage.energy_data`
       through the same contract the upload modal uses.

No credentials are read here; this file never touches the portal.

Usage:
  python3 dmd_export_b64.py                 # human summary + next step
  python3 dmd_export_b64.py --b64           # base64 on stdout (pipe it)
  python3 dmd_export_b64.py --out data.b64  # base64 to a file
  python3 dmd_export_b64.py --file x.xml    # a specific export
  python3 dmd_export_b64.py --url           # ready-made /import?d= link
                                             # (only for small files)
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import sys
from pathlib import Path

INBOX = Path.home() / "electricity-data" / "inbox"
DEFAULT_APP = "https://electricity.markarslan.ca"
# Browsers and proxies stop trusting very long URLs somewhere around 2 MB and
# many cap far lower; pasting is the reliable path for a full-range export.
URL_SAFE_B64_CHARS = 100_000


def newest_xml(inbox: Path) -> Path | None:
    files = sorted(inbox.glob("*.xml"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Base64-encode the newest DMD export for the /import page")
    ap.add_argument("--file", default=None, help="specific XML file (default: newest in inbox)")
    ap.add_argument("--inbox", default=str(INBOX))
    ap.add_argument("--b64", action="store_true", help="print only the base64 payload")
    ap.add_argument("--out", default=None, help="write the base64 payload to this file")
    ap.add_argument("--url", action="store_true",
                    help="print an /import?d= link instead (small files only)")
    ap.add_argument("--app", default=DEFAULT_APP, help="deployed app origin")
    ap.add_argument("--json", action="store_true", help="machine-readable summary")
    args = ap.parse_args(argv)

    path = Path(args.file).expanduser() if args.file else newest_xml(Path(args.inbox))
    if path is None:
        print(f"no XML found in {args.inbox} — run dmd_refresh.py first", file=sys.stderr)
        return 2
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 2

    data = path.read_bytes()
    encoded = base64.b64encode(data).decode("ascii")

    if args.url:
        if len(encoded) > URL_SAFE_B64_CHARS:
            print(
                f"refusing --url: {len(encoded)} base64 chars is too long for a "
                "URL. Drop the XML file onto /import instead, or use --b64.",
                file=sys.stderr,
            )
            return 2
        print(f"{args.app.rstrip('/')}/import?d={encoded}")
        return 0

    if args.b64:
        print(encoded)
        return 0

    if args.out:
        out = Path(args.out).expanduser()
        out.write_text(encoded + "\n", encoding="utf-8")
        print(f"wrote {out} ({len(encoded)} base64 chars)")
        return 0

    if args.json:
        import json

        print(json.dumps({
            "file": str(path),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "b64_chars": len(encoded),
            "readings": data.lower().count(b"<intervalreading") + data.lower().count(b"<espi:intervalreading"),
            "import_url": f"{args.app.rstrip('/')}/import",
        }, indent=2))
        return 0

    # Default: a short human report. Printing megabytes of base64 unasked is
    # hostile in a terminal — that is what --b64 / --out are for.
    print(f"file      {path}")
    print(f"size      {len(data):,} bytes  (base64 {len(encoded):,} chars)")
    print(f"sha256    {hashlib.sha256(data).hexdigest()}")
    print()
    print("Ingest into the browser (client-only — no backend involved):")
    print(f"  A. open {args.app.rstrip('/')}/import and drop this file onto it")
    print(f"  B. or:  python3 {Path(__file__).name} --b64 | pbcopy   then paste at /import")
    print()
    print("/import shows a merge review before touching anything when readings "
          "already exist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
