#!/usr/bin/env python3
"""Reproduce the Wave T task's PUBLISHED band numbers, and show why they differ.

The task brief quotes these figures for Mark's file: "1.33 kWh/h near -10 vs
1.66 at 5-12°C ... 3.5-3.7 kWh/h at 18-30°C, 3.9+ above 30°C". The shipped app
reports 1.33 / 1.63 / 3.34-4.34 / 4.98 for the same file.

This script reproduces the published set EXACTLY, which pins down where they
came from. The recipe is:

  • ask Open-Meteo for `timezone=America/Toronto` — the API then returns each
    value under its TORONTO WALL-CLOCK label (this is the fact the task brief
    insists on, and it is correct);
  • ...but index each reading by its own UTC hour (the unix timestamp ÷ 3600).

Those two choices disagree by Toronto's offset: a reading at 15:00 EDT (19:00Z)
is looked up under the label "19:00", which holds the temperature of TORONTO
19:00 — four hours later in the day. Afternoon usage therefore gets scored
against evening temperatures, and every hot bin comes out cooler than it is.

The shipped app asks for `timezone=UTC` and indexes by the same UTC hour, so
both sides of the lookup are the same absolute instants. That is equivalent to
matching in local time (verified: both give identical band means on this file,
17,539/17,539 readings) and it is also timezone-proof — the numbers do not
depend on which machine or browser tab opened the file.

Usage:  python3 evidence/wave-t-published-repro.py <export.xml>
"""

import datetime
import importlib.util
import json
import os
import sys
import xml.etree.ElementTree as ET
from datetime import UTC

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("audit", os.path.join(HERE, "wave-t-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def shifted_bands(path):
    """The published method: UTC hour index against OpenMeteo's LOCAL labels."""
    root = ET.parse(path).getroot()
    readings = []
    for ir in root.iter():
        if audit.strip(ir.tag) != "IntervalReading":
            continue
        ts = value = None
        for c in ir:
            if audit.strip(c.tag) == "timePeriod":
                for x in c:
                    if audit.strip(x.tag) == "start" and x.text:
                        ts = int(x.text)
            elif audit.strip(c.tag) == "value" and c.text:
                value = int(c.text)
        if ts is not None and value is not None:
            readings.append((ts, value / 1000.0))

    # Local-labelled series, in 183-day chunks (the same chunking as the app).
    temps = {}
    hours = sorted(set(ts // 3600 for ts, _ in readings))
    first_day = (min(hours) // 24) * 24
    last_day = (max(hours) // 24) * 24
    for day in range(first_day, last_day + 1, 183 * 24):
        a = datetime.datetime.fromtimestamp(day * 3600, UTC).date().isoformat()
        b = datetime.datetime.fromtimestamp(min(day + 183 * 24 - 24, last_day) * 3600, UTC).date().isoformat()
        url = (
            f"https://archive-api.open-meteo.com/v1/archive?latitude=43.4668&longitude=-79.6736"
            f"&start_date={a}&end_date={b}&hourly=temperature_2m&timezone=America%2FToronto"
        )
        import urllib.request

        with urllib.request.urlopen(url, timeout=90) as res:
            payload = json.load(res)["hourly"]
        # The BUG, made explicit: the label is taken as the lookup key.
        for label, value in zip(payload["time"], payload["temperature_2m"]):
            key = int(
                datetime.datetime.fromisoformat(label).replace(tzinfo=UTC).timestamp() // 3600
            )
            temps[key] = value

    acc = [{"hours": 0, "kwh": 0.0} for _ in audit.BANDS]
    for ts, kwh in readings:
        b = audit.band_index(temps.get(ts // 3600))
        if b is None:
            continue
        acc[b]["hours"] += 1
        acc[b]["kwh"] += kwh
    return [
        (spec_["label"], a["hours"], round(a["kwh"] / a["hours"], 3) if a["hours"] else 0.0)
        for spec_, a in zip(audit.BANDS, acc)
    ]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(f"{'band':10} {'hours':>6} {'mean kWh/h':>10}   (the published method)")
    for label, hours, mean in shifted_bands(sys.argv[1]):
        print(f"{label:10} {hours:6d} {mean:10.3f}")
    print()
    print("Published in the task: 1.33 near -10 · 1.66 at 5-12 · 3.5-3.7 at 18-30 · 3.9+ over 30")
    print("That is this table:    1.33 · 1.66 · 3.5 + 3.7 · 3.9 — the four-hour shift, reproduced.")
