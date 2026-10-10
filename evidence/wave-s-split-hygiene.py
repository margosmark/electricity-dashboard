#!/usr/bin/env python3
"""Wave S follow-through — behaviour-vs-rate split, per-rate-period baseline
hygiene audit  (kanban t_fee3d256).

Question: is the split double-counting a TOU-SEASON / rate-period change as a
BEHAVIOUR change?  Three separate things ride on a Nov 1 boundary in Ontario:

  1. the ¢/kWh price set changes (the app puts this in the rate component);
  2. the TOU WINDOWS are re-drawn (summer May 1–Oct 31, winter Nov 1–Apr 30)
     — same clock hours, different block, no price change involved;
  3. the TIERED thresholds move (600 kWh/month summer, 1,000 kWh/month
     winter) — same kWh, different block split, no price change involved.

Only (1) is a price.  (2) and (3) move the BILLED MIX, and the app's
behaviour component is priced off the billed mix, so they can only land in
"your usage mix improved/worsened".  This script measures how much, on the
owner's real 2-year export.

Second parser again: Python ElementTree over the raw export, no webapp code.

Usage:  python3 evidence/wave-s-split-hygiene.py <export.xml>
Prints: one JSON object.
"""
import datetime
import json
import math
import sys
import xml.etree.ElementTree as ET
from datetime import UTC
from zoneinfo import ZoneInfo

TORONTO = ZoneInfo('America/Toronto')
WINDOW = 12  # TREND_MAX_PERIODS in webapp/src/lib/statistics.ts

# `latestRateSet` — the OEB set in force now (effective 2025-11-01), read off
# webapp/src/lib/oebRates.fixture.html and cross-checked below against the
# bills' own amount ÷ kWh lines (a typo here cannot go unnoticed).
TODAY = {
    'tou': {'off': 9.8, 'mid': 15.7, 'on': 20.3},
    'ulo': {'off': 3.9, 'weekend': 9.8, 'mid': 15.7, 'on': 39.1},
    'tier': {'tier1': 12.0, 'tier2': 14.2},
}
TIER_THRESHOLD = {'winter': 1000.0, 'summer': 600.0}   # kWh / month, residential


def strip(tag):
    return tag.split('}')[-1]


def ols(values):
    """OLS over evenly spaced periods (index is x) — lib/statistics.ts#linearFit."""
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
    return {'slope': round(slope, 4), 'stderr': round(stderr, 4), 'n': n, 'verdict': verdict}


def block_key(note):
    """Utility note → the rate key rateForUsageNote() would pick."""
    n = note.lower()
    if 'overnight' in n or 'ulo' in n:
        return 'ulo'
    if 'weekend' in n:
        return 'ulo'
    if 'off' in n and 'peak' in n:
        return 'off'
    if 'mid' in n and 'peak' in n:
        return 'mid'
    if 'on' in n and 'peak' in n:
        return 'on'
    if 'block' in n or 'tier' in n:
        return 'tier1' if ('1' in n or 'first' in n) else 'tier2'
    return None


def season_of(date_str):
    """Calendar TOU season: summer May 1–Oct 31, winter Nov 1–Apr 30."""
    return 'summer' if 5 <= int(date_str[5:7]) <= 10 else 'winter'


def parse(path):
    root = ET.parse(path).getroot()
    bills = []
    for s in (c for c in root.iter() if strip(c.tag) == 'UsageSummary'):
        lines = []
        start = duration = None
        total = None
        for c in s.iter():
            tag = strip(c.tag)
            if tag == 'billingPeriod' and start is None:
                for x in c:
                    if strip(x.tag) == 'start' and x.text:
                        start = int(x.text)
                    elif strip(x.tag) == 'duration' and x.text:
                        duration = int(x.text)
            if tag != 'costAdditionalDetailLastPeriod':
                continue
            note = amount = None
            kwh = epoch = None
            for x in c:
                t = strip(x.tag)
                if t == 'note':
                    note = (x.text or '').strip()
                elif t == 'amount':
                    amount = int(x.text or 0) / 100000.0
                elif t == 'measurement':
                    val = uom = mult = None
                    for y in x:
                        yt = strip(y.tag)
                        if yt == 'value':
                            val = int(y.text or 0)
                        elif yt == 'uom':
                            uom = y.text
                        elif yt == 'powerOfTenMultiplier':
                            mult = int(y.text or 0)
                    if note and note.lower().endswith('usage') and int(uom or 72) == 72:
                        kwh = (val or 0) * (10 ** (mult or -6))
                    elif note and int(uom or 0) == 27:
                        epoch = (val or 0) * (10 ** (mult or 0))
            if note is None:
                continue
            lines.append({'note': note, 'amount': amount, 'kwh': kwh, 'epoch': epoch})
            if note == 'Total Electricity Charges':
                total = amount
        if start is None or total is None:
            continue
        blocks = {}
        for ln in lines:
            k = block_key(ln['note'])
            if ln['kwh'] and k:
                blocks.setdefault(k, {'note': ln['note'], 'kwh': 0.0, 'amount': 0.0})
                blocks[k]['note'] = ln['note']
                blocks[k]['kwh'] += ln['kwh']
        for ln in lines:
            k = block_key(ln['note'])
            if ln['amount'] and k in blocks and 'usage' not in ln['note'].lower():
                blocks[k]['amount'] += ln['amount']   # measurement lines carry $0
        kwh = sum(v['kwh'] for v in blocks.values())
        if kwh <= 1:
            continue
        prev = cur = None
        for ln in lines:
            if ln['epoch'] is None:
                continue
            n = ln['note'].lower()
            if 'read date' in n and 'previous' in n:
                prev = ln['epoch']
            elif 'read date' in n and 'current' in n:
                cur = ln['epoch']
        commodity = sum(v['amount'] for v in blocks.values())
        season_words = sorted({w for v in blocks.values() for w in ('summer', 'winter') if w in v['note'].lower()})
        bills.append({
            'start': start,
            'startDate': datetime.datetime.fromtimestamp(start, UTC).date().isoformat(),
            'readStart': prev, 'readEnd': cur,
            'readStartDate': datetime.datetime.fromtimestamp(prev, UTC).date().isoformat() if prev else None,
            'readEndDate': datetime.datetime.fromtimestamp(cur, UTC).date().isoformat() if cur else None,
            'kwh': kwh, 'total': total, 'commodity': commodity,
            'nonCommodity': total - commodity,
            'blocks': blocks,
            'plan': 'TOU' if any(k in blocks for k in ('off', 'mid', 'on')) else 'tiered',
            'seasonWords': season_words,
        })
    bills.sort(key=lambda b: b['start'])

    readings = []
    for ir in root.iter():
        if strip(ir.tag) != 'IntervalReading':
            continue
        t = dur = v = None
        for c in ir.iter():
            tag = strip(c.tag)
            if tag == 'start' and t is None and c.text:
                t = int(c.text.strip())
            elif tag == 'duration' and dur is None and c.text:
                dur = int(c.text.strip())
            elif tag == 'value' and v is None and c.text:
                v = int(c.text.strip())
        if t is not None and v is not None:
            readings.append((t, dur or 3600, v / 1000.0))
    readings.sort()
    return bills, readings


# -------------------------------------------------------------------------- #
# Ontario TOU windows (official, from the OEB Nov 1 2025 table)
# -------------------------------------------------------------------------- #

def is_holiday(d):
    import datetime as dt
    if (d.month, d.day) in {(1, 1), (7, 1), (12, 25), (12, 26)}:
        return True
    y = d.year
    a = y % 19
    b, c = divmod(y, 100)
    dd, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - dd - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    easter = dt.date(y, month, day)
    return d in (easter - dt.timedelta(days=2), easter - dt.timedelta(days=1), easter)


def tou_bucket(local, season):
    """'off' | 'mid' | 'on' under the given window set, for one local hour."""
    if local.weekday() >= 5 or is_holiday(local.date()):
        return 'off'
    h = local.hour
    if season == 'summer':                      # May 1 – Oct 31
        if 11 <= h < 17:
            return 'on'
        if 7 <= h < 11 or 17 <= h < 19:
            return 'mid'
        return 'off'
    if 7 <= h < 11 or 17 <= h < 19:            # Nov 1 – Apr 30
        return 'on'
    if 11 <= h < 17:
        return 'mid'
    return 'off'


def split_hours(readings, lo, hi, fixed=None):
    q = {'off': 0.0, 'mid': 0.0, 'on': 0.0}
    for t, dur, kwh in readings:
        if t < lo or t >= hi:
            continue
        loc = datetime.datetime.fromtimestamp(t, TORONTO)
        season = fixed or season_of(loc.date().isoformat())
        q[tou_bucket(loc, season)] += kwh
    return q


def split_tier(readings, lo, hi):
    """Tiered split under TODAY's thresholds, month by month (Oakville bills
    tier blocks per calendar month; the threshold follows each month's
    season — 1,000 kWh Nov–Apr, 600 kWh May–Oct)."""
    by_month = {}
    for t, dur, kwh in readings:
        if t < lo or t >= hi:
            continue
        loc = datetime.datetime.fromtimestamp(t, TORONTO)
        by_month.setdefault(loc.date().strftime('%Y-%m'), []).append((loc, kwh))
    t1 = t2 = 0.0
    for entries in by_month.values():
        used = 0.0
        for loc, kwh in sorted(entries):
            thr = TIER_THRESHOLD[season_of(loc.date().isoformat())]
            take = max(0.0, min(kwh, thr - used))
            t1 += take
            t2 += kwh - take
            used += kwh
    return {'tier1': t1, 'tier2': t2}


def cents(q, prices):
    """¢/kWh of the split `q` priced at `prices` (already in ¢/kWh)."""
    total = sum(q.values())
    if total <= 0:
        return 0.0
    return sum(v * prices[k] for k, v in q.items() if k in prices) / total


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        sys.exit('pass the export path')
    bills, readings = parse(path)
    rows = []
    for b in bills:
        observed = b['total'] / b['kwh'] * 100
        cf = 0.0
        implied = {}
        for k, v in b['blocks'].items():
            price = TODAY['tou'].get(k) or TODAY['tier'].get(k)
            cf += v['kwh'] * price / 100.0
            implied[k] = round(v['amount'] / v['kwh'] * 100, 3)
        behaviour = (cf + b['nonCommodity']) / b['kwh'] * 100
        rows.append({
            'readStartDate': b['readStartDate'], 'readEndDate': b['readEndDate'],
            'plan': b['plan'], 'seasonWords': b['seasonWords'],
            'kwh': round(b['kwh'], 1), 'cost': round(b['total'], 2),
            'observed': round(observed, 4), 'behaviour': round(behaviour, 4),
            'rate': round(observed - behaviour, 4),
            'mixCents': round(cf / b['kwh'] * 100, 4),
            'nonComCents': round(b['nonCommodity'] / b['kwh'] * 100, 4),
            'impliedPrices': implied,
            'billedMixPct': {k: round(v['kwh'] / b['kwh'] * 100, 2) for k, v in b['blocks'].items()},
        })

    win = rows[-WINDOW:]
    fits = {name: ols([r[key] for r in win]) for name, key in
            [('observed', 'observed'), ('behaviour', 'behaviour'), ('rate', 'rate'),
             ('mixTerm', 'mixCents'), ('nonCommodityTerm', 'nonComCents')]}

    # ---- metered-hours probes -------------------------------------------
    r0, r1 = readings[0][0], readings[-1][0]
    probes = []
    for b, r in zip(bills, rows):
        lo, hi = b['readStart'], b['readEnd']
        if not lo or not hi or lo < r0 or hi > r1:
            continue
        billed = split_hours(readings, lo, hi)
        metered = sum(billed.values())
        summer = split_hours(readings, lo, hi, fixed='summer')
        winter = split_hours(readings, lo, hi, fixed='winter')
        tier = split_tier(readings, lo, hi)
        probes.append({
            'readStartDate': b['readStartDate'], 'plan': b['plan'],
            'meteredKwh': round(metered, 1), 'billedKwh': round(b['kwh'], 1),
            'reconErrPct': round((metered - b['kwh']) / b['kwh'] * 100, 2),
            'mixAtBilledWindows': round(cents(billed, TODAY['tou']), 4),
            'mixAtSummerWindows': round(cents(summer, TODAY['tou']), 4),
            'mixAtWinterWindows': round(cents(winter, TODAY['tou']), 4),
            'mixAtTodayTier': round(cents(tier, TODAY['tier']), 4),
            'windowArtefactCents': round(cents(billed, TODAY['tou']) - cents(summer, TODAY['tou']), 4),
            'billedBlockKwh': {k: round(v, 1) for k, v in billed.items()},
        })

    # ---- verdict sensitivity + rate-schedule artefacts ------------------
    probe_by = {p['readStartDate']: p for p in probes}

    # (a) tier-threshold season band: how far the billed tier split alone
    #     moves the usage counterfactual when the threshold flips Nov 1.
    thresh = []
    for b, r in zip(bills, rows):
        if b['plan'] != 'tiered' or not b['readStart'] or not b['readEnd']:
            continue
        days = (b['readEnd'] - b['readStart']) / 86400
        t1 = b['blocks'].get('tier1', {}).get('kwh', 0.0)
        t2 = b['blocks'].get('tier2', {}).get('kwh', 0.0)
        billed_c = (t1 * TODAY['tier']['tier1'] + t2 * TODAY['tier']['tier2']) / b['kwh']

        def under(thr):
            take = min(b['kwh'], thr * days / 30.44)
            return (take * TODAY['tier']['tier1'] + (b['kwh'] - take) * TODAY['tier']['tier2']) / b['kwh']

        thresh.append({
            'readStartDate': b['readStartDate'], 'days': round(days, 1),
            'usageAtBilledSplit': round(billed_c, 4),
            'usageAtWinterThreshold': round(under(TIER_THRESHOLD['winter']), 4),
            'usageAtSummerThreshold': round(under(TIER_THRESHOLD['summer']), 4),
            'thresholdSeasonSwing': round(abs(under(TIER_THRESHOLD['summer']) - under(TIER_THRESHOLD['winter'])), 4),
        })

    # (b) artefact table over the verdict window: the app's usage component
    #     versus the same metered hours repriced under ONE structure.
    artefacts = []
    for r in win:
        pr = probe_by.get(r['readStartDate'])
        if not pr:
            continue
        neutral = pr['mixAtBilledWindows'] if r['plan'] == 'TOU' else pr['mixAtTodayTier']
        artefacts.append({
            'readStartDate': r['readStartDate'], 'plan': r['plan'],
            'appUsageCents': r['mixCents'],
            'usageUnderTodayTOU': pr['mixAtBilledWindows'],
            'usageUnderTodayTier': pr['mixAtTodayTier'],
            'deliveryCents': r['nonComCents'], 'rateCents': r['rate'],
            'artifactCents': round(r['mixCents'] - neutral, 4),
        })
    art_fit = ols([a['artifactCents'] for a in artefacts]) if len(artefacts) >= 3 else None

    # (c) delivery seasonality: winter mean vs summer mean, and the window's
    #     first/last bill (both summer) — the shape, not a trend.
    seasonal = {}
    for r in win:
        s = season_of(r['readStartDate'])
        seasonal.setdefault(s, []).append(r['nonComCents'])
    delivery_season = {s: {'mean': round(sum(v) / len(v), 4), 'n': len(v), 'min': round(min(v), 4), 'max': round(max(v), 4)}
                       for s, v in seasonal.items()}

    # (d) plan-switch level jumps in the usage component (same season either side)
    plan_jumps = []
    for i in range(1, len(win)):
        a, b_ = win[i - 1], win[i]
        if a['plan'] != b_['plan']:
            plan_jumps.append({
                'at': b_['readStartDate'], 'from': a['plan'], 'to': b_['plan'],
                'usageJumpCents': round(b_['mixCents'] - a['mixCents'], 4),
                'deliveryJumpCents': round(b_['nonComCents'] - a['nonComCents'], 4),
            })

    out = {
        'todaySet': TODAY,
        'tierThresholdBand': thresh,
        'windowArtifacts': artefacts,
        'artifactFit': art_fit,
        'deliverySeasonality': delivery_season,
        'planJumps': plan_jumps,
        'perBill': rows,
        'windowFits': fits,
        'recombineCheck': round(fits['behaviour']['slope'] + fits['rate']['slope'] - fits['observed']['slope'], 6)
        if fits['behaviour'] else None,
        'meteredProbes': probes,
        'readings': {'n': len(readings),
                     'first': datetime.datetime.fromtimestamp(r0, UTC).isoformat(),
                     'last': datetime.datetime.fromtimestamp(r1, UTC).isoformat()},
    }
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == '__main__':
    main()
