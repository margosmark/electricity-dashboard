"""Robust 'vampire' (always-on) base-load estimation for the dashboard.

Why not ``df['usage_kwh'].min()``: a single argmin reading -- a 1-hour summer
outage dip, or one lucky quiet reading -- was being extrapolated as if the house
ran at that floor 24/7/365. For an always-on set of ~150-300 W the floor reading
is an outlier, not a stable base, so the old number swung wildly depending on
which reading happened to win ``min()``.

Instead: the 5th percentile (P05) of readings over the trailing 90 days. A robust
low percentile is insensitive to a handful of deep dips but still sits right at
the always-on floor.

**Units.** ``usage_kwh`` is energy *per reading interval*, and Green Button /
ESPI exports are commonly 15-, 30- or 60-minute IntervalReadings. The P05 is
therefore only equal to kW when readings are hourly, so the estimator converts
explicitly: divide the per-interval kWh by the interval length measured from the
data itself (:func:`infer_interval_hours`). Hourly feeds are unaffected (the
divisor is exactly 1.0); a 15-minute feed reports 4x the per-interval number,
which is the correct draw.
"""

import pandas as pd

# Trailing window used for the base-load estimate.
TRAILING_WINDOW_DAYS = 90

# Bottom percentile of readings treated as the always-on floor (P05).
BASE_LOAD_PERCENTILE = 5.0

# Average month length (365.25 / 12); the old code used a flat 30.
DAYS_PER_MONTH = 30.4

# Divisor used when the reading interval cannot be measured (no usable
# timestamps): the legacy hourly assumption, kept as an explicit fallback
# rather than silently spread through the maths.
UNMEASURABLE_INTERVAL_HOURS = 1.0


def infer_interval_hours(df) -> float:
    """Length of one reading interval, in hours, measured from the data.

    The *modal* spacing between consecutive ``datetime`` values (ties resolved to
    the shortest), because real exports carry gaps the modal spacing ignores:
    outage holes, DST transitions, missing readings and duplicated timestamps all
    produce off-cadence deltas but never outnumber the true cadence.

    Returns ``UNMEASURABLE_INTERVAL_HOURS`` (hourly) when there is nothing to
    measure from -- fewer than two usable timestamps, or no positive gap at all.
    """
    if df is None or len(df) < 2:
        return UNMEASURABLE_INTERVAL_HOURS

    if "datetime" not in set(df.columns):
        raise KeyError("infer_interval_hours requires column: datetime")

    stamps = pd.Series(df["datetime"])
    if not pd.api.types.is_datetime64_any_dtype(stamps):
        stamps = pd.to_datetime(stamps, errors="coerce")
    stamps = stamps.dropna().sort_values()

    if len(stamps) < 2:
        return UNMEASURABLE_INTERVAL_HOURS

    deltas = stamps.diff().dropna()
    deltas = deltas[deltas > pd.Timedelta(0)]
    if deltas.empty:
        # One timestamp repeated, or everything NaT.
        return UNMEASURABLE_INTERVAL_HOURS

    counts = deltas.value_counts()
    busiest = counts.max()
    # value_counts is ordered by frequency; take the shortest of any tied top.
    return float(min(counts.index[counts == busiest]) / pd.Timedelta(hours=1))


def estimate_base_load_kwh_per_interval(
    df,
    window_days: int | None = TRAILING_WINDOW_DAYS,
    percentile: float = BASE_LOAD_PERCENTILE,
):
    """Robust P05 of ``usage_kwh`` -- energy *per reading interval*, in kWh.

    This is the raw measurement; it is only equal to kW for hourly feeds. Use
    :func:`estimate_base_load_kw` for a rate-ready draw.

    Robust P05 over the trailing ``window_days`` before the most recent reading
    (``window_days=None`` disables the window).

    The result depends only on the *set* of readings, never on row order, so
    shuffling the DataFrame cannot change it.

    Returns 0.0 when there is nothing usable to estimate from.
    """
    if df is None or len(df) == 0:
        return 0.0

    missing = {"datetime", "usage_kwh"} - set(df.columns)
    if missing:
        raise KeyError(
            "estimate_base_load_kwh_per_interval requires columns: "
            + ", ".join(sorted(missing))
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


def estimate_base_load_kw(
    df,
    window_days: int | None = TRAILING_WINDOW_DAYS,
    percentile: float = BASE_LOAD_PERCENTILE,
):
    """Estimate always-on base load from readings, **in kW**.

    ``estimate_base_load_kwh_per_interval`` divided by the interval length the
    data actually uses (see :func:`infer_interval_hours`), so 15-, 30- and
    60-minute exports all produce the same physical draw rather than a number
    that is only right once a day.

    Inherits the estimator's guarantees: order-independent, outlier-resistant,
    trailing-window aware. Returns 0.0 when there is nothing usable.
    """
    per_interval = estimate_base_load_kwh_per_interval(df, window_days, percentile)
    if per_interval == 0.0:
        return 0.0
    return per_interval / infer_interval_hours(df)


def monthly_vampire_cost(base_load_kw, rate_cents_per_kwh, days_per_month=DAYS_PER_MONTH):
    """Monthly cost of the always-on load: kW x 24 h x days x $/kWh.

    ``base_load_kw`` must be an actual kW figure -- pass the output of
    :func:`estimate_base_load_kw`, which converts per-interval kWh to kW.
    """
    return float(base_load_kw) * 24.0 * float(days_per_month) * (float(rate_cents_per_kwh) / 100.0)
