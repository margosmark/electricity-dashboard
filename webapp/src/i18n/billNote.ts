/**
 * The display layer for the utility's own bill-line names (`BillLineItem.note`)
 * — the ONE place a line name becomes text (t_0a96fd14).
 *
 * WHY THIS EXISTS
 * "Your actual bill" prints the file's `costAdditionalDetailLastPeriod` items
 * verbatim, because `BillLineItem.note` is the only dependable label the ESPI
 * feed carries (`lib/energy.ts`). That is right for the DATA — classification,
 * grouping and every fraud/completeness check key off the note — but it made
 * the French page print English line names inside French chrome, and the whole
 * point of the panel is that a reader can line the bill up with their own.
 *
 * This module follows the same rule as `periodLabel()` (canonical rate-period
 * names) and `seriesNoteText()` (the ingestion's refusal sentences):
 *
 *   • the NOTE stays canonical — `note` in `BillLineItem` is never normalised,
 *     and the raw wording is what the panel keeps on the node itself
 *     (`data-bill-note`, plus a `title` tooltip) so the file's own words are
 *     always recoverable from the DOM;
 *   • the CATALOG carries the localized VIEW of each name, in `en`/`fr`, and
 *     `billNoteText()` is the only function that builds the displayed text.
 *
 * `billNoteText()` falls back to the raw note whenever it cannot be sure of a
 * full translation: a line name no catalog entry covers (another utility's
 * wording, a line this app has never seen, a `note` that carries values), a key
 * the catalog lacks. A note can therefore never reach the screen as a raw
 * catalog key, and an unknown line is printed exactly as the utility wrote it.
 *
 * The English catalog values ARE the utility's wording, byte for byte, so the
 * English page renders identically to before this module existed —
 * `billNote.test.tsx` pins that against the committed fixtures, and pins that
 * every key is the file's own text rather than a label anybody invented.
 */

import { CATALOGS, getLocale } from './index';

/** The translator a component already has (`useTranslation().t`). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Normalised note → catalog key. The key is the note with case, spacing and the
 * read-date dash folded, and every digit run masked to `#` — the H.S.T. line
 * carries the utility's registration number inside its name, and the NUMBER is
 * the data (it travels as `{n}`), not part of the label.
 */
const FIXTURE_BILL_NOTE_KEYS: Readonly<Record<string, string>> = {
  'amount due': 'billnote.amountDue',
  'balance forward': 'billnote.balanceForward',
  'bill post date': 'billnote.billPostDate',
  'billing period - current read date': 'billnote.billingPeriodCurrentReadDate',
  'billing period - previous read date': 'billnote.billingPeriodPreviousReadDate',
  'current meter read': 'billnote.currentMeterRead',
  'previous meter read': 'billnote.previousMeterRead',
  delivery: 'billnote.delivery',
  'distribution loss factor': 'billnote.distributionLossFactor',
  'due date': 'billnote.dueDate',
  'h.s.t. # #': 'billnote.hstRegistration',
  'mid peak-summer': 'billnote.midPeakSummer',
  'mid peak-summer usage': 'billnote.midPeakSummerUsage',
  'off peak-summer': 'billnote.offPeakSummer',
  'off peak-summer usage': 'billnote.offPeakSummerUsage',
  'on peak-summer': 'billnote.onPeakSummer',
  'on peak-summer usage': 'billnote.onPeakSummerUsage',
  'ontario electricity rebate': 'billnote.ontarioElectricityRebate',
  'regulatory charges': 'billnote.regulatoryCharges',
  'total electricity charges': 'billnote.totalElectricityCharges',
  'number of days in bill period': 'billnote.numberOfDaysInBillPeriod',
};

/**
 * The SECOND document's vocabulary: every line name the committed Enbridge Gas
 * (Ontario) feed carries that the fixture utility's list above does not already
 * cover (`tests/fixtures/utility-enbridge-gas.xml`, provenance in that
 * directory's README).
 *
 * WHY A GAS BILL IS IN AN ELECTRICITY APP'S CATALOG
 * `ActualBillPanel` renders whatever itemized `UsageSummary` the imported file
 * carries: a gas summary routes to `GasBillPeriodCard` (shipped with the gas
 * tabs, f65e778 — a curated card: charges, collapsed zero-lines, rates,
 * volume, facts) and an electric one to the line list, and both print the
 * line names through `billNoteText` — `classifyBillLine()` deliberately keys
 * off the raw note and sends an unknown wording to `other` rather than
 * dropping it. So an Ontario household that imports its Enbridge feed reaches
 * the same surfaces an Oakville bill does (the bill card and the plan-timeline
 * evidence line), and on the French page every one of those 30 names printed
 * English. Seven of the feed's names already sat in the table above, word for
 * word (`Amount Due`, `Due Date`, the two read dates, both meter reads, the
 * days-in-bill-period line), which is the evidence that the vocabulary is
 * shared across commodities rather than gas-specific.
 *
 * Same rule as the block above: the EN value is the file's own wording byte
 * for byte, and `billNote.test.tsx`'s "invents no vocabulary" ratchet compares
 * every value here against a name a committed fixture actually states — so a
 * label nobody can point at a document cannot enter this table.
 */
const PROVIDER_BILL_NOTE_KEYS: Readonly<Record<string, string>> = {
  'adjustment factor (atmospheric)': 'billnote.adjustmentFactorAtmospheric',
  'balance forward ($)': 'billnote.balanceForwardAmount',
  'bill date': 'billnote.billDate',
  'charges from other companies ($)': 'billnote.chargesFromOtherCompanies',
  'contract demand charge': 'billnote.contractDemandCharge',
  'customer charge': 'billnote.customerCharge',
  'direct purchase admin charge': 'billnote.directPurchaseAdminCharge',
  'expansion surcharge': 'billnote.expansionSurcharge',
  'gas cost adjustment ($)': 'billnote.gasCostAdjustment',
  'gas cost adjustment ¢/m#': 'billnote.gasCostAdjustmentRate',
  'gas delivery variable charge': 'billnote.gasDeliveryVariableCharge',
  'gas federal carbon charge': 'billnote.gasFederalCarbonCharge',
  'gas service provider admin fee ($)': 'billnote.gasServiceProviderAdminFee',
  'gas service provider supply charge ($)': 'billnote.gasServiceProviderSupplyCharge',
  'gas supply charge': 'billnote.gasSupplyCharge',
  'gas supply rate ¢/m#': 'billnote.gasSupplyRate',
  'gas transportation charge ($)': 'billnote.gasTransportationCharge',
  'hydrogen blended credit': 'billnote.hydrogenBlendedCredit',
  'hst ($)': 'billnote.hstAmount',
  'load balancing charge': 'billnote.loadBalancingCharge',
  'other gas charges ($)': 'billnote.otherGasCharges',
  'payments received ($)': 'billnote.paymentsReceived',
  'previous balance ($)': 'billnote.previousBalance',
  'previous usage consumption': 'billnote.previousUsageConsumption',
  'pressure factor': 'billnote.pressureFactor',
  'reversal of previously billed charges': 'billnote.reversalOfPreviouslyBilledCharges',
  'total gas charges ($)': 'billnote.totalGasCharges',
  'total gas supply rate ¢/m# (net)': 'billnote.totalGasSupplyRate',
  'transportation to enbridge (lvb)': 'billnote.transportationToEnbridge',
  'usage (unadjusted)': 'billnote.usageUnadjusted',
};

/**
 * Normalised note → catalog key, from BOTH committed documents. The table is
 * two-way with the fixtures and `billNote.test.tsx` pins it from three sides:
 * every name reaches a key, every key reaches a name, and every name still
 * composes back to ITS OWN wording — so a name that folded onto another's key
 * fails the byte-identical test rather than printing the wrong label.
 */
export const BILL_NOTE_KEYS: Readonly<Record<string, string>> = {
  ...FIXTURE_BILL_NOTE_KEYS,
  ...PROVIDER_BILL_NOTE_KEYS,
};

/**
 * Case, spacing and dash folding + digit masking. A utility that writes
 * `Billing Period – Current Read Date` (en dash) or `BILL POST DATE` reaches the
 * same entry; anything this normalisation does not recognise falls back to the
 * verbatim note, which is the honest outcome.
 */
export function normalizeBillNote(note: string): string {
  return note
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\d+/g, '#');
}

/**
 * Whether the catalog defines a key in the reader's language (or in English — a
 * key the French catalog lacks must still be recognised as *a* key, so this
 * display layer falls back to the canonical wording instead of printing the key
 * text at a user).
 */
export function catalogHas(key: string): boolean {
  return key in CATALOGS[getLocale()] || key in CATALOGS.en;
}

/**
 * The catalog key for this line name, or null when it must be printed from the
 * note itself: an unknown name, or a key the catalog does not define.
 */
export function billNoteKey(note: string): string | null {
  const key = BILL_NOTE_KEYS[normalizeBillNote(note)];
  return key && catalogHas(key) ? key : null;
}

/** The values a catalogued line name interpolates (today: the H.S.T. number). */
export function billNoteParams(note: string): Record<string, string | number> {
  const digits = note.match(/\d+/)?.[0];
  return digits ? { n: digits } : {};
}

/**
 * The line name, in the reader's language — or the utility's own wording when no
 * full translation is available. Never a raw key.
 */
export function billNoteText(note: string, t: Translate): string {
  const key = billNoteKey(note);
  if (!key) return note;
  return t(key, billNoteParams(note));
}
