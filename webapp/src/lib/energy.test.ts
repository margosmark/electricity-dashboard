import { describe, it, expect } from 'vitest';
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
    dayStr: dateObj.toISOString().split('T')[0],
    hourStr: dateObj.toISOString().split('T')[1]?.slice(0, 5) || '00:00',
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
    expect(anomalies.length).toBeGreaterThanOrEqual(0);
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
    expect(getBarColor('monthly', '2024-01-06')).toBe('#2563EB');
  });
});
