'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, LogOut, AlertTriangle, CheckCircle, AlertCircle, TrendingUp } from 'lucide-react';
// Note: CheckCircle, AlertCircle used in ALERT_ICON map below
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { PillarAllocationBar } from '@/components/PillarAllocationBar';
import { MarginRiskPanel } from '@/components/MarginRiskPanel';
import { TriplesTacticalPanel } from '@/components/TriplesTacticalPanel';
import { OptionsStrategyPanel } from '@/components/OptionsStrategyPanel';
import { DividendIncomePanel } from '@/components/DividendIncomePanel';
import { AIAnalysisPanel } from '@/components/AIAnalysisPanel';
import { PositionsTable } from '@/components/PositionsTable';
import { CornerStoneCard } from '@/components/CornerStoneCard';
import type { RuleAlert } from '@/lib/classify';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';

interface AccountData {
  accountNumber: string;
  accountHash: string;
  type: string;
  totalValue: number;
  equity: number;
  marginBalance: number;
  buyingPower: number;
  dayGainLoss: number;
  unrealizedGainLoss: number;
  availableForWithdrawal: number;
  positions: EnrichedPosition[];
  pillarSummary: { pillar: PillarType; label: string; totalValue: number; portfolioPercent: number; positionCount: number; dayGainLoss: number }[];
  marginAlerts: RuleAlert[];
}

const ALERT_ICON = {
  danger: <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />,
  warn: <AlertCircle className="w-4 h-4 text-orange-400 flex-shrink-0" />,
  ok: <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />,
};

const ALERT_STYLE = {
  danger: 'bg-red-500/10 border-red-500/25 text-red-300',
  warn: 'bg-orange-500/10 border-orange-500/25 text-orange-300',
  ok: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300',
};

function fmt$(n: number) {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${str}` : `$${str}`;
}

function MetricCard({
  label,
  value,
  colorClass = 'text-white',
  sub,
}: {
  label: string;
  value: string;
  colorClass?: string;
  sub?: string;
}) {
  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-4">
      <div className="text-xs text-[#7c82a0] mb-1">{label}</div>
      <div className={`text-xl font-bold ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-[#4a5070] mt-0.5">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [dividendsTotal, setDividendsTotal] = useState<number>(0);

  const fetchDividends = useCallback(async () => {
    try {
      const res = await fetch('/api/dividends');
      if (res.ok) {
        const data = await res.json();
        setDividendsTotal(data.total ?? 0);
      }
    } catch {
      // non-critical — fail silently
    }
  }, []);

  const fetchAccounts = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/accounts');
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = '/';
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setAccounts(data.accounts ?? []);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load portfolio data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
    fetchDividends();
    // Auto-refresh every 60 seconds during market hours
    const interval = setInterval(() => fetchAccounts(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchAccounts, fetchDividends]);

  const account = accounts[selectedIdx];

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <RefreshCw className="w-8 h-8 text-blue-400 animate-spin mx-auto" />
          <p className="text-[#7c82a0]">Loading portfolio from Schwab…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-md">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto" />
          <h2 className="text-xl font-semibold text-white">Failed to Load Portfolio</h2>
          <p className="text-[#7c82a0] text-sm">{error}</p>
          <button
            onClick={() => fetchAccounts()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-sm transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[#7c82a0]">No accounts found.</p>
      </div>
    );
  }

  const dayGL = account.dayGainLoss;
  const unrealized = account.unrealizedGainLoss ?? 0;
  const totalReturn = unrealized + dividendsTotal;
  const availableForWithdrawal = account.availableForWithdrawal ?? 0;

  const dangerAlerts = account.marginAlerts.filter((a) => a.level === 'danger');

  return (
    <div className="min-h-screen bg-[#0f1117]">
      {/* Header */}
      <header className="border-b border-[#2d3248] bg-[#1a1d27] sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <TrendingUp className="w-5 h-5 text-blue-400" />
            <span className="font-bold text-white text-lg">Triple C</span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <AccountSwitcher
              accounts={accounts}
              selectedIndex={selectedIdx}
              onSelect={setSelectedIdx}
            />

            <button
              onClick={() => fetchAccounts(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {lastUpdated ? lastUpdated.toLocaleTimeString() : 'Refresh'}
            </button>

            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-red-400 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Logout
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Alert banner for danger alerts */}
        {dangerAlerts.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-2">
            {dangerAlerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-red-300">
                {ALERT_ICON.danger}
                <span><strong>{a.rule}:</strong> {a.detail}</span>
              </div>
            ))}
          </div>
        )}

        {/* Portfolio summary cards — 6 metrics in 2 rows of 3 */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricCard
            label="Portfolio Value"
            value={fmt$(account.totalValue)}
          />
          <MetricCard
            label="Equity"
            value={fmt$(account.equity)}
          />
          <MetricCard
            label="Day Gain / Loss"
            value={fmt$(dayGL)}
            colorClass={dayGL >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
          <MetricCard
            label="Total Return"
            value={fmt$(totalReturn)}
            colorClass={totalReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}
            sub={`Includes $${dividendsTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} dividends`}
          />
          <MetricCard
            label="Available to Withdraw"
            value={fmt$(availableForWithdrawal)}
            colorClass="text-blue-400"
            sub="Cash + money market"
          />
          <MetricCard
            label="Buying Power"
            value={fmt$(account.buyingPower)}
            colorClass="text-purple-400"
          />
        </div>

        {/* Pillar allocation */}
        <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-white">Pillar Allocation</h2>
          <PillarAllocationBar summaries={account.pillarSummary} />
        </div>

        {/* Cornerstone NAV Tracker — Phase 2 */}
        <CornerStoneCard />

        {/* Phase 3 — Margin & Risk Intelligence */}
        <MarginRiskPanel
          equity={account.equity}
          marginBalance={account.marginBalance}
          totalValue={account.totalValue}
          positions={account.positions}
          dividendsAnnual={dividendsTotal}
        />

        {/* Phase 4 — Triple ETF Tactical Engine */}
        <TriplesTacticalPanel
          positions={account.positions}
          totalValue={account.totalValue}
        />

        {/* Phase 5 — Options & Put Strategy */}
        <OptionsStrategyPanel
          positions={account.positions}
          totalValue={account.totalValue}
        />

        {/* Phase 7 — AI Portfolio Analysis */}
        <AIAnalysisPanel
          positions={account.positions}
          totalValue={account.totalValue}
          equity={account.equity}
          marginBalance={account.marginBalance}
          pillarSummary={account.pillarSummary}
          dividendsAnnual={dividendsTotal}
          accountHash={account.accountHash}
        />

        {/* Phase 6 — Income & Dividend Dashboard */}
        <DividendIncomePanel
          positions={account.positions}
          totalValue={account.totalValue}
          marginBalance={account.marginBalance}
        />

        {/* Positions table */}
        <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">
              Positions ({account.positions.length})
            </h2>
            <span className="text-xs text-[#7c82a0]">
              Click column headers to sort
            </span>
          </div>
          <PositionsTable positions={account.positions} />
        </div>
      </main>
    </div>
  );
}
