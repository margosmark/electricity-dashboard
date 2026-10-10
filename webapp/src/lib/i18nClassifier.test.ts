/**
 * Wave U — the classifier's French anchors, pinned.
 *
 * The Wave U spec rule 4: canonical data stays untranslated, but the
 * regexes that match the utility's own line names must ALSO accept the
 * French wording a bilingual Oakville export would carry. Oakville's DMD
 * feed emits English only today (checked against Mark's own file), so
 * these tests exist to keep the classifier honest about the format it
 * claims to tolerate — a French bill must never silently read as
 * `unknown` or price a tier at the wrong rate.
 */

import { describe, it, expect } from 'vitest';
import { detectPlanType } from '@/lib/planTimeline';
import { rateForUsageNote } from '@/lib/statistics';
import { type BillLineItem, type RateSet } from '@/lib/energy';

/**
 * A charge line shaped exactly like `lib/planTimeline.test.ts` builds them
 * (itemKind 10 = commodity charge) — only `note` reaches the classifiers.
 */
const line = (note: string): BillLineItem => ({
  note,
  amount: 1,
  rawAmount: 100000,
  itemKind: 10,
  unitCost: null,
  measurement: null,
});

describe('detectPlanType — French bill wording', () => {
  it('reads OEB French ULO period names as ULO', () => {
    const d = detectPlanType([
      line('Période basse de nuit'),
      line('Période creuse (fin de semaine)'),
      line('Période de pointe'),
    ]);
    // The weekend line contains "creuse" AND "fin de semaine" — ULO must
    // win over TOU, exactly like English "Weekend Off-Peak".
    expect(d.plan).toBe('ULO');
  });

  it('reads French TOU period names as TOU', () => {
    const d = detectPlanType([
      line('Période creuse'),
      line('Période normale'),
      line('Période de pointe'),
    ]);
    expect(d.plan).toBe('TOU');
  });

  it('reads French tier/block wording as Tiered', () => {
    expect(detectPlanType([line('BLOC 1 - Hiver')]).plan).toBe('Tiered');
    expect(detectPlanType([line('Palier 2 - Été')]).plan).toBe('Tiered');
  });

  it('keeps the English fingerprints working', () => {
    expect(detectPlanType([line('BLOCK 1 - Winter'), line('BLOCK 2 - Summer')]).plan).toBe('Tiered');
    expect(detectPlanType([line('Off-Peak-Summer'), line('On-Peak')]).plan).toBe('TOU');
    expect(detectPlanType([line('Ultra-Low Overnight'), line('Weekend Off-Peak')]).plan).toBe('ULO');
  });
});

describe('rateForUsageNote — French note wording prices identically', () => {
  const rates = {
    tou: { offPeak: 8, midPeak: 12, onPeak: 17 },
    ulo: { overnight: 3, weekendOffPeak: 7, midPeak: 12, onPeak: 17 },
    tiered: { tier1: 10, tier2: 13 },
  } as unknown as RateSet;

  const price = (note: string) => rateForUsageNote(note, rates);

  it('prices the OEB French period names at the same rates', () => {
    expect(price('Période basse de nuit')).toBe(3);
    expect(price('Période creuse (fin de semaine)')).toBe(7);
    expect(price('Période creuse')).toBe(8);
    expect(price('Période normale')).toBe(12);
    expect(price('Période de pointe')).toBe(17);
  });

  it('prices French tier lines at the same rates', () => {
    expect(price('BLOC 1 - Hiver')).toBe(10);
    expect(price('Palier 2')).toBe(13);
  });

  it('still prices the English wording', () => {
    expect(price('Ultra-Low Overnight')).toBe(3);
    expect(price('Weekend Off-Peak')).toBe(7);
    expect(price('Off-Peak-Summer')).toBe(8);
    expect(price('Mid-Peak-Winter')).toBe(12);
    expect(price('On-Peak')).toBe(17);
    expect(price('BLOCK 1 - Winter')).toBe(10);
    expect(price('Tier 2')).toBe(13);
  });

  it('returns null for a note it cannot price in either language', () => {
    expect(price('Frais d’accès mensuels')).toBeNull();
    expect(price('Monthly access fee')).toBeNull();
  });
});
