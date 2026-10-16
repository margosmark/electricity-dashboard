/**
 * Wave R — the four-section tab strip, sticky under the header.
 *
 * ARIA tabs, properly: `role="tablist"` with roving tabindex (one stop for
 * the whole strip, arrows move BOTH focus and selection), Home/End to the
 * ends, `aria-selected` + `aria-controls`/`aria-labelledby` wiring, and a
 * panel that only exists when its tab is active. That is the same bar the
 * Wave H a11y checklist holds every control to, so tabs get no exemption.
 *
 * `aria-controls` therefore goes on the SELECTED tab only: an aria-controls
 * that names an id nothing renders is a dangling reference (axe
 * `aria-valid-attr-value`, which is what Lighthouse flagged at 0.87). The
 * inactive panels are not in the DOM at all, so only the one tab whose panel
 * is actually rendered may point at it.
 *
 * Layout: icons + short labels, `overflow-x-auto` so the row fits one line
 * at 390 px without shrinking the touch targets below 44 px; when text
 * scales up (150/200%) each pill keeps its full label — width floors at the
 * label's min-content — and the strip scrolls instead of clipping. The
 * active pill is re-anchored into the visible strip on render, resize and
 * content reflow, so rotation can never leave it stranded off-strip.
 * `no-print` because a printed report is the active section, not the chrome
 * that chose it.
 */

'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Banknote, Gauge, Scale } from 'lucide-react';
import { TABS, type TabId } from '@/lib/tabs';
import { useTranslation } from '@/i18n';

const ICONS: Record<TabId, typeof Gauge> = {
  overview: Gauge,

  plans: Scale,
  money: Banknote,
};

export type TabNavProps = {
  active: TabId;
  onChange: (tab: TabId) => void;
  /** Global display preferences belong in the shell, not below page content. */
  shellTools?: ReactNode;
};

export default function TabNav({ active, onChange, shellTools }: TabNavProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // Wave U — `lib/tabs.ts` keeps the canonical English definitions (pure
  // data, unit-tested); the strip renders the localized view of them.
  const { t } = useTranslation();

  const focusTab = (index: number) => {
    const next = (index + TABS.length) % TABS.length;
    buttons.current[next]?.focus();
    onChange(TABS[next].id);
  };

  /**
   * Where the arrows move FROM. Prefer whichever tab currently holds focus
   * over the `active` prop: two arrow presses inside one frame (or a parent
   * that has not re-rendered yet) must walk ONE step each, not two steps from
   * the same anchor. Falls back to `active` when focus is outside the strip,
   * which is where the first arrow lands.
   */
  const anchorIndex = (): number => {
    const focused = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
    return focused >= 0 ? focused : TABS.findIndex((t) => t.id === active);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = anchorIndex();
    switch (event.key) {
      case 'ArrowRight':
        focusTab(current + 1);
        break;
      case 'ArrowLeft':
        focusTab(current - 1);
        break;
      case 'Home':
        focusTab(0);
        break;
      case 'End':
        focusTab(TABS.length - 1);
        break;
      default:
        return;
    }
    // Without this the browser also scrolls the strip / moves focus itself.
    event.preventDefault();
  };

  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * Keep the ACTIVE pill inside the strip's visible box.
   *
   * The strip scrolls horizontally whenever its content outgrows it — 200%
   * text scaling, landscape rotation, long `fr` labels. Measured on the
   * deployed build (79b7d00): after rotating to 844×390 at 200% the strip
   * had scrolled 186px while the selected money pill sat entirely outside
   * the visible box, and nothing ever pulled it back. Manual scrollLeft math
   * instead of scrollIntoView so the PAGE can never be scrolled as a side
   * effect: only the strip moves, and only by the exact overshoot.
   *
   * Three triggers, one per way the strip's geometry can change:
   *   - every render — active tab, locale or other props changed;
   *   - window resize — orientation / browser-chrome changes;
   *   - ResizeObserver over the pills — any content reflow (text scaling)
   *     that changes a pill's box without either of the above firing.
   * Idempotent: it only nudges when the pill is actually out of view, and a
   * non-scrolling strip clamps scrollLeft to 0, so the default layout is
   * untouched.
   */
  useEffect(() => {
    const reveal = () => {
      const list = listRef.current;
      const pill = buttons.current[TABS.findIndex((t) => t.id === active)];
      if (!list || !pill) return;
      const strip = list.getBoundingClientRect();
      const box = pill.getBoundingClientRect();
      if (box.left < strip.left) list.scrollLeft -= strip.left - box.left;
      else if (box.right > strip.right) list.scrollLeft += box.right - strip.right;
    };
    reveal();
    window.addEventListener('resize', reveal);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(reveal);
      buttons.current.forEach((button) => button && observer?.observe(button));
    }
    return () => {
      window.removeEventListener('resize', reveal);
      observer?.disconnect();
    };
  });

  /**
   * t_2d4a97e6 — three load-bearing numbers on the <nav> class below, all
   * measured on the deployed build (79b7d00):
   *
   * - `-mx-4 md:-mx-6 px-4 md:px-6` must mirror `main`'s own horizontal
   *   padding (`px-4 md:px-6` in page.tsx) exactly, in the SAME rem unit.
   *   The redesign (#110) narrowed main but left these at -mx-8/px-8, so at
   *   every ≥768px width the strip overhung the viewport by 8px (16px at
   *   200% text, where the 2rem vs 1.5rem mismatch doubles) and the whole
   *   page panned sideways on rotation.
   * - the calc() padding-top carrying env(safe-area-inset-top, 0px): the
   *   strip pins at top:0 and body's env() rules only cover
   *   left/right/bottom, so in the standalone PWA (viewport-fit: cover) the
   *   strip slid under the status bar. env() reports 0 in every automation
   *   browser (measured in headless Chromium), hence the var(--safe-top, …)
   *   test seam: the e2e sets --safe-top:47px on :root to measure the
   *   geometry a notched device produces, while real devices fall through
   *   to env(). (Phrased in prose, not as a bracketed utility literal:
   *   Tailwind's scanner picks class-shaped text out of comments too and
   *   would emit the ellipsis version as a broken rule.)
   */
  return (
    <nav
      className="no-print sticky top-0 z-[250] -mx-4 md:-mx-6 px-4 md:px-6 pt-[calc(0.5rem_+_var(--safe-top,env(safe-area-inset-top,0px)))] md:pt-[calc(0.75rem_+_var(--safe-top,env(safe-area-inset-top,0px)))] pb-[3px] bg-inset border-b-2 border-edge"
      data-testid="tab-nav"
    >
      {/*
        D2 (t_fcbba376, restated after the #110 redesign): the selected
        pill's marker is now the `border-b-2 border-b-accent` underline, and
        gap-2 (8px) keeps it 8px clear of the next pill's border so it can
        never weld itself to a neighbour — same clearance the old hard blue
        shadow needed. The 4-tab-era `min-w-[76px]` width floor is gone from
        the pills: it overrode flexbox's automatic min-content minimum, so
        at 200% text labels escaped their own pill box (+14px on the
        deployed build) while the strip wrongly reported "fits". Pills now
        floor at their content and the strip does the scrolling.
      */}
      <div className="flex flex-wrap items-center gap-2 md:flex-nowrap md:gap-3">
        <div
          role="tablist"
          aria-label={t('tabnav.aria')}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          ref={listRef}
          className="flex min-w-0 flex-1 gap-2 overflow-x-auto md:gap-3"
        >
          {TABS.map((tab, index) => {
          const Icon = ICONS[tab.id];
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-controls={selected ? `panel-${tab.id}` : undefined}
              aria-selected={selected}
              aria-current={selected ? 'page' : undefined}
              data-go={tab.id}
              data-testid={`tab-${tab.id}`}
              data-active={String(selected)}
              tabIndex={selected ? 0 : -1}
              title={t(`tab.desc.${tab.id}`)}
              onClick={() => onChange(tab.id)}
              className={`inline-flex min-h-11 flex-1 md:flex-none items-center justify-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 rounded-lg md:rounded-xl border border-edge font-medium normal-case text-xs whitespace-nowrap transition-all ${
                selected
                  ? 'bg-card text-ink border-b-2 border-b-accent'
                  : 'bg-inset text-ink-2 hover:text-ink'
              }`}
            >
              <Icon size={14} strokeWidth={4} aria-hidden="true" className="shrink-0" />
              <span>{t(`tab.${tab.id}`)}</span>
            </button>
          );
          })}
        </div>
        {shellTools && <div className="order-2 basis-full sm:order-none sm:basis-auto">{shellTools}</div>}
      </div>
    </nav>
  );
}
