/**
 * The hostile-XML fuzz gate: what the FUNNEL does with the corpus.
 *
 * Run: `npx vitest run src/lib/greenbutton/hostileCorpus.test.ts`
 *
 * Two claims live here, and the recovery-message contract that rides on top
 * of them lives in `recovery.test.ts`:
 *
 *  1. OUTCOMES — every curated case does what its `expect` says: a budget or
 *     bill-figure bomb is REFUSED, a real export still IMPORTS, everything
 *     else is REJECTED with nothing to import. A mutation declares no
 *     outcome; fuzzing only guarantees the contract holds wherever it lands.
 *  2. COST — a refusal over the document budget must be reached WITHOUT
 *     parsing: the unguarded numbers on this tree were 9 697 ms for 300 000
 *     entries and 9 802 ms for 400 000 readings, so anything in that
 *     neighbourhood means the guard moved behind the parser.
 *
 * Plus the regression this corpus was written for: a download truncated to
 * `<?xml ` used to spin `measureDocument` forever. If that regresses, the
 * FIRST test here hangs the worker instead of failing cleanly — the hang IS
 * the signal; the comment under it says where the loop is.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnoseGreenButtonDocument } from '@/lib/parseDiagnostic';
import { parseGreenButtonFeed } from '@/lib/energy';
// main's gas-aware import gate (t_8a9038d6): the app counts USABLE rows —
// electric DataPoints plus commodity-7 volume rows — not `g.readings`, so an
// Enbridge extract is judged by the same number `/import` judges it with.
import { countUsableRows } from '@/hooks/useDashboard';
import { HOSTILE_CORPUS, mutationAt, MUTATION_COUNT, type CorpusCase } from './hostileCorpus';
import { recoveryMessage } from './recovery';
import {
  inspectDocument,
  isGreenButtonRefusal,
  measureDocument,
  MAX_DOCUMENT_BYTES,
} from './limits';

function caseById(id: string): CorpusCase {
  const found = HOSTILE_CORPUS.find((c) => c.id === id);
  if (!found) throw new Error(`corpus case ${id} is missing`);
  return found;
}

/**
 * Run one document through the app's entry point, classifying the failure.
 * The funnel is main's: parse the WHOLE feed, then gate on `countUsableRows`
 * exactly as `/import` and the upload modal do.
 */
function run(xml: string): { outcome: 'import' | 'refuse' | 'reject'; readings: number; ms: number } {
  const started = Date.now();
  try {
    const usable = countUsableRows(parseGreenButtonFeed(xml).groups);
    return { outcome: usable > 0 ? 'import' : 'reject', readings: usable, ms: Date.now() - started };
  } catch (error) {
    if (isGreenButtonRefusal(error)) return { outcome: 'refuse', readings: 0, ms: Date.now() - started };
    return { outcome: 'reject', readings: 0, ms: Date.now() - started };
  }
}

describe('the scanner survives a document that never closes its first construct', () => {
  it('returns, with the byte count, instead of spinning (t_9dfd150b)', () => {
    // THE REGRESSION: `endOfMarkup` returned `endOfTag(...) + 1`, i.e. 0, for
    // an unterminated `<?`/`<!`. The scan checked `end < 0`, did not break,
    // set `i = 0` — and looped on the same `<` forever at 100% CPU. The
    // import never returned: no message, no spinner-off, a frozen tab. Six
    // bytes of truncated download did it.
    for (const xml of ['<?xml ', '<!DOCTYPE feed [', '<feed><!', '<?', '<!']) {
      const started = Date.now();
      const { stats, refusal } = inspectDocument(xml);
      expect(Date.now() - started, `measureDocument spun on ${JSON.stringify(xml)}`).toBeLessThan(500);
      expect(stats.bytes).toBe(xml.length);
      // Malformed, but not over budget: the DIAGNOSIS is what must explain it.
      expect(refusal, `budget refusal for ${JSON.stringify(xml)}`).toBeNull();
    }

    // …and the reader still gets a sentence for the truncated file.
    const diag = diagnoseGreenButtonDocument('<?xml ', 0);
    expect(diag.ok).toBe(false);
    if (diag.ok) throw new Error('unreachable');
    expect(diag.headline).toMatch(/well-formed/i);
    expect(diag.hints.length).toBeGreaterThan(0);

    // The same shape, one element further in: a comment that never closes.
    const { stats: commented } = inspectDocument('<feed><!-- oops');
    expect(commented.entries).toBe(0);
    // The PI is skipped as markup; the root counts, the self-closing child does not.
    expect(measureDocument('<?xml version="1.0"?>\n<feed><entry/></feed>').depth).toBe(1);
  });

  it('still counts what a WELL-FORMED document carries', () => {
    const { stats } = inspectDocument(caseById('good').xml);
    expect(stats.entries).toBe(1);
    expect(stats.readings).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
    // The control is inside the budget on every dimension: the scanner must
    // not start refusing real files now that it stops early on broken ones.
    expect(stats.bytes).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
  });
});

describe('every curated case does what it declares', () => {
  it('holds, case by case', () => {
    const declared = HOSTILE_CORPUS.filter((c) => c.expect);
    expect(declared.length).toBeGreaterThan(30);

    const wrong: string[] = [];
    for (const c of declared) {
      const { outcome } = run(c.xml);
      if (outcome !== c.expect) wrong.push(`${c.id}: expected ${c.expect}, got ${outcome}`);
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  }, 300_000);

  it('the corpus declares each family and reproduces its mutations', () => {
    const families = new Set(HOSTILE_CORPUS.map((c) => c.family));
    for (const family of [
      'budget',
      'markup',
      'entity',
      'not-xml',
      'encoding',
      'numeric',
      'structure',
      'mutation',
      'control',
    ]) {
      expect([...families], `family ${family} is missing`).toContain(family);
    }
    const mutations = HOSTILE_CORPUS.filter((c) => c.family === 'mutation');
    expect(mutations.length).toBe(MUTATION_COUNT);
    // A failing `mut-N-kind` id must be rebuildable from its index alone.
    const rebuilt = HOSTILE_CORPUS.find((c) => c.id.startsWith('mut-42-')) as CorpusCase;
    expect(mutationAt(42)).toEqual(rebuilt);
  });
});

describe('the document budget is judged before the parser runs', () => {
  it('is reached in a fraction of the unguarded cost, for each dimension', () => {
    // Measured unguarded on this tree (t_2961ce14): 9 697 ms for 300 000
    // entries, 9 802 ms for 400 000 readings. The bounds below leave 6×
    // headroom over the measured scans (0 / 21 / 69 / 420 ms) while staying
    // far under what an unguarded parse would cost.
    const budget: [string, number][] = [
      ['bytes-over', 1000], // judged from `text.length`: a read, not a walk
      ['depth-bomb-20000', 3000],
      ['entries-over', 3000],
      ['readings-over', 3000],
    ];
    for (const [id, limit] of budget) {
      const c = caseById(id);
      const { outcome, ms } = run(c.xml);
      expect(outcome, `${id} must be refused`).toBe('refuse');
      expect(ms, `${id} took ${ms}ms — the budget is judged before the parser runs`).toBeLessThan(limit);
    }
  }, 300_000);

  it('a refusal names the dimension and the numbers it judged', () => {
    try {
      parseGreenButtonFeed(caseById('readings-over').xml);
      throw new Error('unreachable');
    } catch (error) {
      expect(isGreenButtonRefusal(error)).toBe(true);
      if (!isGreenButtonRefusal(error)) throw error;
      expect(error.code).toBe('budget');
      expect(error.dim).toBe('readings');
      expect(error.measured).toBe(500_001);
      expect(error.hints.length).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe('the corpus as a whole is bounded work', () => {
  it('runs to completion inside the gate budget', () => {
    // Every case, classified once: the byte bomb is a `length` read, the two
    // deliberately expensive in-budget documents (10 MB text node, 50 000
    // attributes) are the corpus's own measurement of a worst-legal upload.
    const started = Date.now();
    const costs: [string, number][] = [];
    for (const c of HOSTILE_CORPUS) {
      const { ms } = run(c.xml);
      if (ms > 1000) costs.push([c.id, ms]);
    }
    const elapsed = Date.now() - started;

    // A case that costs seconds is allowed — but it must be a DECLARED one,
    // so a new shape that quietly becomes expensive fails here by name.
    const declaredSlow = new Set(['huge-text-node-10mb', 'attr-bomb-50k', 'readings-over']);
    const surprise = costs.filter(([id]) => !declaredSlow.has(id));
    expect(surprise, `unexpectedly slow: ${surprise.map(([id, ms]) => `${id}=${ms}ms`).join(', ')}`).toEqual([]);

    expect(HOSTILE_CORPUS.length).toBeGreaterThan(60);
    expect(elapsed, `the corpus took ${elapsed}ms`).toBeLessThan(90_000);
  }, 180_000);
});

/**
 * The re-target of this funnel onto main's gas-aware flow (t_01956bbe) has to
 * be DISCRIMINATING, or swapping `countUsableRows` back for an electric-only
 * `g.readings` count would stay green: no corpus document carries a
 * commodity-7 volume series. This is the negative control for that wiring.
 */
describe('the funnel is the GAS-AWARE gate, not an electric-readings count', () => {
  const gas = (): string =>
    readFileSync(join(__dirname, '../../../tests/fixtures/enbridge-gas-synthetic.xml'), 'utf8');

  it('imports an Enbridge extract that carries ZERO electric rows (t_8a9038d6)', () => {
    const xml = gas();
    // Why the old gate rejected every gas file: its rows are volume series,
    // so the electric-only count reads nothing.
    const electric = parseGreenButtonFeed(xml).groups.reduce((n, g) => n + g.readings.length, 0);
    expect(electric).toBe(0);

    const outcome = run(xml);
    expect(outcome.outcome, 'the shipped gate counts volume rows — a gas file imports').toBe('import');
    expect(outcome.readings).toBe(5); // the five IntervalBlocks, per gasImport.test.ts
  });

  it('says nothing to import for a gas doc whose rows were stripped — the gate still closes', () => {
    const feed = parseGreenButtonFeed(gas());
    const stripped = feed.groups.map((g) => ({ ...g, series: [] }));
    expect(countUsableRows(stripped)).toBe(0);
    // …and the reader gets the gate's own sentence for it, not silence.
    const msg = recoveryMessage({ text: gas(), readings: 0 });
    expect(msg.ok).toBe(false);
    expect(msg.hints.length).toBeGreaterThan(0);
  });
});
