import Dashboard from '@/components/Dashboard';
import HeaderTagline from '@/components/HeaderTagline';
import ViewModeSwitch from '@/components/ViewModeSwitch';

/**
 * Page shell.
 *
 * Two seams live on this element (t_82a4dc08), both of the shape
 * "existing spacing + the value a notched device reports":
 *
 *  1. TOP SAFE AREA — `viewport-fit: cover` (layout.tsx) lets the installed
 *     PWA's status bar overlay the top of the layout viewport, so at scroll 0
 *     the title sat under it (measured ≈47-59px on notched iPhones; `env()`
 *     reports 0 in every automation browser, hence the `--safe-top` seam the
 *     e2e sets to reproduce the geometry). The reserve is ADDED to the
 *     existing top padding — 0.75rem below md, 1.25rem at md and up — so with
 *     an inset of 0 the padding is byte-identical to the old `py-3 md:py-5`.
 *     TabNav's own strip carries the same seam for the moment it sticks to
 *     the top (t_2d4a97e6); this one covers the page before any scroll.
 *
 *  2. Horizontal padding is untouched: `px-4 md:px-6` plus `pb-3 md:pb-5`
 *     keep the bottom reserve the old vertical padding gave.
 *
 * Note for readers: keep the padded-top class out of prose below — the
 * Tailwind extractor reads comments in this file and would emit the literal
 * bracket form as a broken rule.
 */
export default function Home() {
  return (
    <main
      className="min-h-screen bg-inset px-4 md:px-6 pb-3 md:pb-5 pt-[calc(0.75rem_+_var(--safe-top,env(safe-area-inset-top,0px)))] md:pt-[calc(1.25rem_+_var(--safe-top,env(safe-area-inset-top,0px)))]"
      data-testid="page-shell"
    >
      <div className="max-w-[1180px] mx-auto space-y-3 md:space-y-4">
        <header
          className="min-h-11 flex flex-wrap items-center gap-3 border-b border-edge-muted pb-2"
          data-testid="page-header"
        >
          <h1 className="text-sm md:text-base font-semibold text-ink tracking-tight whitespace-nowrap">Ontario Energy Optimizer</h1>
          {/* Wave U — the one translated string in this server header. */}
          <div className="hidden sm:block"><HeaderTagline /></div>
          <ViewModeSwitch current="quiet" />
        </header>
        <Dashboard />
      </div>
    </main>
  );
}
