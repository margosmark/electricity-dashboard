/**
 * Wave J — planning an ingestion that may already have data in the browser.
 *
 * The dashboard is client-only, so a refresh has exactly one place to land:
 * `localStorage.energy_data`, the same key the upload modal writes. That key
 * is the user's whole history, which makes "just overwrite it" the single
 * most destructive thing this app could do. `/import` therefore asks first,
 * and this module is where the numbers on that question come from — pure
 * functions, so the prompt cannot disagree with what the write will do.
 *
 * Design rules (covered by importPlan.test.ts):
 *  - Nothing is written here. `planImport` only reports; the page writes.
 *  - Merge is a UNION on timestamp, with the *incoming* export winning an
 *    overlap: the fresh portal download is the newer account of the same
 *    hour, and a re-run of the same file must be a no-op, not a rewrite.
 *  - Payload decoding accepts raw XML or base64 (the `--b64` output of
 *    `ops/dmd/dmd_export_b64.py`) and refuses anything else with a message
 *    that says what was expected.
 */

import { format } from 'date-fns';
import type { DataPoint } from './energy';

export type PayloadDecode =
  | { ok: true; text: string }
  | { ok: false; error: string };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Raw XML or base64-of-XML in; XML text out, or a user-actionable reason. */
export function decodeImportPayload(raw: string): PayloadDecode {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Nothing to import — paste the export or its base64 form.' };
  }
  if (trimmed.startsWith('<')) return { ok: true, text: trimmed };

  const compact = trimmed.replace(/\s+/g, '');
  if (!BASE64_RE.test(compact)) {
    return {
      ok: false,
      error:
        'That is neither an XML export nor base64 of one. Expected the file to start with "<", or base64 from `dmd_export_b64.py --b64`.',
    };
  }
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    if (!text.trimStart().startsWith('<')) {
      return { ok: false, error: 'Decoded successfully, but the result is not an XML document.' };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'That base64 payload could not be decoded.' };
  }
}

function dayOf(ts: number): string {
  return format(new Date(ts * 1000), 'yyyy-MM-dd');
}

function span(rows: DataPoint[]): { first: string; last: string } {
  if (rows.length === 0) return { first: '', last: '' };
  let first = rows[0].timestamp;
  let last = rows[0].timestamp;
  for (const r of rows) {
    if (r.timestamp < first) first = r.timestamp;
    if (r.timestamp > last) last = r.timestamp;
  }
  return { first: dayOf(first), last: dayOf(last) };
}

export type ImportPlan = {
  /** Rows already in this browser (0 ⇒ no prompt is needed at all). */
  existingRows: number;
  /** Rows the new export carries, before any dedupe. */
  incomingRows: number;
  /** Timestamps present in BOTH — repeated runs of the same file. */
  overlapRows: number;
  /** Rows the export contributes that this browser does not have yet. */
  addedRows: number;
  /** Row count the user gets from "Merge" (union, incoming wins). */
  mergeRows: number;
  /** Row count the user gets from "Replace" (the export only). */
  replaceRows: number;
  existingFirst: string;
  existingLast: string;
  incomingFirst: string;
  incomingLast: string;
  /** True when the two sets are identical — merging would change nothing. */
  identical: boolean;
};

function dedupeByTimestamp(rows: DataPoint[]): Map<number, DataPoint> {
  const byTs = new Map<number, DataPoint>();
  for (const r of rows) byTs.set(r.timestamp, r);
  return byTs;
}

/**
 * Report what a merge and a replace would each produce.
 *
 * Sources are ordered incoming-first so `mergeRows` reflects the incoming
 * export winning every overlapping timestamp — the same rule the write uses.
 */
export function planImport(existing: DataPoint[], incoming: DataPoint[]): ImportPlan {
  const existingByTs = dedupeByTimestamp(existing);
  const incomingByTs = dedupeByTimestamp(incoming);

  let overlap = 0;
  for (const ts of incomingByTs.keys()) {
    if (existingByTs.has(ts)) overlap += 1;
  }

  const merged = new Map<number, DataPoint>(existingByTs);
  for (const [ts, row] of incomingByTs) merged.set(ts, row);

  const existingSpan = span(existing);
  const incomingSpan = span(incoming);
  const mergedRows = [...merged.keys()].sort((a, b) => a - b);

  return {
    existingRows: existing.length,
    incomingRows: incoming.length,
    overlapRows: overlap,
    addedRows: incomingByTs.size - overlap,
    mergeRows: mergedRows.length,
    replaceRows: incomingByTs.size,
    existingFirst: existingSpan.first,
    existingLast: existingSpan.last,
    incomingFirst: incomingSpan.first,
    incomingLast: incomingSpan.last,
    identical: overlap === existingByTs.size && overlap === incomingByTs.size,
  };
}

/**
 * The rows a confirmed merge writes: every timestamp from both sets, with
 * the incoming export's value where they disagree. Sorted ascending, which
 * is the order `energy_data` is documented to hold.
 */
export function mergeForWrite(existing: DataPoint[], incoming: DataPoint[]): DataPoint[] {
  const byTs = dedupeByTimestamp(existing);
  for (const [ts, row] of dedupeByTimestamp(incoming)) byTs.set(ts, row);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}


