/**
 * The display layer for the utility's own bill-line names (t_0a96fd14).
 *
 * The panel used to print `BillLineItem.note` verbatim, which is right for the
 * DATA (classification, grouping and every completeness check read it raw) and
 * wrong for the LABEL: the French page then printed English line names, and the
 * three survivors of qa's live sweep (`Ontario Electricity Rebate`,
 * `Billing Period - Current Read Date`, `Billing Period - Previous Read Date`)
 * were exactly that — the substring matcher in
 * `evidence/money-locale-verify.cjs` flagged them because each contains an
 * `en.json` phrase, but the CLASS is the whole vocabulary the fixtures carry.
 *
 * Two properties are load-bearing and are pinned here:
 *   1. the English page is byte-identical to the file's own wording (the `en`
 *      catalog value IS the note), so nothing an English reader sees changed;
 *   2. a name no catalog entry covers prints exactly as the utility wrote it —
 *      `t()` is not even called — so an unknown utility can never see a
 *      half-translated row or a raw key.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActualBillPanel } from '@/components/ActualBillPanel';
import { PlanTimelineEditor } from '@/components/PlanTimelineEditor';
import { parseUsageSummaries } from '@/lib/energy';
import { setLocale, t } from './index';
import en from './en.json';
import fr from './fr.json';
import {
  BILL_NOTE_KEYS,
  billNoteKey,
  billNoteParams,
  billNoteText,
  normalizeBillNote,
} from './billNote';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
/**
 * The THREE fixtures that carry an itemized bill (`<espi:note>` per line): the
 * two synthetic electricity bills, plus the committed Enbridge Gas (Ontario)
 * feed — the second PROVIDER whose wording the catalog now has to cover, and
 * the one that made "unrecognized provider label" a measurable class instead
 * of a claim.
 */
const WITH_NOTES = [
  'usage-summary-open-tail.xml',
  'usage-summary-synthetic.xml',
  'utility-enbridge-gas.xml',
];
const NOTES = [
  ...new Set(
    WITH_NOTES.flatMap((file) => [
      ...fs.readFileSync(path.join(FIXTURES, file), 'utf8').matchAll(/<espi:note>([^<]*)<\/espi:note>/g),
    ]).map((m) => m[1]),
  ),
];

/** The catalog template with this line's own values filled in. */
const fill = (template: string, note: string) =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const params = billNoteParams(note);
    return name in params ? String(params[name]) : match;
  });

const unwired = (note: string) => BILL_NOTE_KEYS[normalizeBillNote(note)];

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLocale('en');
});

describe('the utility’s line names, in the reader’s language', () => {
  it('covers every name the shipped fixtures carry', () => {
    // A fixture that grows a line name must grow the catalog with it — this is
    // the ratchet that keeps "the class" closed instead of the three rows qa
    // happened to count. 21 distinct names in the two synthetic bills + 30 the
    // Enbridge feed adds beyond them (it shares 7) = 51.
    expect(NOTES.length).toBe(51);
    const unmapped = NOTES.filter((note) => billNoteKey(note) === null);
    expect(unmapped, `unmapped line names: ${unmapped.join(' | ')}`).toEqual([]);
  });

  it('leaves the English page byte-identical: every name composes back to the file’s wording', () => {
    setLocale('en');
    for (const note of NOTES) {
      expect(billNoteText(note, t), note).toBe(note);
    }
  });

  it('paints French for every name, and never a raw key', () => {
    setLocale('fr');
    for (const note of NOTES) {
      const key = billNoteKey(note);
      expect(key, note).not.toBeNull();
      const text = billNoteText(note, t);
      expect(text, note).not.toBe(note);
      expect(text, note).toBe(fill(fr[key as keyof typeof fr], note));
      expect(text.startsWith('billnote.'), note).toBe(false);
    }
  });

  it('falls back to the utility’s own wording — and never calls t — for a name it does not know', () => {
    setLocale('fr');
    const bomb = () => {
      throw new Error('t() was called for a line name no catalog entry covers');
    };
    expect(billNoteText('Water Heater Rental', bomb)).toBe('Water Heater Rental');
    expect(billNoteText('', bomb)).toBe('');
  });

  it('folds case, spacing and the read-date dash, and keeps the digits a name carries as values', () => {
    expect(billNoteKey('  BILL   POST DATE ')).toBe(unwired('Bill Post Date'));
    // An en dash is what a bilingual export emits; it must reach the same row.
    expect(billNoteKey('Billing Period – Current Read Date')).toBe(unwired('Billing Period - Current Read Date'));
    expect(normalizeBillNote('H.S.T. # 123456789')).toBe('h.s.t. # #');
    expect(billNoteParams('H.S.T. # 123456789')).toEqual({ n: '123456789' });
    setLocale('fr');
    expect(billNoteText('H.S.T. # 999999999', t)).toBe('TVH n° 999999999');
  });

  it('invents no vocabulary: every key is one of the file’s own names', () => {
    // The catalog may translate the utility's wording; it may not name a line
    // the file never states. `{n}` masked like a digit run, so the H.S.T.
    // template compares against the note it came from.
    const canonical = new Set(NOTES.map(normalizeBillNote));
    const orphans = Object.entries(BILL_NOTE_KEYS)
      .filter(([, key]) => {
        const value = en[key as keyof typeof en];
        return !canonical.has(normalizeBillNote(String(value).replace(/\{\w+\}/g, '#')));
      })
      .map(([, key]) => key);
    expect(orphans).toEqual([]);
  });

  it('is exactly two-way with the fixtures: no key without a name, no name without a key', () => {
    // The other direction of the same ratchet, stated on the TABLE: a fold that
    // collides (two providers writing the same normalised string) would print
    // one utility's label for another's line, and a key nothing states would be
    // dead weight nobody can verify.
    const keys = Object.values(BILL_NOTE_KEYS);
    expect(new Set(keys).size, 'two line names folded onto one key').toBe(keys.length);
    expect(new Set(Object.keys(BILL_NOTE_KEYS)), 'keys no committed name reaches').toEqual(
      new Set(NOTES.map(normalizeBillNote)),
    );
  });
});

describe('the panel that paints them', () => {
  const summaries = parseUsageSummaries(
    fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
  );

  it('paints the localized names on the French page and keeps the file’s wording on the node', () => {
    setLocale('fr');
    const { container } = render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const lines = [...container.querySelectorAll('[data-bill-note]')];
    expect(lines.length).toBeGreaterThan(0);
    for (const el of lines) {
      const note = el.getAttribute('data-bill-note') as string;
      expect(el.textContent, note).toBe(billNoteText(note, t));
      // The English name is not on the page as text — it is on the NODE.
      expect(el.textContent, note).not.toBe(note);
      expect(el.getAttribute('title'), note).toBe(note);
    }
    // Concrete rows, so a passing count cannot hide a wrong label.
    // (Three billing periods — each row appears three times.)
    expect(screen.getAllByText('TVH n° 123456789')).toHaveLength(3);
    expect(screen.getAllByText('Remise de l’Ontario')).toHaveLength(3);
    expect(screen.queryAllByText('H.S.T. # 123456789')).toHaveLength(0);
    expect(screen.queryAllByText('Ontario Electricity Rebate')).toHaveLength(0);
  });

  it('prints the utility’s own wording, unchanged, on the English page', () => {
    setLocale('en');
    const { container } = render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const lines = [...container.querySelectorAll('[data-bill-note]')];
    expect(lines.length).toBeGreaterThan(0);
    for (const el of lines) {
      const note = el.getAttribute('data-bill-note') as string;
      expect(el.textContent, note).toBe(note);
      // Nothing to disambiguate in English: no tooltip, no duplicate wording.
      expect(el.getAttribute('title'), note).toBeNull();
    }
    expect(screen.getAllByText('Ontario Electricity Rebate').length).toBe(3);
  });
});

/**
 * The SECOND surface that prints the utility's line names: the plan-timeline
 * detection strip quotes the bill lines that produced its verdict. It shipped
 * English inside French chrome for the same reason the bill panel did — and it
 * only became VISIBLE to the live sweep when the names entered the catalog
 * (its words were already in the gate's fixture vocabulary, so the unit gate
 * could never see it). Same rule, same fallback.
 */
describe('the plan-timeline evidence line', () => {
  const summaries = parseUsageSummaries(
    fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
  );

  it('names the bill’s own lines in the reader’s language, wording kept on the node', () => {
    setLocale('fr');
    render(<PlanTimelineEditor summaries={summaries} />);
    // One evidence line per billing period (three in this fixture).
    const lines = screen.getAllByTestId('plan-timeline-evidence');
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const raw = line.getAttribute('data-bill-evidence') as string;
      const shown = raw.split(' · ').slice(0, 3);
      expect(shown.length, raw).toBeGreaterThan(0);
      for (const note of shown) expect(line.textContent, note).toContain(billNoteText(note, t));
      // The English season-suffixed period names never appear as painted text.
      expect(line.textContent, raw).not.toContain('Peak-Summer');
      expect(raw).toContain('Off Peak-Summer');
      expect(line.getAttribute('title'), raw).toBe(raw);
    }
  });

  it('is byte-identical on the English page', () => {
    setLocale('en');
    render(<PlanTimelineEditor summaries={summaries} />);
    for (const line of screen.getAllByTestId('plan-timeline-evidence')) {
      const raw = line.getAttribute('data-bill-evidence') as string;
      for (const note of raw.split(' · ').slice(0, 3)) {
        expect(line.textContent, note).toContain(note);
      }
      expect(line.getAttribute('title'), raw).toBeNull();
    }
  });
});

/**
 * The SECOND provider's document, PAINTED — the class this card is about.
 * `ActualBillPanel` renders whatever itemized summary the imported file
 * carries, so this Ontario gas feed reaches the same panel an Oakville bill
 * does: before the catalog grew, all 37 of these lines fell back to the
 * utility's English wording on the French page (the fallback is correct — it
 * is simply English).
 */
describe('the panel with a second provider’s bill', () => {
  const summaries = parseUsageSummaries(
    fs.readFileSync(path.join(FIXTURES, 'utility-enbridge-gas.xml'), 'utf8'),
  );

  it('parses one itemized bill of 37 lines — so coverage here is measurable', () => {
    expect(summaries).toHaveLength(1);
    expect(summaries[0].items).toHaveLength(37);
  });

  it('paints French for every line and keeps the file’s wording on the node', () => {
    setLocale('fr');
    const { container } = render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const lines = [...container.querySelectorAll('[data-bill-note]')];
    expect(lines).toHaveLength(37);
    for (const el of lines) {
      const note = el.getAttribute('data-bill-note') as string;
      expect(el.textContent, note).toBe(billNoteText(note, t));
      expect(el.textContent, note).not.toBe(note);
      expect(el.getAttribute('title'), note).toBe(note);
    }
    // Concrete rows, so a passing count cannot hide a wrong or missing label:
    // a name only this provider writes, and the tax line.
    expect(screen.getAllByText('Charge de fourniture de gaz')).toHaveLength(1);
    expect(screen.getAllByText('Transport vers Enbridge (LVB)')).toHaveLength(1);
    expect(screen.getAllByText('TVH ($)')).toHaveLength(1);
    expect(screen.queryAllByText('Gas Supply Charge')).toHaveLength(0);
    expect(screen.queryAllByText('Transportation to Enbridge (LVB)')).toHaveLength(0);
  });

  it('is byte-identical on the English page', () => {
    setLocale('en');
    const { container } = render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const lines = [...container.querySelectorAll('[data-bill-note]')];
    expect(lines).toHaveLength(37);
    for (const el of lines) {
      const note = el.getAttribute('data-bill-note') as string;
      expect(el.textContent, note).toBe(note);
      expect(el.getAttribute('title'), note).toBeNull();
    }
  });
});
