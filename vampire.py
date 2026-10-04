"""Robust 'vampire' (always-on) base-load estimation for the dashboard.

Why not ``df['usage_kwh'].min()``: a single argmin hour -- a 1-hour summer outage
dip, or one lucky quiet reading -- was being extrapolated as if the house ran at
that floor 24/7/365. For an always-on set of ~150-300 W the floor hour is an
outlier, not a stable base, so the old number swung wildly depending on which hour
happened to win ``min()``.

Instead: the 5th percentile (P05) of hourly readings over the trailing 90 days.
A robust low percentile is insensitive to a handful of deep dips but still sits
right at the always-on floor.
"""

import pandas as pd

# Trailing window used for the base-load estimate.
TRAILING_WINDOW_DAYS = 90

# Bottom percentile of hourly kWh treated as the always-on floor (P05).
BASE_LOAD_PERCENTILE = 5.0

# Average month length (365.25 / 12); the old code used a flat 30.
DAYS_PER_MONTH = 30.4


def estimate_base_load_kw(
    df,
    window_days: int | None = TRAILING_WINDOW_DAYS,
    percentile: float = BASE_LOAD_PERCENTILE,
):
    """Estimate always-on base load from hourly usage, in kWh per hourly interval.

    Robust P05 of ``usage_kwh`` over the trailing ``window_days`` before the most
    recent reading (``window_days=None`` disables the window).

    The result depends only on the *set* of readings, never on row order, so
    shuffling the DataFrame cannot change it.

    Returns 0.0 when there is nothing usable to estimate from.
    """
    if df is None or len(df) == 0:
        return 0.0

    missing = {"datetime", "usage_kwh"} - set(df.columns)
    if missing:
        raise KeyError(
            "estimate_base_load_kw requires columns: " + ", ".join(sorted(missing))
        )

    if not 0 <= percentile <= 100:
        raise ValueError(f"percentile must be within [0, 100], got {percentile!r}")

    sample = df
    if window_days is not None:
        newest = df["datetime"].max()
        if pd.notna(newest):
            cutoff = newest - pd.Timedelta(days=window_days)
            sample = df[df["datetime"] >= cutoff]

    values = sample["usage_kwh"].dropna()
    if values.empty:
        return 0.0

    return float(values.quantile(percentile / 100.0))


def monthly_vampire_cost(base_load_kw, rate_cents_per_kwh, days_per_month=DAYS_PER_MONTH):
    """Monthly cost of the always-on load: kW x 24 h x days x $/kWh."""
    return float(base_load_kw) * 24.0 * float(days_per_month) * (float(rate_cents_per_kwh) / 100.0)
