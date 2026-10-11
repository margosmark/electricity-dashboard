/**
 * Wave P slice 5 — the plan-type annotation layer for Wave O's money chart.
 *
 * Each billing period's bar gets a background band tinted and labelled with
 * the plan that period was actually billed under (detected from the bill, or
 * declared by you) — so the composition story and the plan story read from
 * one chart. Periods with no known plan get no band: there is nothing
 * honest to tint.
 *
 * The bands are Recharts ReferenceAreas keyed by the chart's own category
 * values (the period labels), rendered BEFORE the bars so they paint behind
 * them. Horizontal layout puts categories on x, the 100%-share view flips
 * them onto y — both are handled here so the caller does not care.
 */

"use client";

import { ReferenceArea } from 'recharts';

import type { PeriodPlanAnnotation, PlanType } from '@/lib/planTimeline';
import { PLAN_BAND_STYLE } from '@/lib/planStyles';

export type PlanAnnotation = PeriodPlanAnnotation;

/* Wave R: the fills moved to lib/planStyles so a component that must not
 * import Recharts (the switch timeline) can share them. Re-exported here so
 * every existing import of PLAN_BAND_STYLE keeps resolving. */
export { PLAN_BAND_STYLE };

export type PlanBandDatum = {
  /** The exact category value the axis draws (row label). */
  key: string;
  plan: PlanType;
  /** Informational; an unknown ORIGIN can no longer coexist with a known
   *  plan, but the annotation type keeps the union in one place. */
  origin: PeriodPlanAnnotation['origin'];
};

type Props = {
  /** One entry per period that has a known plan, in chart order. */
  bands: PlanBandDatum[];
  /** 'horizontal': categories on x (dollars/usage). 'vertical': on y (share). */
  layout: 'horizontal' | 'vertical';
};

export function PlanBands({ bands, layout }: Props) {
  return (
    <>
      {bands.map((band) => {
        const style = PLAN_BAND_STYLE[band.plan];
        const coords =
          layout === 'horizontal' ? { x1: band.key, x2: band.key } : { y1: band.key, y2: band.key };
        return (
          <ReferenceArea
            key={`${band.key}-${band.plan}`}
            {...coords}
            /* Behind the bars (SVG paints in document order) and never
               stealing the axis domain: a band is an annotation, not data. */
            fill={style.fill}
            stroke="var(--edge)"
            strokeDasharray="4 3"
            strokeWidth={1}
            /* Annotation, not data: a band whose key somehow leaves the
               chart must disappear, never grow a phantom axis category. */
            ifOverflow="hidden"
            label={{
              value: style.label,
              position: layout === 'horizontal' ? 'insideTop' : 'insideRight',
              /* The band's own text: ink in BOTH themes. Light bands are
                 pale tints so black reads (13.7:1 on TOU's yellow); dark bands
                 are the same hue washed over the card, where black would be
                 ~1.5:1 and --ink (slate-50) is 9.6:1. One token, both themes. */
              fill: 'var(--ink)',
              fontSize: 9,
              fontWeight: 900,
            }}
            data-testid={`plan-band-${band.key}`}
            data-plan={band.plan}
          />
        );
      })}
    </>
  );
}

export default PlanBands;
