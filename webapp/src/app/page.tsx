import Dashboard from '@/components/Dashboard';
import HeaderTagline from '@/components/HeaderTagline';
import ViewModeSwitch from '@/components/ViewModeSwitch';

export default function Home() {
  return (
    <main className="min-h-screen bg-inset px-4 md:px-6 py-3 md:py-5">
      <div className="max-w-[1180px] mx-auto space-y-3 md:space-y-4">
        <header className="min-h-11 flex flex-wrap items-center gap-3 border-b border-edge-muted pb-2">
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
