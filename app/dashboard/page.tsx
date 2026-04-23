'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw, LogOut, AlertTriangle, CheckCircle, AlertCircle,
  TrendingUp, BarChart2, Shield, Zap, Brain, DollarSign,
  List, Calculator, PieChart, Gauge, ClipboardList, Eye, BookOpen, Target, Inbox,
} from 'lucide-react';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { PillarAllocationBar } from '@/components/PillarAllocationBar';
import { MarginRiskPanel } from '@/components/MarginRiskPanel';
import { TriplesTacticalPanel } from '@/components/TriplesTacticalPanel';
import { OptionsStrategyPanel } from '@/components/OptionsStrategyPanel';
import { IncomeHub } from '@/components/IncomeHub';
import { AIAnalysisPanel } from '@/components/AIAnalysisPanel';
import { TradeHub } from '@/components/TradeHub';
import { OpenPutTracker } from '@/components/OpenPutTracker';
import { PositionsTable } from '@/components/PositionsTable';
import { usePendingOrderSymbols } from '@/components/TradeHub';
import { CornerStoneCard } from '@/components/CornerStoneCard';
import { CollapsiblePanel } from '@/components/CollapsiblePanel';
import { SettingsPanel, useStrategyTargets } from '@/components/SettingsPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AutomationToggle } from '@/components/AutomationToggle';
import { PerformancePanel } from '@/components/PerformancePanel';
import { TradeInbox } from '@/components/TradeInbox';
import { PortfolioExport } from '@/components/PortfolioExport';
import { AlertMonitor } from '@/components/ToastProvider';
import { WatchlistPanel } from '@/components/WatchlistPanel';
import { StrategyGuide } from '@/components/StrategyGuide';
import { MarketConditionsDashboard } from '@/components/MarketConditionsDashboard';
import { RebalanceWorkflow } from '@/components/RebalanceWorkflow';
import { updateStrategyTargets } from '@/components/SettingsPanel';
import { PortfolioChart } from '@/components/PortfolioChart';
import { usePortfolioStream } from '@/lib/hooks/usePortfolioStream';
import type { RuleAlert, PillarSummary } from '@/lib/classify';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import type { StrategyTargets } from '@/lib/utils';
import { fmt$, gainLossColor } from '@/lib/utils';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { motion } from 'framer-motion';

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
  label, value, rawValue, colorClass = 'text-white', sub, trend, gradientClass, hoverShadow,
}: {
  label: string;
  value: string;
  rawValue?: number;
  colorClass?: string;
  sub?: string;
  trend?: 'up' | 'down' | null;
  /** Tailwind gradient classes for value text, e.g. "from-amber-400 to-orange-500". Overrides colorClass. */
  gradientClass?: string;
  /** Optional colored hover shadow override */
  hoverShadow?: string;
}) {
  const valueClass = gradientClass
    ? `bg-gradient-to-r ${gradientClass} bg-clip-text text-transparent`
    : colorClass;
  return (
    <motion.div
      className="card-glass border border-[#252840] rounded-xl p-4 flex flex-col gap-1.5 shadow-card cursor-default"
      whileHover={{ y: -2, boxShadow: hoverShadow ?? '0 8px 28px rgba(0,0,0,0.5)', borderColor: 'rgba(53,56,96,1)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
    >
      <div className="text-[11px] text-[#7c82a0] font-semibold tracking-widest uppercase">{label}</div>
      <div className="text-2xl font-extrabold tabular-nums tracking-tight flex items-center gap-1.5 leading-none">
        {rawValue !== undefined
          ? <AnimatedNumber value={rawValue} format={fmt$} className={valueClass} />
          : <span className={valueClass}>{value}</span>}
        {trend === 'up'   && <TrendingUp className="w-3.5 h-3.5 text-emerald-400 opacity-80" />}
        {trend === 'down' && <TrendingUp className="w-3.5 h-3.5 text-red-400 opacity-80 rotate-180" />}
      </div>
      {sub && <div className="text-[11px] text-[#4a5070] leading-snug">{sub}</div>}
    </motion.div>
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
      <span className={`w-2 h-2 rounded-full ${dotColor} dot-live shadow-[0_0_6px_currentColor]`} />
      <span className="tabular-nums text-[#7c82a0]">{label}</span>
    </span>
  );
}

// ─── Section jump nav ─────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: 'overview',     label: 'Overview',      icon: BarChart2   },
  { id: 'market',       label: 'Market',        icon: TrendingUp  },
  { id: 'cornerstone',  label: 'Cornerstone',   icon: PieChart    },
  { id: 'margin',       label: 'Margin',        icon: Gauge       },
  { id: 'triples',      label: 'Triples',       icon: Zap         },
  { id: 'options',      label: 'Options & Puts', icon: Shield      },
  { id: 'ai',           label: 'AI Analysis',   icon: Brain       },
  { id: 'income',       label: 'Income',        icon: DollarSign  },
  { id: 'rebalance',    label: 'Rebalance',     icon: Calculator  },
  { id: 'orders',       label: 'Orders',        icon: ClipboardList },
  { id: 'watchlist',    label: 'Watchlist',     icon: Eye         },
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
    <nav className="w-full overflow-x-auto border-b border-[#252840] card-glass sticky top-[57px] z-30">
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

// ─── Options + Open Puts tabbed panel ────────────────────────────────────────

function OptionsPutsPanel({
  positions,
  totalValue,
  accountHash,
}: {
  positions: EnrichedPosition[];
  totalValue: number;
  accountHash: string;
}) {
  const [tab, setTab] = useState<'strategy' | 'puts'>('strategy');

  return (
    <CollapsiblePanel
      id="options"
      title="Options & Puts"
      icon={<Shield className="w-4 h-4 text-blue-400" />}
      accentClass="border-blue-500/40"
      tintClass="from-blue-500/[0.04]"
      iconContainerClass="bg-blue-500/10 border border-blue-500/20"
      glowColor="cornerstone"
      defaultOpen={true}
    >
      <div className="pt-4 space-y-4">
        {/* Tab bar */}
        <div className="flex gap-1 border-b border-[#2d3248] pb-0">
          <button
            onClick={() => setTab('strategy')}
            className={`px-4 py-2 text-xs font-medium rounded-t-lg transition-colors -mb-px border-b-2 ${
              tab === 'strategy'
                ? 'text-blue-400 border-blue-500 bg-blue-500/5'
                : 'text-[#7c82a0] border-transparent hover:text-white'
            }`}
          >
            Strategy &amp; Candidates
          </button>
          <button
            onClick={() => setTab('puts')}
            className={`px-4 py-2 text-xs font-medium rounded-t-lg transition-colors -mb-px border-b-2 ${
              tab === 'puts'
                ? 'text-indigo-400 border-indigo-500 bg-indigo-500/5'
                : 'text-[#7c82a0] border-transparent hover:text-white'
            }`}
          >
            Open Puts
          </button>
        </div>

        {tab === 'strategy' && (
          <OptionsStrategyPanel
            positions={positions}
            totalValue={totalValue}
            accountHash={accountHash}
          />
        )}
        {tab === 'puts' && (
          <OpenPutTracker positions={positions} />
        )}
      </div>
    </CollapsiblePanel>
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
  const [aiPulseTrigger, setAiPulseTrigger] = useState(0);
  const pendingOrders = usePendingOrderSymbols(accounts[selectedIdx]?.accountHash ?? '');
  const strategyTargets = useStrategyTargets();
  const fireTarget = strategyTargets.fireNumber;

  // Live streaming — only activate when we have account data
  const streamSymbols = (accounts[selectedIdx]?.positions ?? [])
    .map((p) => p.instrument.symbol)
    .filter((s) => !s.includes(' ')); // skip options
  const { liveQuotes, status: streamStatus } = usePortfolioStream(streamSymbols, streamSymbols.length > 0);

  // Merge live prices into positions so AI gets current market values
  const livePositions = useMemo(() => {
    const positions = accounts[selectedIdx]?.positions ?? [];
    if (!liveQuotes.size) return positions;
    const updated = positions.map((p) => {
      const livePrice = liveQuotes.get(p.instrument.symbol);
      if (!livePrice) return p;
      const qty = p.longQuantity || p.shortQuantity || 0;
      const newMarketValue = livePrice * qty;
      return { ...p, marketValue: newMarketValue };
    });
    // Recompute total and portfolioPercent with live values
    const liveTotalValue = updated.reduce((sum, p) => sum + Math.abs(p.marketValue), 0) || (accounts[selectedIdx]?.totalValue ?? 0);
    return updated.map((p) => ({
      ...p,
      portfolioPercent: liveTotalValue > 0 ? (Math.abs(p.marketValue) / liveTotalValue) * 100 : p.portfolioPercent,
    }));
  }, [accounts, selectedIdx, liveQuotes]);

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
    <div className="min-h-screen bg-[#0a0c14]">

      {/* ── Top header ────────────────────────────────────────────────────── */}
      <header className="border-b border-[#252840] card-glass sticky top-0 z-40">
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
            <AccountSwitcher
              accounts={accounts}
              selectedIndex={selectedIdx}
              onSelect={setSelectedIdx}
            />

            <button
              onClick={() => {
                setAiPulseTrigger((n) => n + 1);
                document.getElementById('panel-ai')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="flex items-center gap-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300 bg-cyan-600/10 hover:bg-cyan-600/20 border border-cyan-500/30 px-3 py-1.5 rounded-lg transition-colors"
              title="Run AI daily pulse analysis"
            >
              <Zap className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Daily Pulse</span>
            </button>

            <SettingsPanel />
            <AutomationToggle />
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

      {/* ── Section nav ───────────────────────────────────────────────────── */}
      <SectionNav />

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">

        {/* ── Danger banner ───────────────────────────────────────────────── */}
        {dangerAlerts.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 space-y-2 shadow-[0_0_24px_rgba(239,68,68,0.12)]">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-red-400 dot-live shadow-[0_0_8px_#ef4444]" />
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-red-300">
                {dangerAlerts.length} Rule Violation{dangerAlerts.length > 1 ? 's' : ''}
              </span>
            </div>
            {dangerAlerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-red-300 ml-8">
                <span>•</span>
                <span><strong>{a.rule}:</strong> {a.detail}</span>
              </div>
            ))}
          </div>
        )}

        {warnAlerts.length > 0 && dangerAlerts.length === 0 && (
          <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-3 flex items-center gap-2.5 shadow-[0_0_20px_rgba(249,115,22,0.10)]">
            <span className="w-2 h-2 rounded-full bg-orange-400 dot-live shadow-[0_0_6px_#f97316]" />
            {ALERT_ICON.warn}
            <span className="text-sm text-orange-300">
              {warnAlerts.length} warning{warnAlerts.length > 1 ? 's' : ''} — review Margin &amp; Risk below
            </span>
          </div>
        )}

        {/* ── Portfolio overview ──────────────────────────────────────────── */}
        <div id="panel-overview" className="scroll-mt-20 space-y-4">
          {/* Metric cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard
              label="Portfolio Value"
              value={fmt$(account.totalValue)}
              rawValue={account.totalValue}
              gradientClass="from-amber-300 via-amber-400 to-orange-500"
              hoverShadow="0 0 28px rgba(245,158,11,0.20), 0 10px 32px rgba(0,0,0,0.5)"
            />
            <MetricCard
              label="Equity"
              value={fmt$(account.equity)}
              rawValue={account.equity}
              gradientClass="from-blue-400 via-sky-400 to-cyan-400"
              hoverShadow="0 0 28px rgba(59,130,246,0.20), 0 10px 32px rgba(0,0,0,0.5)"
            />
            <MetricCard
              label="Day P&L"
              value={fmt$(dayGL)}
              rawValue={dayGL}
              colorClass={gainLossColor(dayGL)}
              trend={dayGL > 0 ? 'up' : dayGL < 0 ? 'down' : null}
            />
            <MetricCard
              label="Unrealized Return"
              value={fmt$(totalReturn)}
              rawValue={totalReturn}
              colorClass={gainLossColor(totalReturn)}
              sub={`Includes $${dividendsTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} dividends`}
            />
            <MetricCard
              label="Available Cash"
              value={fmt$(availableForWithdrawal)}
              rawValue={availableForWithdrawal}
              colorClass="text-blue-400"
              sub="Cash + money market"
            />
            <MetricCard
              label="Buying Power"
              value={fmt$(account.buyingPower)}
              rawValue={account.buyingPower}
              colorClass="text-purple-400"
            />
          </div>

          {/* Pillar allocation bar */}
          <motion.div
            className="card-glass border border-[#252840] rounded-xl p-5 space-y-4 shadow-card bg-gradient-to-br from-blue-500/[0.04] to-transparent"
            whileHover={{ y: -2, boxShadow: '0 0 32px rgba(59,130,246,0.22), 0 12px 36px rgba(0,0,0,0.5)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white tracking-tight">Pillar Allocation</h2>
              <div className="flex items-center gap-2">
                {streamStatus === 'connected' && (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-1.5 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 dot-live shadow-[0_0_6px_#10b981]" />
                    live
                  </span>
                )}
                <span className="text-xs text-[#4a5070]">{account.positions.length} positions</span>
              </div>
            </div>
            <PillarAllocationBar summaries={account.pillarSummary} targets={strategyTargets} />
          </motion.div>

          {/* Portfolio performance chart */}
          <motion.div
            className="card-glass border border-[#252840] rounded-xl p-5 shadow-card"
            whileHover={{ y: -2, boxShadow: '0 0 32px rgba(6,182,212,0.20), 0 12px 36px rgba(0,0,0,0.5)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          >
            <div className="flex items-center gap-2.5 mb-3">
              <span className="p-1.5 rounded-md bg-blue-500/10 border border-blue-500/20">
                <BarChart2 className="w-4 h-4 text-blue-400" />
              </span>
              <h2 className="text-sm font-semibold text-white tracking-tight">Portfolio History</h2>
            </div>
            <PortfolioChart />
          </motion.div>
        </div>

        {/* ── Performance vs 40% target ────────────────────────────────────── */}
        <CollapsiblePanel
          id="performance"
          title="Performance — vs 40% Target"
          icon={<Target className="w-4 h-4 text-emerald-400" />}
          accentClass="border-emerald-500/40"
          tintClass="from-emerald-500/[0.04]"
          iconContainerClass="bg-emerald-500/10 border border-emerald-500/20"
          glowColor="income"
          defaultOpen={true}
        >
          <div className="pt-4">
            <PerformancePanel />
          </div>
        </CollapsiblePanel>

        {/* ── Trade Inbox — unified one-click approval queue ────────────────── */}
        <CollapsiblePanel
          id="inbox"
          title="Trade Inbox"
          icon={<Inbox className="w-4 h-4 text-cyan-400" />}
          accentClass="border-cyan-500/40"
          tintClass="from-cyan-500/[0.04]"
          iconContainerClass="bg-cyan-500/10 border border-cyan-500/20"
          glowColor="cyan"
          defaultOpen={true}
        >
          <div className="pt-4">
            <TradeInbox
              accountHash={account.accountHash}
              onChanged={() => fetchAccounts(true)}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Market Conditions & Recommendations ──────────────────────────── */}
        <CollapsiblePanel
          id="market"
          title="Market Conditions & AI Recommendations"
          icon={<TrendingUp className="w-4 h-4 text-cyan-400" />}
          accentClass="border-cyan-500/40"
          tintClass="from-cyan-500/[0.04]"
          iconContainerClass="bg-cyan-500/10 border border-cyan-500/20"
          glowColor="cyan"
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
          tintClass="from-amber-500/[0.05]"
          iconContainerClass="bg-amber-500/10 border border-amber-500/25"
          glowColor="triples"
          defaultOpen={true}
        >
          <div className="pt-4">
            <CornerStoneCard
              positions={account.positions}
              accountHash={account.accountHash}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Margin & Risk ────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="margin"
          title="Margin & Risk Intelligence"
          icon={<Gauge className="w-4 h-4 text-orange-400" />}
          badge={
            dangerAlerts.length > 0 ? (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 shadow-[0_0_10px_rgba(239,68,68,0.25)]">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 dot-live" />
                {dangerAlerts.length} ALERT{dangerAlerts.length > 1 ? 'S' : ''}
              </span>
            ) : undefined
          }
          accentClass={dangerAlerts.length > 0 ? 'border-red-500/60' : 'border-orange-500/40'}
          tintClass={dangerAlerts.length > 0 ? 'from-red-500/[0.05]' : 'from-orange-500/[0.04]'}
          iconContainerClass={dangerAlerts.length > 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-orange-500/10 border border-orange-500/20'}
          glowColor={dangerAlerts.length > 0 ? 'red' : 'orange'}
          defaultOpen={true}
        >
          <div className="pt-4">
            <MarginRiskPanel
              equity={account.equity}
              marginBalance={account.marginBalance}
              totalValue={account.totalValue}
              positions={account.positions}
              dividendsAnnual={monthlyIncome * 12}
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
          tintClass="from-violet-500/[0.04]"
          iconContainerClass="bg-violet-500/10 border border-violet-500/20"
          glowColor="hedge"
          defaultOpen={true}
        >
          <div className="pt-4">
            <TriplesTacticalPanel
              positions={account.positions}
              totalValue={account.totalValue}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Options & Open Puts (tabbed) ─────────────────────────────────── */}
        <OptionsPutsPanel
          positions={account.positions}
          totalValue={account.totalValue}
          accountHash={account.accountHash}
        />

        {/* ── AI Analysis ─────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="ai"
          title="AI Portfolio Analysis"
          icon={<Brain className="w-4 h-4 text-cyan-400" />}
          accentClass="border-cyan-500/40"
          tintClass="from-cyan-500/[0.04]"
          iconContainerClass="bg-cyan-500/10 border border-cyan-500/20"
          glowColor="cyan"
          defaultOpen={true}
        >
          <div className="pt-4">
            <AIAnalysisPanel
              positions={livePositions}
              totalValue={account.totalValue}
              equity={account.equity}
              marginBalance={account.marginBalance}
              pillarSummary={account.pillarSummary}
              dividendsAnnual={dividendsTotal}
              accountHash={account.accountHash}
              triggerPulse={aiPulseTrigger}
              onIncomeSnapshot={setMonthlyIncome}
            />
          </div>
        </CollapsiblePanel>

        {/* ── Income Hub (Historical + Projected + FIRE + Margin + Simulator) ── */}
        <div id="panel-income" className="scroll-mt-20 space-y-4">
          <div id="panel-calendar" />
          <div id="panel-simulator" />
          <IncomeHub
            positions={account.positions}
            totalValue={account.totalValue}
            equity={account.equity}
            marginBalance={account.marginBalance}
            pillarSummary={account.pillarSummary}
            onProjectedMonthly={setMonthlyIncome}
          />
        </div>

        {/* ── Rebalance Workflow ───────────────────────────────────────────── */}
        <div id="panel-rebalance" className="scroll-mt-20">
          <RebalanceWorkflow
            positions={account.positions}
            pillarSummary={account.pillarSummary}
            totalValue={account.totalValue}
            equity={account.equity}
            marginBalance={account.marginBalance}
            accountHash={account.accountHash}
            strategyTargets={strategyTargets}
          />
        </div>

        {/* ── Watchlist ─────────────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="watchlist"
          title="Watchlist"
          icon={<Eye className="w-4 h-4 text-purple-400" />}
          accentClass="border-purple-500/30"
          tintClass="from-purple-500/[0.03]"
          iconContainerClass="bg-purple-500/10 border border-purple-500/20"
          glowColor="purple"
          defaultOpen={true}
        >
          <div className="pt-4">
            <WatchlistPanel />
          </div>
        </CollapsiblePanel>

        {/* ── Orders & Trade History ───────────────────────────────────────── */}
        <div id="panel-orders" className="scroll-mt-20">
          <div id="panel-history" />
          <TradeHub accountHash={account.accountHash} />
        </div>

        {/* ── Positions table ──────────────────────────────────────────────── */}
        <CollapsiblePanel
          id="positions"
          title={`All Positions (${account.positions.length})`}
          icon={<BarChart2 className="w-4 h-4 text-[#7c82a0]" />}
          iconContainerClass="bg-white/[0.06] border border-white/10"
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
          tintClass="from-blue-500/[0.03]"
          iconContainerClass="bg-blue-500/10 border border-blue-500/20"
          glowColor="cornerstone"
          defaultOpen={false}
        >
          <div className="pt-4">
            <StrategyGuide />
          </div>
        </CollapsiblePanel>

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
