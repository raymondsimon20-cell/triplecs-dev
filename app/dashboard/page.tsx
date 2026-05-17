'use client';

/**
 * Dashboard — 2026-05 redesign.
 *
 * The old single-scroll page with 16 panels and a 14-item section nav has been
 * replaced with three top-level tabs:
 *
 *   • Today      — TodayPanel (unified action queue) + 4-metric hero + pillar
 *                  bar + Market Read + Top Positions. Morning check-in fits
 *                  above the fold.
 *   • Portfolio  — sub-tabs (Positions, Income, Trades, Market, Strategy).
 *                  Weekly rebalance + deep dives.
 *   • History    — forensics (AI Analysis, Performance, Plan Archive, Replay,
 *                  Rollback, Strategy Guide).
 *
 * All existing data plumbing (Schwab fetch, live stream, drift auto-rebalance,
 * alerts) is preserved. The change is purely IA + visual.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw, LogOut, AlertTriangle, AlertCircle, CheckCircle,
  TrendingUp, BarChart2, Shield, Zap, Brain, DollarSign,
  List, PieChart, Gauge, ClipboardList, Eye, BookOpen, Target,
  Inbox, X, Wallet, History, Calculator, Activity,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { PillarAllocationBar } from '@/components/PillarAllocationBar';
import { MarginRiskPanel } from '@/components/MarginRiskPanel';
import { TriplesTacticalPanel } from '@/components/TriplesTacticalPanel';
import { OptionsStrategyPanel } from '@/components/OptionsStrategyPanel';
import { IncomeHub } from '@/components/IncomeHub';
import { AIAnalysisPanel } from '@/components/AIAnalysisPanel';
import { TradeHub, usePendingOrderSymbols } from '@/components/TradeHub';
import { OpenPutTracker } from '@/components/OpenPutTracker';
import { PositionsTable } from '@/components/PositionsTable';
import { CornerStoneCard } from '@/components/CornerStoneCard';
import { CollapsiblePanel } from '@/components/CollapsiblePanel';
import { SettingsPanel, useStrategyTargets, updateStrategyTargets } from '@/components/SettingsPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AutomationToggle } from '@/components/AutomationToggle';
import { PerformancePanel } from '@/components/PerformancePanel';
import { TodayPanel } from '@/components/TodayPanel';
import { DailyPlanPanel } from '@/components/DailyPlanPanel';
import { ReplayPanel } from '@/components/ReplayPanel';
import { PlanArchivePanel } from '@/components/PlanArchivePanel';
import { RollbackPanel } from '@/components/RollbackPanel';
import { PerformanceReviewPanel } from '@/components/PerformanceReviewPanel';
import { PortfolioExport } from '@/components/PortfolioExport';
import { AlertMonitor } from '@/components/ToastProvider';
import { WatchlistPanel } from '@/components/WatchlistPanel';
import { StrategyGuide } from '@/components/StrategyGuide';
import { MarketConditionsDashboard } from '@/components/MarketConditionsDashboard';
import { RebalanceWorkflow } from '@/components/RebalanceWorkflow';
import { PortfolioChart } from '@/components/PortfolioChart';
import { usePortfolioStream } from '@/lib/hooks/usePortfolioStream';
import type { RuleAlert } from '@/lib/classify';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import { fmt$, gainLossColor } from '@/lib/utils';
import { AnimatedNumber } from '@/components/AnimatedNumber';

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

type View = 'today' | 'portfolio' | 'history';
type PortfolioSub = 'positions' | 'income' | 'trades' | 'market' | 'strategy';

// ─── Slim metric card ─────────────────────────────────────────────────────────
// Pre-redesign every card had a gradient text fill + colored hover glow. Now
// one neutral surface, optional colorClass for the value only (used for P&L).
function MetricCard({
  label, value, rawValue, colorClass = 'text-white', sub, trend,
}: {
  label: string;
  value: string;
  rawValue?: number;
  colorClass?: string;
  sub?: string;
  trend?: 'up' | 'down' | null;
}) {
  return (
    <motion.div
      className="bg-[#12151f] border border-[#1f2334] rounded-lg p-3 flex flex-col gap-1 cursor-default"
      whileHover={{ y: -1, boxShadow: '0 6px 22px rgba(0,0,0,0.4)', borderColor: 'rgba(45,50,72,1)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
    >
      <div className="text-[10px] text-[#7c82a0] font-semibold tracking-widest uppercase">{label}</div>
      <div className={`text-xl font-bold tabular-nums tracking-tight flex items-center gap-1.5 leading-none ${colorClass}`}>
        {rawValue !== undefined
          ? <AnimatedNumber value={rawValue} format={(v) => value.includes('%') ? `${v.toFixed(1)}%` : fmt$(v)} className={colorClass} />
          : <span>{value}</span>}
        {trend === 'up'   && <TrendingUp className="w-3 h-3 text-emerald-400 opacity-80" />}
        {trend === 'down' && <TrendingUp className="w-3 h-3 text-red-400 opacity-80 rotate-180" />}
      </div>
      {sub && <div className="text-[10px] text-[#4a5070] leading-snug">{sub}</div>}
    </motion.div>
  );
}

// ─── FIRE progress pill ───────────────────────────────────────────────────────
function FireProgress({ monthly, target }: { monthly: number; target: number }) {
  const pct = target > 0 ? Math.min((monthly / target) * 100, 100) : 0;
  const reached = pct >= 100;
  return (
    <div className="hidden md:flex items-center gap-2 min-w-[140px]" title={`FIRE target: $${target.toLocaleString()}/mo`}>
      <span className="text-[10px] text-[#7c82a0] uppercase tracking-wider">FIRE</span>
      <div className="flex-1 h-1.5 bg-[#1f2334] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${reached ? 'bg-emerald-400' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] font-semibold tabular-nums ${reached ? 'text-emerald-400' : 'text-[#9aa2c0]'}`}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

// ─── Data age indicator ───────────────────────────────────────────────────────
function DataAge({ updated }: { updated: Date }) {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceRender((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  const ageSec = Math.floor((Date.now() - updated.getTime()) / 1000);
  const ageMin = Math.floor(ageSec / 60);
  let dotColor = 'bg-emerald-400';
  let label = `${ageSec}s ago`;
  if (ageMin >= 5)       { dotColor = 'bg-orange-400';  label = `${ageMin}m ago`; }
  else if (ageMin >= 2)  { dotColor = 'bg-yellow-400';  label = `${ageMin}m ago`; }
  else if (ageSec >= 60) {                              label = `1m ago`;          }
  return (
    <span className="hidden sm:flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} dot-live shadow-[0_0_6px_currentColor]`} />
      <span className="tabular-nums text-[#7c82a0]">{label}</span>
    </span>
  );
}

// ─── Top tabs ─────────────────────────────────────────────────────────────────
function TopTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const items: { id: View; label: string; icon: typeof BarChart2 }[] = [
    { id: 'today',     label: 'Today',     icon: Zap     },
    { id: 'portfolio', label: 'Portfolio', icon: Wallet  },
    { id: 'history',   label: 'History',   icon: History },
  ];
  return (
    <nav className="w-full border-b border-[#1a1e2e] bg-[rgba(18,21,31,0.6)] backdrop-blur sticky top-[57px] z-30">
      <div className="max-w-7xl mx-auto px-4 flex gap-1">
        {items.map(({ id, label, icon: Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                active
                  ? 'text-white border-blue-500'
                  : 'text-[#7c82a0] border-transparent hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ─── Portfolio sub-tabs ───────────────────────────────────────────────────────
function PortfolioSubTabs({
  active, onChange, counts,
}: {
  active: PortfolioSub;
  onChange: (s: PortfolioSub) => void;
  counts: { positions: number; orders: number };
}) {
  const items: { id: PortfolioSub; label: string; count?: number }[] = [
    { id: 'positions', label: 'Positions', count: counts.positions },
    { id: 'income',    label: 'Income' },
    { id: 'trades',    label: 'Trades',    count: counts.orders },
    { id: 'market',    label: 'Market' },
    { id: 'strategy',  label: 'Strategy tools' },
  ];
  return (
    <div className="flex items-center gap-1 flex-wrap mb-4">
      {items.map(({ id, label, count }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 ${
              isActive
                ? 'bg-[#1a1e2e] text-white'
                : 'text-[#7c82a0] hover:text-white hover:bg-white/[0.03]'
            }`}
          >
            {label}
            {count !== undefined && (
              <span className={`text-[10px] ${isActive ? 'text-[#9aa2c0]' : 'text-[#4a5070]'}`}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Market Read mini card (lightweight inline; pulls /api/market-conditions) ─
function MarketReadCard() {
  const [data, setData] = useState<{
    vix: number; vixChange: number; sp500Change: number; nasdaq100Change: number;
    marketTrend: 'bullish' | 'neutral' | 'bearish';
    volatilityLevel: 'low' | 'normal' | 'high' | 'extreme';
    recommendation?: string;
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const r = await fetch('/api/market-conditions');
        if (!r.ok) return;
        const j = await r.json();
        if (mounted) {
          setData({
            vix: j.marketData?.vix ?? 0,
            vixChange: j.marketData?.vixChange ?? 0,
            sp500Change: j.marketData?.sp500Change ?? 0,
            nasdaq100Change: j.marketData?.nasdaq100Change ?? 0,
            marketTrend: j.marketData?.marketTrend ?? 'neutral',
            volatilityLevel: j.marketData?.volatilityLevel ?? 'normal',
            recommendation: j.recommendation?.recommendation,
          });
        }
      } catch { /* swallow — card simply won't render until data arrives */ }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  const vixTone =
    !data ? 'text-[#7c82a0]' :
    data.volatilityLevel === 'extreme' ? 'text-red-400' :
    data.volatilityLevel === 'high'    ? 'text-orange-400' :
    data.volatilityLevel === 'low'     ? 'text-emerald-400' :
                                          'text-[#9aa2c0]';

  const vixLabel =
    !data ? '' :
    data.volatilityLevel === 'extreme' ? 'Extreme stress' :
    data.volatilityLevel === 'high'    ? 'High caution' :
    data.volatilityLevel === 'low'     ? 'Bull territory' :
                                          'Normal';

  return (
    <div className="bg-[#12151f] border border-[#1f2334] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-semibold text-white">Market read</span>
        </div>
        <span className="text-[10px] text-[#4a5070]">refreshed 60s</span>
      </div>
      {data ? (
        <>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <div className="text-[9px] text-[#7c82a0] uppercase tracking-wider">VIX</div>
              <div className="text-base font-bold tabular-nums">{data.vix.toFixed(1)}</div>
              <div className={`text-[10px] ${vixTone}`}>{vixLabel}</div>
            </div>
            <div>
              <div className="text-[9px] text-[#7c82a0] uppercase tracking-wider">SPX</div>
              <div className={`text-base font-bold tabular-nums ${gainLossColor(data.sp500Change)}`}>
                {data.sp500Change >= 0 ? '+' : ''}{data.sp500Change.toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[#7c82a0] uppercase tracking-wider">NDX</div>
              <div className={`text-base font-bold tabular-nums ${gainLossColor(data.nasdaq100Change)}`}>
                {data.nasdaq100Change >= 0 ? '+' : ''}{data.nasdaq100Change.toFixed(2)}%
              </div>
            </div>
          </div>
          {data.recommendation && (
            <div className="text-[11px] text-[#9aa2c0] leading-relaxed pt-3 border-t border-[#1a1e2e]">
              {data.recommendation}
            </div>
          )}
        </>
      ) : (
        <div className="h-16 flex items-center justify-center text-[11px] text-[#4a5070]">Loading market…</div>
      )}
    </div>
  );
}

// ─── Top positions mini card ──────────────────────────────────────────────────
function TopPositionsCard({
  positions, onSeeAll,
}: {
  positions: EnrichedPosition[];
  onSeeAll: () => void;
}) {
  const top = useMemo(() => {
    return [...positions]
      .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue))
      .slice(0, 5);
  }, [positions]);

  return (
    <div className="bg-[#12151f] border border-[#1f2334] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <List className="w-4 h-4 text-[#9aa2c0]" />
          <span className="text-sm font-semibold text-white">Top positions</span>
        </div>
        <button
          onClick={onSeeAll}
          className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
        >
          View all →
        </button>
      </div>
      <div className="space-y-0">
        {top.map((p, i) => {
          const dayGL = p.todayGainLoss ?? 0;
          const dayPct = p.marketValue > 0 ? (dayGL / p.marketValue) * 100 : 0;
          return (
            <div
              key={p.instrument.symbol}
              className={`flex items-center justify-between py-2 text-xs ${
                i < top.length - 1 ? 'border-b border-[#1a1e2e]' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold tabular-nums truncate">{p.instrument.symbol}</span>
                <span className="text-[10px] text-[#4a5070] tabular-nums">{p.portfolioPercent.toFixed(1)}%</span>
              </div>
              <span className={`font-medium tabular-nums ${gainLossColor(dayGL)}`}>
                {dayGL >= 0 ? '+' : ''}{dayPct.toFixed(2)}%
              </span>
            </div>
          );
        })}
        {top.length === 0 && (
          <div className="text-[11px] text-[#4a5070] py-3 text-center">No positions yet</div>
        )}
      </div>
    </div>
  );
}

// ─── Options + Open Puts (kept tabbed, just used inside Portfolio → Strategy) ─
function OptionsPutsPanel({
  positions, totalValue, accountHash,
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
      iconContainerClass="bg-blue-500/10 border border-blue-500/20"
      defaultOpen={true}
    >
      <div className="pt-4 space-y-4">
        <div className="flex gap-1 border-b border-[#1f2334] pb-0">
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
          <OptionsStrategyPanel positions={positions} totalValue={totalValue} accountHash={accountHash} />
        )}
        {tab === 'puts' && <OpenPutTracker positions={positions} />}
      </div>
    </CollapsiblePanel>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PAGE
// ═════════════════════════════════════════════════════════════════════════════

export default function DashboardPage() {
  const [accounts, setAccounts]         = useState<AccountData[]>([]);
  const [selectedIdx, setSelectedIdx]   = useState(0);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);
  const [dividendsTotal, setDividendsTotal] = useState<number>(0);
  const [monthlyIncome, setMonthlyIncome]   = useState<number>(0);
  const [aiPulseTrigger, setAiPulseTrigger] = useState(0);
  const [view, setView]                 = useState<View>('today');
  const [portfolioSub, setPortfolioSub] = useState<PortfolioSub>('positions');

  const pendingOrders = usePendingOrderSymbols(accounts[selectedIdx]?.accountHash ?? '');
  const strategyTargets = useStrategyTargets();
  const fireTarget = strategyTargets.fireNumber;

  // Live streaming
  const streamSymbols = (accounts[selectedIdx]?.positions ?? [])
    .map((p) => p.instrument.symbol)
    .filter((s) => !s.includes(' '));
  const { liveQuotes, status: streamStatus } = usePortfolioStream(streamSymbols, streamSymbols.length > 0);

  // Merge live prices into positions
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
    const liveTotalValue = updated.reduce((sum, p) => sum + Math.abs(p.marketValue), 0) || (accounts[selectedIdx]?.totalValue ?? 0);
    return updated.map((p) => ({
      ...p,
      portfolioPercent: liveTotalValue > 0 ? (Math.abs(p.marketValue) / liveTotalValue) * 100 : p.portfolioPercent,
    }));
  }, [accounts, selectedIdx, liveQuotes]);

  const fetchDividends = useCallback(async () => {
    try {
      const res = await fetch('/api/dividends');
      if (!res.ok) return;
      const data = await res.json() as {
        dividends?: { amount: number; date: string; symbol: string }[];
        total?: number;
      };
      const total = data.total ?? 0;
      setDividendsTotal(total);
      if (Array.isArray(data.dividends) && data.dividends.length > 0) {
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const recentSum = data.dividends
          .filter((d) => new Date(d.date).getTime() >= thirtyDaysAgo)
          .reduce((s, d) => s + d.amount, 0);
        setMonthlyIncome(recentSum > 0 ? recentSum : total / 12);
      } else {
        setMonthlyIncome(total / 12);
      }
    } catch { /* swallow */ }
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

  // ── Drift>2% auto-rebalance (unchanged behaviour, slimmer banner UI) ──────
  const driftRebalanceFiredRef = useRef(false);
  const [driftRebalanceBanner, setDriftRebalanceBanner] = useState<
    | { kind: 'staging'; maxDriftPct: number }
    | { kind: 'staged';  count: number; summary: string }
    | { kind: 'skipped_existing' }
    | { kind: 'paused' }
    | { kind: 'error'; message: string }
    | null
  >(null);

  useEffect(() => {
    if (driftRebalanceFiredRef.current) return;
    if (!account || !account.pillarSummary?.length || !account.totalValue) return;
    if (!strategyTargets) return;

    const targetMap: Record<string, number> = {
      triples:     strategyTargets.triplesPct,
      cornerstone: strategyTargets.cornerstonePct,
      income:      strategyTargets.incomePct,
      hedge:       strategyTargets.hedgePct,
    };
    const drifts = account.pillarSummary
      .filter((p) => p.pillar !== 'other')
      .map((p) => Math.abs(p.portfolioPercent - (targetMap[p.pillar] ?? 0)));
    const maxDrift = drifts.length ? Math.max(...drifts) : 0;
    if (maxDrift <= 2) return;

    driftRebalanceFiredRef.current = true;

    (async () => {
      try {
        const inboxRes = await fetch('/api/inbox?status=pending&source=rebalance');
        if (inboxRes.ok) {
          const data = await inboxRes.json() as { items?: unknown[] };
          if (Array.isArray(data.items) && data.items.length > 0) {
            setDriftRebalanceBanner({ kind: 'skipped_existing' });
            return;
          }
        }
        setDriftRebalanceBanner({ kind: 'staging', maxDriftPct: maxDrift });
        const res = await fetch('/api/rebalance-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            totalValue:    account.totalValue,
            equity:        account.equity,
            positions:     account.positions,
            pillarSummary: account.pillarSummary,
            targets:       strategyTargets,
          }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (accumulated.includes('__DONE__')) break;
        }
        const match = accumulated.match(/__RESULT__([\s\S]*?)\n__DONE__/);
        if (!match) throw new Error('No result in stream');
        const parsed = JSON.parse(match[1].trim()) as {
          orders?:  { symbol: string }[];
          summary?: string;
          paused?:  boolean;
          error?:   string;
        };
        if (parsed.error)  throw new Error(parsed.error);
        if (parsed.paused) { setDriftRebalanceBanner({ kind: 'paused' }); return; }
        const count = parsed.orders?.length ?? 0;
        if (count > 0) {
          setDriftRebalanceBanner({ kind: 'staged', count, summary: parsed.summary ?? '' });
        } else {
          setDriftRebalanceBanner(null);
        }
      } catch (err) {
        setDriftRebalanceBanner({ kind: 'error', message: err instanceof Error ? err.message : 'Auto-rebalance failed' });
      }
    })();
  }, [account, strategyTargets]);

  // ── Max drift (per pillar) — surfaced as a Today metric so weekly-rebalance
  //    drift is always visible without digging into the allocation panel. ────
  const maxDrift = useMemo(() => {
    if (!account?.pillarSummary?.length) return 0;
    const targetMap: Record<string, number> = {
      triples:     strategyTargets.triplesPct,
      cornerstone: strategyTargets.cornerstonePct,
      income:      strategyTargets.incomePct,
      hedge:       strategyTargets.hedgePct,
    };
    return Math.max(
      ...account.pillarSummary
        .filter((p) => p.pillar !== 'other')
        .map((p) => Math.abs(p.portfolioPercent - (targetMap[p.pillar] ?? 0))),
      0,
    );
  }, [account, strategyTargets]);

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
          <h2 className="text-xl font-semibold text-white">Failed to load portfolio</h2>
          <p className="text-[#7c82a0] text-sm">{error}</p>
          <button
            onClick={() => fetchAccounts()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg text-sm transition-colors"
          >
            Try again
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
  const dayGL = account.dayGainLoss;
  const availableForWithdrawal = account.availableForWithdrawal ?? 0;
  const marginUsedPct = (account.equity + Math.abs(account.marginBalance)) > 0
    ? (Math.abs(account.marginBalance) / (account.equity + Math.abs(account.marginBalance))) * 100
    : 0;
  const dangerAlerts = account.marginAlerts.filter((a) => a.level === 'danger');
  const warnAlerts   = account.marginAlerts.filter((a) => a.level === 'warn');

  // ── Daily pulse handler — switches to History and triggers AI deep-dive ───
  const fireDailyPulse = () => {
    setView('history');
    setAiPulseTrigger((n) => n + 1);
    setTimeout(() => {
      document.getElementById('panel-ai')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0c14]">

      {/* ── Slim header (5 functional groups instead of 10) ───────────────── */}
      <header className="border-b border-[#1a1e2e] bg-[rgba(18,21,31,0.85)] backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-4">

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
                <TrendingUp className="w-3 h-3 text-blue-400" />
              </div>
              <div className="leading-none">
                <div className="font-bold text-white text-sm tracking-tight">Triple C</div>
              </div>
            </div>
            <FireProgress monthly={monthlyIncome} target={fireTarget} />
          </div>

          <div className="flex items-center gap-2 sm:gap-2.5 text-xs">
            <AccountSwitcher accounts={accounts} selectedIndex={selectedIdx} onSelect={setSelectedIdx} />

            <button
              onClick={() => fetchAccounts(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-[#7c82a0] hover:text-white transition-colors disabled:opacity-50"
              title={lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Refresh'}
              aria-label="Refresh portfolio data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {lastUpdated && <DataAge updated={lastUpdated} />}
            </button>

            <button
              onClick={fireDailyPulse}
              className="flex items-center gap-1.5 font-semibold text-cyan-400 hover:text-cyan-300 bg-cyan-600/10 hover:bg-cyan-600/20 border border-cyan-500/30 px-2.5 py-1 rounded-md transition-colors"
              title="Run AI daily pulse analysis"
            >
              <Zap className="w-3 h-3" />
              <span className="hidden sm:inline">Daily pulse</span>
            </button>

            <div className="flex items-center gap-1.5 pl-2 border-l border-[#1f2334]">
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
              <form action="/api/auth/logout" method="POST">
                <button
                  type="submit"
                  aria-label="Log out"
                  className="flex items-center text-[#7c82a0] hover:text-red-400 transition-colors p-1"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          </div>
        </div>
      </header>

      {/* ── Top tabs ──────────────────────────────────────────────────────── */}
      <TopTabs view={view} onChange={setView} />

      <main className="max-w-7xl mx-auto px-4 py-5 space-y-4">

        {/* ── Drift auto-rebalance banner ──────────────────────────────────── */}
        {driftRebalanceBanner && driftRebalanceBanner.kind !== 'skipped_existing' && (
          <div
            className={`rounded-lg border p-3 flex items-start gap-2 text-xs ${
              driftRebalanceBanner.kind === 'staged'  ? 'bg-blue-500/8 border-blue-500/35 text-blue-200'  :
              driftRebalanceBanner.kind === 'staging' ? 'bg-blue-500/5 border-blue-500/20 text-blue-200'  :
              driftRebalanceBanner.kind === 'paused'  ? 'bg-yellow-500/8 border-yellow-500/25 text-yellow-200' :
              'bg-red-500/8 border-red-500/25 text-red-200'
            }`}
          >
            {driftRebalanceBanner.kind === 'staging' && <RefreshCw className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 animate-spin" />}
            {driftRebalanceBanner.kind === 'staged'  && <Inbox      className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
            {driftRebalanceBanner.kind === 'paused'  && <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
            {driftRebalanceBanner.kind === 'error'   && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
            <div className="flex-1 min-w-0 leading-relaxed">
              {driftRebalanceBanner.kind === 'staging' && (
                <><span className="font-semibold">Drift detected ({driftRebalanceBanner.maxDriftPct.toFixed(1)}%).</span> Generating rebalance trades…</>
              )}
              {driftRebalanceBanner.kind === 'staged' && (
                <>
                  <span className="font-semibold">Rebalance staged.</span>{' '}
                  {driftRebalanceBanner.count} order{driftRebalanceBanner.count === 1 ? '' : 's'} ready in Today.
                  {driftRebalanceBanner.summary && (
                    <span className="block text-blue-200/70 mt-0.5">{driftRebalanceBanner.summary}</span>
                  )}
                </>
              )}
              {driftRebalanceBanner.kind === 'paused' && (
                <><span className="font-semibold">Automation paused.</span> Drift detected but no trades generated.</>
              )}
              {driftRebalanceBanner.kind === 'error' && (
                <><span className="font-semibold">Auto-rebalance failed:</span> {driftRebalanceBanner.message}</>
              )}
            </div>
            <button
              onClick={() => setDriftRebalanceBanner(null)}
              className="text-current/60 hover:text-current transition-colors flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Margin danger / warn ribbons ─────────────────────────────────── */}
        {dangerAlerts.length > 0 && (
          <div className="bg-red-500/8 border border-red-500/30 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
              <span className="text-xs font-semibold text-red-300">
                {dangerAlerts.length} rule violation{dangerAlerts.length > 1 ? 's' : ''}
              </span>
            </div>
            {dangerAlerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-red-300/90 ml-5.5">
                <span>•</span>
                <span><strong>{a.rule}:</strong> {a.detail}</span>
              </div>
            ))}
          </div>
        )}
        {warnAlerts.length > 0 && dangerAlerts.length === 0 && (
          <div className="bg-orange-500/8 border border-orange-500/25 rounded-lg px-3 py-2 flex items-center gap-2 text-xs text-orange-300">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{warnAlerts.length} warning{warnAlerts.length > 1 ? 's' : ''} — see Margin & Risk on Portfolio › Strategy.</span>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            TODAY view — the morning check-in. Action queue first.
            ═══════════════════════════════════════════════════════════════════ */}
        {view === 'today' && (
          <>
            {/* 4-metric strip — Equity + Buying Power dropped; Max Drift added */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard
                label="Portfolio value"
                value={fmt$(account.totalValue)}
                rawValue={account.totalValue}
                sub={`${account.positions.length} positions`}
              />
              <MetricCard
                label="Day P&L"
                value={fmt$(dayGL)}
                rawValue={dayGL}
                colorClass={gainLossColor(dayGL)}
                trend={dayGL > 0 ? 'up' : dayGL < 0 ? 'down' : null}
                sub={account.totalValue > 0 ? `${((dayGL / account.totalValue) * 100).toFixed(2)}% today` : undefined}
              />
              <MetricCard
                label="AFW"
                value={fmt$(availableForWithdrawal)}
                rawValue={availableForWithdrawal}
                colorClass="text-blue-400"
                sub={`Margin ${marginUsedPct.toFixed(0)}% / 50 cap`}
              />
              <MetricCard
                label="Max drift"
                value={`${maxDrift.toFixed(1)}%`}
                rawValue={maxDrift}
                colorClass={maxDrift > 2 ? 'text-orange-400' : maxDrift > 1 ? 'text-yellow-400' : 'text-emerald-400'}
                sub={maxDrift > 2 ? 'Rebalance staged' : maxDrift > 1 ? 'Watch' : 'On target'}
              />
            </div>

            {/* Unified action queue */}
            <TodayPanel
              accountHash={account.accountHash}
              onChanged={() => fetchAccounts(true)}
            />

            {/* Pillar allocation */}
            <div className="bg-[#12151f] border border-[#1f2334] rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <PieChart className="w-4 h-4 text-[#9aa2c0]" />
                  <span className="text-sm font-semibold text-white">Pillar allocation</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[#7c82a0]">
                  {streamStatus === 'connected' && (
                    <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 dot-live shadow-[0_0_5px_#10b981]" />
                      live
                    </span>
                  )}
                  <span>{account.positions.length} positions</span>
                </div>
              </div>
              <PillarAllocationBar summaries={account.pillarSummary} targets={strategyTargets} />
            </div>

            {/* Market read + Top positions side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <MarketReadCard />
              <TopPositionsCard
                positions={livePositions}
                onSeeAll={() => { setView('portfolio'); setPortfolioSub('positions'); }}
              />
            </div>
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            PORTFOLIO view — deep dives, weekly rebalance.
            ═══════════════════════════════════════════════════════════════════ */}
        {view === 'portfolio' && (
          <>
            <PortfolioSubTabs
              active={portfolioSub}
              onChange={setPortfolioSub}
              counts={{ positions: account.positions.length, orders: pendingOrders.size }}
            />

            {portfolioSub === 'positions' && (
              <CollapsiblePanel
                id="positions"
                title={`All positions (${account.positions.length})`}
                icon={<BarChart2 className="w-4 h-4 text-[#9aa2c0]" />}
                iconContainerClass="bg-white/[0.06] border border-white/10"
                defaultOpen={true}
              >
                <div className="pt-4">
                  <PositionsTable positions={account.positions} pendingOrders={pendingOrders} />
                </div>
              </CollapsiblePanel>
            )}

            {portfolioSub === 'income' && (
              <>
                <IncomeHub
                  positions={account.positions}
                  totalValue={account.totalValue}
                  equity={account.equity}
                  marginBalance={account.marginBalance}
                  pillarSummary={account.pillarSummary}
                  onProjectedMonthly={setMonthlyIncome}
                />
                <CollapsiblePanel
                  id="portfolio-chart"
                  title="Portfolio history"
                  icon={<BarChart2 className="w-4 h-4 text-blue-400" />}
                  accentClass="border-blue-500/40"
                  iconContainerClass="bg-blue-500/10 border border-blue-500/20"
                  defaultOpen={true}
                >
                  <div className="pt-4"><PortfolioChart /></div>
                </CollapsiblePanel>
              </>
            )}

            {portfolioSub === 'trades' && (
              <>
                <TradeHub accountHash={account.accountHash} />
                <CollapsiblePanel
                  id="rebalance"
                  title="Rebalance workflow"
                  icon={<Calculator className="w-4 h-4 text-purple-400" />}
                  accentClass="border-purple-500/40"
                  iconContainerClass="bg-purple-500/10 border border-purple-500/20"
                  defaultOpen={true}
                >
                  <div className="pt-4">
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
                </CollapsiblePanel>
              </>
            )}

            {portfolioSub === 'market' && (
              <CollapsiblePanel
                id="market"
                title="Market conditions & recommendations"
                icon={<TrendingUp className="w-4 h-4 text-cyan-400" />}
                accentClass="border-cyan-500/40"
                iconContainerClass="bg-cyan-500/10 border border-cyan-500/20"
                defaultOpen={true}
              >
                <div className="pt-4">
                  <MarketConditionsDashboard
                    currentTargets={strategyTargets}
                    onTargetsChange={updateStrategyTargets}
                  />
                </div>
              </CollapsiblePanel>
            )}

            {portfolioSub === 'strategy' && (
              <>
                <CollapsiblePanel
                  id="cornerstone"
                  title="Cornerstone — CLM / CRF"
                  icon={<PieChart className="w-4 h-4 text-amber-400" />}
                  accentClass="border-amber-500/60"
                  iconContainerClass="bg-amber-500/10 border border-amber-500/25"
                  defaultOpen={true}
                >
                  <div className="pt-4">
                    <CornerStoneCard positions={account.positions} accountHash={account.accountHash} />
                  </div>
                </CollapsiblePanel>

                <CollapsiblePanel
                  id="triples"
                  title="Triple ETF tactical engine"
                  icon={<Zap className="w-4 h-4 text-violet-400" />}
                  accentClass="border-violet-500/40"
                  iconContainerClass="bg-violet-500/10 border border-violet-500/20"
                  defaultOpen={true}
                >
                  <div className="pt-4">
                    <TriplesTacticalPanel positions={account.positions} totalValue={account.totalValue} />
                  </div>
                </CollapsiblePanel>

                <OptionsPutsPanel
                  positions={account.positions}
                  totalValue={account.totalValue}
                  accountHash={account.accountHash}
                />

                <CollapsiblePanel
                  id="margin"
                  title="Margin & risk intelligence"
                  icon={<Gauge className="w-4 h-4 text-orange-400" />}
                  badge={
                    dangerAlerts.length > 0 ? (
                      <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 dot-live" />
                        {dangerAlerts.length} alert{dangerAlerts.length > 1 ? 's' : ''}
                      </span>
                    ) : undefined
                  }
                  accentClass={dangerAlerts.length > 0 ? 'border-red-500/60' : 'border-orange-500/40'}
                  iconContainerClass={dangerAlerts.length > 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-orange-500/10 border border-orange-500/20'}
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

                <CollapsiblePanel
                  id="watchlist"
                  title="Watchlist"
                  icon={<Eye className="w-4 h-4 text-purple-400" />}
                  accentClass="border-purple-500/30"
                  iconContainerClass="bg-purple-500/10 border border-purple-500/20"
                  defaultOpen={true}
                >
                  <div className="pt-4"><WatchlistPanel /></div>
                </CollapsiblePanel>
              </>
            )}
          </>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            HISTORY view — forensics, deep AI, archives.
            ═══════════════════════════════════════════════════════════════════ */}
        {view === 'history' && (
          <>
            <CollapsiblePanel
              id="ai"
              title="AI portfolio analysis"
              icon={<Brain className="w-4 h-4 text-cyan-400" />}
              accentClass="border-cyan-500/40"
              iconContainerClass="bg-cyan-500/10 border border-cyan-500/20"
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

            <CollapsiblePanel
              id="performance"
              title="Performance — vs 40% target"
              icon={<Target className="w-4 h-4 text-emerald-400" />}
              accentClass="border-emerald-500/40"
              iconContainerClass="bg-emerald-500/10 border border-emerald-500/20"
              defaultOpen={false}
            >
              <div className="pt-4"><PerformancePanel /></div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="daily-plan"
              title="Daily autopilot plan"
              icon={<ClipboardList className="w-4 h-4 text-emerald-400" />}
              accentClass="border-emerald-500/40"
              iconContainerClass="bg-emerald-500/10 border border-emerald-500/20"
              defaultOpen={false}
            >
              <div className="pt-4"><DailyPlanPanel /></div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="review"
              title="AI performance review"
              icon={<Brain className="w-4 h-4 text-purple-400" />}
              accentClass="border-purple-500/40"
              iconContainerClass="bg-purple-500/10 border border-purple-500/20"
              defaultOpen={false}
            >
              <div className="pt-4">
                <PerformanceReviewPanel currentTargets={strategyTargets} />
              </div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="plan-archive"
              title="Plan archive"
              icon={<History className="w-4 h-4 text-purple-400" />}
              accentClass="border-purple-500/40"
              iconContainerClass="bg-purple-500/10 border border-purple-500/20"
              defaultOpen={false}
            >
              <div className="pt-4"><PlanArchivePanel /></div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="replay"
              title="Engine replay"
              icon={<Activity className="w-4 h-4 text-purple-400" />}
              accentClass="border-purple-500/40"
              iconContainerClass="bg-purple-500/10 border border-purple-500/20"
              defaultOpen={false}
            >
              <div className="pt-4"><ReplayPanel /></div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="rollback"
              title="Rollback"
              icon={<RefreshCw className="w-4 h-4 text-red-400" />}
              accentClass="border-red-500/40"
              iconContainerClass="bg-red-500/10 border border-red-500/20"
              defaultOpen={false}
            >
              <div className="pt-4"><RollbackPanel /></div>
            </CollapsiblePanel>

            <CollapsiblePanel
              id="strategy"
              title="Triple C's strategy guide"
              icon={<BookOpen className="w-4 h-4 text-blue-400" />}
              accentClass="border-blue-500/30"
              iconContainerClass="bg-blue-500/10 border border-blue-500/20"
              defaultOpen={false}
            >
              <div className="pt-4"><StrategyGuide /></div>
            </CollapsiblePanel>
          </>
        )}

        <div className="h-12" />
      </main>

      {/* ── Real-time alert monitor (renders nothing, fires toasts) ─────── */}
      <AlertMonitor
        marginPct={marginUsedPct}
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
