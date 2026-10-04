#!/usr/bin/env python3
"""Weekly OEB rate-staleness check for the electricity-dashboard.

Installed as a Hermes cron job (no_agent): stdout is delivered verbatim to
Mark's chat; EMPTY stdout sends nothing, so a quiet week = rates verified
current. Three outcomes:

  * OEB page carries an effectiveDate NEWER than the deployed /api/rates
    -> bullet report with per-period deltas and the update instructions.
  * Everything matches -> no output at all (watchdog pattern).
  * Fetch/parse failure -> one-line warning, because a silently broken
    checker is worse than a noisy one.

Mirrors webapp/src/lib/oebRates.ts (same regexes, same table classification)
and is pinned to webapp/src/lib/oebRates.fixture.html by tests/test_oeb_staleness.py.

Usage:
  python3 check_oeb_staleness.py                 # live check (cron)
  python3 check_oeb_staleness.py --html FILE     # parse a local page instead
  python3 check_oeb_staleness.py --rates FILE    # use a local /api/rates JSON
"""

import json
import re
import sys
import urllib.request

OEB_URL = (
    "https://www.oeb.ca/consumer-information-and-protection/electricity-rates"
)
RATES_URL = "https://electricity.markarslan.ca/api/rates"

MONTH_TO_NUM = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05", "june": "06", "july": "07", "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
}


def fetch(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(
        url,
        headers={
            # The OEB serves the page to plain urllib; no UA blocking found
            # (probed 2026-10-02), but identify ourselves anyway.
            "User-Agent": "Mozilla/5.0 (compatible; staleness-check/1.0)",
            "Accept": "text/html,application/json,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def strip_tags(html: str) -> str:
    text = re.sub(r"<[^>]*>", " ", html)
    text = re.sub(r"&nbsp;|&#160;|\u00a0", " ", text, flags=re.I)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&#39;", "'").replace("&apos;", "'").replace("&quot;", '"')
    return re.sub(r"\s+", " ", text).strip()


def row_cells(row_html: str):
    return [
        strip_tags(m.group(1))
        for m in re.finditer(r"<t[dh][^>]*>(.*?)</t[dh]>", row_html, re.I | re.S)
    ]


def first_number(cell: str):
    m = re.search(r"-?\d+(?:,\d{3})*(?:\.\d+)?", cell.replace("\u00a0", " "))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def month_date_to_iso(text: str):
    m = re.match(r"^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$", text.strip())
    if not m:
        return None
    mm = MONTH_TO_NUM.get(m.group(1).lower())
    if not mm:
        return None
    return f"{m.group(3)}-{mm}-{m.group(2).zfill(2)}"


def price_for(cells, label_pattern, what, missing):
    if not cells:
        return None
    if not re.match(label_pattern, cells[0], re.I):
        return None
    n = first_number(cells[-1]) if cells else None
    if n is None:
        missing.append(what)
        return None
    return n


def parse_oeb_page(html: str):
    """Equivalent of parseOebRatesPage(): (iso_date|None, rates|None, missing)."""
    missing = []

    date_match = re.search(
        r"prices set by the OEB for\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})", html, re.I
    )
    effective_date = month_date_to_iso(date_match.group(1)) if date_match else None
    if not effective_date:
        missing.append("effectiveDate")

    tou, ulo, tiered = {}, {}, {}
    for table in re.findall(r"<table.*?</table>", html, re.I | re.S):
        rows = re.findall(r"<tr.*?</tr>", table, re.I | re.S)
        if not rows:
            continue
        header = strip_tags(rows[0])

        if re.search(r"TOU Price Periods", header, re.I):
            for row in rows[1:]:
                c = row_cells(row)
                if len(c) < 2:
                    continue
                v = price_for(c, r"^Off-Peak", "tou.offPeak", missing)
                if v is not None:
                    tou["offPeak"] = v
                v = price_for(c, r"^Mid-Peak", "tou.midPeak", missing)
                if v is not None:
                    tou["midPeak"] = v
                v = price_for(c, r"^On-Peak", "tou.onPeak", missing)
                if v is not None:
                    tou["onPeak"] = v
        elif re.search(r"ULO Price Periods", header, re.I):
            for row in rows[1:]:
                c = row_cells(row)
                if len(c) < 2:
                    continue
                v = price_for(c, r"^Ultra-Low Overnight", "ulo.overnight", missing)
                if v is not None:
                    ulo["overnight"] = v
                v = price_for(c, r"^Weekend Off-Peak", "ulo.weekendOffPeak", missing)
                if v is not None:
                    ulo["weekendOffPeak"] = v
                v = price_for(c, r"^Mid-Peak", "ulo.midPeak", missing)
                if v is not None:
                    ulo["midPeak"] = v
                v = price_for(c, r"^On-Peak", "ulo.onPeak", missing)
                if v is not None:
                    ulo["onPeak"] = v
        elif re.search(r"Tier Thresholds", header, re.I):
            for row in rows[1:]:
                c = row_cells(row)
                if len(c) < 2:
                    continue
                if re.match(r"^Tier 1", c[0], re.I):
                    v = first_number(c[-1])
                    if v is None:
                        missing.append("tiered.tier1")
                    else:
                        tiered["tier1"] = v
                    winter = re.search(r"first\s+([\d,]+(?:\.\d+)?)\s*kWh", c[1], re.I)
                    if winter:
                        tiered["thresholdWinter"] = float(winter.group(1).replace(",", ""))
                    else:
                        missing.append("tiered.thresholdWinter")
                    summer = re.search(
                        r"first\s+([\d,]+(?:\.\d+)?)\s*kWh",
                        c[2] if len(c) > 2 else "",
                        re.I,
                    )
                    if summer:
                        tiered["thresholdSummer"] = float(summer.group(1).replace(",", ""))
                    else:
                        missing.append("tiered.thresholdSummer")
                elif re.match(r"^Tier 2", c[0], re.I):
                    v = first_number(c[-1])
                    if v is None:
                        missing.append("tiered.tier2")
                    else:
                        tiered["tier2"] = v

    required = [
        ("tou.offPeak", "offPeak" in tou), ("tou.midPeak", "midPeak" in tou),
        ("tou.onPeak", "onPeak" in tou),
        ("ulo.overnight", "overnight" in ulo),
        ("ulo.weekendOffPeak", "weekendOffPeak" in ulo),
        ("ulo.midPeak", "midPeak" in ulo), ("ulo.onPeak", "onPeak" in ulo),
        ("tiered.tier1", "tier1" in tiered), ("tiered.tier2", "tier2" in tiered),
        ("tiered.thresholdWinter", "thresholdWinter" in tiered),
        ("tiered.thresholdSummer", "thresholdSummer" in tiered),
    ]
    for name, ok in required:
        if not ok and name not in missing:
            missing.append(name)

    complete = all(ok for _, ok in required) and effective_date is not None
    rates = None
    if complete:
        rates = {
            "effectiveDate": effective_date,
            "tou": {k: tou[k] for k in ("offPeak", "midPeak", "onPeak")},
            "ulo": {k: ulo[k] for k in ("overnight", "weekendOffPeak", "midPeak", "onPeak")},
            "tiered": {k: tiered[k] for k in (
                "tier1", "tier2", "thresholdWinter", "thresholdSummer",
            )},
        }
    else:
        if not date_match:
            missing.append("dateSentence")
    return effective_date, rates, missing


def max_shipped(rates_json: dict):
    dates = [
        r.get("effectiveDate")
        for r in rates_json.get("historicalRates", [])
        if r.get("effectiveDate")
    ]
    return max(dates) if dates else None


def fmt(n) -> str:
    """10.5 -> '10.5' (trailing .0 trimmed), like JS template numbers."""
    if n is None:
        return "?"
    if float(n) == int(float(n)):
        return str(int(float(n)))
    return f"{float(n):g}"


def deltas(current: dict, new: dict):
    """Per-period deltas, only changed periods (mirror of summarizeRateChange)."""
    pairs = [
        ("TOU Off-Peak", current["tou"]["offPeak"], new["tou"]["offPeak"]),
        ("TOU Mid-Peak", current["tou"]["midPeak"], new["tou"]["midPeak"]),
        ("TOU On-Peak", current["tou"]["onPeak"], new["tou"]["onPeak"]),
        ("ULO Overnight", current["ulo"]["overnight"], new["ulo"]["overnight"]),
        ("ULO Weekend Off-Peak", current["ulo"]["weekendOffPeak"], new["ulo"]["weekendOffPeak"]),
        ("ULO Mid-Peak", current["ulo"]["midPeak"], new["ulo"]["midPeak"]),
        ("ULO On-Peak", current["ulo"]["onPeak"], new["ulo"]["onPeak"]),
        ("Tier 1", current["tiered"]["tier1"], new["tiered"]["tier1"]),
        ("Tier 2", current["tiered"]["tier2"], new["tiered"]["tier2"]),
        ("Winter threshold", current["tiered"]["thresholdWinter"], new["tiered"]["thresholdWinter"]),
        ("Summer threshold", current["tiered"]["thresholdSummer"], new["tiered"]["thresholdSummer"]),
    ]
    return [(label, a, b) for label, a, b in pairs if a != b]


def build_report(oeb_date, new_rates, shipped_max, shipped_set, missing):
    lines = [
        "⚡ *Ontario electricity rates changed*",
        "",
        f"• OEB publishes effective *{oeb_date}* — deployed /api/rates ships *{shipped_max}*",
    ]
    if new_rates and shipped_set:
        changed = deltas(shipped_set, new_rates)
        if changed:
            lines.append("• Changed periods (¢/kWh):")
            for label, a, b in changed:
                lines.append(f"    – {label}: {fmt(a)} → {fmt(b)}")
        else:
            lines.append("• No price changes — effective date bump only")
    else:
        lines.append(f"• Price tables incomplete (missing: {', '.join(missing)}) — verify the page manually")
    lines += [
        "• Update: append a RateSet with this effectiveDate to",
        "    webapp/src/app/api/rates/route.ts and bump RATES_LAST_CHECKED",
        f"• Source: {OEB_URL}",
    ]
    return "\n".join(lines)


def main(argv) -> int:
    html_path = None
    rates_path = None
    args = list(argv[1:])
    while args:
        flag = args.pop(0)
        if flag == "--html" and args:
            html_path = args.pop(0)
        elif flag == "--rates" and args:
            rates_path = args.pop(0)
        else:
            print(f"⚠️ OEB staleness check: bad arguments {flag!r}", file=sys.stdout)
            return 1

    try:
        html = open(html_path, encoding="utf-8").read() if html_path else fetch(OEB_URL)
    except Exception as exc:  # noqa: BLE001 — any network/IO failure is reportable
        print(f"⚠️ OEB staleness check failed: cannot fetch OEB page ({exc})")
        return 1

    oeb_date, new_rates, missing = parse_oeb_page(html)
    if not oeb_date:
        print(
            "⚠️ OEB staleness check failed: effectiveDate not found in page "
            f"(missing: {', '.join(missing)}) — OEB markup may have changed"
        )
        return 1

    try:
        raw = open(rates_path, encoding="utf-8").read() if rates_path else fetch(RATES_URL)
        rates_json = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ OEB staleness check failed: cannot fetch deployed /api/rates ({exc})")
        return 1

    shipped_max = max_shipped(rates_json)
    if not shipped_max:
        print("⚠️ OEB staleness check failed: deployed /api/rates has no historicalRates")
        return 1

    if oeb_date <= shipped_max:
        return 0  # current — silence is the signal

    history = rates_json.get("historicalRates", [])
    shipped_set = next(
        (r for r in history if r.get("effectiveDate") == shipped_max), history[-1] if history else None
    )
    print(build_report(oeb_date, new_rates, shipped_max, shipped_set, missing))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
