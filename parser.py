import re
import xml.etree.ElementTree as ET
import pandas as pd
import pytz

# Namespaces used in the Green Button XML
NS = {
    'atom': 'http://www.w3.org/2005/Atom',
    'espi': 'http://naesb.org/espi'
}

# A Green Button export with no interval duration anywhere is treated as the
# historical Oakville Hydro 60-minute resolution.
DEFAULT_INTERVAL_SECONDS = 3600

# Where an interval duration can live, most specific first.
# - IntervalReading/timePeriod/duration is the reading's own interval.
# - IntervalBlock/timePeriod/duration (and the period/intervalDuration
#   variants seen in ESPI exports) is the block-wide interval.
_DURATION_PATHS = (
    'espi:timePeriod/espi:duration',
    'espi:period/espi:duration',
    'espi:duration',
    'espi:intervalDuration',
    'espi:interval',
)

_ISO_DURATION_RE = re.compile(
    r'^P(?:(?P<weeks>\d+(?:\.\d+)?)W)?'
    r'(?:(?P<days>\d+(?:\.\d+)?)D)?'
    r'(?:T'
    r'(?:(?P<hours>\d+(?:\.\d+)?)H)?'
    r'(?:(?P<minutes>\d+(?:\.\d+)?)M)?'
    r'(?:(?P<seconds>\d+(?:\.\d+)?)S)?'
    r')?$'
)


def _duration_text_to_seconds(text):
    """Return interval length in seconds for a duration value, or None.

    Accepts plain seconds (``900``, ``900.0``) and ISO-8601 durations
    (``PT15M``, ``PT1H``, ``P1DT12H``). Anything unparseable returns None so
    the caller can fall back to the next source.
    """
    if text is None:
        return None
    text = text.strip()
    if not text:
        return None

    match = _ISO_DURATION_RE.match(text)
    if match:
        parts = {k: float(v) for k, v in match.groupdict().items() if v is not None}
        if not parts:
            return None
        seconds = (
            parts.get('weeks', 0) * 7 * 86400
            + parts.get('days', 0) * 86400
            + parts.get('hours', 0) * 3600
            + parts.get('minutes', 0) * 60
            + parts.get('seconds', 0)
        )
        return seconds or None

    try:
        seconds = float(text)
    except ValueError:
        return None
    return seconds or None


def _find_interval_seconds(element, ns=NS):
    """Best-effort interval duration (seconds) for one XML element."""
    if element is None:
        return None
    for path in _DURATION_PATHS:
        child = element.find(path, ns)
        if child is None:
            continue
        seconds = _duration_text_to_seconds(child.text)
        if seconds is not None and seconds > 0:
            return seconds
    return None


def _block_interval_seconds(root, ns=NS):
    """Map id(IntervalReading) -> interval seconds declared by its IntervalBlock.

    Readings that sit outside any IntervalBlock (or inside a block with no
    duration) are simply absent from the map and fall back to the default.
    """
    block_intervals = {}
    for block in root.findall('.//espi:IntervalBlock', ns):
        block_seconds = _find_interval_seconds(block, ns)
        for reading in block.findall('.//espi:IntervalReading', ns):
            block_intervals[id(reading)] = block_seconds
    return block_intervals


def _build_summary(df, total_kwh=None):
    """Sidecar summary: readings seen, per-interval-minute counts, total kWh."""
    if df is None or df.empty:
        return {
            'total_readings': 0,
            'interval_minutes_counts': {},
            'total_kwh': 0.0,
        }

    counts = {}
    for minutes in df['interval_minutes'].tolist():
        key = int(minutes) if float(minutes).is_integer() else float(minutes)
        counts[key] = counts.get(key, 0) + 1

    if total_kwh is None:
        total_kwh = float(df['usage_kwh'].sum())

    return {
        'total_readings': int(len(df)),
        'interval_minutes_counts': counts,
        'total_kwh': float(total_kwh),
    }


def _parse_green_button(file_path):
    tree = ET.parse(file_path)
    root = tree.getroot()

    block_intervals = _block_interval_seconds(root)

    data = []

    # Find all IntervalReading elements
    # Using relative path to find any IntervalReading regardless of its exact depth
    for reading in root.findall('.//espi:IntervalReading', NS):
        # Extract start time (Unix timestamp)
        time_period = reading.find('espi:timePeriod', NS)
        if time_period is None:
            continue

        start_element = time_period.find('espi:start', NS)
        value_element = reading.find('espi:value', NS)
        if start_element is None or value_element is None:
            continue
        start_text = start_element.text
        value_text = value_element.text
        if start_text is None or value_text is None:
            continue

        # Interval resolution: the reading's own duration, else its block's,
        # else the historical 60-minute default.
        interval_seconds = _find_interval_seconds(reading)
        if interval_seconds is None:
            interval_seconds = block_intervals.get(id(reading))
        if not interval_seconds or interval_seconds <= 0:
            interval_seconds = DEFAULT_INTERVAL_SECONDS

        hours = interval_seconds / 3600.0
        interval_minutes = interval_seconds / 60.0

        start_timestamp = int(start_text)
        value = int(value_text)

        data.append({
            'timestamp': start_timestamp,
            'value': value,
            'interval_seconds': interval_seconds,
            'interval_minutes': interval_minutes,
            # `value` is the average rate over the interval (W), so energy for
            # the row is rate * hours. At 60-minute resolution hours == 1 and
            # this is identical to the old value / 1000.0.
            'usage_kwh': value / 1000.0 * hours,
        })

    # Create DataFrame
    df = pd.DataFrame(data)

    if df.empty:
        return df, _build_summary(df)

    # Convert timestamp to timezone-aware datetime (America/Toronto for Oakville)
    tz = pytz.timezone('America/Toronto')

    # The timestamps are UTC unix timestamps
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='s', utc=True)
    df['datetime'] = df['datetime'].dt.tz_convert(tz)

    # Keep integer-ish interval minutes readable (15, 60) instead of 15.0
    if (df['interval_minutes'] % 1 == 0).all():
        df['interval_minutes'] = df['interval_minutes'].astype(int)

    # Add useful columns for the dashboard
    df['year'] = df['datetime'].dt.year
    df['month'] = df['datetime'].dt.month
    df['day'] = df['datetime'].dt.day
    df['hour'] = df['datetime'].dt.hour
    df['day_of_week'] = df['datetime'].dt.dayofweek  # Monday=0, Sunday=6
    df['is_weekend'] = df['day_of_week'] >= 5
    df['date'] = df['datetime'].dt.date

    # Sort chronologically just in case
    df = df.sort_values('datetime').reset_index(drop=True)

    summary = _build_summary(df)
    return df, summary


def parse_green_button_xml_with_summary(file_path):
    """Parse a Green Button export.

    Returns ``(df, summary)`` where ``summary`` reports total readings seen,
    per-interval-minute counts and the total kWh computed across every
    resolution present in the file.
    """
    df, summary = _parse_green_button(file_path)
    df.attrs['summary'] = summary
    return df, summary


def parse_green_button_xml(file_path):
    """Parse a Green Button export into a DataFrame.

    Signature-compatible with the original single-resolution parser. The
    resolution-aware sidecar summary is available in ``df.attrs['summary']``
    or via :func:`parse_green_button_xml_with_summary`.
    """
    df, summary = _parse_green_button(file_path)
    df.attrs['summary'] = summary
    return df


if __name__ == "__main__":
    # Quick test to ensure parsing works
    df = parse_green_button_xml("/mnt/g/projects/electricity/electricit2024-now.xml")
    print(f"Successfully parsed {len(df)} records.")
    if not df.empty:
        print(df.head())
