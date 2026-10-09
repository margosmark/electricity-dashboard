/**
 * Wave R — where a plan's colour lives.
 *
 * Extracted from `PlanBands` because that file imports Recharts, and the
 * Wave R timeline needs the same three fills without paying the ~651 KB
 * vendor chunk for two hex values. One definition, two consumers: the money
 * chart's background bands and the switch timeline's segments cannot drift
 * into telling you that yellow is TOU in one place and ULO in another.
 *
 * `PlanBands` re-exports this, so existing imports keep working.
 */

import type { PlanType } from './planTimeline';

export const PLAN_BAND_STYLE: Record<PlanType, { fill: string; label: string }> = {
  TOU: { fill: '#fde047', label: 'TOU' }, // yellow — matches the plan cards
  Tiered: { fill: '#bfdbfe', label: 'TIERED' }, // blue-200
  ULO: { fill: '#bbf7d0', label: 'ULO' }, // green-200
};

/** Periods with no known plan get no honest tint — this is what "none" draws. */
export const UNKNOWN_PLAN_FILL = '#e2e8f0'; // slate-200, hatched in the UI
