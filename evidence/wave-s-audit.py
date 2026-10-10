#!/usr/bin/env python3
"""Wave S independent ¢/kWh audit — a second parser over the raw export.

This is deliberately NOT the app's parser: Python's ElementTree reading the
Green Button XML directly, the way the task-spec probe /tmp/cpkwh2.py did.
The browser check (wave-s-verify.cjs) spawns this file and asserts the DOM
against its output, so a bug in either parser shows up as a mismatch instead
of the two agreeing with themselves.

 ¢/kWh per bill = "Total Electricity Charges" (amount, /100000 → dollars)
                  ÷ the bill's own per-category "… Usage" measurements
                  (measurement value, uom 72 Wh → /1,000,000 → kWh)

Usage:  python3 evidence/wave-s-audit.py <export.xml>
Prints: one JSON object:
  { bills: [{date, end, cost, kwh, cents}, ...oldest first],
    readings: {first, last},                 # the metered span the chart shows
    allTime: {bills, cost, kwh, cents},      # cents = kWh-weighted mean
    netFit: {slope, stderr, n, verdict} }    # OLS over the newest 12 cents
"""
import xml.etree.ElementTree as ET
import datetime
from datetime import UTC, timedelta
import json
import math
import sys

# The rate sets shipped by webapp/src/app/api/rates/route.ts — the dates the
# mini-line is allowed to draw a red "rates" tick for.
RATE_DATES = ['2023-11-01', '2024-11-01', '2025-11-01']
WINDOW = 12  # TREND_MAX_PERIODS in lib/statistics.ts


def strip(tag):
    return tag.split('}')[-1]


def ols(values):
    """Ordinary least squares over evenly spaced points (index is x)."""
    n = len(values)
    if n < 3:
        return None
    mx = (n - 1) / 2
    my = sum(values) / n
    sxx = sum((i - mx) ** 2 for i in range(n))
    sxy = sum((i - mx) * (values[i] - my) for i in range(n))
    slope = sxy / sxx
    inter = my - slope * mx
    sse = sum((values[i] - (inter + slope * i)) ** 2 for i in range(n))
    stderr = math.sqrt(sse / (n - 2) / sxx)
    verdict = 'stable' if abs(slope) <= stderr else ('improving' if slope < 0 else 'worsening')
    return {'slope': slope, 'stderr': stderr, 'n': n, 'verdict': verdict}


def audit(path):
    root = ET.parse(path).getroot()
    rows = []

    # The metered span: "in view" is scoped to the readings on screen, so a
    # bill that predates the first reading is legitimately out of view while
    # still counting for all-time.
    reading_starts = []
    for ir in root.iter():
        if strip(ir.tag) != 'IntervalReading':
            continue
        for c in ir:
            if strip(c.tag) == 'timePeriod':
                for x in c:
                    if strip(x.tag) == 'start' and x.text and x.text.strip():
                        try:
                            reading_starts.append(int(x.text.strip()))
                        except ValueError:
                            pass
    readings = {}
    if reading_starts:
        readings = {
            'first': datetime.datetime.fromtimestamp(min(reading_starts), UTC).date().isoformat(),
            'last': datetime.datetime.fromtimestamp(max(reading_starts), UTC).date().isoformat(),
        }

    for s in (c for c in root.iter() if strip(c.tag) == 'UsageSummary'):
        start = duration = total_charges = None
        kwh_by_cat = {}
        for c in s.iter():
            if strip(c.tag) == 'billingPeriod' and start is None:
                for x in c:
                    if strip(x.tag) == 'start' and x.text:
                        start = int(x.text)
                    if strip(x.tag) == 'duration' and x.text:
                        duration = int(x.text)
            if strip(c.tag) == 'costAdditionalDetailLastPeriod':
                note = None
                amt = 0
                m = None
                for x in c:
                    if strip(x.tag) == 'note':
                        note = (x.text or '').strip()
                    if strip(x.tag) == 'amount':
                        amt = int(x.text or 0)
                    if strip(x.tag) == 'measurement':
                        m = x
                if note == 'Total Electricity Charges':
                    total_charges = amt / 100000
                if m is not None and note and 'Usage' in note:
                    val = None
                    uom = None
                    for x in m:
                        if strip(x.tag) == 'value' and x.text:
                            val = int(x.text)
                        if strip(x.tag) == 'uom':
                            uom = x.text
                    kwh_by_cat[note] = (
                        (val or 0) / 1000000.0 if int(uom or 72) == 72 else (val or 0) / 1000.0
                    )
        if start is None or total_charges is None:
            continue
        kwh = sum(kwh_by_cat.values())
        if kwh <= 1:
            continue
        begin = datetime.datetime.fromtimestamp(start, UTC)
        end = begin + timedelta(seconds=duration or 0)
        rows.append({
            'date': begin.date().isoformat(),
            'end': end.date().isoformat(),
            'cost': round(total_charges, 2),
            'kwh': round(kwh, 1),
            'cents': total_charges / kwh * 100,
        })
    rows.sort(key=lambda r: r['date'])
    cost = sum(r['cost'] for r in rows)
    kwh = sum(r['kwh'] for r in rows)
    window = rows[-WINDOW:]
    return {
        'bills': rows,
        'readings': readings,
        'allTime': {
            'bills': len(rows),
            'cost': round(cost, 2),
            'kwh': round(kwh, 1),
            'cents': (cost / kwh * 100) if kwh else None,
        },
        # What the app must independently reproduce: the net (observed) fit.
        'netFit': ols([r['cents'] for r in window]),
        # Nov 1 boundaries that fall strictly inside the billed span.
        'rateBoundaries': [d for d in RATE_DATES if rows and rows[0]['date'] < d <= rows[-1]['end']],
    }


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(json.dumps(audit(sys.argv[1]), indent=2))
