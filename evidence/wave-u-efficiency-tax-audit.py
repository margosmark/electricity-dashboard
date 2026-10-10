#!/usr/bin/env python3
"""Wave U independent ¢/kWh-with-tax audit — a second parser over the raw export.

Deliberately NOT the app's parser: Python's ElementTree reading the Green
Button XML directly. The browser check (wave-u-efficiency-tax-verify.cjs)
spawns this file and asserts the DOM against its output, so a bug in either
parser shows up as a mismatch instead of the two agreeing with themselves.

What it answers, and why it exists:

  Mark asked "does the avg kWh cost include all fees?" and the card could
  not answer. Verified from the source: the numerator IS the bill's own
  "Total Electricity Charges" line — commodity + Delivery + Regulatory —
  and HST is a SEPARATE line beneath it on the itemized bill. So the
  headline 16.3¢/kWh was never all-in, and nothing said so.

  This audit recomputes BOTH readings straight from the XML:

    ¢/kWh excl. tax = "Total Electricity Charges"  ÷ billed kWh
    ¢/kWh incl. tax = ("Total Electricity Charges" + HST line) ÷ billed kWh

  …per bill and kWh-weighted over the file, plus the implied tax rate
  (ΣHST ÷ ΣTotal Electricity Charges) the card's footnote quotes. Nothing
  here multiplies by 1.13: each bill's own tax line is used, so a file
  whose tax is not 13% — or absent — is reported as it is.

Money is stored in the feed as an integer scaled by 100000; usage
measurements are uom 72 (Wh) scaled the same way.

Usage:  python3 evidence/wave-u-efficiency-tax-audit.py <export.xml>
Prints: one JSON object:
  { bills: [{date, end, cost, tax, kwh, cents, centsInclTax, taxPct},
            ...oldest first],
    allTime: {bills, cost, tax, kwh, cents, centsInclTax, taxPct},
    taxLineCount, billsWithoutTax }
"""
import xml.etree.ElementTree as ET
import datetime
from datetime import UTC, timedelta
import json
import sys

# Rate sets shipped by webapp/src/app/api/rates/route.ts — kept only so the
# output can be cross-checked against the app's window; no fit is asserted
# here (the tax line is a constant multiplier, so it moves no slope).
RATE_DATES = ['2023-11-01', '2024-11-01', '2025-11-01']


def strip(tag):
    return tag.split('}')[-1]


def is_tax_note(note):
    """The app's classifyBillLine tax regex, restated: HST / GST / tax."""
    n = note.lower()
    return ('h.s.t' in n or 'hst' in n or 'g.s.t' in n or 'gst' in n
            or ' tax' in n or n.startswith('tax'))


def audit(path):
    root = ET.parse(path).getroot()
    rows = []
    tax_lines = 0

    for s in (c for c in root.iter() if strip(c.tag) == 'UsageSummary'):
        start = duration = total_charges = None
        tax = 0.0
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
                if note is None:
                    continue
                if is_tax_note(note):
                    tax += amt / 100000
                    tax_lines += 1
                if note == 'Total Electricity Charges':
                    total_charges = amt / 100000
                if m is not None and 'Usage' in note:
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
            'tax': round(tax, 2),
            'kwh': round(kwh, 1),
            'cents': total_charges / kwh * 100,
            'centsInclTax': (total_charges + tax) / kwh * 100,
            'taxPct': (tax / total_charges * 100) if total_charges else None,
        })
    rows.sort(key=lambda r: r['date'])
    cost = sum(r['cost'] for r in rows)
    tax = sum(r['tax'] for r in rows)
    kwh = sum(r['kwh'] for r in rows)
    return {
        'bills': rows,
        'rateDates': RATE_DATES,
        'allTime': {
            'bills': len(rows),
            'cost': round(cost, 2),
            'tax': round(tax, 2),
            'kwh': round(kwh, 1),
            'cents': (cost / kwh * 100) if kwh else None,
            'centsInclTax': ((cost + tax) / kwh * 100) if kwh else None,
            'taxPct': (tax / cost * 100) if cost else None,
        },
        'taxLineCount': tax_lines,
        'billsWithoutTax': sum(1 for r in rows if r['tax'] == 0),
    }


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(json.dumps(audit(sys.argv[1]), indent=2))
