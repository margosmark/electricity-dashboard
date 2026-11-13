import Dashboard from '@/components/classic/Dashboard';
import ActivePlanChip from '@/components/classic/ActivePlanChip';
import HeaderTagline from '@/components/classic/HeaderTagline';
import ViewModeSwitch from '@/components/ViewModeSwitch';

import './classic.css';

/**
 * The authentic pre-Quiet-Meter dashboard, rewound from ab2a892: the header
 * composition and the Dashboard are the historical sources verbatim (the
 * ab2a892 page shape), mounted under /classic. Adaptations beyond the
 * historical markup: (a) the view switch that links this view with `/`,
 * (b) `classic-scope` re-values the token cascade for this subtree
 * (classic.css), so the pre-redesign palette cannot leak to `/`.
 */
export default function ClassicPage() {
  return (
    <main className="classic-scope min-h-screen bg-inset p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <header className="relative mb-4 md:mb-8">
          <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-ink uppercase tracking-tighter italic border-b-4 md:border-b-8 border-edge w-fit pr-4 md:pr-8 pb-1 md:pb-2">Ontario Energy Optimizer</h1>
          {/* Wave U — the one translated string in this server header. */}
          <HeaderTagline />
          {/* Wave H item 2: the active plan, visible before any scrolling. */}
          <ActivePlanChip />
          {/* Adaptation: the accessible view switch between / and /classic.
              It must not reflow the historical header (extra row): it hangs
              off the header's top-right corner, in-flow only where there is
              no room to overlap (narrow phones). */}
          <div className="no-print sm:absolute sm:top-0 sm:right-0">
            <ViewModeSwitch current="classic" />
          </div>
        </header>
        <Dashboard />
      </div>
    </main>
  );
}
