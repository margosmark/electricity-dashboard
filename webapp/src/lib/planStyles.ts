/**
 * Wave R — where a plan's colour lives.
 *
 * Extracted from `PlanBands` because that file imports Recharts, and the
 * Wave R timeline needs the same three fills without paying the ~651 KB
 * vendor chunk for two hex values. One definition, two consumers: the money
 * chart's background bands and the switch timeline's segments cannot drift
 * into telling you that yellow is TOU in one place and ULO in another.
 *
 * Dark mode (t_d5d0a86b): the fills became `var(--plan-*)` because a band is
 * a WASH, not data. On white, TOU's #fde047 at full strength is a slab; on a
 * dark card the same hue at full strength is a beacon. Each theme bakes its
 * own tint (35% over white in light, 22% over the card in dark) so a band
 * reads as a band in both — and ink stays ≥9.6:1 on every one. SVG
 * presentation attributes accept `var()` and Recharts passes `fill` straight
 * through, so one definition serves both themes with no `getFoo(theme)`
 * plumbing — exactly the drift `planStyles.ts` was extracted to prevent.
 *
 * The value is the FULL tint, so a consumer that wants the band to sit behind
 * bars draws it at full strength; a consumer that stacks it (the timeline's
 * legend swatch, which paints over a card) owns its own opacity.
 *
 * `PlanBands` re-exports this, so existing imports keep working.
 */

import type { PlanType } from './planTimeline';

export const PLAN_BAND_STYLE: Record<PlanType, { fill: string; label: string }> = {
  TOU: { fill: 'var(--plan-tou)', label: 'TOU' }, // yellow — matches the plan cards
  Tiered: { fill: 'var(--plan-tiered)', label: 'TIERED' }, // blue-200
  ULO: { fill: 'var(--plan-ulo)', label: 'ULO' }, // green-200
};


