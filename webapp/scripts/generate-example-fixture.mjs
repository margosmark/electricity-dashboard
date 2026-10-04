#!/usr/bin/env node
/**
 * Generate `public/samples/example-usage.xml` — the "Try with example data"
 * fixture (Wave H item 1).
 *
 * WHAT IT IS: a SYNTHETIC household. No real meter, no real address, no real
 * account. Every reading is produced by the model below from a fixed PRNG
 * seed, so regenerating the file is byte-for-byte reproducible and the e2e
 * assertions built on it never drift.
 *
 * WHY IT LOOKS REAL: it is modelled on an Oakville-style detached home with
 * an EV — hourly readings over exactly one year of America/Toronto wall time,
 * carrying the patterns a real Ontario export shows:
 *
 *   · always-on base load (fridge/standby) with a summer fridge bump
 *   · occupancy shape (weekday empty 09-17, weekend home all day)
 *   · seasonal heating/cooling — cold snaps in Jan, a July heat wave that
 *     shows up as anomaly cards, AC running 11:00-21:00 above 21 °C
 *   · EV overnight block: 00:00-03:00 at 3.3 kW on ~75% of Sun-Thu nights
 *     (the block every plan comparison should be about)
 *   · laundry on weekday noon (washer 12:00, dryer 13:00 — summer ON-PEAK)
 *   · dishwasher on weekday noon/evening, landing on-peak in both seasons
 *
 * Timestamps are REAL UTC instants for Toronto local hours, so DST is handled
 * the way a utility export handles it: the 02:00 hour simply does not exist
 * on 2026-03-08, and 01:00 happens twice on 2025-11-02.
 *
 * Usage:  node scripts/generate-example-fixture.mjs
 * Output: public/samples/example-usage.xml  (~650 KB, 8760 readings)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TZ = 'America/Toronto';
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/samples/example-usage.xml',
);

/** Deterministic PRNG (mulberry32) — the whole fixture depends only on SEED. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  weekday: 'short',
});

/** Local Toronto calendar parts for a UTC instant. */
function localParts(utcMs) {
  const out = {};
  for (const p of partsFmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +out.year,
    month: +out.month, // 1-12
    day: +out.day,
    hour: out.hour === '24' ? 0 : +out.hour, // Intl can emit 24:00
    dow: dowMap[out.weekday],
  };
}

/** Day of year, 1-based (leap-year safe). */
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function dayOfYear(month, day, year) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return CUM[month - 1] + day + (leap && month > 2 ? 1 : 0);
}

/** Seasonal mean temperature in °C: ~-3 °C mid-January, ~25 °C mid-July. */
function seasonalTemp(doy) {
  return 11 - 14 * Math.cos((2 * Math.PI * (doy - 15)) / 365);
}

const WINTER_MONTHS = new Set([11, 12, 1, 2, 3, 4]); // OEB season boundary

/**
 * kWh for one hour. Split into named parts so the fixture's structure can be
 * asserted in tests (EV block / appliances / seasonal swing) instead of
 * only "some numbers came out".
 */
function modelHour(p, rand) {
  const { month, hour: h, dow } = p;
  const weekend = dow === 0 || dow === 6;
  const doy = dayOfYear(month, p.day, p.year);
  const temp = seasonalTemp(doy) + (rand() - 0.5) * 5;

  // Occupancy-driven demand (kWh): the household's own behaviour.
  let occupancy;
  if (weekend) {
    occupancy = h < 6 ? 0.16 : h < 10 ? 0.5 : h < 17 ? 0.72 : 0.95;
  } else {
    occupancy = h < 6 ? 0.12 : h < 9 ? 0.75 : h < 17 ? 0.28 : 0.9;
  }
  occupancy *= 0.85 + 0.3 * rand();

  // Always-on base load, harder on the fridge when it is hot out.
  let kwh = 0.21 + 0.05 * rand() + (temp > 20 ? 0.04 : 0);

  // Electric heat assist: only on cold hours, stronger when someone is home.
  if (temp < 10) {
    kwh += ((10 - temp) / 20) * (h >= 17 || h < 7 ? 0.45 : 0.17) * (0.7 + 0.6 * rand());
  }

  // Air conditioning: 11:00-21:00 on days above 21 °C, weekend runs longer.
  if (temp > 21) {
    const window = h >= 11 && h < 21 ? 1.0 : 0.22;
    kwh += ((temp - 21) / 11) * window * (weekend ? 1.15 : 0.95) * (0.75 + 0.5 * rand());
  }

  kwh += occupancy;

  // --- EV: the overnight block. Sun-Thu nights (Mon-Fri commutes), ~80%. ---
  const evNight = [0, 1, 2, 3, 4].includes(dow); // dow of the DAY the charge runs
  if (evNight && rand() < 0.75 && h >= 0 && h < 4) kwh += 3.3;
  // A rare top-up starting before midnight (still off-peak / ULO-mid).
  if (evNight && h === 23 && rand() < 0.1) kwh += 3.3;

  // --- Appliances -------------------------------------------------------
  const weekday = !weekend;
  if (weekday) {
    // Laundry: washer at noon, dryer 13:00 — summer ON-PEAK, winter Mid.
    if (p.laundry && h === 12) kwh += 1.0;
    if (p.laundry && h === 13) kwh += 2.6;
    // Extra dryer load on winter evenings (ON-PEAK 17:00-19:00 Nov-Apr).
    if (p.dryerEvening && WINTER_MONTHS.has(month) && h === 18) kwh += 2.6;
    // Dishwasher: after-lunch run in summer (11-17 ON-PEAK), after-dinner
    // in winter (17-19 ON-PEAK) — on-peak in both seasons, on purpose.
    if (p.dishwasher && h === (WINTER_MONTHS.has(month) ? 18 : 13)) kwh += 1.3;
    // Oven / cooking the evening meal.
    if (h === 17 || h === 18) kwh += 0.7 * (0.6 + 0.8 * rand());
  } else {
    // Weekend cooking + laundry, spread through the day (off-peak).
    if (p.wkndLaundry && (h === 10 || h === 11)) kwh += h === 10 ? 1.0 : 2.6;
    if (p.wkndCook && (h === 11 || h === 12)) kwh += 1.1;
    if (h === 17 || h === 18) kwh += 0.6;
  }

  return Math.max(0.05, kwh);
}

/**
 * Build the day-level roll so a whole day's appliances correlate (a laundry
 * day is a laundry day), instead of flipping per hour.
 */
function dayPlan(rand) {
  const r = rand();
  return {
    laundry: r < 0.42,
    dryerEvening: r >= 0.42 && r < 0.62,
    dishwasher: rand() < 0.5,
    wkndLaundry: rand() < 0.55,
    wkndCook: rand() < 0.7,
  };
}

function generate() {
  const rand = mulberry32(0x5eed10a1);
  const rows = [];
  // 2025-10-01 00:00 EDT -> 2026-10-01 00:00 EDT = 365 days, 8760 hours.
  const start = Date.UTC(2025, 9, 1, 4, 0, 0);
  const end = Date.UTC(2026, 9, 1, 4, 0, 0);
  const HOUR = 3600 * 1000;

  let lastDayKey = null;
  let plan = null;

  for (let t = start; t < end; t += HOUR) {
    const p = localParts(t);
    const dayKey = `${p.year}-${p.month}-${p.day}`;
    if (dayKey !== lastDayKey) {
      plan = dayPlan(rand);
      lastDayKey = dayKey;
    }

    // Day-level roll (laundry/dishwasher) rides along with the hour.
    const mods = { ...p, ...plan };

    // July 2026 heat wave (days 198-201): a natural anomaly week.
    const heatWave = p.month === 7 && p.day >= 14 && p.day <= 17;
    let kwh = modelHour(mods, rand);
    if (heatWave && kwh > 0.4) kwh *= 1.35;

    // Holiday week (Dec 22-28): guests + extra laundry + a space heater.
    const holidays = p.month === 12 && p.day >= 22 && p.day <= 28;
    if (holidays && p.hour >= 8 && p.hour < 22) kwh += 1.4;

    rows.push({ ts: Math.round(t / 1000), wh: Math.round(kwh * 1000) });
  }

  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  EXAMPLE DATA - NOT REAL USAGE.  Synthetic household, no real meter,
  no real address, no real account. Generated by
  webapp/scripts/generate-example-fixture.mjs from a fixed seed.

  One year of hourly readings, 2025-10-01 00:00 to 2026-09-30 23:00
  America/Toronto (DST handled: no 02:00 on 2026-03-08, 01:00 twice on
  2025-11-02). Modelled on an Oakville detached home with an EV:
  always-on base load, weekday/weekend occupancy, seasonal heating and
  cooling (incl. a July heat wave), an EV overnight block 00:00-03:00 on
  ~75% of Sun-Thu nights, weekday laundry at 12:00/13:00 and a dishwasher
  that lands on-peak in both seasons.

  Regenerate: node scripts/generate-example-fixture.mjs
-->
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://schemas.opengroup.org/espi/1.0">
  <title>Example household - synthetic Green Button export (not real usage)</title>
  <subtitle>Synthetic demo data for Ontario Energy Optimizer. Not a real meter.</subtitle>
  <entry>
    <IntervalBlock>
`;

  const body = rows
    .map(
      (r) =>
        `      <IntervalReading><timePeriod><start>${r.ts}</start></timePeriod><value>${r.wh}</value></IntervalReading>`,
    )
    .join('\n');

  const xml = `${header}${body}\n    </IntervalBlock>\n  </entry>\n</feed>\n`;

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, xml);

  // Console summary so the generator reports what it actually produced.
  const total = rows.reduce((s, r) => s + r.wh, 0) / 1000;
  const evRows = rows.filter((r) => r.wh >= 3000).length;
  console.log(
    `wrote ${path.relative(process.cwd(), OUT)}\n` +
      `  readings: ${rows.length}\n` +
      `  span: ${new Date(rows[0].ts * 1000).toISOString()} .. ${new Date(
        rows[rows.length - 1].ts * 1000,
      ).toISOString()}\n` +
      `  total: ${total.toFixed(0)} kWh  (${(total / (rows.length / 24)).toFixed(1)} kWh/day)\n` +
      `  bytes: ${xml.length}\n` +
      `  hours >= 3.0 kWh (EV-ish): ${evRows}`,
  );
}

generate();
