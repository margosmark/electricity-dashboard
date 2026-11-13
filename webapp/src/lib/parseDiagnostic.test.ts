/**
 * Wave G item 4 — first-run diagnostics.
 *
 * When an upload produces nothing, the user gets a sentence that names what
 * was missing and what to do next — never a bare "invalid XML".
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseGreenButtonDocument } from './parseDiagnostic';
import { parseGreenButtonUsagePoints } from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const failure = (xml: string, parsedReadings?: number) => {
  const d = diagnoseGreenButtonDocument(xml, parsedReadings);
  expect(d.ok, 'expected a failure diagnostic').toBe(false);
  return d as Extract<ReturnType<typeof diagnoseGreenButtonDocument>, { ok: false }>;
};

describe('diagnoseGreenButtonDocument — the file is not an export at all', () => {
  it('says an HTML page was saved instead of the data', () => {
    const d = failure('<!DOCTYPE html><html><head><title>Sign in</title></head><body>Please log in</body></html>');
    expect(d.headline).toMatch(/web page/i);
    expect(d.detail).toMatch(/login|error page/i);
    expect(d.hints.join(' ')).toMatch(/utility portal/i);
  });

  it('says a JSON file is not supported', () => {
    const d = failure('{"historicalRates":[]}');
    expect(d.headline).toMatch(/not xml/i);
    expect(d.hints.join(' ')).toMatch(/xml/i);
  });

  it('says an empty file is empty', () => {
    const d = failure('   \n  ');
    expect(d.headline).toMatch(/empty/i);
  });

  it('never falls back to the words "invalid XML" alone', () => {
    for (const bad of ['', 'nope', '<feed><entry>']) {
      const d = failure(bad);
      expect(d.headline.toLowerCase()).not.toBe('invalid xml');
      expect(d.detail.length).toBeGreaterThan(20);
      expect(d.hints.length).toBeGreaterThan(0);
    }
  });
});

describe('diagnoseGreenButtonDocument — malformed XML', () => {
  it('points at the line the parser choked on', () => {
    const d = failure('<?xml version="1.0"?>\n<feed>\n  <entry>\n</feed>');
    expect(d.headline).toMatch(/well-formed/i);
    expect(d.headline).toMatch(/line \d+/);
    expect(d.hints.join(' ')).toMatch(/truncated|re-download/i);
  });

  it('keeps the validator’s own English prose off the screen — the CODE picks our sentence', () => {
    // The QA corpus' truncated export (F-07g) stops mid-element, and the
    // validator answers `InvalidXml` at line 1 with its internal stack dump:
    // `Invalid '[    "feed",    "entry",    "updated"]' found.` That string
    // used to be printed verbatim inside `diag.malformedDetailMsg`, so the fr
    // page showed English library text in a French sentence (t_9dfd150b,
    // found by the hostile-XML corpus). The line stays — it is a number and
    // translates with the headline around it.
    const d = failure(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
        '  <entry>\n' +
        '    <updated>2026-01-01',
    );
    expect(d.headline).toBe('The XML is not well-formed at line 1.');
    expect(d.detail).toBe('The file ended before its tags were balanced.');
    expect(d.detail).not.toMatch(/Invalid '|found\./);
    expect(d.hints.join(' ')).toMatch(/truncated|re-download/i);
  });

  it('translates each validator code into its own sentence, not the library’s', () => {
    // The four codes fast-xml-parser returns, each with library prose behind
    // it that must never reach the user in either language.
    expect(failure('<feed><entry></feed></entry>').detail).toBe(
      'A tag in it is opened and never closed, or closed by the wrong tag.',
    );
    expect(failure('<feed><entry a="1" a="2"/></feed>').detail).toBe(
      'An attribute is repeated, written without quotes, or given no value.',
    );
    // NB: text that does not start with `<` never reaches the validator — the
    // "not XML at all" branch answers first — so this one carries the invalid
    // character INSIDE an otherwise well-formed document.
    expect(failure('<feed><entry>&#xZZ;</entry></feed>').detail).toBe(
      'A character sits where XML allows none — usually an unescaped &, a stray <, or a control character.',
    );
    // An unknown code (a library upgrade) falls back to the generic sentence,
    // still ours.
    expect(failure('<?xml version="1.0"?>').detail).toBe(
      'The file ended before its tags were balanced.',
    );
  });
});

describe('diagnoseGreenButtonDocument — security refusal', () => {
  it('names external entities instead of repeating the parser error', () => {
    const d = failure(
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><feed><entry><content><IntervalBlock>' +
        '<IntervalReading><timePeriod><start>1&xxe;</start></timePeriod><value>1</value></IntervalReading>' +
        '</IntervalBlock></content></entry></feed>',
    );
    expect(d.headline).toMatch(/external entities/i);
    expect(d.detail).toMatch(/<!ENTITY/);
    expect(d.hints.join(' ')).toMatch(/untrusted/i);
  });
});

describe('diagnoseGreenButtonDocument — well-formed but missing the data', () => {
  it('explains a feed with entries but no readings', () => {
    const d = failure(`<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>urn:uuid:1</id><title>UsagePoint</title></entry>
  <entry><id>urn:uuid:2</id><title>MeterReading</title></entry>
</feed>`);
    expect(d.headline).toMatch(/2 entries, but no interval readings/i);
    expect(d.detail).toMatch(/IntervalBlock/);
    expect(d.hints.join(' ')).toMatch(/interval/i);
  });

  it('explains readings that lost their timestamps', () => {
    const d = failure(`<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><content><IntervalBlock>
    <IntervalReading><value>1500</value></IntervalReading>
  </IntervalBlock></content></entry>
</feed>`);
    expect(d.headline).toMatch(/timestamp/i);
    expect(d.detail).toMatch(/<start>/);
  });

  it('explains a document with no Green Button content at all', () => {
    const d = failure('<?xml version="1.0"?><notes><todo>buy milk</todo></notes>');
    expect(d.headline).toMatch(/no green button data/i);
    expect(d.detail).toMatch(/IntervalReading/);
  });

  it('explains a structurally-complete file the parser still could not read', () => {
    const xml = read('utility-toronto-hydro.xml');
    const d = diagnoseGreenButtonDocument(xml, 0);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.headline).toMatch(/no readable rows/i);
    expect(d.detail).toMatch(/entries/);
  });
});

describe('diagnoseGreenButtonDocument — healthy documents report counts', () => {
  it('accepts every fixture that the parser actually loads', () => {
    for (const file of [
      'utility-hydro-one.xml',
      'utility-toronto-hydro.xml',
      'utility-espi-prefixed-standin.xml',
      'green-button-alliance-sample.xml',
      'synthetic.xml',
    ]) {
      const xml = read(file);
      const readings = parseGreenButtonUsagePoints(xml).reduce(
        (n, g) => n + g.readings.length,
        0,
      );
      const d = diagnoseGreenButtonDocument(xml, readings);
      expect(d.ok, `${file}: ${d.ok ? '' : d.headline}`).toBe(true);
      if (d.ok) {
        expect(d.readings).toBeGreaterThan(0);
        expect(d.entries).toBeGreaterThan(0);
      }
    }
  });
});
