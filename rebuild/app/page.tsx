'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PillarBar } from '@/components/PillarBar';
import { MarginMeter } from '@/components/MarginMeter';
import { PositionsTable, type PositionRow } from '@/components/PositionsTable';
import { TradeInbox } from '@/components/TradeInbox';
import { AIPanel } from '@/components/AIPanel';
import { FireProgress } from '@/components/FireProgress';
import { Toasts, type ToastMsg } from '@/components/Toast';

interface AccountData {
  accountNumber: string;
  hashValue: string;
  balances: {
    liquidationValue: number;
    availableFunds: number; // AFW (Available For Withdrawal)
    marginBalance: number;
    cashBalance?: number;
  };
  positions: {
    instrument: { symbol: string; putCall?: 'PUT' | 'CALL' };
    longQuantity: number;
    shortQuantity: number;
    marketValue: number;
    currentDayProfitLoss?: number;
  }[];
  pillars: { percents: Record<string, number>; values: Record<string, number> };
}

interface Plan {
  trades: { id: string; rule: string; severity: string; title: string; rationale: string; trade?: { symbol: string; side: string; notional: number } }[];
  alerts: { id: string; title: string; rationale: string; severity: string }[];
  autoExecuted: { id: string; title: string }[];
  approvals: Record<string, string>;
}

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [settings, setSettings] = useState<{ fireTargetEquity: number }>({ fireTargetEquity: 2_000_000 });
  const [authed, setAuthed] = useState(true);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [accRes, planRes, setRes] = await Promise.all([
        fetch('/api/accounts'),
        fetch('/api/signals'),
        fetch('/api/strategy'),
      ]);
      if (accRes.status === 500) {
        const body = await accRes.json();
        if (String(body.error).includes('Not authenticated')) {
          setAuthed(false);
          return;
        }
        throw new Error(body.error);
      }
      const accs = (await accRes.json()) as AccountData[];
      setAccounts(accs);
      setAuthed(true);
      setSelected((s) => s || accs[0]?.hashValue || '');
      if (planRes.ok) setPlan(await planRes.json());
      if (setRes.ok) setSettings(await setRes.json());
    } catch (e) {
      toast(String(e), true);
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (isMarketHours()) refresh(); // 60s auto-refresh during market hours
    }, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const account = accounts.find((a) => a.hashValue === selected);

  if (!authed) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="card p-8 text-center">
          <h1 className="mb-2 text-2xl font-bold">Triple C</h1>
          <p className="mb-4 text-sm opacity-70">Connect your Schwab account to begin.</p>
          <a href="/api/auth/login" className="rounded bg-indigo-600 px-6 py-2 font-semibold text-white">
            Log in with Schwab
          </a>
        </div>
      </main>
    );
  }

  const positions: PositionRow[] = (account?.positions ?? []).map((p) => ({
    symbol: p.instrument.symbol,
    pillar: 'unknown',
    quantity: p.longQuantity - p.shortQuantity,
    marketValue: p.marketValue,
    dayPL: p.currentDayProfitLoss,
  }));

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Triple C</h1>
        <div className="flex items-center gap-3">
          {accounts.length > 1 && (
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            >
              {accounts.map((a) => (
                <option key={a.hashValue} value={a.hashValue}>
                  …{a.accountNumber.slice(-4)}
                </option>
              ))}
            </select>
          )}
          <button onClick={refresh} className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-700">
            Refresh
          </button>
        </div>
      </header>

      {account && (
        <>
          <FireProgress equity={account.balances.liquidationValue} target={settings.fireTargetEquity} />
          <div className="grid gap-4 md:grid-cols-2">
            <PillarBar percents={account.pillars.percents} />
            <MarginMeter
              equity={account.balances.liquidationValue}
              marginDebit={Math.max(0, -account.balances.marginBalance)}
              afw={account.balances.availableFunds}
            />
          </div>
          {plan && plan.alerts.length > 0 && (
            <div className="card space-y-1 border-l-4 border-l-amber-500 p-3">
              {plan.alerts.map((a) => (
                <div key={a.id} className="text-sm">
                  <b>{a.title}</b> <span className="opacity-70">{a.rationale}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <PositionsTable rows={positions} />
            <TradeInbox
              trades={plan?.trades ?? []}
              approvals={plan?.approvals ?? {}}
              accountHash={selected}
              onDecision={(m, e) => {
                toast(m, e);
                refresh();
              }}
            />
          </div>
          <AIPanel />
        </>
      )}
      <Toasts toasts={toasts} />
    </main>
  );
}
