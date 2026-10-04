"""Tests for the hardened vampire-load estimator (vampire.py).

The pre-fix dashboard used ``df['usage_kwh'].min()`` -- a single argmin reading --
as the always-on floor. These tests pin the new estimator's behaviour:
order-independent, outlier-resistant, trailing-window aware, and provably
different from the old min() on a fixture with a deep dip.

They also pin the unit contract: ``usage_kwh`` is per *reading interval*, so the
P05 is only kW on an hourly feed. The interval-aware conversion must produce the
same kW (and the same $/mo) from hourly, 30-minute and 15-minute exports of the
same house -- the bundled fixture is hourly, so without these a regression would
be invisible to the demo.
"""

import math

import pandas as pd
import pytest

from vampire import (
    BASE_LOAD_PERCENTILE,
    DAYS_PER_MONTH,
    TRAILING_WINDOW_DAYS,
    UNMEASURABLE_INTERVAL_HOURS,
    estimate_base_load_kw,
    estimate_base_load_kwh_per_interval,
    infer_interval_hours,
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


# --------------------------------------------------------------------------
# Interval awareness -- the unit contract (Green Button exports arrive hourly,
# half-hourly or 15-minute; only the hourly case makes per-reading kWh equal kW)
# --------------------------------------------------------------------------


def _interval_df(values, freq, start="2024-07-01 00:00:00"):
    index = pd.date_range(start, periods=len(values), freq=freq, tz="America/Toronto")
    return pd.DataFrame({"datetime": index, "usage_kwh": values})


def _same_house(freq, per_hour, days=30, night_kwh=0.18, day_kwh=0.45):
    """One physical house sampled at different cadences.

    ``per_hour`` readings per clock hour (1 hourly, 2 half-hourly, 4 at
    15 minutes); each clock hour's energy is split evenly across them, so the
    always-on floor per *reading* is ``night_kwh / per_hour`` while the house's
    actual draw stays put. Hours 0-6 and 20-23 are the always-on night floor.
    """
    values = []
    for _ in range(days):
        for hour in range(24):
            hour_kwh = night_kwh if (hour < 7 or hour >= 20) else day_kwh
            values.extend([hour_kwh / per_hour] * per_hour)
    return _interval_df(values, freq)


def test_infer_interval_hours_reads_the_cadence_off_the_data():
    assert infer_interval_hours(_hourly_df([0.18] * 48)) == 1.0
    assert infer_interval_hours(_same_house("30min", 2)) == 0.5
    assert infer_interval_hours(_same_house("15min", 4)) == 0.25
    assert infer_interval_hours(_same_house("h", 1)) == 1.0
    assert UNMEASURABLE_INTERVAL_HOURS == 1.0


def test_infer_interval_hours_survives_gaps_duplicates_and_row_order():
    quarter = _same_house("15min", 4, days=10)
    # A 3-hour outage hole, then a duplicated timestamp, then shuffled rows.
    holed = quarter.drop(index=range(100, 112))
    holed = pd.concat([holed, holed.iloc[[50]]], ignore_index=True)
    shuffled = holed.sample(frac=1, random_state=7).reset_index(drop=True)

    assert infer_interval_hours(shuffled) == 0.25
    assert infer_interval_hours(holed) == 0.25

    # Multi-day hole in an hourly feed: still hourly, not "one giant gap".
    hourly = _hourly_df([0.18] * 24 * 40)
    gapped = pd.concat([hourly.iloc[:100], hourly.iloc[-50:]], ignore_index=True)
    assert infer_interval_hours(gapped) == 1.0


def test_infer_interval_hours_falls_back_to_hourly_when_unmeasurable():
    assert infer_interval_hours(None) == 1.0
    assert infer_interval_hours(pd.DataFrame(columns=["datetime", "usage_kwh"])) == 1.0
    # One reading: no spacing to measure, so the legacy hourly assumption is
    # used deliberately rather than being smuggled in through the maths.
    assert infer_interval_hours(_hourly_df([0.18])) == 1.0

    with pytest.raises(KeyError):
        infer_interval_hours(pd.DataFrame({"usage_kwh": [1.0, 2.0]}))


def test_base_load_kw_is_a_real_kw_on_a_15_minute_feed():
    hourly = _same_house("h", 1)
    quarter = _same_house("15min", 4)

    # Per-interval energy really does differ by the cadence...
    assert estimate_base_load_kwh_per_interval(hourly) == pytest.approx(0.18, rel=1e-9)
    assert estimate_base_load_kwh_per_interval(quarter) == pytest.approx(0.045, rel=1e-9)

    # ...and only the conversion makes them the same physical draw.
    assert estimate_base_load_kw(hourly) == pytest.approx(0.18, rel=1e-9)
    assert estimate_base_load_kw(quarter) == pytest.approx(0.18, rel=1e-9)
    assert estimate_base_load_kw(quarter) == pytest.approx(
        estimate_base_load_kw(hourly), rel=1e-9
    )


def test_hourly_feed_is_bit_for_bit_unchanged_by_the_conversion():
    df = _household_df()
    assert infer_interval_hours(df) == 1.0
    # Division by exactly 1.0: the hourly demo number must not move at all.
    assert estimate_base_load_kw(df) == estimate_base_load_kwh_per_interval(df)


def test_monthly_vampire_cost_is_interval_correct():
    rate = 8.7
    expected = 0.18 * 24 * 30.4 * 0.087  # ~$11.43/mo for a 0.18 kW floor

    costs = [
        monthly_vampire_cost(estimate_base_load_kw(_same_house(freq, n)), rate)
        for freq, n in (("h", 1), ("30min", 2), ("15min", 4))
    ]
    assert costs == pytest.approx([expected, expected, expected], rel=1e-9)

    # The pre-interval-fix number on 15-minute data was 4x too low, because it
    # priced a quarter-hour of energy as if it were a full hour of draw.
    quarter = _same_house("15min", 4)
    pre_fix = monthly_vampire_cost(
        estimate_base_load_kwh_per_interval(quarter), rate
    )
    assert pre_fix == pytest.approx(expected / 4, rel=1e-9)
    assert costs[2] == pytest.approx(4 * pre_fix, rel=1e-9)


def test_bundled_sample_fixture_stays_hourly_so_the_demo_number_is_unchanged():
    from sample_data import load_sample_dataframe

    sample = load_sample_dataframe()
    assert infer_interval_hours(sample) == 1.0
    assert estimate_base_load_kw(sample) == estimate_base_load_kwh_per_interval(sample)
