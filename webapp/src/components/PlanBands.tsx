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

export type PlanAnnotation = PeriodPlanAnnotation;

export const PLAN_BAND_STYLE: Record<PlanType, { fill: string; label: string }> = {
  TOU: { fill: '#fde047', label: 'TOU' }, // yellow — matches the plan cards
  Tiered: { fill: '#bfdbfe', label: 'TIERED' }, // blue-200
  ULO: { fill: '#bbf7d0', label: 'ULO' }, // green-200
};

export type PlanBandDatum = {
  /** The exact category value the axis draws (row label). */
  key: string;
  plan: PlanType;
  origin: 'detected' | 'declared';
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
            fillOpacity={0.35}
            stroke="#000"
            strokeDasharray="4 3"
            strokeWidth={1}
            /* Annotation, not data: a band whose key somehow leaves the
               chart must disappear, never grow a phantom axis category. */
            ifOverflow="hidden"
            label={{
              value: style.label,
              position: layout === 'horizontal' ? 'insideTop' : 'insideRight',
              fill: '#000',
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
