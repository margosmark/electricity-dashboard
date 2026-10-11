import Dashboard from '@/components/Dashboard';
import ActivePlanChip from '@/components/ActivePlanChip';
import HeaderTagline from '@/components/HeaderTagline';

export default function Home() {
  return (
    <main className="min-h-screen bg-inset p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <header className="mb-4 md:mb-8">
          <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-ink uppercase tracking-tighter italic border-b-4 md:border-b-8 border-edge w-fit pr-4 md:pr-8 pb-1 md:pb-2">Ontario Energy Optimizer</h1>
          {/* Wave U — the one translated string in this server header. */}
          <HeaderTagline />
          {/* Wave H item 2: the active plan, visible before any scrolling. */}
          <ActivePlanChip />
        </header>
        <Dashboard />
      </div>
    </main>
  );
}
