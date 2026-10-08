/**
 * The estimate ledger, wired to the browser.
 *
 * Two jobs, in the order they matter:
 *
 *  1. SETTLE — any claim this browser made earlier that the bills now cover
 *     is scored against those bills and moved into the closed list. This runs
 *     before anything is written, so a fresh export closes its own windows in
 *     the same render that first shows them.
 *  2. RECORD — today's open-period claim, upserted by window so the panel
 *     never stacks a new claim for the same days as readings arrive.
 *
 * The pure logic lives in `lib/estimateLedger` (tested without a DOM); this
 * hook owns nothing but storage and an effect. Both pure functions return the
 * SAME object when nothing changed, which is what stops the effect from
 * re-writing forever.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  ESTIMATE_LEDGER_KEY,
  EMPTY_LEDGER,
  closeEstimates,
  readLedger,
  recordOpenEstimate,
  serializeLedger,
  type EstimateLedger,
  type PlanId,
} from '@/lib/estimateLedger';
import type { UsageSummary } from '@/lib/energy';

/** What the open period claims, or null when there is no open period. */
export type OpenClaim = {
  windowStart: number;
  windowEnd: number;
  plan: PlanId;
  estimated: number;
  meteredKwh: number;
};

function load(): EstimateLedger {
  try {
    return readLedger(window.localStorage.getItem(ESTIMATE_LEDGER_KEY));
  } catch {
    // Storage blocked (private mode, quota): the panel still works, it just
    // cannot remember a claim past this page load.
    return EMPTY_LEDGER;
  }
}

export function useEstimateLedger(
  claim: OpenClaim | null,
  summaries: UsageSummary[],
): EstimateLedger {
  // What this browser has recorded so far (the file on disk, first render).
  const [stored, setStored] = useState<EstimateLedger>(load);

  // Settling and recording are PURE derivations of (stored, claim, bills) —
  // no clock, no storage, no writes — so they belong in render: a new export
  // scores its own windows in the very render that first shows them, and the
  // numbers on screen can never be one commit behind what is on disk.
  const ledger = useMemo(() => {
    let next = stored;
    if (summaries.length > 0) next = closeEstimates(next, summaries);
    if (claim && claim.estimated > 0) next = recordOpenEstimate(next, claim);
    return next;
  }, [stored, claim, summaries]);

  // React's own "adjust state while rendering" pattern: fold the derivation
  // back into its own base, so the NEXT claim upserts into what was actually
  // recorded instead of into the mount-time copy (which would drop a window
  // closed earlier in this same session). It converges in one pass: once the
  // two agree the derivation returns the same object and this stops firing.
  if (stored !== ledger) setStored(ledger);

  // localStorage is an external system — syncing it from state is exactly
  // what an effect is for.
  useEffect(() => {
    // Nothing to remember yet: leave storage alone rather than seeding it
    // with an empty document nobody asked for.
    if (ledger.open.length === 0 && ledger.closed.length === 0) return;
    try {
      window.localStorage.setItem(ESTIMATE_LEDGER_KEY, serializeLedger(ledger));
    } catch {
      /* storage refused the write: the in-memory ledger is still correct */
    }
  }, [ledger]);

  return ledger;
}
