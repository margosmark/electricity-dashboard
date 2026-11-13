/**
 * The detection notice `/import` hands to the dashboard across a client-side
 * navigation (t_cb0cf70f — Defect B).
 *
 * `commodityNotice` lives in `useEnergyData`'s state, so `/import` — a
 * different route, a different hook instance — cannot set it, and the
 * dashboard's own state is gone by the time `router.push('/')` lands. Yet
 * the disclosure obligation is exactly the same as the upload modal's: say
 * what the file was detected as. So the committing page STAGES the verdict
 * here and the dashboard CONSUMES it on mount.
 *
 * Module scope is the right channel: `router.push` is a client-side
 * navigation, so the module instance survives the route change (no storage
 * key is written — a raw localStorage diff must not grow a bookkeeping key),
 * and a hard reload loses it — which matches the notice's own lifetime: it
 * is hook state on the modal path too, cleared by dismiss or next upload.
 *
 * Read WITHOUT clearing, clear in the consumer's mount effect: React may
 * double-invoke a `useState` initializer (StrictMode, dev), and a
 * read-and-clear initializer would race itself into `null`.
 */

import type { Commodity } from "@/lib/commodity";

let staged: Commodity | "both" | null = null;

/** The verdict `/import` computed from the document it just wrote. */
export function stageCommodityNotice(next: Commodity | "both" | null): void {
  staged = next;
}

/** Peek at the staged verdict — does NOT consume it (see module doc). */
export function readCommodityNotice(): Commodity | "both" | null {
  return staged;
}

/** Drop the staged verdict once the dashboard has taken it into state. */
export function clearCommodityNotice(): void {
  staged = null;
}
