import pytest
import xml.etree.ElementTree as ET
from datetime import datetime
import pytz

from parser import parse_green_button_xml, parse_green_button_xml_with_summary


SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry>
    <espi:IntervalBlock>
      <espi:IntervalReading>
        <espi:timePeriod>
          <espi:start>1704067200</espi:start>
        </espi:timePeriod>
        <espi:value>1500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod>
          <espi:start>1704070800</espi:start>
        </espi:timePeriod>
        <espi:value>2000</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod>
          <espi:start>1704074400</espi:start>
        </espi:timePeriod>
        <espi:value>500</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock>
  </entry>
</feed>
"""


@pytest.fixture
def sample_xml_file(tmp_path):
    xml_file = tmp_path / "sample.xml"
    xml_file.write_text(SAMPLE_XML)
    return str(xml_file)


def test_parse_returns_dataframe(sample_xml_file):
    import pandas as pd
    df = parse_green_button_xml(sample_xml_file)
    assert isinstance(df, pd.DataFrame)
    assert len(df) == 3


def test_parse_extracts_timestamps(sample_xml_file):
    df = parse_green_button_xml(sample_xml_file)
    assert list(df['timestamp']) == [1704067200, 1704070800, 1704074400]


def test_parse_converts_wh_to_kwh(sample_xml_file):
    df = parse_green_button_xml(sample_xml_file)
    assert list(df['usage_kwh']) == [1.5, 2.0, 0.5]


def test_parse_adds_datetime_column(sample_xml_file):
    df = parse_green_button_xml(sample_xml_file)
    assert 'datetime' in df.columns
    assert df['datetime'].dt.tz is not None


def test_parse_adds_date_components(sample_xml_file):
    df = parse_green_button_xml(sample_xml_file)
    assert 'year' in df.columns
    assert 'month' in df.columns
    assert 'day' in df.columns
    assert 'hour' in df.columns
    assert 'day_of_week' in df.columns
    assert 'is_weekend' in df.columns
    assert 'date' in df.columns


def test_parse_weekend_flag(sample_xml_file):
    df = parse_green_button_xml(sample_xml_file)
    for _, row in df.iterrows():
        expected = row['datetime'].weekday() >= 5
        assert row['is_weekend'] == expected


def test_parse_empty_xml(tmp_path):
    empty_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
    </feed>"""
    xml_file = tmp_path / "empty.xml"
    xml_file.write_text(empty_xml)
    df = parse_green_button_xml(str(xml_file))
    assert len(df) == 0


# --- Multi-interval-resolution fixtures ---------------------------------
#
# Each helper writes an inline feed whose IntervalBlock entries declare their
# own interval duration, so we can exercise 60-min, 15-min and mixed files
# without any external test data.

def _interval_xml(blocks):
    """Build a Green Button feed.

    ``blocks`` is a list of ``(duration, readings)`` where ``duration`` is the
    block's interval length in seconds (or None for "absent") and ``readings``
    is a list of ``(start, value)`` or ``(start, value, duration)`` tuples —
    a third element puts the duration on the reading's own timePeriod instead
    of on the block.
    """
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">',
    ]
    for duration, readings in blocks:
        parts.append('  <entry>')
        parts.append('    <espi:IntervalBlock>')
        if duration is not None:
            parts.append('      <espi:timePeriod>')
            parts.append(f'        <espi:duration>{duration}</espi:duration>')
            parts.append('      </espi:timePeriod>')
        for reading in readings:
            start, value = reading[0], reading[1]
            reading_duration = reading[2] if len(reading) > 2 else None
            parts.append('      <espi:IntervalReading>')
            parts.append('        <espi:timePeriod>')
            parts.append(f'          <espi:start>{start}</espi:start>')
            if reading_duration is not None:
                parts.append(f'          <espi:duration>{reading_duration}</espi:duration>')
            parts.append('        </espi:timePeriod>')
            parts.append(f'        <espi:value>{value}</espi:value>')
            parts.append('      </espi:IntervalReading>')
        parts.append('    </espi:IntervalBlock>')
        parts.append('  </entry>')
    parts.append('</feed>')
    return "\n".join(parts)


def _write(tmp_path, xml, name="fixture.xml"):
    xml_file = tmp_path / name
    xml_file.write_text(xml)
    return str(xml_file)


def test_pure_60_min_totals_unchanged(tmp_path):
    """60-min resolution: totals identical to the original fixed-hour parser."""
    xml = _interval_xml([
        (3600, [(1704067200, 1500), (1704070800, 2000), (1704074400, 500)]),
    ])
    df = parse_green_button_xml(_write(tmp_path, xml))

    # Original parser produced value / 1000 for these three readings.
    assert list(df['usage_kwh']) == [1.5, 2.0, 0.5]
    assert df['usage_kwh'].sum() == 4.0
    assert list(df['interval_minutes']) == [60, 60, 60]

    summary = df.attrs['summary']
    assert summary['total_readings'] == 3
    assert summary['interval_minutes_counts'] == {60: 3}
    assert summary['total_kwh'] == 4.0


def test_pure_15_min_totals_no_inflation(tmp_path):
    """15-min resolution: no 4x inflation from treating rows as hours."""
    xml = _interval_xml([
        (900, [(1704067200, 1500), (1704068100, 2000), (1704069000, 500)]),
    ])
    df = parse_green_button_xml(_write(tmp_path, xml))

    naive_total = (1500 + 2000 + 500) / 1000.0  # what the old parser gave: 4.0
    assert df['usage_kwh'].sum() == pytest.approx(1.0)
    assert df['usage_kwh'].sum() != pytest.approx(naive_total)
    # Each reading is 0.25 h of energy at its reported rate.
    assert list(df['usage_kwh']) == pytest.approx([0.375, 0.5, 0.125])
    assert list(df['interval_minutes']) == [15, 15, 15]

    summary = df.attrs['summary']
    assert summary['total_readings'] == 3
    assert summary['interval_minutes_counts'] == {15: 3}
    assert summary['total_kwh'] == pytest.approx(1.0)


def test_mixed_60_and_15_min_totals(tmp_path):
    """Mixed resolutions: both buckets reported, no double counting."""
    xml = _interval_xml([
        (3600, [(1704067200, 1500), (1704070800, 2000), (1704074400, 500)]),
        (900, [(1704078000, 1500), (1704078900, 2000), (1704079800, 500)]),
    ])
    df = parse_green_button_xml(_write(tmp_path, xml))

    assert len(df) == 6
    assert sorted(set(df['interval_minutes'])) == [15, 60]
    # 60-min block contributes 4.0 kWh, 15-min block contributes 1.0 kWh.
    assert df['usage_kwh'].sum() == pytest.approx(5.0)
    assert df[df['interval_minutes'] == 60]['usage_kwh'].sum() == pytest.approx(4.0)
    assert df[df['interval_minutes'] == 15]['usage_kwh'].sum() == pytest.approx(1.0)

    summary = df.attrs['summary']
    assert summary['total_readings'] == 6
    assert summary['interval_minutes_counts'] == {60: 3, 15: 3}
    assert summary['total_kwh'] == pytest.approx(5.0)


def test_summary_sidecar_from_sibling_function(tmp_path):
    """parse_green_button_xml_with_summary returns (df, summary)."""
    xml = _interval_xml([
        (3600, [(1704067200, 1500), (1704070800, 2000)]),
        (900, [(1704078000, 1500)]),
    ])
    df, summary = parse_green_button_xml_with_summary(_write(tmp_path, xml))

    assert summary['total_readings'] == 3
    assert summary['interval_minutes_counts'] == {60: 2, 15: 1}
    assert summary['total_kwh'] == pytest.approx(3.5 + 0.375)
    # The plain signature keeps returning just the DataFrame.
    assert list(df['usage_kwh']) == pytest.approx([1.5, 2.0, 0.375])


def test_summary_sidecar_on_empty_file(tmp_path):
    df, summary = parse_green_button_xml_with_summary(
        _write(tmp_path, """<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
        </feed>""", "empty.xml")
    )
    assert len(df) == 0
    assert summary == {'total_readings': 0, 'interval_minutes_counts': {}, 'total_kwh': 0.0}


def test_reading_level_duration_fallback(tmp_path):
    """No block duration: the reading's own timePeriod/duration wins."""
    xml = _interval_xml([
        (None, [(1704067200, 1500, 300), (1704067500, 4000, 300)]),
    ])
    df = parse_green_button_xml(_write(tmp_path, xml))

    assert list(df['interval_minutes']) == [5, 5]
    assert df['usage_kwh'].sum() == pytest.approx(1500 / 1000 * (300 / 3600) + 4000 / 1000 * (300 / 3600))
    assert df.attrs['summary']['interval_minutes_counts'] == {5: 2}


def test_absent_duration_falls_back_to_60_min(tmp_path):
    """No duration anywhere (original SAMPLE_XML shape) -> 60-min default."""
    df = parse_green_button_xml(_write(tmp_path, SAMPLE_XML, "sample.xml"))
    assert list(df['usage_kwh']) == [1.5, 2.0, 0.5]
    assert list(df['interval_minutes']) == [60, 60, 60]


def test_iso8601_duration(tmp_path):
    """ESPI exports may spell the interval PT15M instead of 900 seconds."""
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
      <entry>
        <espi:IntervalBlock>
          <espi:timePeriod>
            <espi:duration>PT15M</espi:duration>
          </espi:timePeriod>
          <espi:IntervalReading>
            <espi:timePeriod>
              <espi:start>1704067200</espi:start>
            </espi:timePeriod>
            <espi:value>4000</espi:value>
          </espi:IntervalReading>
        </espi:IntervalBlock>
      </entry>
    </feed>
    """
    df = parse_green_button_xml(_write(tmp_path, xml, "iso.xml"))
    assert list(df['interval_minutes']) == [15]
    assert df['usage_kwh'].sum() == pytest.approx(1.0)

