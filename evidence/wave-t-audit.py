#!/usr/bin/env python3
"""Wave T independent audit — a second parser over the raw export + live weather.

This is deliberately NOT the app's parser or its fetcher: Python's
ElementTree reads the Green Button XML directly, and the temperatures come
from Open-Meteo's own REST API over urllib — no fast-xml-parser, no app code.
wave-t-verify.cjs spawns this file and asserts the DOM against its output, so
a bug in either side shows up as a mismatch instead of as agreement.

WHAT IT REPRODUCES (and therefore what it can accuse the app of getting wrong):

  readings   the metered span and its length, from IntervalReading;
  hours      every reading bucketed to an absolute UTC hour and matched to
             the temperature Open-Meteo reports for that SAME hour — the
             alignment lib/openMeteo.ts uses, and the one that makes an EDT
             afternoon compare with an EDT afternoon;
  bands      the seven temperature bins: hours, kWh, mean kWh/h, share;
  bills      24 UsageSummary periods with their delivery/regulatory lines,
             classified by the NOTE the same way classifyBillLine does;
  fit        the least-squares delivery/regulatory split, its worst miss,
             and the verdict that miss earns at the 5% bar;
  anomalies  the newest N spike days (same day-of-week rule as
             detectAnomalies) with each day's mean/high/low and the verdict
             those temperatures imply.

Usage:  python3 evidence/wave-t-audit.py <export.xml> [window_start window_end]
Env:    OPEN_METEO_LAT/LON (defaults: the app's Toronto constants)
Prints: one JSON object (see AUDIT_KEYS at the bottom).
"""

import datetime
import json
import math
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import UTC, timedelta
from zoneinfo import ZoneInfo

TOR = ZoneInfo("America/Toronto")
LAT = float(__import__("os").environ.get("OPEN_METEO_LAT", "43.6532"))
LON = float(__import__("os").environ.get("OPEN_METEO_LON", "-79.3832"))

# lib/tempBands.ts — same seven bins, same half-open edges.
BANDS = [
    {"id": "lt-10", "label": "< -10"},
    {"id": "-10..5", "label": "-10 to 5"},
    {"id": "5..12", "label": "5 to 12"},
    {"id": "12..18", "label": "12 to 18"},
    {"id": "18..24", "label": "18 to 24"},
    {"id": "24..30", "label": "24 to 30"},
    {"id": "gt-30", "label": "over 30"},
]

# lib/energy.ts — the anomaly verdict thresholds.
AC_TEMP_C = 24
HEAT_TEMP_C = 0

# energy.ts CHARGE_FIT_MAX_RESIDUAL_SHARE
FIT_RESIDUAL_SHARE = 0.05

INFO_NOTE = re.compile(
    r"\busage\b|meter read|days in bill|loss factor|read date|due date|"
    r"post date|balance forward|amount due"
)


# JavaScript's Math.round: halves away from zero, unlike Python's round().
def js_round(value):
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def strip(tag):
    return tag.split("}")[-1]


def classify(note, amount):
    """classifyBillLine, ported — keyed off the note, never off itemKind."""
    n = note.lower()
    if INFO_NOTE.search(n):
        return "info"
    if re.search(r"^total\b|total electricity", n):
        return "total"
    if re.search(r"h\.?s\.?t\.?|g\.?s\.?t\.?|\btax\b", n):
        return "tax"
    if amount is not None and amount < 0:
        return "credit"
    if re.search(r"rebate|\bcredit\b", n):
        return "credit"
    if re.search(r"delivery|distribution", n):
        return "delivery"
    if re.search(r"regulatory", n):
        return "regulatory"
    if re.search(r"(off|mid|on)[ -]?peak|tiered|-peak|block|supply|commodity|energy charge", n):
        return "commodity"
    if amount is None or amount == 0:
        return "info"
    return "other"


def parse(path):
    root = ET.parse(path).getroot()

    starts = []
    for ir in root.iter():
        if strip(ir.tag) != "IntervalReading":
            continue
        for c in ir:
            if strip(c.tag) == "timePeriod":
                for x in c:
                    if strip(x.tag) == "start" and x.text and x.text.strip():
                        try:
                            starts.append(int(x.text.strip()))
                        except ValueError:
                            pass

    bills = []
    for s in (c for c in root.iter() if strip(c.tag) == "UsageSummary"):
        start = duration = None
        items = []
        for c in s.iter():
            t = strip(c.tag)
            if t == "billingPeriod" and start is None:
                for x in c:
                    if strip(x.tag) == "start" and x.text:
                        start = int(x.text)
                    if strip(x.tag) == "duration" and x.text:
                        duration = int(x.text)
            if t == "costAdditionalDetailLastPeriod":
                note = amount = None
                meas = None
                for x in c:
                    if strip(x.tag) == "note":
                        note = (x.text or "").strip()
                    elif strip(x.tag) == "amount":
                        amount = int(x.text or 0)
                    elif strip(x.tag) == "measurement":
                        meas = x
                if note is None:
                    continue
                items.append({"note": note, "amount": (amount or 0) / 100000.0, "meas": meas})
        if start is None:
            continue

        lines = {"delivery": 0.0, "regulatory": 0.0, "total": None}
        kwh_parts = {}
        for it in items:
            cls = classify(it["note"], it["amount"])
            if cls in ("delivery", "regulatory"):
                lines[cls] += it["amount"]
            elif cls == "total":
                lines["total"] = it["amount"]
            if it["meas"] is not None and "usage" in it["note"].lower():
                val = uom = None
                for x in it["meas"]:
                    if strip(x.tag) == "value" and x.text:
                        val = int(x.text)
                    if strip(x.tag) == "uom" and x.text:
                        uom = int(x.text)
                kwh_parts[it["note"]] = (val or 0) / 1e6 if uom == 72 else (val or 0) / 1e3
        kwh = sum(kwh_parts.values())
        if kwh <= 1:
            continue
        begin = datetime.datetime.fromtimestamp(start, UTC)
        bills.append(
            {
                "start": start,
                "date": begin.date().isoformat(),
                "end": (begin + timedelta(seconds=duration or 0)).date().isoformat(),
                "delivery": round(lines["delivery"], 2),
                "regulatory": round(lines["regulatory"], 2),
                "total": round(lines["total"], 2) if lines["total"] else None,
                "kwh": round(kwh, 4),
            }
        )
    bills.sort(key=lambda b: b["start"])
    return bills, sorted(starts)


def open_meteo(start_iso, end_iso):
    url = (
        f"https://archive-api.open-meteo.com/v1/archive?latitude={LAT}&longitude={LON}"
        f"&start_date={start_iso}&end_date={end_iso}&hourly=temperature_2m&timezone=UTC"
    )
    with urllib.request.urlopen(url, timeout=90) as res:
        payload = json.load(res)
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    values = hourly.get("temperature_2m") or []
    if len(times) != len(values) or not times:
        raise SystemExit(f"Open-Meteo returned no hourly series for {start_iso}..{end_iso}")
    out = {}
    for t, v in zip(times, values):
        # EXPLICITLY UTC: the stamps carry no offset, and `fromisoformat(...).
        # timestamp()` would read them in THIS machine's zone (the evidence box
        # runs EDT) — a four-hour shift that lands every temperature on the
        # wrong hour. The app does the same thing with `Date.parse(... + 'Z')`.
        instant = datetime.datetime.fromisoformat(t).replace(tzinfo=UTC)
        out[int(instant.timestamp() // 3600)] = v
    return out


def fetch_hours(hours):
    """Hour-indexed temperatures, in 183-day chunks — the same request the app makes."""
    temps = {}
    first_day = (min(hours) // 24) * 24
    last_day = (max(hours) // 24) * 24
    step = 183 * 24
    for day in range(first_day, last_day + 1, step):
        a = datetime.datetime.fromtimestamp(day * 3600, UTC).date().isoformat()
        b = datetime.datetime.fromtimestamp(min(day + step - 24, last_day) * 3600, UTC).date().isoformat()
        temps.update(open_meteo(a, b))
    return temps


def band_index(temp):
    if temp is None:
        return None
    edges = [-10, 5, 12, 18, 24, 30]
    for i, edge in enumerate(edges):
        if temp < edge:
            return i
        if i == len(edges) - 1 and temp <= edge:
            return i
    return 6


def ols(amounts, kwh):
    n = len(amounts)
    if n < 3:
        return None
    mx = sum(kwh) / n
    my = sum(amounts) / n
    spread = max(kwh) - min(kwh)
    if mx <= 0 or spread < mx * 0.03:
        return {"reason": "usage barely moves between periods"}
    sxy = sum((x - mx) * (y - my) for x, y in zip(kwh, amounts))
    sxx = sum((x - mx) ** 2 for x in kwh)
    if sxx <= 0:
        return {"reason": "every period used the same amount"}
    slope = sxy / sxx
    intercept = my - slope * mx
    if slope < 0:
        return {"reason": "the fitted rate is negative"}
    through_origin = intercept < 0
    if through_origin:
        sxy0 = sum(x * y for x, y in zip(kwh, amounts))
        sxx0 = sum(x * x for x in kwh)
        if sxx0 <= 0:
            return {"reason": "no period used any electricity"}
        slope = sxy0 / sxx0
        if slope < 0:
            return {"reason": "the fitted rate is negative"}
    flat = 0.0 if through_origin else intercept
    residuals = [abs(y - (flat + slope * x)) for x, y in zip(kwh, amounts)]
    worst = max(range(n), key=lambda i: residuals[i])
    share = residuals[worst] / amounts[-1] if amounts[-1] else float("inf")
    return {
        "flat": round(flat, 2),
        "perKwh": round(slope, 4),
        "maxResidual": round(residuals[worst], 2),
        "residualShare": round(share, 4),
        "throughOrigin": through_origin,
        "worstPeriod": worst,
        "periods": n,
        "status": "split" if share <= FIT_RESIDUAL_SHARE else "rejected",
    }


def audit(path, window_start=None, window_end=None):
    bills, starts = parse(path)
    if not starts:
        raise SystemExit("no IntervalReading in the export")
    first, last = starts[0], starts[-1]

    # Usage is summed per hour from the raw values (Wh → kWh).
    root = ET.parse(path).getroot()
    kwh_by_hour = {}
    for ir in root.iter():
        if strip(ir.tag) != "IntervalReading":
            continue
        ts = value = None
        for c in ir:
            if strip(c.tag) == "timePeriod":
                for x in c:
                    if strip(x.tag) == "start" and x.text:
                        ts = int(x.text)
            elif strip(c.tag) == "value" and c.text:
                value = int(c.text)
        if ts is None or value is None:
            continue
        h = ts // 3600
        kwh_by_hour[h] = kwh_by_hour.get(h, 0.0) + value / 1000.0

    temps = fetch_hours(sorted(kwh_by_hour))
    matched = 0
    band_acc = [{"hours": 0, "kwh": 0.0} for _ in BANDS]
    for h, kwh in kwh_by_hour.items():
        b = band_index(temps.get(h))
        if b is None:
            continue
        matched += 1
        band_acc[b]["hours"] += 1
        band_acc[b]["kwh"] += kwh
    total_kwh = sum(b["kwh"] for b in band_acc)

    bands = []
    for i, spec in enumerate(BANDS):
        a = band_acc[i]
        bands.append(
            {
                **spec,
                "hours": a["hours"],
                "kwh": round(a["kwh"], 3),
                "meanKwhPerHour": round(a["kwh"] / a["hours"], 4) if a["hours"] else 0.0,
                "shareOfKwh": round(a["kwh"] / total_kwh, 6) if total_kwh else 0.0,
            }
        )

    fits = {}
    for line in ("delivery", "regulatory"):
        amounts = [b[line] for b in bills]
        fit = ols(amounts, [b["kwh"] for b in bills])
        if fit and "worstPeriod" in fit:
            fit["worstPeriod"] = bills[fit["worstPeriod"]]["date"]
        fits[line] = fit
        if fit and "amount" not in fit:
            fit["amount"] = amounts[-1]

    # --- anomalies: the same day-of-week rule as detectAnomalies -----------
    # Days are LOCAL (Toronto) — the app groups by the household's calendar.
    days = {}
    for h, kwh in kwh_by_hour.items():
        d = datetime.datetime.fromtimestamp(h * 3600, TOR)
        key = d.date().isoformat()
        e = days.setdefault(key, {"kwh": 0.0, "dow": d.weekday(), "temps": []})
        e["kwh"] += kwh
        t = temps.get(h)
        if t is not None:
            e["temps"].append(t)

    dow_sum = {}
    dow_days = {}
    for key, e in days.items():
        dow_sum[e["dow"]] = dow_sum.get(e["dow"], 0.0) + e["kwh"]
        dow_days.setdefault(e["dow"], set()).add(key)
    expected = {
        d: (dow_sum[d] / len(dow_days[d]) if d in dow_days and dow_days[d] else 0.0)
        for d in range(7)
    }

    def in_window(key):
        if window_start and key < window_start:
            return False
        if window_end and key > window_end:
            return False
        return True

    spikes = []
    for key, e in days.items():
        if not in_window(key):
            continue
        exp = expected[e["dow"]]
        if exp > 0 and e["kwh"] > exp * 1.5 and e["kwh"] - exp > 5:
            spikes.append((key, e, exp))
    spikes.sort(key=lambda s: s[0], reverse=True)

    anomalies = []
    for key, e, exp in spikes[:5]:
        ts = e["temps"]
        mean = sum(ts) / len(ts) if ts else None
        high = max(ts) if ts else None
        low = min(ts) if ts else None
        if mean is None:
            kind, temp, text = "unknown", None, "no data"
        elif high >= AC_TEMP_C:
            kind, temp, text = "ac", js_round(high), f"{js_round(high)}°C — that's AC"
        elif low <= HEAT_TEMP_C:
            kind, temp, text = "heat", js_round(low), f"{js_round(low)}°C — that's heat"
        else:
            kind, temp, text = "mild", js_round(mean), "no weather signal — worth checking the appliance"
        anomalies.append(
            {
                "date": key,
                "usage": round(e["kwh"], 2),
                "expected": round(exp, 2),
                "meanTempC": round(mean, 2) if mean is not None else None,
                "highTempC": round(high, 2) if high is not None else None,
                "lowTempC": round(low, 2) if low is not None else None,
                "hours": len(ts),
                "kind": kind,
                "temp": temp,
                "text": text,
            }
        )

    return {
        "location": {"latitude": LAT, "longitude": LON, "timezone": "UTC"},
        "readings": {
            "count": len(starts),
            "first": datetime.datetime.fromtimestamp(first, UTC).isoformat(),
            "last": datetime.datetime.fromtimestamp(last, UTC).isoformat(),
        },
        "hours": {
            "total": len(kwh_by_hour),
            "matched": matched,
            "unmatched": len(kwh_by_hour) - matched,
        },
        "totalKwh": round(total_kwh, 3),
        "bands": bands,
        "bills": [
            {k: v for k, v in b.items() if k != "start"} for b in bills
        ],
        "fit": fits,
        "anomalies": anomalies,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    start = sys.argv[2] if len(sys.argv) > 2 else None
    end = sys.argv[3] if len(sys.argv) > 3 else None
    print(json.dumps(audit(sys.argv[1], start, end), indent=2))
