/**
 * Wave T — the hook that puts temperatures next to readings, and nothing else.
 *
 * One fetch for the whole dashboard: the span is the dates the LOADED data
 * covers (never the window on screen, never a date the household has no
 * readings for), it is served by Open-Meteo's public CDN straight from this
 * browser, and the answer is remembered in localStorage so a reload costs
 * nothing. See lib/openMeteo.ts for why the alignment is on absolute hours.
 *
 * Failure is a first-class state, not an exception: offline, blocked by an
 * extension, rate-limited or mocked out in a test, the hook settles on
 * `status: 'error'` with no temperatures, and every consumer renders the
 * "no data" branch it already had before Wave T existed. There is no retry
 * loop and no spinner that outlives the request — the app must never look
 * broken because the weather is unavailable.
 *
 * The result is STORED AGAINST the span it answers for, and any other span
 * reads as "loading" until its own answer lands. That is what keeps a new
 * upload from flashing the previous export's temperatures over its dates.
 */

'use client';

import { useEffect, useState } from 'react';

import { loadHourlyTemps, spanOfRows, type HourlyTemps, type TempFetchResult } from '@/lib/openMeteo';

export type HourlyTempsState = {
  /** `idle` until data exists to ask about. */
  status: 'idle' | TempFetchResult['status'];
  temps: HourlyTemps | null;
  /** Where the series came from, for the honest footer. */
  source: 'cache' | 'network' | null;
  /** Hours of the readings' span that got a temperature. */
  coveredHours: number;
  /** Hours the readings' span has. */
  spanHours: number;
  loading: boolean;
};


const IDLE: HourlyTempsState = {
  status: 'idle',
  temps: null,
  source: null,
  coveredHours: 0,
  spanHours: 0,
  loading: false,
};

/** What to show for a span we are asking about but have not answered yet. */
const pending = (): HourlyTempsState => ({ ...IDLE, status: 'idle', loading: true });

export function useHourlyTemps(rows: { timestamp: number }[] | undefined): HourlyTempsState {
  const span = spanOfRows(rows ?? []);
  const rowCount = rows?.length ?? 0;
  const key =
    !span || rowCount === 0 ? '' : `${span.startHour}:${span.endHour}:${rowCount}`;

  const [entry, setEntry] = useState<{ key: string; value: HourlyTempsState } | null>(null);

  // `rows` is the dashboard's MEMOISED processed dataset (not the window's
  // filtered slice), so its identity moves when the data changes — an upload,
  // a merge, a sync — and never when the user merely drags the window. That
  // is exactly the invariant this fetch is supposed to have.
  useEffect(() => {
    if (!key || !rows) return;
    let live = true;
    void loadHourlyTemps(rows).then((result: TempFetchResult) => {
      if (!live) return;
      setEntry({ key, value: { ...result, loading: false } });
    });
    return () => {
      live = false;
    };
  }, [key, rows]);

  if (!key) return IDLE;
  if (!entry || entry.key !== key) return pending();
  return entry.value;
}
