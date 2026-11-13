/**
 * `/import`'s decision about the BILL half of a Green Button file.
 *
 * A feed has two halves that land in two different places: the readings go
 * under `energy_data_v2` (storage.ts, the merge review in importPlan.ts),
 * and the UsageSummary bills + the feed's clock rules go under
 * `usage_summaries` / `local_time_parameters` (useDashboard's
 * `writeStoredBillFeed`). The upload modal folds the bill half in with
 * `commitBillFeed("replace" | "union")`; this page must reach the SAME
 * verdict, or an import through here silently drops the bills — which is
 * exactly the defect this module exists to close (gas never rendered after
 * importing an EGD export at `/import`).
 *
 * Two rules, both inherited from useDashboard's semantics:
 *
 *  - `merge` — union with what is already stored. A file that carries no
 *    summaries must not erase an existing bill feed: `unionBillFeeds` keeps
 *    the base's periods and its clock when the incoming file declares none.
 *  - `replace` — the file the user just reviewed IS the dataset, so the
 *    stored feed becomes exactly what it parsed (nothing, if it parsed no
 *    bills). Normalised through `unionBillFeeds(EMPTY, …)` for the same
 *    de-dupe/sort the modal's replace path applies.
 *
 * Nothing is written here — `planBillFeed` only reports; the page writes
 * (same contract as importPlan.ts).
 */

import { EMPTY_BILL_FEED, unionBillFeeds, type BillFeed } from '@/hooks/useDashboard';

/** Which write the confirmed import performs. `merge` is also what a
 *  no-review commit uses: without a review screen the user has not chosen
 *  to drop anything. */
export type BillFeedMode = 'merge' | 'replace';

/** The bill feed a commit of `incoming` should persist over `existing`. */
export function planBillFeed(mode: BillFeedMode, existing: BillFeed, incoming: BillFeed): BillFeed {
  return mode === 'replace'
    ? unionBillFeeds(EMPTY_BILL_FEED, incoming)
    : unionBillFeeds(existing, incoming);
}
