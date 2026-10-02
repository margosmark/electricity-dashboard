import { describe, it, expect } from 'vitest';
import { format } from 'date-fns';
import {
  getBillingPeriod,
  parseGreenButtonXML,
  categorizeTOU,
  categorizeULO,
  processRawData,
  filterByDateRange,
  aggregateChartData,
  buildActiveChartData,
  calculateComparison,
  calculateVampire,
  detectAnomalies,
  buildHeatmapData,
  isWeekendBar,
  getBarColor,
  getTouRateKey,
  getUloRateKey,
  parseGreenButtonUsagePoints,
  processedDataToCSV,
  csvExportFilename,
  csvFilenameForRows,
  CSV_COLUMNS,
  calculateTrueBill,
  parseChargeInput,
  hasExtraCharges,
  countMonthsInView,
  EMPTY_EXTRA_CHARGES,
  BASELINE_ESTIMATE_CAPTION,
  selectInitialWindow,
  calculateFullDataTotals,
  type RateSet,
  type ProcessedPoint,
  type DataPoint,
} from './energy';

const sampleRateSet: RateSet = {
  effectiveDate: '2023-01-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

function makeProcessedPoint(overrides: Partial<ProcessedPoint> & { timestamp: number }): ProcessedPoint {
  const dateObj = new Date(overrides.timestamp * 1000);
  return {
    usage_kwh: 1.0,
    dateObj,
    dayStr: format(dateObj, 'yyyy-MM-dd'),
    hourStr: format(dateObj, 'HH:mm'),
    touCategory: 'Off-Peak',
    uloCategory: 'Overnight',
    isWinter: false,
    costTOU: 0,
    costTiered: 0,
    costULO: 0,
    activeRateSet: sampleRateSet,
    ...overrides,
  };
}

describe('getBillingPeriod', () => {
  it('returns correct period when billing day is 1', () => {
    const ref = new Date('2024-01-15');
    const { start, end } = getBillingPeriod(ref, 1);
    expect(start.toISOString().split('T')[0]).toBe('2024-01-01');
    expect(end.toISOString().split('T')[0]).toBe('2024-01-31');
  });

  it('returns previous month period when date is before billing day', () => {
    const ref = new Date('2024-01-10');
    const { start, end } = getBillingPeriod(ref, 15);
    expect(start.toISOString().split('T')[0]).toBe('2023-12-15');
    expect(end.toISOString().split('T')[0]).toBe('2024-01-14');
  });

  it('returns current month period when date is on or after billing day', () => {
    const ref = new Date('2024-01-20');
    const { start, end } = getBillingPeriod(ref, 15);
    expect(start.toISOString().split('T')[0]).toBe('2024-01-15');
    expect(end.toISOString().split('T')[0]).toBe('2024-02-14');
  });
});

describe('parseGreenButtonXML', () => {
  it('parses valid XML with IntervalReading elements', () => {
    const xml = `<?xml version="1.0"?>
    <feed>
      <entry>
        <IntervalBlock>
          <IntervalReading>
            <timePeriod><start>1704067200</start></timePeriod>
            <value>1500</value>
          </IntervalReading>
          <IntervalReading>
            <timePeriod><start>1704070800</start></timePeriod>
            <value>2000</value>
          </IntervalReading>
        </IntervalBlock>
      </entry>
    </feed>`;
    const result = parseGreenButtonXML(xml);
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe(1704067200);
    expect(result[0].usage_kwh).toBe(1.5);
    expect(result[1].timestamp).toBe(1704070800);
    expect(result[1].usage_kwh).toBe(2.0);
  });

  it('returns empty array for XML with no readings', () => {
    const xml = `<?xml version="1.0"?><feed><entry></entry></feed>`;
    expect(parseGreenButtonXML(xml)).toEqual([]);
  });

  it('skips readings with zero timestamp', () => {
    const xml = `<?xml version="1.0"?>
    <feed>
      <IntervalReading>
        <timePeriod><start>0</start></timePeriod>
        <value>1000</value>
      </IntervalReading>
    </feed>`;
    expect(parseGreenButtonXML(xml)).toEqual([]);
  });

  it('sorts readings by timestamp', () => {
    const xml = `<?xml version="1.0"?>
    <feed>
      <IntervalReading>
        <timePeriod><start>200</start></timePeriod>
        <value>200</value>
      </IntervalReading>
      <IntervalReading>
        <timePeriod><start>100</start></timePeriod>
        <value>100</value>
      </IntervalReading>
    </feed>`;
    const result = parseGreenButtonXML(xml);
    expect(result[0].timestamp).toBe(100);
    expect(result[1].timestamp).toBe(200);
  });
});

describe('categorizeTOU', () => {
  it('returns Off-Peak for weekends regardless of hour', () => {
    const saturday = new Date('2024-01-06T14:00:00');
    const sunday = new Date('2024-01-07T10:00:00');
    expect(categorizeTOU(saturday)).toBe('Off-Peak');
    expect(categorizeTOU(sunday)).toBe('Off-Peak');
  });

  it('returns Off-Peak for weekday nights (after 19:00 or before 07:00)', () => {
    const earlyMorning = new Date('2024-01-08T05:00:00');
    const evening = new Date('2024-01-08T22:00:00');
    expect(categorizeTOU(earlyMorning)).toBe('Off-Peak');
    expect(categorizeTOU(evening)).toBe('Off-Peak');
  });

  it('returns On-Peak for winter weekday morning peak (7-11)', () => {
    const winterMorning = new Date('2024-01-08T09:00:00');
    expect(categorizeTOU(winterMorning)).toBe('On-Peak');
  });

  it('returns On-Peak for winter weekday evening peak (17-19)', () => {
    const winterEvening = new Date('2024-01-08T18:00:00');
    expect(categorizeTOU(winterEvening)).toBe('On-Peak');
  });

  it('returns Mid-Peak for winter weekday midday (11-17)', () => {
    const winterMidday = new Date('2024-01-08T14:00:00');
    expect(categorizeTOU(winterMidday)).toBe('Mid-Peak');
  });

  it('returns On-Peak for summer weekday afternoon (11-17)', () => {
    const summerAfternoon = new Date('2024-07-08T14:00:00');
    expect(categorizeTOU(summerAfternoon)).toBe('On-Peak');
  });

  it('returns Mid-Peak for summer weekday morning (7-11)', () => {
    const summerMorning = new Date('2024-07-08T09:00:00');
    expect(categorizeTOU(summerMorning)).toBe('Mid-Peak');
  });
});

describe('categorizeULO', () => {
  it('returns Overnight for hours 23-07', () => {
    expect(categorizeULO(new Date('2024-01-08T03:00:00'))).toBe('Overnight');
    expect(categorizeULO(new Date('2024-01-08T23:30:00'))).toBe('Overnight');
  });

  it('returns Weekend Off-Peak for weekend daytime hours', () => {
    const saturday = new Date('2024-01-06T14:00:00');
    const sunday = new Date('2024-01-07T10:00:00');
    expect(categorizeULO(saturday)).toBe('Weekend Off-Peak');
    expect(categorizeULO(sunday)).toBe('Weekend Off-Peak');
  });

  it('returns On-Peak for weekday 16-21', () => {
    expect(categorizeULO(new Date('2024-01-08T18:00:00'))).toBe('On-Peak');
  });

  it('returns Mid-Peak for weekday 07-16 and 21-23', () => {
    expect(categorizeULO(new Date('2024-01-08T10:00:00'))).toBe('Mid-Peak');
    expect(categorizeULO(new Date('2024-01-08T22:00:00'))).toBe('Mid-Peak');
  });
});

describe('getTouRateKey', () => {
  it('maps categories to correct rate keys', () => {
    expect(getTouRateKey('Off-Peak')).toBe('offPeak');
    expect(getTouRateKey('Mid-Peak')).toBe('midPeak');
    expect(getTouRateKey('On-Peak')).toBe('onPeak');
  });
});

describe('getUloRateKey', () => {
  it('maps categories to correct rate keys', () => {
    expect(getUloRateKey('Overnight')).toBe('overnight');
    expect(getUloRateKey('Weekend Off-Peak')).toBe('weekendOffPeak');
    expect(getUloRateKey('Mid-Peak')).toBe('midPeak');
    expect(getUloRateKey('On-Peak')).toBe('onPeak');
  });
});

describe('processRawData', () => {
  it('returns empty array when rateHistory is empty', () => {
    expect(processRawData([{ timestamp: 100, usage_kwh: 1 }], [])).toEqual([]);
  });

  it('processes raw data with correct categories and costs', () => {
    const rawData: DataPoint[] = [{ timestamp: 1704700800, usage_kwh: 2.0 }];
    const result = processRawData(rawData, [sampleRateSet]);
    expect(result).toHaveLength(1);
    expect(result[0].touCategory).toBeDefined();
    expect(result[0].uloCategory).toBeDefined();
    expect(result[0].costTOU).toBeGreaterThan(0);
    expect(result[0].costULO).toBeGreaterThan(0);
    expect(result[0].activeRateSet).toEqual(sampleRateSet);
  });
});

describe('filterByDateRange', () => {
  const points: ProcessedPoint[] = [
    makeProcessedPoint({ timestamp: 1704067200 }),
    makeProcessedPoint({ timestamp: 1704153600 }),
    makeProcessedPoint({ timestamp: 1704240000 }),
  ];

  it('returns all data when dates are empty', () => {
    expect(filterByDateRange(points, '', '')).toEqual(points);
  });

  it('filters data within date range', () => {
    const result = filterByDateRange(points, '2024-01-01', '2024-01-02');
    expect(result.length).toBeLessThanOrEqual(points.length);
  });
});

describe('aggregateChartData', () => {
  const points: ProcessedPoint[] = [
    makeProcessedPoint({ timestamp: 1704067200, usage_kwh: 1.0, costTOU: 0.1, costULO: 0.05, costTiered: 0.12 }),
    makeProcessedPoint({ timestamp: 1704153600, usage_kwh: 2.0, costTOU: 0.2, costULO: 0.1, costTiered: 0.24 }),
  ];

  it('aggregates hourly data correctly', () => {
    const result = aggregateChartData(points, 'hourly');
    expect(result).toHaveLength(2);
    expect(result[0].key).toBeDefined();
  });

  it('aggregates daily data correctly', () => {
    const result = aggregateChartData(points, 'daily');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].usage).toBeGreaterThan(0);
  });

  it('sorts results by key', () => {
    const result = aggregateChartData(points, 'daily');
    for (let i = 1; i < result.length; i++) {
      expect(result[i].key >= result[i - 1].key).toBe(true);
    }
  });
});

describe('buildActiveChartData', () => {
  const points: ProcessedPoint[] = [
    makeProcessedPoint({ timestamp: 1704067200, usage_kwh: 1.0, costTOU: 0.1, costULO: 0.05, costTiered: 0.12 }),
  ];

  it('returns aggregated data without zoom target', () => {
    const result = buildActiveChartData(points, 'daily', null);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

describe('calculateComparison', () => {
  it('returns null for empty data', () => {
    expect(calculateComparison([])).toBeNull();
  });

  it('sums costs correctly', () => {
    const data = [
      { label: 'A', usage: 1, key: 'a', costTOU: 10, costULO: 5, costTiered: 8 },
      { label: 'B', usage: 2, key: 'b', costTOU: 20, costULO: 10, costTiered: 16 },
    ];
    const result = calculateComparison(data);
    expect(result).toEqual({ TOU: 30, Tiered: 24, ULO: 15 });
  });
});

describe('calculateVampire', () => {
  it('returns zero for empty data', () => {
    expect(calculateVampire([])).toEqual({ cost: 0, watts: 0 });
  });

  it('calculates vampire load from lowest 5% of usage', () => {
    const points: ProcessedPoint[] = Array.from({ length: 20 }, (_, i) =>
      makeProcessedPoint({ timestamp: 1704067200 + i * 3600, usage_kwh: i + 1 }),
    );
    const result = calculateVampire(points);
    expect(result.watts).toBeGreaterThan(0);
    expect(result.cost).toBeGreaterThan(0);
  });
});

describe('detectAnomalies', () => {
  it('returns empty array when no anomalies', () => {
    const points: ProcessedPoint[] = [
      makeProcessedPoint({ timestamp: 1704067200, usage_kwh: 1.0 }),
    ];
    expect(detectAnomalies(points, points)).toEqual([]);
  });

  it('detects significant spikes', () => {
    const normalPoints: ProcessedPoint[] = Array.from({ length: 10 }, (_, i) =>
      makeProcessedPoint({ timestamp: 1704067200 + i * 86400, usage_kwh: 5.0 }),
    );
    const spikePoint = makeProcessedPoint({ timestamp: 1704960000, usage_kwh: 50.0 });
    const allPoints = [...normalPoints, spikePoint];
    const anomalies = detectAnomalies(allPoints, allPoints);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0].usage).toBe(50.0);
  });
});

describe('buildHeatmapData', () => {
  it('returns grid and maxAvg', () => {
    const points: ProcessedPoint[] = [
      makeProcessedPoint({ timestamp: 1704067200, usage_kwh: 2.0 }),
    ];
    const result = buildHeatmapData(points);
    expect(result.grid).toHaveLength(7);
    expect(result.grid[0]).toHaveLength(24);
    expect(result.maxAvg).toBeGreaterThanOrEqual(0);
  });

  it('returns zero grid for empty data', () => {
    const result = buildHeatmapData([]);
    expect(result.maxAvg).toBe(0);
  });
});

describe('isWeekendBar', () => {
  it('returns true for Saturday in daily view', () => {
    expect(isWeekendBar('daily', '2024-01-06')).toBe(true);
  });

  it('returns true for Sunday in daily view', () => {
    expect(isWeekendBar('daily', '2024-01-07')).toBe(true);
  });

  it('returns false for weekday in daily view', () => {
    expect(isWeekendBar('daily', '2024-01-08')).toBe(false);
  });

  it('returns false for non-daily view even if weekend', () => {
    expect(isWeekendBar('weekly', '2024-01-06')).toBe(false);
    expect(isWeekendBar('monthly', '2024-01-06')).toBe(false);
    expect(isWeekendBar('hourly', '2024-01-06')).toBe(false);
  });

  it('returns false for undefined key', () => {
    expect(isWeekendBar('daily', undefined)).toBe(false);
  });
});

describe('getBarColor', () => {
  it('returns orange for weekend bars in daily view', () => {
    expect(getBarColor('daily', '2024-01-06')).toBe('#F97316');
    expect(getBarColor('daily', '2024-01-07')).toBe('#F97316');
  });

  it('returns blue for weekday bars in daily view', () => {
    expect(getBarColor('daily', '2024-01-08')).toBe('#2563EB');
  });

  it('returns blue for non-daily views', () => {
    expect(getBarColor('weekly', '2024-01-06')).toBe('#2563EB');
    expect(getBarColor('hourly', '2024-01-08')).toBe('#2563EB');
  });
});

/* ========================================================================== *
 * Wave B — CSV export of the processed per-interval table
 * ========================================================================== */

describe('processedDataToCSV', () => {
  const rows: ProcessedPoint[] = [
    makeProcessedPoint({
      timestamp: 1704067200, usage_kwh: 1.5,
      costTOU: 0.123456, costTiered: 0.18, costULO: 0.0585,
    }),
    makeProcessedPoint({
      timestamp: 1704070800, usage_kwh: 2,
      costTOU: 0.2, costTiered: 0.24, costULO: 0.078,
    }),
  ];

  it('emits exactly the documented columns as the header row', () => {
    expect(CSV_COLUMNS).toEqual([
      'datetime', 'usage_kwh', 'tou_category', 'ulo_category',
      'costTOU', 'costTiered', 'costULO', 'activeRateSet.effectiveDate',
    ]);
    const csv = processedDataToCSV(rows);
    expect(csv.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
  });

  it('serializes one row per interval with ISO datetime, rounded costs and rate date', () => {
    const lines = processedDataToCSV(rows).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      '2024-01-01T00:00:00.000Z,1.5,Off-Peak,Overnight,0.1235,0.18,0.0585,2023-01-01',
    );
    expect(lines[2]).toBe(
      '2024-01-01T01:00:00.000Z,2,Off-Peak,Overnight,0.2,0.24,0.078,2023-01-01',
    );
  });

  it('follows the input order rather than re-sorting', () => {
    const reversed = [...rows].reverse();
    const lines = processedDataToCSV(reversed).trim().split('\n');
    expect(lines[1].startsWith('2024-01-01T01:00:00.000Z')).toBe(true);
  });

  it('quotes cells containing commas or quotes (RFC 4180)', () => {
    const tricky = makeProcessedPoint({
      timestamp: 1704067200,
      touCategory: 'Weird, "quoted"',
    });
    const csv = processedDataToCSV([tricky]);
    expect(csv).toContain('"Weird, ""quoted"""');
    // Plain cells must not gain stray quotes.
    expect(csv).toContain(',Overnight,');
  });

  it('returns only the header for an empty table', () => {
    expect(processedDataToCSV([])).toBe(CSV_COLUMNS.join(',') + '\n');
  });
});

describe('csv export filename', () => {
  it('follows the energy_export_<start>_<end>.csv pattern', () => {
    expect(csvExportFilename('2024-01-01', '2024-01-31')).toBe(
      'energy_export_2024-01-01_2024-01-31.csv',
    );
  });

  it('derives start/end from the exported rows', () => {
    const d1 = new Date(1704153600 * 1000);
    const d2 = new Date(1704240000 * 1000);
    const spanning = [
      makeProcessedPoint({ timestamp: 1704240000 }),
      makeProcessedPoint({ timestamp: 1704153600 }),
    ];
    const start = format(d1, 'yyyy-MM-dd');
    const end = format(d2, 'yyyy-MM-dd');
    expect(csvFilenameForRows(spanning)).toBe(`energy_export_${start}_${end}.csv`);
  });

  it('is still deterministic with no rows', () => {
    expect(csvFilenameForRows([])).toBe('energy_export_no-data_no-data.csv');
  });
});

/* ========================================================================== *
 * Wave B — multi-UsagePoint Green Button feeds
 * ========================================================================== */

const SINGLE_POINT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry>
    <id>urn:uuid:entry-block-a</id>
    <link href="https://utility.example/espi/UsagePoint/aaaaaaaa-1111-2222-3333-444444444444/MeterReading/mr-a/IntervalBlock/ib-a" rel="self" type="espi-entry/IntervalBlock"/>
    <content>
      <espi:IntervalBlock>
        <espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading>
        <espi:IntervalReading><espi:timePeriod><espi:start>1704070800</espi:start></espi:timePeriod><espi:value>2000</espi:value></espi:IntervalReading>
      </espi:IntervalBlock>
    </content>
  </entry>
</feed>`;

const TWO_POINT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry>
    <id>urn:uuid:ltp</id>
    <link href="https://utility.example/espi/UsagePoint" rel="up" type="espi-feed/LocalTimeParameters"/>
    <content><espi:LocalTimeParameters><espi:tzOffset>-18000</espi:tzOffset></espi:LocalTimeParameters></content>
  </entry>
  <entry>
    <id>urn:uuid:block-a</id>
    <link href="https://utility.example/espi/UsagePoint/aaaaaaaa-1111-2222-3333-444444444444" rel="up" type="espi-feed/MeterReading"/>
    <link href="https://utility.example/espi/UsagePoint/aaaaaaaa-1111-2222-3333-444444444444/MeterReading/mr-a/IntervalBlock/ib-a" rel="self" type="espi-entry/IntervalBlock"/>
    <link href="https://utility.example/espi/UsagePoint/bbbbbbbb-1111-2222-3333-444444444444" rel="related" type="espi-entry/UsagePoint"/>
    <content>
      <espi:IntervalBlock>
        <espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading>
        <espi:IntervalReading><espi:timePeriod><espi:start>1704070800</espi:start></espi:timePeriod><espi:value>2000</espi:value></espi:IntervalReading>
      </espi:IntervalBlock>
    </content>
  </entry>
  <entry>
    <id>urn:uuid:block-b</id>
    <link href="https://utility.example/espi/UsagePoint/bbbbbbbb-1111-2222-3333-444444444444/MeterReading/mr-b/IntervalBlock/ib-b" rel="self" type="espi-entry/IntervalBlock"/>
    <content>
      <espi:IntervalBlock>
        <espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>9000</espi:value></espi:IntervalReading>
        <espi:IntervalReading><espi:timePeriod><espi:start>1704070800</espi:start></espi:timePeriod><espi:value>4000</espi:value></espi:IntervalReading>
      </espi:IntervalBlock>
    </content>
  </entry>
</feed>`;

describe('parseGreenButtonUsagePoints', () => {
  it('single UsagePoint → exactly one group, readings identical to the legacy parse', () => {
    const groups = parseGreenButtonUsagePoints(SINGLE_POINT_XML);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(groups[0].label).toContain('aaaaaaaa');
    expect(groups[0].blocks).toBe(1);
    expect(groups[0].readings).toEqual(parseGreenButtonXML(SINGLE_POINT_XML));
    expect(groups[0].readings).toHaveLength(2);
  });

  it('two UsagePoints → two groups holding only their own rows', () => {
    const groups = parseGreenButtonUsagePoints(TWO_POINT_XML);
    expect(groups).toHaveLength(2);
    const [a, b] = groups;
    expect(a.id).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(b.id).toBe('bbbbbbbb-1111-2222-3333-444444444444');
    expect(a.readings.map((r) => r.usage_kwh)).toEqual([1.5, 2.0]);
    expect(b.readings.map((r) => r.usage_kwh)).toEqual([9.0, 4.0]);
    // The entry that merely links to the other point must not donate rows to it.
    expect(a.readings).toHaveLength(2);
    expect(b.readings).toHaveLength(2);
  });

  it('combining every group reproduces the legacy merged read', () => {
    const groups = parseGreenButtonUsagePoints(TWO_POINT_XML);
    const combined = groups
      .flatMap((g) => g.readings)
      .sort((x, y) => x.timestamp - y.timestamp);
    expect(combined).toEqual(parseGreenButtonXML(TWO_POINT_XML));
    expect(combined).toHaveLength(4);
  });

  it('groups with no UsagePoint link collapse into one unnamed meter', () => {
    const xml = `<?xml version="1.0"?><feed><entry><IntervalBlock>
      <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
    </IntervalBlock></entry></feed>`;
    const groups = parseGreenButtonUsagePoints(xml);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('');
    expect(groups[0].readings).toHaveLength(1);
  });

  it('readings outside any entry stay in the unnamed meter (legacy behavior)', () => {
    const xml = `<?xml version="1.0"?><feed>
      <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
      <entry><IntervalBlock>
        <IntervalReading><timePeriod><start>1704070800</start></timePeriod><value>2000</value></IntervalReading>
      </IntervalBlock></entry>
    </feed>`;
    const groups = parseGreenButtonUsagePoints(xml);
    expect(groups).toHaveLength(1);
    expect(groups[0].readings).toHaveLength(2);
    expect(parseGreenButtonXML(xml)).toHaveLength(2);
  });

  it('a feed with no readings yields no groups at all', () => {
    expect(parseGreenButtonUsagePoints('<?xml version="1.0"?><feed><entry></entry></feed>')).toEqual([]);
    expect(parseGreenButtonXML('<?xml version="1.0"?><feed><entry></entry></feed>')).toEqual([]);
  });

  it('groups are ordered by their first reading (stable for the picker)', () => {
    const groups = parseGreenButtonUsagePoints(TWO_POINT_XML);
    const expected = [...groups].sort(
      (x, y) => (x.readings[0].timestamp - y.readings[0].timestamp) || x.id.localeCompare(y.id),
    );
    expect(groups.map((g) => g.id)).toEqual(expected.map((g) => g.id));
  });
});

/* ========================================================================== *
 * Wave B — true-bill estimate from local user inputs
 * ========================================================================== */

describe('parseChargeInput', () => {
  it('treats empty / whitespace as unset', () => {
    expect(parseChargeInput('')).toBeNull();
    expect(parseChargeInput('   ')).toBeNull();
    expect(parseChargeInput(null)).toBeNull();
    expect(parseChargeInput(undefined)).toBeNull();
  });

  it('rejects garbage and negatives instead of coercing them to zero', () => {
    expect(parseChargeInput('abc')).toBeNull();
    expect(parseChargeInput('-2')).toBeNull();
    expect(parseChargeInput('Infinity')).toBeNull();
  });

  it('parses plain and padded numbers, and accepts an explicit zero', () => {
    expect(parseChargeInput('13')).toBe(13);
    expect(parseChargeInput(' 0.0125 ')).toBe(0.0125);
    expect(parseChargeInput('0')).toBe(0);
  });
});

describe('hasExtraCharges', () => {
  it('is false for the seeded-empty state', () => {
    expect(hasExtraCharges(EMPTY_EXTRA_CHARGES)).toBe(false);
  });

  it('is true as soon as any single field holds a number', () => {
    expect(hasExtraCharges({ ...EMPTY_EXTRA_CHARGES, hstPct: '13' })).toBe(true);
    expect(hasExtraCharges({ ...EMPTY_EXTRA_CHARGES, deliveryFlat: '15' })).toBe(true);
    expect(hasExtraCharges({ ...EMPTY_EXTRA_CHARGES, deliveryPerKwh: '0.01' })).toBe(true);
    expect(hasExtraCharges({ ...EMPTY_EXTRA_CHARGES, regulatoryPerKwh: '0.0005' })).toBe(true);
  });

  it('stays false when the fields only hold unusable text', () => {
    expect(hasExtraCharges({ ...EMPTY_EXTRA_CHARGES, hstPct: 'abc' })).toBe(false);
  });
});

describe('countMonthsInView', () => {
  it('counts distinct calendar months in the window', () => {
    const rows = [
      makeProcessedPoint({ timestamp: 1704153600 }),
      makeProcessedPoint({ timestamp: 1704240000 }),
      makeProcessedPoint({ timestamp: 1707998400 }), // 2024-02-15 12:00Z — safely February in any TZ
    ];
    expect(countMonthsInView(rows)).toBe(2);
  });

  it('is zero for an empty window', () => {
    expect(countMonthsInView([])).toBe(0);
  });
});

describe('calculateTrueBill', () => {
  const base = { variableCost: 10, totalKwh: 100, months: 1 };

  it('returns null while every input is empty, so today behavior is untouched', () => {
    expect(calculateTrueBill({ ...base, charges: EMPTY_EXTRA_CHARGES })).toBeNull();
  });

  it('returns null when the fields hold only unusable text', () => {
    expect(
      calculateTrueBill({ ...base, charges: { ...EMPTY_EXTRA_CHARGES, hstPct: 'abc', deliveryPerKwh: '-1' } }),
    ).toBeNull();
  });

  it('stacks delivery $/kWh + regulatory $/kWh + HST on top of the variable cost', () => {
    const bill = calculateTrueBill({
      ...base,
      charges: { deliveryPerKwh: '0.01', deliveryFlat: '', regulatoryPerKwh: '0.0005', hstPct: '13' },
    });
    expect(bill).not.toBeNull();
    expect(bill!.variable).toBe(10);
    expect(bill!.delivery).toBeCloseTo(1, 10); // 0.01 * 100 kWh
    expect(bill!.regulatory).toBeCloseTo(0.05, 10); // 0.0005 * 100 kWh
    expect(bill!.hst).toBeCloseTo(0.13 * (10 + 1 + 0.05), 10);
    expect(bill!.total).toBeCloseTo(12.4865, 10);
    expect(bill!.caption).toContain('variable energy charges');
    expect(bill!.caption).toContain('delivery ($0.0100/kWh)');
    expect(bill!.caption).toContain('regulatory ($0.0005/kWh)');
    expect(bill!.caption).toContain('HST (13%)');
  });

  it('charges flat delivery once per month present in the window', () => {
    const bill = calculateTrueBill({
      ...base,
      months: 3,
      charges: { ...EMPTY_EXTRA_CHARGES, deliveryFlat: '15' },
    });
    expect(bill!.delivery).toBe(45);
    expect(bill!.regulatory).toBe(0);
    expect(bill!.hst).toBe(0); // HST left empty → not applied
    expect(bill!.total).toBeCloseTo(55, 10);
    expect(bill!.caption).toContain('delivery ($15.00/month)');
  });

  it('allows both delivery modes at the same time', () => {
    const bill = calculateTrueBill({
      ...base,
      charges: { ...EMPTY_EXTRA_CHARGES, deliveryPerKwh: '0.01', deliveryFlat: '15' },
    });
    expect(bill!.delivery).toBeCloseTo(16, 10);
  });

  it('applies HST to variable + delivery + regulatory (not just variable)', () => {
    const bill = calculateTrueBill({
      ...base,
      charges: { ...EMPTY_EXTRA_CHARGES, deliveryPerKwh: '0.01', hstPct: '13' },
    });
    expect(bill!.hst).toBeCloseTo(0.13 * (10 + 1), 10);
    expect(bill!.total).toBeCloseTo(11 + 1.43, 10);
    expect(bill!.included).toEqual(['variable energy charges', 'delivery ($0.0100/kWh)', 'HST (13%)']);
  });

  it('does not invent HST when the HST field is empty', () => {
    const bill = calculateTrueBill({
      ...base,
      charges: { ...EMPTY_EXTRA_CHARGES, deliveryPerKwh: '0.01' },
    });
    expect(bill!.hst).toBe(0);
    expect(bill!.caption).not.toContain('HST');
    expect(bill!.total).toBeCloseTo(11, 10);
  });

  it('keeps the baseline caption free of any "included" claim', () => {
    expect(BASELINE_ESTIMATE_CAPTION).toContain(
      'does not include fixed delivery charges, regulatory charges, or HST',
    );
  });
});

/** One reading per day at local noon (noon keeps the local calendar day stable in any TZ). */
function dailySeries(fromISO: string, toISO: string): DataPoint[] {
  const out: DataPoint[] = [];
  let d = new Date(`${fromISO}T12:00:00`);
  const end = new Date(`${toISO}T12:00:00`);
  while (d.getTime() <= end.getTime()) {
    out.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: 1 });
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

describe('selectInitialWindow', () => {
  it('returns null when there is no data', () => {
    expect(selectInitialWindow([], 1, new Date('2026-10-02T12:00:00'))).toBeNull();
  });

  // The proven first-load defect: data ends 2026-10-01, billing_day=1 opens
  // Oct 1-31 = ~12h of data in a 31-day window.
  it('regression: never opens a mostly-future window after upload (E2E 2026-10-02)', () => {
    const data = dailySeries('2026-07-01', '2026-10-01');
    const w = selectInitialWindow(data, 1, new Date('2026-10-02T12:00:00'));
    expect(w).toEqual({ start: '2026-09-01', end: '2026-10-01', scope: 'Custom' });
    // the window must be fully covered by data, not 1 day out of 31
    const days = new Set(data.map((d) => format(new Date(d.timestamp * 1000), 'yyyy-MM-dd')));
    let covered = 0;
    for (let d = new Date('2026-09-01T12:00:00'); d <= new Date('2026-10-01T12:00:00'); d = new Date(d.getTime() + 86400000)) {
      if (days.has(format(d, 'yyyy-MM-dd'))) covered++;
    }
    expect(covered).toBe(31);
  });

  it('keeps BillingPeriod scope when the billing window is at least half covered', () => {
    const data = dailySeries('2026-07-01', '2026-10-02');
    const w = selectInitialWindow(data, 15, new Date('2026-10-02T12:00:00'));
    expect(w).toEqual({ start: '2026-09-15', end: '2026-10-14', scope: 'BillingPeriod' });
  });

  it('clamps the anchor to min(last data day, today) — never anchors past today', () => {
    // Readings are timestamped 28 days ahead of today; the anchor must stay on
    // today, so the window must NOT run into November.
    const data = dailySeries('2026-07-01', '2026-10-30');
    const w = selectInitialWindow(data, 15, new Date('2026-10-02T12:00:00'));
    expect(w).toEqual({ start: '2026-09-15', end: '2026-10-14', scope: 'BillingPeriod' });
    expect(w!.end < '2026-11-01').toBe(true);
  });

  it('falls back to Month scope when the billing window is mostly empty', () => {
    // billing_day=20 anchors Sep 20 - Oct 19 (only 2 of 30 days have data);
    // the calendar month of the anchor (Sep 1-30) is 21/30 covered.
    const data = dailySeries('2026-07-01', '2026-09-21');
    const w = selectInitialWindow(data, 20, new Date('2026-09-21T12:00:00'));
    expect(w).toEqual({ start: '2026-09-01', end: '2026-09-30', scope: 'Month' });
  });

  it('falls back to the trailing data-anchored window when both are mostly empty', () => {
    const data = dailySeries('2026-07-01', '2026-07-05');
    const w = selectInitialWindow(data, 1, new Date('2026-10-02T12:00:00'));
    expect(w).toEqual({ start: '2026-07-01', end: '2026-07-05', scope: 'Custom' });
  });

  it('never starts before the first reading (clamped to the data range)', () => {
    const data = dailySeries('2026-07-01', '2026-07-05');
    const w = selectInitialWindow(data, 1, new Date('2026-07-10T12:00:00'));
    expect(w!.start).toBe('2026-07-01');
  });
});

describe('calculateFullDataTotals', () => {
  it('returns null for empty data', () => {
    expect(calculateFullDataTotals([])).toBeNull();
  });

  it('sums kWh and per-plan cost over ALL data, with best/worst plan and the delta', () => {
    const points: ProcessedPoint[] = [
      makeProcessedPoint({ timestamp: 1705327200, usage_kwh: 10, costTOU: 0.5, costULO: 0.2 }), // 2024-01-15 12:00 local-ish
    ];
    const t = calculateFullDataTotals(points)!;
    expect(t.totalKwh).toBeCloseTo(10, 6);
    expect(t.costTOU).toBeCloseTo(0.5, 6);
    expect(t.costULO).toBeCloseTo(0.2, 6);
    // tier1 only: usage 10 <= monthly tiered threshold
    expect(t.costTiered).toBeCloseTo(1.2, 6);
    expect(t.bestPlan).toBe('ULO');
    expect(t.worstPlan).toBe('Tiered');
    expect(t.planDelta).toBeCloseTo(1.0, 6);
    expect(t.firstDate).toBe(format(new Date(1705327200 * 1000), 'yyyy-MM-dd'));
    expect(t.lastDate).toBe(format(new Date(1705327200 * 1000), 'yyyy-MM-dd'));
  });

  it('spans the whole dataset (first to last reading), not the visible window', () => {
    const points: ProcessedPoint[] = [
      makeProcessedPoint({ timestamp: 1705327200, usage_kwh: 5, costTOU: 0.25, costULO: 0.1 }), // Jan 2024
      makeProcessedPoint({ timestamp: 1709946000, usage_kwh: 5, costTOU: 0.25, costULO: 0.1 }), // Mar 2024
    ];
    const t = calculateFullDataTotals(points)!;
    expect(t.totalKwh).toBeCloseTo(10, 6);
    expect(t.costTOU).toBeCloseTo(0.5, 6);
    expect(t.firstDate).toBe(format(new Date(1705327200 * 1000), 'yyyy-MM-dd'));
    expect(t.lastDate).toBe(format(new Date(1709946000 * 1000), 'yyyy-MM-dd'));
  });

  it('applies the tiered tier-2 threshold per month instead of flat tier1', () => {
    // 30 kWh in a single winter-ish day against thresholdSummer 600 kWh/month
    // scaled to the month's covered days: th = 600 * (1 / 30.4).
    const th = 600 * (1 / 30.4);
    const expectedTiered = th * 0.12 + (30 - th) * 0.142;
    const points: ProcessedPoint[] = [
      makeProcessedPoint({ timestamp: 1705327200, usage_kwh: 30, costTOU: 0, costULO: 0 }),
    ];
    const t = calculateFullDataTotals(points)!;
    expect(t.costTiered).toBeCloseTo(expectedTiered, 6);
    expect(t.costTiered).not.toBeCloseTo(30 * 0.12, 3); // flat tier1 would be wrong
  });
});
