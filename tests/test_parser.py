import pytest
import xml.etree.ElementTree as ET
from datetime import datetime
import pytz

from parser import parse_green_button_xml


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
