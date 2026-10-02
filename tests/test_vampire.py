"""Tests for the hardened vampire-load estimator (vampire.py).

The pre-fix dashboard used ``df['usage_kwh'].min()`` -- a single argmin hour --
as the always-on floor. These tests pin the new estimator's behaviour:
order-independent, outlier-resistant, trailing-window aware, and provably
different from the old min() on a fixture with a deep dip.
"""

import math

import pandas as pd
import pytest

from vampire import (
    BASE_LOAD_PERCENTILE,
    DAYS_PER_MONTH,
    TRAILING_WINDOW_DAYS,
    estimate_base_load_kw,
    monthly_vampire_cost,
)


def _percentile(values, p):
    """Independent P-p implementation (linear interpolation), no pandas involved."""
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100.0
    low = math.floor(k)
    high = math.ceil(k)
    return ordered[low] + (ordered[high] - ordered[low]) * (k - low)


def _hourly_df(values, start="2024-07-01 00:00:00"):
    index = pd.date_range(start, periods=len(values), freq="h", tz="America/Toronto")
    return pd.DataFrame({"datetime": index, "usage_kwh": values})


def _household_df(days=30, dip_at=200, dip_value=0.02):
    """~150-300 W always-on floor with peaks, plus one deep outage dip."""
    hours = days * 24
    values = []
    for i in range(hours):
        hour = i % 24
        base = 0.18 + 0.02 * ((i % 7) - 3) / 3.0  # fridge cycling around 0.18
        if 7 <= hour < 19:
            base += 0.25  # daytime activity
        values.append(base)
    values[dip_at] = dip_value  # the 1-hour summer-outage dip
    return _hourly_df(values)


def test_estimate_is_stable_under_shuffled_row_order():
    df = _household_df()
    baseline = estimate_base_load_kw(df)

    for seed in (0, 42, 1234):
        shuffled = df.sample(frac=1, random_state=seed).reset_index(drop=True)
        assert estimate_base_load_kw(shuffled) == baseline


def test_estimate_differs_from_old_min_on_outlier_fixture():
    df = _household_df()
    old_min_based = df["usage_kwh"].min()
    new_estimate = estimate_base_load_kw(df)

    # The fixture is built so the gap is provable, not cosmetic.
    assert old_min_based == pytest.approx(0.02)
    assert new_estimate == pytest.approx(_percentile(df["usage_kwh"], 5), rel=1e-9)
    assert new_estimate > 0.15
    assert new_estimate > 5 * old_min_based

    # ...and the displayed dollar figure changes by the same margin.
    old_cost = monthly_vampire_cost(old_min_based, 8.7)
    new_cost = monthly_vampire_cost(new_estimate, 8.7)
    assert new_cost > 5 * old_cost


def test_single_outage_dip_does_not_move_estimate():
    clean = _household_df()
    outage_hour = _hourly_df([0.001], start="2024-08-01 03:00:00")
    with_dip = pd.concat([clean, outage_hour], ignore_index=True)

    base = estimate_base_load_kw(clean)
    dipped = estimate_base_load_kw(with_dip)

    # min() collapses entirely; the robust estimate shrugs it off.
    assert with_dip["usage_kwh"].min() < clean["usage_kwh"].min() / 10
    assert dipped == pytest.approx(base, rel=0.05)


def test_trailing_window_excludes_older_readings():
    old_block = _hourly_df([0.05] * 24 * 120, start="2024-01-01 00:00:00")
    recent_block = _hourly_df(
        [0.18 + 0.01 * ((i % 5) - 2) for i in range(24 * 100)],
        start="2024-07-15 00:00:00",
    )
    df = pd.concat([old_block, recent_block], ignore_index=True)

    trailing = estimate_base_load_kw(df)  # default 90-day window
    unbounded = estimate_base_load_kw(df, window_days=None)

    assert trailing == pytest.approx(_percentile(recent_block["usage_kwh"], 5), rel=1e-9)
    assert unbounded < trailing  # without the window the stale low block wins
    assert TRAILING_WINDOW_DAYS == 90
    assert BASE_LOAD_PERCENTILE == 5.0


def test_monthly_vampire_cost_uses_24h_30_4d_and_rate():
    assert monthly_vampire_cost(0.2, 8.7) == pytest.approx(0.2 * 24 * 30.4 * 0.087)
    assert DAYS_PER_MONTH == 30.4
    # 0.2 kW always-on at off-peak = ~$12.70/mo, not the old flat-30 figure.
    assert monthly_vampire_cost(0.2, 8.7) == pytest.approx(12.69504, rel=1e-9)
    assert monthly_vampire_cost(0.2, 8.7) != pytest.approx(0.2 * 24 * 30 * 0.087)


def test_estimator_edge_cases():
    empty = pd.DataFrame(columns=["datetime", "usage_kwh"])
    assert estimate_base_load_kw(empty) == 0.0
    assert estimate_base_load_kw(None) == 0.0

    with pytest.raises(KeyError):
        estimate_base_load_kw(pd.DataFrame({"usage_kwh": [1.0]}))

    with pytest.raises(ValueError):
        estimate_base_load_kw(_household_df(), percentile=101)
