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
  mergeReadings,
  classifyDayShape,
  calculateWfhShare,
  calculateAlwaysOnFloor,
  inferIntervalHours,
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

/* ========================================================================== *
 * Wave F — multi-export merge
 * ========================================================================== */

const localTs = (y: number, m: number, d: number, h: number) =>
  Math.floor(new Date(y, m, d, h).getTime() / 1000);

function rowSeq(startTs: number, hours: number, usage: number): DataPoint[] {
  return Array.from({ length: hours }, (_, i) => ({
    timestamp: startTs + i * 3600,
    usage_kwh: usage,
  }));
}

describe('mergeReadings', () => {
  it('returns an empty result for no sources at all', () => {
    const r = mergeReadings([]);
    expect(r.readings).toEqual([]);
    expect(r.totalRows).toBe(0);
    expect(r.duplicateRows).toBe(0);
    expect(r.mergedRows).toBe(0);
    expect(r.firstDate).toBe('');
    expect(r.lastDate).toBe('');
    expect(r.files).toEqual([]);
  });

  it('joins two disjoint exports into one ascending range', () => {
    const jan = rowSeq(localTs(2026, 0, 1, 0), 4, 1.5);
    const feb = rowSeq(localTs(2026, 1, 1, 0), 6, 2.5);
    const r = mergeReadings([
      { name: 'january.xml', readings: jan },
      { name: 'february.xml', readings: feb },
    ]);

    expect(r.mergedRows).toBe(10);
    expect(r.totalRows).toBe(10);
    expect(r.duplicateRows).toBe(0);
    expect(r.firstDate).toBe('2026-01-01');
    expect(r.lastDate).toBe('2026-02-01');
    for (let i = 1; i < r.readings.length; i++) {
      expect(r.readings[i].timestamp).toBeGreaterThan(r.readings[i - 1].timestamp);
    }
    expect(r.files).toHaveLength(2);
    expect(r.files[0]).toMatchObject({ name: 'january.xml', rows: 4, rawRows: 4, duplicates: 0 });
    expect(r.files[1]).toMatchObject({ name: 'february.xml', rows: 6, rawRows: 6, duplicates: 0 });
  });

  it('drops overlapping timestamps and keeps the FIRST file’s value', () => {
    const t0 = localTs(2026, 0, 1, 0);
    const a = [
      { timestamp: t0, usage_kwh: 1.0 },
      { timestamp: t0 + 3600, usage_kwh: 2.0 },
    ];
    const b = [
      { timestamp: t0 + 3600, usage_kwh: 9.9 },
      { timestamp: t0 + 7200, usage_kwh: 3.0 },
    ];
    const r = mergeReadings([
      { name: 'first.xml', readings: a },
      { name: 'second.xml', readings: b },
    ]);

    expect(r.mergedRows).toBe(3);
    expect(r.totalRows).toBe(4);
    expect(r.duplicateRows).toBe(1);
    expect(r.readings.map((x) => x.usage_kwh)).toEqual([1.0, 2.0, 3.0]);
    expect(r.files[0]).toMatchObject({ rows: 2, duplicates: 0 });
    expect(r.files[1]).toMatchObject({ rows: 1, rawRows: 2, duplicates: 1 });
  });

  it('dedupes duplicate timestamps inside one file too', () => {
    const t0 = localTs(2026, 0, 1, 0);
    const r = mergeReadings([
      {
        name: 'messy.xml',
        readings: [
          { timestamp: t0, usage_kwh: 1 },
          { timestamp: t0, usage_kwh: 7 },
          { timestamp: t0 + 3600, usage_kwh: 2 },
        ],
      },
    ]);
    expect(r.mergedRows).toBe(2);
    expect(r.duplicateRows).toBe(1);
    expect(r.readings[0].usage_kwh).toBe(1);
    expect(r.files[0]).toMatchObject({ rows: 2, rawRows: 3, duplicates: 1 });
  });

  it('still reports a fully duplicated file’s own date range', () => {
    const jan = rowSeq(localTs(2026, 0, 1, 0), 4, 1);
    const r = mergeReadings([
      { name: 'original.xml', readings: jan },
      { name: 'copy.xml', readings: jan },
    ]);
    expect(r.mergedRows).toBe(4);
    expect(r.duplicateRows).toBe(4);
    expect(r.files[1]).toMatchObject({ rows: 0, rawRows: 4, duplicates: 4 });
    expect(r.files[1].firstDate).toBe('2026-01-01');
    expect(r.files[1].lastDate).toBe('2026-01-01');
  });

  it('handles an empty file alongside a real one', () => {
    const jan = rowSeq(localTs(2026, 0, 1, 0), 4, 1);
    const r = mergeReadings([
      { name: 'empty.xml', readings: [] },
      { name: 'january.xml', readings: jan },
    ]);
    expect(r.mergedRows).toBe(4);
    expect(r.files[0]).toMatchObject({ rows: 0, rawRows: 0, firstDate: '', lastDate: '' });
    expect(r.firstDate).toBe('2026-01-01');
  });
});

/* ========================================================================== *
 * Wave F — appliance-signature labels
 * ========================================================================== */

function dayRows(hourly: Record<number, number>) {
  return Object.entries(hourly).map(([h, usage_kwh]) => ({
    dateObj: new Date(2026, 5, 1, Number(h), 0, 0),
    usage_kwh,
  }));
}

describe('classifyDayShape', () => {
  it('names a sustained >=3 kW run after the appliances that make one', () => {
    const s = classifyDayShape(dayRows({ 0: 0.5, 1: 4, 2: 4, 3: 4, 4: 4, 5: 0.5, 6: 0.5 }));
    expect(s.id).toBe('sustained-high');
    expect(s.label).toContain('water heater / EV / space heater');
    expect(s.detail).toContain('4 h straight at 3 kW or more');
    expect(s.detail).toContain('01:00–05:00');
  });

  it('names a brief high-kW run as a motor / kettle spike', () => {
    const s = classifyDayShape(dayRows({ 9: 0.5, 10: 5.5, 11: 4.5, 12: 0.5 }));
    expect(s.id).toBe('short-spike');
    expect(s.label).toContain('motor / kettle');
    expect(s.detail).toContain('Brief 2 h spike to 5.5 kW');
    expect(s.detail).toContain('10:00–12:00');
  });

  it('names a flat elevated overnight tail as something left on', () => {
    const s = classifyDayShape(
      dayRows({ 23: 2, 0: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 0.4 }),
    );
    expect(s.id).toBe('overnight-flat-tail');
    expect(s.label).toContain('left-on load');
    expect(s.detail).toContain('8 hours from 23:00 to 07:00 held 2.0 kW');
    expect(s.detail).toContain('never dipped');
  });

  it('falls back to an honest unclassified label that lists what it checked', () => {
    const s = classifyDayShape(dayRows({ 0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5, 5: 0.5, 6: 0.5 }));
    expect(s.id).toBe('unclassified');
    expect(s.label).toContain('nothing we can name');
    expect(s.detail).toContain('No 3 kW run lasting 4 h');
    expect(s.detail).toContain('no flat 23:00–07:00 block');
  });

  it('does not call a 3-hour run sustained, and a cool night is not a tail', () => {
    const s = classifyDayShape(dayRows({ 1: 4, 2: 4, 3: 4 }));
    expect(s.id).toBe('unclassified');
  });

  it('returns unclassified for a day with no recorded hours', () => {
    expect(classifyDayShape([]).id).toBe('unclassified');
  });

  it('labels anomalies it reports, not just the ones handed to it directly', () => {
    const normal: ProcessedPoint[] = Array.from({ length: 10 }, (_, i) =>
      makeProcessedPoint({ timestamp: 1704067200 + i * 86400, usage_kwh: 5.0 }),
    );
    const spike = makeProcessedPoint({ timestamp: 1704960000, usage_kwh: 50.0 });
    const anomalies = detectAnomalies([...normal, spike], [...normal, spike]);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0].signature).toBeDefined();
    expect(anomalies[0].signature.id).toBe('short-spike');
    expect(anomalies[0].signature.label.length).toBeGreaterThan(0);
  });
});

/* ========================================================================== *
 * Wave F — work-from-home window annotation
 * ========================================================================== */

describe('calculateWfhShare', () => {
  it('returns null for empty data and for a zero-energy window', () => {
    expect(calculateWfhShare([])).toBeNull();
    const zeros = [makeProcessedPoint({ timestamp: 1704067200, usage_kwh: 0 })];
    expect(calculateWfhShare(zeros)).toBeNull();
  });

  it('counts weekday 07:00–19:00 energy against the whole window', () => {
    const monday = Array.from({ length: 24 }, (_, h) =>
      makeProcessedPoint({ timestamp: localTs(2026, 5, 1, h), usage_kwh: 1 }),
    );
    const saturday = Array.from({ length: 24 }, (_, h) =>
      makeProcessedPoint({ timestamp: localTs(2026, 5, 6, h), usage_kwh: 1 }),
    );
    const w = calculateWfhShare([...monday, ...saturday])!;
    expect(w).not.toBeNull();
    expect(w.totalKwh).toBe(48);
    expect(w.kwh).toBe(12); // 07:00–18:00 inclusive on the Monday only
    expect(w.share).toBeCloseTo(0.25, 6);
    expect(w.weekdays).toBe(1);
    expect(w.label).toContain('07:00–19:00 weekdays');
  });

  it('excludes the edges: 06:00 and 19:00 are outside the window', () => {
    const rows = [
      makeProcessedPoint({ timestamp: localTs(2026, 5, 1, 6), usage_kwh: 10 }),
      makeProcessedPoint({ timestamp: localTs(2026, 5, 1, 19), usage_kwh: 10 }),
      makeProcessedPoint({ timestamp: localTs(2026, 5, 1, 7), usage_kwh: 10 }),
    ];
    const w = calculateWfhShare(rows)!;
    expect(w.kwh).toBe(10);
    expect(w.share).toBeCloseTo(1 / 3, 6);
  });
});

/* ========================================================================== *
 * Wave F — always-on floor phrasing + community benchmark
 * ========================================================================== */

function floorRows(counts: { low: number; lowKwh: number; high: number; highKwh: number }) {
  const total = counts.low + counts.high;
  return Array.from({ length: total }, (_, i) => {
    const usage_kwh = i < counts.low ? counts.lowKwh : counts.highKwh;
    return makeProcessedPoint({
      timestamp: 1704067200 + i * 3600,
      usage_kwh,
      costTOU: usage_kwh * 0.098,
      costTiered: usage_kwh * 0.12,
      costULO: usage_kwh * 0.039,
    });
  });
}

describe('calculateAlwaysOnFloor', () => {
  it('returns null for empty data', () => {
    expect(calculateAlwaysOnFloor([], 'TOU')).toBeNull();
  });

  it('phrases the floor as kWh/day and $/yr at the household’s own blended rate', () => {
    // 5th percentile index 5 lands on 0.5 kWh -> 12 kWh/day.
    const rows = floorRows({ low: 6, lowKwh: 0.5, high: 94, highKwh: 3.0 });
    const f = calculateAlwaysOnFloor(rows, 'TOU')!;
    expect(f).not.toBeNull();
    expect(f.kwhPerDay).toBeCloseTo(12, 6);
    expect(f.watts).toBeCloseTo(500, 6);
    expect(f.blendedRateCents).toBeCloseTo(9.8, 4);
    expect(f.annualCost).toBeCloseTo(12 * 365 * 0.098, 4);
    expect(f.label).toContain('Always-on floor ≈ 12.0 kWh/day');
    expect(f.label).toContain('≈ $429/yr');
    expect(f.benchmarkShare).toBeCloseTo(0.1, 6);
    expect(f.verdict).toBe('above');
    expect(f.detail).toContain('Community benchmark is about 10% of the bill');
    expect(f.detail).toContain('worth a plug-hunt');
  });

  it('calls a floor right on the benchmark "near"', () => {
    // 100 h at avg 10 kWh, floor 1 kWh/h -> exactly 10% of the bill.
    const rows = floorRows({ low: 10, lowKwh: 1.0, high: 90, highKwh: 11.0 });
    const f = calculateAlwaysOnFloor(rows, 'TOU')!;
    expect(f.billShare).toBeCloseTo(0.1, 6);
    expect(f.verdict).toBe('near');
    expect(f.detail).toContain('yours works out at 10%');
    expect(f.detail).toContain('in line with it');
  });

  it('calls a floor well under the benchmark "below"', () => {
    const rows = floorRows({ low: 6, lowKwh: 0.5, high: 94, highKwh: 8.0 });
    const f = calculateAlwaysOnFloor(rows, 'TOU')!;
    expect(f.billShare).toBeLessThan(0.08);
    expect(f.verdict).toBe('below');
    expect(f.detail).toContain('below it, nicely low');
  });

  it('prices against the selected plan, not a hard-coded rate', () => {
    const rows = floorRows({ low: 10, lowKwh: 1.0, high: 90, highKwh: 11.0 });
    for (const plan of ['TOU', 'Tiered', 'ULO'] as const) {
      const f = calculateAlwaysOnFloor(rows, plan)!;
      expect(f.blendedRateCents).toBeGreaterThan(0);
      expect(f.kwhPerDay).toBeCloseTo(24, 6);
    }
  });
});

/* ==========================================================================
 * Reading-interval (cadence) hygiene — 15- and 30-minute exports
 *
 * `usage_kwh` is energy PER READING INTERVAL, and every bundled fixture is
 * hourly, which is exactly why `base * 24` looked right: an hourly feed divides
 * by 1.0. Each assertion below is made twice — once from an hourly feed and
 * once from the SAME profile split into 15-minute readings — because a fix that
 * only re-labels the units would still fail here.
 * ========================================================================== */

/** 200 hours of varied usage — enough rows for a stable P05. */
const CADENCE_PROFILE = Array.from(
  { length: 200 },
  (_, i) => 0.35 + ((i * 37) % 97) / 30,
);

/** 2024-01-01T00:00:00Z — no DST transition inside the 200-hour window. */
const CADENCE_BASE_TS = 1704067200;

/**
 * The SAME hourly profile rendered at any cadence: each hour's kWh split evenly
 * across its readings, one interval apart. Costs track usage so the blended
 * rate is the same either way.
 */
function cadenceRows(stepSeconds: number): ProcessedPoint[] {
  const perHour = 3600 / stepSeconds;
  return CADENCE_PROFILE.flatMap((hourKwh, h) =>
    Array.from({ length: perHour }, (_, k) => {
      const usage_kwh = hourKwh / perHour;
      return makeProcessedPoint({
        timestamp: CADENCE_BASE_TS + h * 3600 + k * stepSeconds,
        usage_kwh,
        costTOU: usage_kwh * 0.098,
        costTiered: usage_kwh * 0.12,
        costULO: usage_kwh * 0.039,
      });
    }),
  );
}

/** The pre-fix P05: `sorted[floor(n * 0.05)]`, per interval. */
function legacyP05(rows: ProcessedPoint[]): number {
  const sorted = rows.map((r) => r.usage_kwh).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.05)] || sorted[0];
}

describe('inferIntervalHours', () => {
  it('measures the cadence from the data itself', () => {
    expect(inferIntervalHours(cadenceRows(3600))).toBeCloseTo(1, 9);
    expect(inferIntervalHours(cadenceRows(1800))).toBeCloseTo(0.5, 9);
    expect(inferIntervalHours(cadenceRows(900))).toBeCloseTo(0.25, 9);
  });

  it('reads gaps as epoch-SECONDS (900 s is a 0.25 h interval)', () => {
    expect(
      inferIntervalHours([
        { timestamp: 1704067200 },
        { timestamp: 1704068100 },
        { timestamp: 1704069000 },
      ]),
    ).toBeCloseTo(0.25, 9);
  });

  it('picks the cadence over an outage gap, a duplicate stamp and row order', () => {
    const rows = cadenceRows(900);
    const gappy = [
      ...rows.slice(0, 40),
      // A 7-hour outage, a duplicated timestamp, and the rows shuffled: none of
      // them outnumber the true cadence.
      makeProcessedPoint({ timestamp: rows[40].timestamp + 7 * 3600, usage_kwh: 1 }),
      ...rows.slice(40),
      makeProcessedPoint({ timestamp: rows[10].timestamp, usage_kwh: 1 }),
    ];
    expect(inferIntervalHours(gappy)).toBeCloseTo(0.25, 9);

    const backwards = [...rows].reverse();
    expect(inferIntervalHours(backwards)).toBeCloseTo(0.25, 9);
  });

  it('falls back to the hourly assumption when there is nothing to measure', () => {
    expect(inferIntervalHours([])).toBe(1);
    expect(inferIntervalHours([{ timestamp: CADENCE_BASE_TS }])).toBe(1);
    const identical = [0, 1, 2].map(() =>
      makeProcessedPoint({ timestamp: CADENCE_BASE_TS, usage_kwh: 1 }),
    );
    expect(inferIntervalHours(identical)).toBe(1);
  });
});

describe('cadence equivalence — the same house, 15-minute vs hourly export', () => {
  it('calculateVampire reports the same watts and cost either way', () => {
    const hourly = calculateVampire(cadenceRows(3600));
    const quarter = calculateVampire(cadenceRows(900));
    expect(hourly.watts).toBeGreaterThan(0);
    expect(quarter.watts).toBe(hourly.watts);
    expect(quarter.cost).toBe(hourly.cost);
  });

  it('calculateAlwaysOnFloor reports the same watts / kWh-day / annual cost', () => {
    const hourly = calculateAlwaysOnFloor(cadenceRows(3600), 'TOU')!;
    const quarter = calculateAlwaysOnFloor(cadenceRows(900), 'TOU')!;
    expect(quarter.watts).toBe(hourly.watts);
    expect(quarter.kwhPerDay).toBe(hourly.kwhPerDay);
    expect(quarter.annualCost).toBeCloseTo(hourly.annualCost, 6);
    expect(quarter.blendedRateCents).toBeCloseTo(hourly.blendedRateCents, 9);
    expect(quarter.label).toBe(hourly.label);
    // floorCost and billShare sum over rows: already cadence-independent, and
    // they must stay that way (changing them would break the benchmark verdict).
    expect(quarter.billShare).toBeCloseTo(hourly.billShare, 6);
    expect(quarter.verdict).toBe(hourly.verdict);
  });

  it('REGRESSION: a 15-minute feed read 4x low — now it is exactly 4x the old number', () => {
    const rows = cadenceRows(900);
    const fixed = calculateVampire(rows);

    // The pre-fix formula, recomputed here on purpose.
    const p05 = legacyP05(rows);
    const legacyCost = p05 * 24 * 30 * (rows[0].activeRateSet.tou.offPeak / 100);
    expect(fixed.cost).toBeCloseTo(legacyCost * 4, 6);
    expect(fixed.watts).toBeCloseTo(p05 * 1000 * 4, 6);

    // ...and that legacy number WAS the hourly figure divided by 4 — the bug.
    expect(legacyCost).toBeCloseTo(calculateVampire(cadenceRows(3600)).cost / 4, 6);
  });

  it('heatmap cells average per HOUR, not per reading', () => {
    const hourly = buildHeatmapData(cadenceRows(3600));
    const quarter = buildHeatmapData(cadenceRows(900));
    expect(quarter.maxAvg).toBeCloseTo(hourly.maxAvg, 9);

    let checked = 0;
    for (let d = 0; d < 7; d += 1) {
      for (let h = 0; h < 24; h += 1) {
        const cell = quarter.grid[d][h];
        if (cell.days === 0) continue;
        checked += 1;
        expect(cell.avg).toBeCloseTo(hourly.grid[d][h].avg, 9);
        // The 15-minute feed has 4x the readings in the same cell — which is
        // exactly what the old `sum / count` hid.
        expect(cell.count).toBe(hourly.grid[d][h].count * 4);
        expect(cell.avg).toBeCloseTo(cell.sum / cell.days, 9);
      }
    }
    expect(checked).toBeGreaterThan(24); // the profile spans more than a day
  });
});
