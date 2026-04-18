'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, LogOut, AlertTriangle, CheckCircle, AlertCircle,
  TrendingUp, BarChart2, Shield, Zap, Brain, DollarSign,
  List, Calculator, PieChart, Calendar, Gauge, History, ClipboardList, Eye, BookOpen,
  Sun, LayoutGrid,
} from 'lucide-react';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { PillarAllocationBar } from '@/components/PillarAllocationBar';
import { MarginRiskPanel } from '@/components/MarginRiskPanel';
import { TriplesTacticalPanel } from '@/components/TriplesTacticalPanel';
import { OptionsStrategyPanel } from '@/components/OptionsStrategyPanel';
import { DividendIncomePanel } from '@/components/DividendIncomePanel';
import { AIAnalysisPanel } from '@/components/AIAnalysisPanel';
import { TradeHistoryPanel } from '@/components/TradeHistoryPanel';
import { RebalanceCalculator } from '@/components/RebalanceCalculator';
import { OpenPutTracker } from '@/components/OpenPutTracker';
import { FundFamilyMonitor } from '@/components/FundFamilyMonitor';
import { DistributionCalendar } from '@/components/DistributionCalendar';
import { MarginSimulator } from '@/components/MarginSimulator';
import { PositionsTable } from '@/components/PositionsTable';
import { PendingOrdersPanel, usePendingOrderSymbols } from '@/components/PendingOrdersPanel';
import { CornerStoneCard } from '@/components/CornerStoneCard';
import { CollapsiblePanel } from '@/components/CollapsiblePanel';
import { SettingsPanel, useStrategyTargets } from '@/components/SettingsPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PortfolioExport } from '@/components/PortfolioExport';
import { AlertMonitor } from '@/components/ToastProvider';
import { WatchlistPanel } from '@/components/WatchlistPanel';
import { StrategyGuide } from '@/components/StrategyGuide';
import { MarketConditionsDashboard } from '@/components/MarketConditionsDashboard';
import { SimplifiedTradeWorkflow } from '@/components/SimplifiedTradeWorkflow';
import { DailyFlow } from '@/components/DailyFlow';
import { updateStrategyTargets } from '@/components/SettingsPanel';
import type { RuleAlert, PillarSummary } from '@/lib/classify';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import type { StrategyTargets } from '@/lib/utils';
import { fmt$, gainLossColor } from '@/lib/utils';

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

// ─── Alert icons ──────────────────────────────────────────────────────────────

const ALERT_ICON = {
  danger: <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />,
  warn:   <AlertCircle   className="w-4 h-4 text-orange-400 flex-shrink-0" />,
  ok:     <CheckCircle   className="w-4 h-4 text-emerald-400 flex-shrink-0" />,
};

// ─── Metric card ──────────────────────────────────────────────────────────────

function MetricCard({
  label, value, colorClass = 'text-white', sub, trend,
}: {
  label: string;
  value: string;
  colorClass?: string;
  sub?: string;
  trend?: 'up' | 'down' | null;
}) {
  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-4 flex flex-col gap-1 hover:border-[#3d4468] transition-colors">
      <div className="text-[11px] text-[#7c82a0] font-medium tracking-wide uppercase">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${colorClass} flex items-center gap-1`}>
        {value}
        {trend === 'up'   && <TrendingUp   className="w-3.5 h-3.5 text-emerald-400 opacity-70" />}
        {trend === 'down' && <TrendingUp   className="w-3.5 h-3.5 text-red-400 opacity-70 rotate-180" />}
      </div>
      {sub && <div className="text-[11px] text-[#4a5070] leading-snug">{sub}</div>}
    </div>
  );
}

// ─── FIRE progress bar ────────────────────────────────────────────────────────

function FireProgress({ monthly, target }: { monthly: number; target: number }) {
  const pct = target > 0 ? Math.min((monthly / target) * 100, 100) : 0;
  const reached = pct >= 100;
  return (
    <div className="hidden md:flex items-center gap-2 min-w-[160px]" title={`FIRE target: $${target.toLocaleString()}/mo`}>
      <span className="text-[11px] text-[#7c82a0] whitespace-nowrap">FIRE</span>
      <div className="flex-1 h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${reached ? 'bg-emerald-400' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] font-semibold tabular-nums ${reached ? 'text-emerald-400' : 'text-[#7c82a0]'}`}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

// ─── Data age indicator ───────────────────────────────────────────────────────

function DataAge({ updated }: { updated: Date }) {
  const [, forceRender] = useState(0);

  // Re-render every 15 seconds to update the age display
  useEffect(() => {
    const id = setInterval(() => forceRender((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const ageSec = Math.floor((Date.now() - updated.getTime()) / 1000);
  const ageMin = Math.floor(ageSec / 60);

  let dotColor = 'bg-emerald-400';   // fresh (< 2 min)
  let label = `${ageSec}s ago`;
  if (ageMin >= 5) {
    dotColor = 'bg-orange-400';
    label = `${ageMin}m ago`;
  } else if (ageMin >= 2) {
    dotColor = 'bg-yellow-400';
    label = `${ageMin}m ago`;
  } else if (ageSec >= 60) {
    label = `1m ago`;
  }

  return (
    <span className="hidden sm:flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

// ─── View mode toggle ────────────────────────────────────────────────────────

function ViewModeToggle({
  mode, onChange,
}: { mode: 'today' | 'dashboard'; onChange: (m: 'today' | 'dashboard') => void }) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="hidden sm:inline-flex items-center bg-[#0f1117] border border-[#2d3248] rounded-lg p-0.5"
    >
      <button
        role="tab"
        aria-selected={mode === 'today'}
        onClick={() => onChange('today')}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
          mode === 'today'
            ? 'bg-blue-600/20 text-blue-300 shadow-sm'
            : 'text-[#7c82a0] hover:text-white'
        }`}
      >
        <Sun className="w-3.5 h-3.5" />
        Today
      </button>
      <button
        role="tab"
        aria-selected={mode === 'dashboard'}
        onClick={() => onChange('dashboard')}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
          mode === 'dashboard'
            ? 'bg-blue-600/20 text-blue-300 shadow-sm'
            : 'text-[#7c82a0] hover:text-white'
        }`}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        Dashboard
      </button>
    </div>
  );
}

// ─── Section jump nav ─────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: 'overview',     label: 'Overview',      icon: BarChart2   },
  { id: 'market',       label: 'Market',        icon: TrendingUp  },
  { id: 'cornerstone',  label: 'Cornerstone',   icon: PieChart    },
  { id: 'margin',       label: 'Margin',        icon: Gauge       },
  { id: 'triples',      label: 'Triples',       icon: Zap         },
  { id: 'options',      label: 'Options',       icon: Shield      },
  { id: 'ai',           label: 'AI Analysis',   icon: Brain       },
  { id: 'income',       label: 'Income',        icon: DollarSign  },
  { id: 'calendar',     label: 'Calendar',      icon: Calendar    },
  { id: 'rebalance',    label: 'Rebalance',     icon: Calculator  },
  { id: 'puts',         label: 'Open Puts',     icon: History     },
  { id: 'families',     label: 'Fund Families', icon: List        },
  { id: 'simulator',    label: 'Simulator',     icon: Gauge       },
  { id: 'watchlist',    label: 'Watchlist',     icon: Eye         },
  { id: 'orders',       label: 'Orders',        icon: ClipboardList },
  { id: 'positions',    label: 'Positions',     icon: List        },
  { id: 'strategy',     label: 'Strategy Guide', icon: BookOpen   },
];

function SectionNav() {
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          // Pick the topmost visible section
          const top = visible.reduce((a, b) =>
            a.boundingClientRect.top < b.boundingClientRect.top ? a : b
          );
          setActive(top.target.id.replace('panel-', ''));
        }
      },
      { rootMargin: '-60px 0px -60% 0px', threshold: 0 }
    );
    NAV_ITEMS.forEach(({ id }) => {
      const el = document.getElementById(`panel-${id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  function scrollTo(id: string) {
    const el = document.getElementById(`panel-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <nav className="w-full overflow-x-auto border-b border-[#2d3248] bg-[#0f1117] sticky top-[57px] z-30">
      <div className="max-w-7xl mx-auto px-4 flex gap-0.5 py-1.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => scrollTo(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors
              ${active === id
                ? 'bg-blue-600/20 text-blue-400'
                : 'text-[#7c82a0] hover:text-white hover:bg-white/5'
              }`}
          >
            <Icon className="w-3 h-3 flex-shrink-0" />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [accounts, setAccounts]         = useState<AccountData[]>([]);
  const [selectedIdx, setSelectedIdx]   = useState(0);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);
  const [dividendsTotal, setDividendsTotal] = useState<number>(0);
  // Estimated monthly income from dividend data (for FIRE pill)
  const [monthlyIncome, setMonthlyIncome]   = useState<number>(0);
  // FIRE target from settings (default 10 000)
  const [fireTarget] = useState<number>(() => {
    if (typeof window === 'undefined') return 10_000;
    try {
      const raw = localStorage.getItem('triplec_strategy_targets');
      return raw ? (JSON.parse(raw).fireNumber ?? 10_000) : 10_000;
    } catch { return 10_000; }
  });

  const pendingOrders = usePendingOrderSymbols(accounts[selectedIdx]?.accountHash ?? '');
  const strategyTargets = useStrategyTargets();

  // View mode: 'today' = curated daily flow, 'dashboard' = full detail
  const [viewMode, setViewMode] = useState<'today' | 'dashboard'>(() => {
    if (typeof window === 'undefined') return 'today';
    try {
      const stored = localStorage.getItem('triplec_view_mode');
      return stored === 'dashboard' ? 'dashboard' : 'today';
    } catch { return 'today'; }
  });

  function switchView(next: 'today' | 'dashboard') {
    setViewMode(next);
    try { localStorage.setItem('triplec_view_mode', next); } catch { /* ignore */ }
  }

  // Jump from Today view → Dashboard view and scroll to the target section
  const jumpToSection = useCallback((sectionId: string) => {
    switchView('dashboard');
    // Wait for dashboard render + any panel expand animations
    setTimeout(() => {
      const el = document.getElementById(`panel-${sectionId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }, []);

  const fetchDividends = useCallback(async () => {
    try {
      const res = await fetch('/api/dividends');
      if (!res.ok) {
        console.warn('[fetchDividends] API returned', res.status);
        return;
      }
      const data = await res.json() as {
        dividends?: { amount: number; date: string; symbol: string }[];
        total?: number;
      };
      const total = data.total ?? 0;
      setDividendsTotal(total);

      // Calculate monthly income from recent 30-day dividends if detailed data available
      if (Array.isArray(data.dividends) && data.dividends.length > 0) {
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const recentSum = data.dividends
          .filter((d) => new Date(d.date).getTime() >= thirtyDaysAgo)
          .reduce((s, d) => s + d.amount, 0);
        // Annualize the 30-day window if we have recent data, otherwise use total/12
        setMonthlyIncome(recentSum > 0 ? recentSum : total / 12);
      } else {
        setMonthlyIncome(total / 12);
      }
    } catch (err) {
      console.warn('[fetchDividends] Error:', err);
    }
  }, []);

  const fetchAccounts = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/accounts');
      if (!res.ok) {
        if (res.status === 401) { window.location.href = '/'; return; }
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
    const interval = setInterval(() => fetchAccounts(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchAccounts, fetchDividends]);

  const account = accounts[selectedIdx];

  // ── Loading / error states ──────────────────────────────────────────────────

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

  // ── Derived values ──────────────────────────────────────────────────────────

  const dayGL               = account.dayGainLoss;
  const unrealized          = account.unrealizedGainLoss ?? 0;
  const totalReturn         = unrealized + dividendsTotal;
  const availableForWithdrawal = account.availableForWithdrawal ?? 0;
  const dangerAlerts        = account.marginAlerts.filter((a) => a.level === 'danger');
  const warnAlerts          = account.marginAlerts.filter((a) => a.level === 'warn');

  return (
    <div className="min-h-screen bg-[#0f1117]">

      {/* ── Top header ────────────────────────────────────────────────────── */}
      <header className="border-b border-[#2d3248] bg-[#1a1d27] sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">

          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
              <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
            </div>
            <div className="leading-none">
              <div className="font-bold text-white text-sm tracking-tight">Triple C</div>
              <div className="text-[10px] text-[#4a5070] hidden sm:block">Triples · Cornerstone · Core/Income</div>
            </div>
          </div>

          {/* FIRE progress */}
          <FireProgress monthly={monthlyIncome} target={fireTarget} />

          {/* Right controls */}
          <div className="flex items-center gap-2 sm:gap-3">
            <ViewModeToggle mode={viewMode} onChange={switchView} />

            <AccountSwitcher
              accounts={accounts}
              selectedIndex={selectedIdx}
              onSelect={setSelectedIdx}
            />

            <SettingsPanel />
            <ThemeToggle />
            <PortfolioExport
              positions={account.positions}
              totalValue={account.totalValue}
              equity={account.equity}
              marginBalance={account.marginBalance}
              accountNumber={account.accountNumber}
              pillarSummary={account.pillarSummary}
              dividendsAnnual={dividendsTotal}
            />

            <button
              onClick={() => fetchAccounts(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors disabled:opacity-50"
              title={lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Refresh portfolio data'}
              aria-label="Refresh portfolio data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {lastUpdated && (
                <DataAge updated={lastUpdated} />
              )}
              {!lastUpdated && <span className="hidden sm:inline">Refresh</span>}
            </button>

            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                aria-label="Log out of Schwab"
                className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-red-400 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* ── Section nav (Dashboard view only) ─────────────────────────── */}
      {viewMode === 'dashboard' && <SectionNav />}

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">

        {/* ── Danger banner ───────────────────────────────────────────────── */}
        {dangerAlerts.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-red-300">
                {dangerAlerts.length} Rule Violation{dangerAlerts.length > 1 ? 's' : ''}
              </span>
            </div>
            {dangerAlerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-red-300 ml-6">
                <span>•</span>
                <span><strong>{a.rule}:</strong> {a.detail}</span>
              </div>
            ))}
          </div>
        )}

        {warnAlerts.length > 0 && dangerAlerts.length === 0 && viewMode === 'dashboard' && (
          <div className="bg-orange-500/10 border border-orange-500/25 rounded-xl px-4 py-3 flex items-center gap-2">
            {ALERT_ICON.warn}
            <span className="text-sm text-orange-300">
              {warnAlerts.length} warning{warnAlerts.length > 1 ? 's' : ''} — review Margin &amp; Risk below
            </span>
          </div>
        )}

        {/* ── Today view ─────────────────────────────────────────────────── */}
        {viewMode === 'today' && (
          <DailyFlow
            totalValue={account.totalValue}
            equity={account.equity}
            marginBalance={account.marginBalance}
            dayGainLoss={dayGL}
            unrealizedGainLoss={unrealized}
            availableForWithdrawal={availableForWithdrawal}
            positions={account.positions}
            pillarSummary={account.pillarSummary}
            marginAlerts={account.marginAlerts}
            dividendsTotal={dividendsTotal}
            monthlyIncome={monthlyIncome}
            fireTarget={fireTarget}
            strategyTargets={strategyTargets}
            pendingOrderCount={pendingOrders.size}
            onJumpTo={jumpToSection}
          />
        )}

        {/* ── Dashboard view (full detail) ───────────────────────────────── */}
        {viewMode === 'dashboard' && (
          <>

        {/* ── Portfolio overview ──────────────────────────────────────────── */}
        <div id="panel-overview" className="scroll-mt-20 space-y-4">
          {/* Metric cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="Portfolio Value" value={fmt$(account.totalValue)} />
            <MetricCard label="Equity"          value={fmt$(account.equity)} />
            <MetricCard
              label="Day P&amp;L"
              value={fmt$(dayGL)}
              colorClass={gainLossColor(dayGL)}
              trend={dayGL > 0 ? 'up' : dayGL < 0 ? 'down' : null}
            />
            <MetricCard
              label="Unrealized Return"
              value={fmt$(totalReturn)}
              colorClass={gainLossColor(totalReturn)}
              sub={`Includes $${dividendsTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} dividends`}
            />
            <MetricCard
              label="Available Cash"
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

          {/* Pillar allocation bar */}
          <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Pillar Allocation</h2>
              <span className="text-xs text-[#4a5070]">{account.positions.length} positions</span>
            </div>
            <PillarAllocationBar summaries={account.pillarSummary} targets={strategyTargets} />
          </div>
        </div>

        {/* ── Market Conditions & Recommendations ──────────────────────────── */}
        <CollapsiblePanel
          id="market"
          title="Market Conditions & AI Recommendations"
          icon={<TrendingUp className="w-4 h-4 text-cyan-400" />}
          accentClass="border-cyan-500/40"
          defaultOpen={true}
        >
          <div className="pt-4">
            <MarketConditionsDashboard
              currentTargets={strategyTargets}
              onTargetsChange={updateStrategyTargets}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Cornerstone ─────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="cornerstone"
          title="Cornerstone — CLM / CRF"
          icon={<PieChart className="w-4 h-4 text-amber-400" />}
          accentClass="border-amber-500/60"
          defaultOpen={true}
        >
          <div className="pt-4">
            <CornerStoneCard />
          </div>
        </CollapsiblePanel>

        {/* ── Margin & Risk ────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="margin"
          title="Margin & Risk Intelligence"
          icon={<Gauge className="w-4 h-4 text-orange-400" />}
          badge={
            dangerAlerts.length > 0 ? (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                {dangerAlerts.length} ALERT{dangerAlerts.length > 1 ? 'S' : ''}
              </span>
            ) : undefined
          }
          accentClass={dangerAlerts.length > 0 ? 'border-red-500/60' : 'border-orange-500/40'}
          defaultOpen={true}
        >
          <div className="pt-4">
            <MarginRiskPanel
              equity={account.equity}
              marginBalance={account.marginBalance}
              totalValue={account.totalValue}
              positions={account.positions}
              dividendsAnnual={dividendsTotal}
              marginRate={strategyTargets.marginRatePct / 100}
              familyCapPct={strategyTargets.familyCapPct}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Triples Tactical Engine ──────────────────────────────────────── */}
        <CollapsiblePanel
          id="triples"
          title="Triple ETF Tactical Engine"
          icon={<Zap className="w-4 h-4 text-violet-400" />}
          accentClass="border-violet-500/40"
          defaultOpen={true}
        >
          <div className="pt-4">
            <TriplesTacticalPanel
              positions={account.positions}
              totalValue={account.totalValue}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Options / Put Strategy ───────────────────────────────────────── */}
        <CollapsiblePanel
          id="options"
          title="Options & Put Strategy"
          icon={<Shield className="w-4 h-4 text-blue-400" />}
          accentClass="border-blue-500/40"
          defaultOpen={false}
        >
          <div className="pt-4">
            <OptionsStrategyPanel
              positions={account.positions}
              totalValue={account.totalValue}
            />
          </div>
        </CollapsiblePanel>

        {/* ── AI Analysis ─────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="ai"
          title="AI Portfolio Analysis"
          icon={<Brain className="w-4 h-4 text-cyan-400" />}
          accentClass="border-cyan-500/40"
          defaultOpen={false}
        >
          <div className="pt-4">
            <AIAnalysisPanel
              positions={account.positions}
              totalValue={account.totalValue}
              equity={account.equity}
              marginBalance={account.marginBalance}
              pillarSummary={account.pillarSummary}
              dividendsAnnual={dividendsTotal}
              accountHash={account.accountHash}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Income & Dividends ───────────────────────────────────────────── */}
        <CollapsiblePanel
          id="income"
          title="Income & Dividend Dashboard"
          icon={<DollarSign className="w-4 h-4 text-emerald-400" />}
          accentClass="border-emerald-500/40"
          defaultOpen={false}
        >
          <div className="pt-4">
            <DividendIncomePanel
              positions={account.positions}
              totalValue={account.totalValue}
              marginBalance={account.marginBalance}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Distribution Calendar ────────────────────────────────────────── */}
        <CollapsiblePanel
          id="calendar"
          title="Distribution Calendar"
          icon={<Calendar className="w-4 h-4 text-pink-400" />}
          accentClass="border-pink-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <DistributionCalendar
              positions={account.positions}
              totalValue={account.totalValue}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Rebalance Calculator ─────────────────────────────────────────── */}
        <CollapsiblePanel
          id="rebalance"
          title="Rebalance Calculator"
          icon={<Calculator className="w-4 h-4 text-yellow-400" />}
          accentClass="border-yellow-500/30"
          defaultOpen={false}
        >
          <div className="pt-4 space-y-4">
            <RebalanceCalculator
              positions={account.positions}
              totalValue={account.totalValue}
              equity={account.equity}
              marginBalance={account.marginBalance}
              pillarSummary={account.pillarSummary}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Simplified Trade Workflow ────────────────────────────────────── */}
        <SimplifiedTradeWorkflow
          pillars={account.pillarSummary}
          positions={account.positions}
          totalValue={account.totalValue}
          currentTargets={strategyTargets}
          marginData={{ equity: account.equity, marginBalance: account.marginBalance }}
        />

        {/* ── Open Put Tracker ─────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="puts"
          title="Open Put Tracker"
          icon={<History className="w-4 h-4 text-indigo-400" />}
          accentClass="border-indigo-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <OpenPutTracker positions={account.positions} />
          </div>
        </CollapsiblePanel>

        {/* ── Fund Family Monitor ──────────────────────────────────────────── */}
        <CollapsiblePanel
          id="families"
          title="Fund Family Concentration"
          icon={<List className="w-4 h-4 text-teal-400" />}
          accentClass="border-teal-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <FundFamilyMonitor
              positions={account.positions}
              totalValue={account.totalValue}
            />
          </div>
        </CollapsiblePanel>

        {/* ── "What If" Margin Simulator ───────────────────────────────────── */}
        <CollapsiblePanel
          id="simulator"
          title='"What If" Margin Simulator'
          icon={<Gauge className="w-4 h-4 text-rose-400" />}
          accentClass="border-rose-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <MarginSimulator
              positions={account.positions}
              totalValue={account.totalValue}
              equity={account.equity}
              marginBalance={account.marginBalance}
              pillarSummary={account.pillarSummary}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Trade History ────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="history"
          title="Trade History"
          icon={<History className="w-4 h-4 text-slate-400" />}
          accentClass="border-slate-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <TradeHistoryPanel />
          </div>
        </CollapsiblePanel>

        {/* ── Watchlist ─────────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="watchlist"
          title="Watchlist"
          icon={<Eye className="w-4 h-4 text-purple-400" />}
          accentClass="border-purple-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <WatchlistPanel />
          </div>
        </CollapsiblePanel>

        {/* ── Pending Orders ───────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="orders"
          title="Pending Orders"
          icon={<ClipboardList className="w-4 h-4 text-yellow-400" />}
          accentClass="border-yellow-500/30"
          defaultOpen={true}
        >
          <div className="pt-4">
            <PendingOrdersPanel accountHash={account.accountHash} />
          </div>
        </CollapsiblePanel>

        {/* ── Positions table ──────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="positions"
          title={`All Positions (${account.positions.length})`}
          icon={<BarChart2 className="w-4 h-4 text-[#7c82a0]" />}
          defaultOpen={true}
        >
          <div className="pt-4">
            <PositionsTable positions={account.positions} pendingOrders={pendingOrders} />
          </div>
        </CollapsiblePanel>

        {/* ── Strategy Guide ───────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="strategy"
          title="Triple C's Strategy Guide"
          icon={<BookOpen className="w-4 h-4 text-blue-400" />}
          accentClass="border-blue-500/30"
          defaultOpen={false}
        >
          <div className="pt-4">
            <StrategyGuide />
          </div>
        </CollapsiblePanel>

          </>
        )}

        {/* Footer spacer */}
        <div className="h-12" />
      </main>

      {/* ── Real-time alert monitor (renders nothing, fires toasts) ─────── */}
      <AlertMonitor
        marginPct={
          (account.equity + Math.abs(account.marginBalance)) > 0
            ? (Math.abs(account.marginBalance) / (account.equity + Math.abs(account.marginBalance))) * 100
            : 0
        }
        positions={account.positions.map((p) => ({
          symbol: p.instrument.symbol,
          portfolioPercent: p.portfolioPercent,
        }))}
        pendingOrderCount={pendingOrders.size}
        marginWarnPct={strategyTargets.marginWarnPct}
        marginLimitPct={strategyTargets.marginLimitPct}
      />
    </div>
  );
}
