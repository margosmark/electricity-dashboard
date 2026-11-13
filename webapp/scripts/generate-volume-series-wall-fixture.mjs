#!/usr/bin/env node
/**
 * Generate `volume-series-wall-fixture.xml`: ONE UsagePoint carrying
 * **23 volume series** (commodity 7 / uom 42 / multiplier −3 — the Enbridge
 * gas shape), each with its own MeterReading + ReadingType + 4 daily
 * IntervalReadings.
 *
 * WHY THIS FILE EXISTS (t_1d93a874)
 * Mark's real export printed a WALL of 23 near-identical "loaded as volume"
 * sentences that differed ONLY in the series label — `seriesLabel()` renders
 * `${shortId(usagePoint)} · ${shortId(meterReading)} · ${unit}`, so every
 * sentence has a unique {label} and a group-by-RENDERED-TEXT aggregation
 * yields 23 groups of 1. This fixture reproduces that shape with synthetic
 * ids (`FEED0001 · READ0001 … m³`) so the aggregation can be proven end to
 * end: 23 notes, one code, one uom/multiplier/count, 23 distinct labels.
 *
 * PRIVACY: every id here is invented for this file. The owner's real export
 * carries his name, address, account number and meter serials and must never
 * enter this repo — the label SHAPE (8-char id · 8-char id · unit) is what is
 * reproduced, not any real identifier.
 *
 * Regenerate:  node scripts/generate-volume-series-wall-fixture.mjs
 * (byte-stable: re-running leaves `git status` clean)
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'tests', 'fixtures', 'volume-series-wall-fixture.xml');

/** The wall: 23 series under ONE UsagePoint is what makes it a wall. */
const SERIES = 23;
/** Readings per series — identical across the series, as in the real file. */
const PER_SERIES = 4;
const UP = 'FEED0001';
const BASE = 1776902400; // 2026-04-23T00:00:00Z, the same epoch the Enbridge fixture uses
const DAY = 86400;

const id = (prefix, n) => `${prefix}${String(n).padStart(4, '0')}`;
const uuid = (kind, n) => `urn:uuid:volwall-${kind}-${String(n).padStart(4, '0')}`;
const API = 'https://api.example.test/espi/1_1/resource';

/** 4 daily readings, offset per series so no two series share a timestamp. */
function intervalBlock(n) {
  const start = BASE + (n - 1) * PER_SERIES * DAY;
  const readings = Array.from({ length: PER_SERIES }, (_, k) => {
    const t = start + k * DAY;
    return [
      '        <espi:IntervalReading>',
      '          <espi:timePeriod>',
      `            <espi:duration>${DAY}</espi:duration>`,
      `            <espi:start>${t}</espi:start>`,
      '          </espi:timePeriod>',
      // raw −3 ⇒ 400 m³ + n, the same scaling the Enbridge shape uses.
      `          <espi:value>${400000 + n * 1000}</espi:value>`,
      '        </espi:IntervalReading>',
    ].join('\n');
  }).join('\n');

  return [
    '  <entry>',
    `    <id>${uuid('ib', n)}</id>`,
    '    <title>Interval Block</title>',
    '    <updated>2026-06-01T04:37:20Z</updated>',
    `    <link rel="self" type="espi-entry/IntervalBlock" href="${API}/UsagePoint/${UP}/MeterReading/${id('READ', n)}/IntervalBlock/ib" />`,
    `    <link rel="up" type="espi-feed/IntervalBlock" href="${API}/UsagePoint/${UP}/MeterReading/${id('READ', n)}/IntervalBlock" />`,
    `    <link rel="related" type="espi-entry/MeterReading" href="${API}/UsagePoint/${UP}/MeterReading/${id('READ', n)}" />`,
    '    <content>',
    '      <espi:IntervalBlock>',
    '        <espi:interval>',
    `          <espi:duration>${DAY * PER_SERIES}</espi:duration>`,
    `          <espi:start>${start}</espi:start>`,
    '        </espi:interval>',
    readings,
    '      </espi:IntervalBlock>',
    '    </content>',
    '  </entry>',
  ].join('\n');
}

function readingType(n) {
  return [
    '  <entry>',
    `    <id>${uuid('rt', n)}</id>`,
    '    <title>Reading Type</title>',
    '    <updated>2026-06-01T04:37:20Z</updated>',
    `    <link rel="self" type="espi-entry/ReadingType" href="${API}/ReadingType/${id('RTYP', n)}" />`,
    '    <link rel="up" type="espi-feed/ReadingType" href="https://api.example.test/espi/1_1/resource/ReadingType" />',
    '    <content>',
    '      <espi:ReadingType>',
    '        <espi:accumulationBehaviour>4</espi:accumulationBehaviour>',
    '        <espi:commodity>7</espi:commodity>',
    '        <espi:currency>124</espi:currency>',
    '        <espi:flowDirection>1</espi:flowDirection>',
    `        <espi:intervalLength>${DAY}</espi:intervalLength>`,
    '        <espi:kind>58</espi:kind>',
    '        <espi:powerOfTenMultiplier>-3</espi:powerOfTenMultiplier>',
    '        <espi:uom>42</espi:uom>',
    '      </espi:ReadingType>',
    '    </content>',
    '  </entry>',
  ].join('\n');
}

function meterReading(n) {
  return [
    '  <entry>',
    `    <id>${uuid('mr', n)}</id>`,
    '    <title>Meter Reading</title>',
    '    <updated>2026-06-01T04:37:20Z</updated>',
    `    <link rel="self" type="espi-entry/MeterReading" href="${API}/UsagePoint/${UP}/MeterReading/${id('READ', n)}" />`,
    `    <link rel="up" type="espi-feed/MeterReading" href="${API}/UsagePoint/${UP}/MeterReading" />`,
    `    <link rel="related" type="espi-feed/IntervalBlock" href="${API}/UsagePoint/${UP}/MeterReading/${id('READ', n)}/IntervalBlock" />`,
    `    <link rel="related" type="espi-entry/ReadingType" href="${API}/ReadingType/${id('RTYP', n)}" />`,
    '    <content>',
    '      <espi:MeterReading />',
    '    </content>',
    '  </entry>',
  ].join('\n');
}

const usagePoint = [
  '  <entry>',
  `    <id>${uuid('up', 1)}</id>`,
  '    <title>Usage Point</title>',
  '    <updated>2026-06-01T04:37:20Z</updated>',
  `    <link rel="self" type="espi-entry/UsagePoint" href="${API}/UsagePoint/${UP}" />`,
  '    <link rel="up" type="espi-feed/UsagePoint" href="https://api.example.test/espi/1_1/resource/UsagePoint" />',
  '    <link rel="related" type="espi-feed/MeterReading" href="' + `${API}/UsagePoint/${UP}/MeterReading` + '" />',
  '    <content>',
  '      <espi:UsagePoint>',
  '        <espi:ServiceCategory>',
  '          <espi:kind>1</espi:kind>',
  '        </espi:ServiceCategory>',
  '      </espi:UsagePoint>',
  '    </content>',
  '  </entry>',
].join('\n');

// One series per entry triple (ReadingType → MeterReading → IntervalBlock),
// which is the document order the parser's own fixtures use.
const series = Array.from({ length: SERIES }, (_, i) => {
  const n = i + 1;
  return [readingType(n), meterReading(n), intervalBlock(n)].join('\n');
}).join('\n');

const doc = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xmlns:espi="http://naesb.org/espi"
      xsi:schemaLocation="http://www.w3.org/2005/Atom https://greenbuttondata.org/xsd/3_3/atom.xsd http://naesb.org/espi https://www.naesb.org/espi.xsd">
  <id>urn:uuid:volwall-feed-0001</id>
  <title>Energy Usage</title>
  <updated>2026-06-01T04:37:20Z</updated>
  <link rel="related" href="https://cert.greenbuttonalliance.org/certificate/volume-wall-synthetic" type="text/html" />
${usagePoint}
${series}
</feed>
`;

writeFileSync(out, doc);
console.log(
  `${out.split('/').pop()} written: 1 UsagePoint + ${SERIES} volume series × ${PER_SERIES} readings = ${SERIES * PER_SERIES} readings`,
);
