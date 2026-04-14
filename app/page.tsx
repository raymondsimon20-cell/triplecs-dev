import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function Home({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const session = await getSession();
  if (session?.authenticated) {
    redirect('/dashboard');
  }

  const errorMessages: Record<string, string> = {
    missing_params: 'Authorization failed — missing required parameters.',
    state_mismatch: 'Security check failed. Please try again.',
    token_exchange_failed: 'Could not exchange authorization code. Please try again.',
    missing_env: 'App is not configured. Check environment variables.',
  };

  const errorMsg = searchParams.error
    ? errorMessages[searchParams.error] ?? searchParams.error
    : null;

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Logo / Title */}
        <div>
          <div className="flex items-center justify-center gap-3 mb-4">
            <span className="text-4xl">📈</span>
            <h1 className="text-3xl font-bold text-white">Triple C</h1>
          </div>
          <p className="text-[#7c82a0] text-sm leading-relaxed">
            Real-time portfolio dashboard for the Triple C&apos;s strategy.
            <br />
            Triples · Cornerstone · Core/Income
          </p>
        </div>

        {/* Pillars */}
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
            <div className="text-amber-400 font-semibold mb-1">Triples</div>
            <div className="text-[#7c82a0]">UPRO · TQQQ · SPXL</div>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
            <div className="text-blue-400 font-semibold mb-1">Cornerstone</div>
            <div className="text-[#7c82a0]">CLM · CRF</div>
          </div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
            <div className="text-emerald-400 font-semibold mb-1">Income</div>
            <div className="text-[#7c82a0]">Yieldmax · JEPI</div>
          </div>
        </div>

        {/* Error */}
        {errorMsg && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm">
            {errorMsg}
          </div>
        )}

        {/* Login button */}
        <a
          href="/api/auth/login"
          className="block w-full bg-[#1273ea] hover:bg-[#0f5ec7] text-white font-semibold py-3 px-6 rounded-lg transition-colors"
        >
          Connect Schwab Account
        </a>

        <p className="text-xs text-[#7c82a0]">
          Your credentials never touch our servers — OAuth connects directly to Schwab.
        </p>
      </div>
    </main>
  );
}
