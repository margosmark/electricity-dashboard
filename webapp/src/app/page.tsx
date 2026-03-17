import Dashboard from '@/components/Dashboard';

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">⚡ Home Electricity Insights</h1>
          <p className="text-slate-600">Advanced analysis of your Oakville Hydro Green Button data.</p>
        </header>
        <Dashboard />
      </div>
    </main>
  );
}
