'use client';

import { useState, useEffect } from 'react';
import {
  TrendingUp, BarChart2, Gauge, ClipboardList,
  CheckCircle, AlertTriangle, AlertCircle, X, ChevronRight,
  ExternalLink, RefreshCw,
} from 'lucide-react';
import { PendingOrdersPanel } from '@/components/PendingOrdersPanel';
import type { PillarType } from '@/lib/schwab/types';
import type { StrategyTargets } from '@/lib/utils';
import type { RuleAlert } from '@/lib/classify';
import { fmt$, gainLossColor } from '@/lib/utils';
import { updateStrategyTargets } from '@/components/SettingsPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PillarSummary {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

interface MarketData {
  vix: number;
  vixChange: number;
  sp500Change: number;
  marketTrend: 'bullish' | 'neutral' | 'bearish';
  volatilityLevel: 'low' | 'normal' | 'high' | 'extreme';
}

interface Recommendation {
  recommendation: string;
  reason: string;
  suggestedChanges: {
    triplesPct?: number;
    cornerstonePct?: number;
    incomePct?: number;
    hedgePct?: number;
  };
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface DailyReviewWizardProps {
  isOpen: boolean;
  onClose: () => void;
  account: {
    accountHash: string;
    equity: number;
    marginBalance: number;
    totalValue: number;
    pillarSummary: PillarSummary[];
    marginAlerts: RuleAlert[];
    dayGainLoss: number;
  };
  strategyTargets: StrategyTargets;
  pendingOrderCount: number;
}

type StepStatus = 'ok' | 'warn' | 'danger';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const STEP_META = [
  { id: 1, label: 'Market',  Icon: TrendingUp   },
  { id: 2, label: 'Pillars', Icon: BarChart2     },
  { id: 3, label: 'Margin',  Icon: Gauge         },
  { id: 4, label: 'Orders',  Icon: ClipboardList },
];

const STATUS_ICON: Record<StepStatus, React.ReactNode> = {
  ok:     <CheckCircle  className="w-5 h-5 text-emerald-400" />,
  warn:   <AlertCircle  className="w-5 h-5 text-yellow-400" />,
  danger: <AlertTriangle className="w-5 h-5 text-red-400" />,
};

const STATUS_LABEL: Record<StepStatus, string> = {
  ok:     'All clear',
  warn:   'Review recommended',
  danger: 'Action needed',
};

const VIX_LABEL: Record<string, string> = {
  low:     'Low (< 15)',
  normal:  'Normal (15–25)',
  high:    'Elevated (25–40)',
  extreme: 'Extreme (> 40)',
};

const VIX_COLOR: Record<string, string> = {
  low:     'text-emerald-400',
  normal:  'text-blue-400',
  high:    'text-yellow-400',
  extreme: 'text-red-400',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scrollToPanel(id: string) {
  setTimeout(() => {
    const el = document.getElementById(`panel-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}

function pillarPct(summaries: PillarSummary[], pillar: PillarType): number {
  return summaries.find((s) => s.pillar === pillar)?.portfolioPercent ?? 0;
}

function drift(actual: number, target: number): number {
  return actual - target;
}

// ─── Step components ──────────────────────────────────────────────────────────

function StepCard({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}

function StatusBadge({ status }: { status: StepStatus }) {
  const colors: Record<StepStatus, string> = {
    ok:     'bg-emerald-400/10 border-emerald-500/30 text-emerald-300',
    warn:   'bg-yellow-400/10 border-yellow-500/30 text-yellow-300',
    danger: 'bg-red-400/10 border-red-500/30 text-red-300',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold ${colors[status]}`}>
      {STATUS_ICON[status]}
      {STATUS_LABEL[status]}
    </span>
  );
}

function MetricRow({ label, value, sub, colorClass = 'text-white' }: {
  label: string; value: string; sub?: string; colorClass?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#2d3248]/50 last:border-0">
      <span className="text-sm text-[#7c82a0]">{label}</span>
      <div className="text-right">
        <span className={`text-sm font-semibold tabular-nums ${colorClass}`}>{value}</span>
        {sub && <div className="text-[11px] text-[#4a5070]">{sub}</div>}
      </div>
    </div>
  );
}

// Step 1 — Market Pulse
function StepMarket({
  marketData, recommendation, loading, strategyTargets, onApply, onNext,
}: {
  marketData: MarketData | null;
  recommendation: Recommendation | null;
  loading: boolean;
  strategyTargets: StrategyTargets;
  onApply: () => void;
  onNext: (status: StepStatus) => void;
}) {
  if (loading || !marketData) {
    return (
      <StepCard>
        <div className="flex items-center justify-center py-10 gap-2 text-[#7c82a0]">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Fetching market data…</span>
        </div>
      </StepCard>
    );
  }

  const status: StepStatus =
    marketData.volatilityLevel === 'extreme' ? 'danger'
    : marketData.volatilityLevel === 'high' || marketData.marketTrend === 'bearish' ? 'warn'
    : 'ok';

  const trendColor = marketData.marketTrend === 'bullish' ? 'text-emerald-400'
    : marketData.marketTrend === 'bearish' ? 'text-red-400' : 'text-yellow-400';

  const hasChanges = recommendation?.suggestedChanges &&
    (recommendation.suggestedChanges.triplesPct !== strategyTargets.triplesPct ||
     recommendation.suggestedChanges.cornerstonePct !== strategyTargets.cornerstonePct ||
     recommendation.suggestedChanges.incomePct !== strategyTargets.incomePct ||
     recommendation.suggestedChanges.hedgePct !== strategyTargets.hedgePct);

  return (
    <StepCard>
      <StatusBadge status={status} />

      <div className="bg-[#0f1117] rounded-xl border border-[#2d3248] divide-y divide-[#2d3248]/50">
        <MetricRow
          label="VIX"
          value={marketData.vix.toFixed(1)}
          sub={VIX_LABEL[marketData.volatilityLevel]}
          colorClass={VIX_COLOR[marketData.volatilityLevel]}
        />
        <MetricRow
          label="Market Trend"
          value={marketData.marketTrend.charAt(0).toUpperCase() + marketData.marketTrend.slice(1)}
          colorClass={trendColor}
        />
        <MetricRow
          label="S&P 500 Today"
          value={`${marketData.sp500Change >= 0 ? '+' : ''}${marketData.sp500Change.toFixed(2)}%`}
          colorClass={gainLossColor(marketData.sp500Change)}
        />
      </div>

      {recommendation && (
        <div className="bg-[#0f1117] rounded-xl border border-[#2d3248] p-4 space-y-2">
          <p className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">AI Recommendation</p>
          <p className="text-sm font-semibold text-white">{recommendation.recommendation}</p>
          <p className="text-xs text-[#7c82a0] leading-relaxed">{recommendation.reason}</p>
          {hasChanges && (
            <div className="grid grid-cols-4 gap-2 pt-2">
              {(['triplesPct', 'cornerstonePct', 'incomePct', 'hedgePct'] as const).map((key) => {
                const suggested = recommendation.suggestedChanges[key];
                const current = strategyTargets[key];
                if (suggested === undefined) return null;
                const diff = suggested - current;
                return (
                  <div key={key} className="bg-[#1a1d27] rounded-lg p-2 text-center">
                    <p className="text-[10px] text-[#4a5070] capitalize">{key.replace('Pct', '').replace('triples', 'Triples').replace('cornerstone', 'Corner').replace('income', 'Income').replace('hedge', 'Hedge')}</p>
                    <p className="text-sm font-bold text-white">{suggested}%</p>
                    {diff !== 0 && (
                      <p className={`text-[10px] font-semibold ${diff > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {diff > 0 ? '+' : ''}{diff}%
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {hasChanges && (
          <button
            onClick={() => { onApply(); onNext(status); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
          >
            Apply Recommendation
          </button>
        )}
        <button
          onClick={() => onNext(status)}
          className={`flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors ${hasChanges ? 'px-4 text-[#7c82a0] hover:text-white hover:bg-white/5' : 'flex-1 bg-[#1a1d27] hover:bg-[#2d3248] text-white border border-[#2d3248]'}`}
        >
          {hasChanges ? 'Skip' : 'Looks Good'} <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </StepCard>
  );
}

// Step 2 — Pillar Drift
function StepPillars({
  pillarSummary, strategyTargets, totalValue, onScrollTo, onNext,
}: {
  pillarSummary: PillarSummary[];
  strategyTargets: StrategyTargets;
  totalValue: number;
  onScrollTo: (id: string) => void;
  onNext: (status: StepStatus) => void;
}) {
  const pillars: { key: PillarType; label: string; target: number; color: string }[] = [
    { key: 'triples',     label: 'Triples',     target: strategyTargets.triplesPct,     color: 'text-violet-400' },
    { key: 'cornerstone', label: 'Cornerstone', target: strategyTargets.cornerstonePct, color: 'text-amber-400'  },
    { key: 'income',      label: 'Income',      target: strategyTargets.incomePct,      color: 'text-emerald-400' },
    { key: 'hedge',       label: 'Hedge',       target: strategyTargets.hedgePct,       color: 'text-red-400'    },
  ];

  const drifts = pillars.map((p) => {
    const actual = pillarPct(pillarSummary, p.key);
    const d = drift(actual, p.target);
    return { ...p, actual, drift: d };
  });

  const maxAbsDrift = Math.max(...drifts.map((d) => Math.abs(d.drift)));
  const status: StepStatus = maxAbsDrift > 5 ? 'danger' : maxAbsDrift > 2 ? 'warn' : 'ok';
  const needsAction = status !== 'ok';

  return (
    <StepCard>
      <StatusBadge status={status} />

      <div className="bg-[#0f1117] rounded-xl border border-[#2d3248] divide-y divide-[#2d3248]/50">
        {drifts.map(({ key, label, actual, target, drift: d, color }) => (
          <div key={key} className="flex items-center justify-between py-2.5 px-4">
            <span className={`text-sm font-medium ${color}`}>{label}</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#4a5070]">target {target}%</span>
              <span className={`text-sm font-semibold tabular-nums ${Math.abs(d) > 2 ? (d > 0 ? 'text-yellow-400' : 'text-red-400') : 'text-white'}`}>
                {actual.toFixed(1)}%
              </span>
              {Math.abs(d) >= 0.5 && (
                <span className={`text-xs font-semibold tabular-nums ${d > 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {d > 0 ? '+' : ''}{d.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {needsAction && (
        <p className="text-xs text-[#7c82a0] px-1">
          {maxAbsDrift > 5
            ? 'One or more pillars have drifted significantly from target. Rebalancing is recommended.'
            : 'Minor drift detected. Consider rebalancing when convenient.'}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        {needsAction && (
          <button
            onClick={() => { onScrollTo('rebalance'); onNext(status); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            Go to Rebalance <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => onNext(status)}
          className={`flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors ${needsAction ? 'px-4 text-[#7c82a0] hover:text-white hover:bg-white/5' : 'flex-1 bg-[#1a1d27] hover:bg-[#2d3248] text-white border border-[#2d3248]'}`}
        >
          {needsAction ? 'Skip' : 'Looks Good'} <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </StepCard>
  );
}

// Step 3 — Margin Health
function StepMargin({
  equity, marginBalance, totalValue, marginAlerts, strategyTargets, onScrollTo, onNext,
}: {
  equity: number;
  marginBalance: number;
  totalValue: number;
  marginAlerts: RuleAlert[];
  strategyTargets: StrategyTargets;
  onScrollTo: (id: string) => void;
  onNext: (status: StepStatus) => void;
}) {
  const dangerAlerts = marginAlerts.filter((a) => a.level === 'danger');
  const warnAlerts   = marginAlerts.filter((a) => a.level === 'warn');
  const status: StepStatus = dangerAlerts.length > 0 ? 'danger' : warnAlerts.length > 0 ? 'warn' : 'ok';
  const needsAction = status !== 'ok';

  const marginDebt    = Math.abs(marginBalance);
  const marginUsedPct = totalValue > 0 ? (marginDebt / totalValue) * 100 : 0;
  const barColor      = marginUsedPct >= strategyTargets.marginLimitPct ? 'bg-red-500'
    : marginUsedPct >= strategyTargets.marginWarnPct ? 'bg-yellow-500' : 'bg-emerald-500';

  return (
    <StepCard>
      <StatusBadge status={status} />

      <div className="bg-[#0f1117] rounded-xl border border-[#2d3248] divide-y divide-[#2d3248]/50">
        <MetricRow label="Equity"        value={fmt$(equity)} />
        <MetricRow label="Margin Debt"   value={fmt$(marginDebt)}     colorClass={marginDebt > 0 ? 'text-orange-400' : 'text-white'} />
        <MetricRow
          label="Margin Used"
          value={`${marginUsedPct.toFixed(1)}%`}
          sub={`Warn: ${strategyTargets.marginWarnPct}%  Limit: ${strategyTargets.marginLimitPct}%`}
          colorClass={marginUsedPct >= strategyTargets.marginLimitPct ? 'text-red-400' : marginUsedPct >= strategyTargets.marginWarnPct ? 'text-yellow-400' : 'text-emerald-400'}
        />
      </div>

      {/* Margin bar */}
      <div className="space-y-1">
        <div className="h-2 bg-[#2d3248] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(marginUsedPct / strategyTargets.marginLimitPct * 100, 100)}%` }}
          />
        </div>
      </div>

      {needsAction && (dangerAlerts.length > 0 || warnAlerts.length > 0) && (
        <div className="space-y-1.5">
          {[...dangerAlerts, ...warnAlerts].slice(0, 3).map((a, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              {a.level === 'danger'
                ? <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                : <AlertCircle   className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0 mt-0.5" />}
              <span className={a.level === 'danger' ? 'text-red-300' : 'text-yellow-300'}>
                <strong>{a.rule}:</strong> {a.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {needsAction && (
          <button
            onClick={() => { onScrollTo('margin'); onNext(status); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5"
          >
            Go to Margin <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => onNext(status)}
          className={`flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors ${needsAction ? 'px-4 text-[#7c82a0] hover:text-white hover:bg-white/5' : 'flex-1 bg-[#1a1d27] hover:bg-[#2d3248] text-white border border-[#2d3248]'}`}
        >
          {needsAction ? 'Skip' : 'Margin is Healthy'} <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </StepCard>
  );
}

// Step 4 — Pending Orders
function StepOrders({
  accountHash, pendingOrderCount, onNext,
}: {
  accountHash: string;
  pendingOrderCount: number;
  onNext: (status: StepStatus) => void;
}) {
  const status: StepStatus = pendingOrderCount > 0 ? 'warn' : 'ok';

  return (
    <StepCard>
      <StatusBadge status={status} />
      <PendingOrdersPanel accountHash={accountHash} />
      <button
        onClick={() => onNext(status)}
        className="w-full flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors bg-[#1a1d27] hover:bg-[#2d3248] text-white border border-[#2d3248]"
      >
        Done <ChevronRight className="w-4 h-4" />
      </button>
    </StepCard>
  );
}

// Summary — Step 6
function StepSummary({
  statuses, onClose,
}: {
  statuses: Record<number, StepStatus>;
  onClose: () => void;
}) {
  const stepLabels: Record<number, string> = {
    1: 'Market Pulse',
    2: 'Pillar Drift',
    3: 'Margin Health',
    4: 'Pending Orders',
  };

  const allClear = Object.values(statuses).every((s) => s === 'ok');
  const actionItems = Object.entries(statuses).filter(([, s]) => s !== 'ok');

  return (
    <StepCard>
      <div className={`rounded-xl border p-4 ${allClear ? 'bg-emerald-400/10 border-emerald-500/30' : 'bg-[#1a1d27] border-[#2d3248]'}`}>
        <p className={`text-sm font-semibold ${allClear ? 'text-emerald-300' : 'text-white'}`}>
          {allClear ? '✓ Portfolio looks healthy today' : `${actionItems.length} item${actionItems.length > 1 ? 's' : ''} need${actionItems.length === 1 ? 's' : ''} attention`}
        </p>
      </div>

      <div className="space-y-2">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => {
          const s = statuses[n] ?? 'ok';
          return (
            <div key={n} className="flex items-center gap-3 py-1.5">
              <div className="w-5 flex-shrink-0">{STATUS_ICON[s]}</div>
              <span className="text-sm text-white flex-1">{stepLabels[n]}</span>
              <span className={`text-xs font-medium ${s === 'ok' ? 'text-emerald-400' : s === 'warn' ? 'text-yellow-400' : 'text-red-400'}`}>
                {STATUS_LABEL[s]}
              </span>
            </div>
          );
        })}
      </div>

      <button
        onClick={onClose}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors mt-2"
      >
        Done — Back to Dashboard
      </button>
    </StepCard>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export function DailyReviewWizard({
  isOpen, onClose, account, strategyTargets, pendingOrderCount,
}: DailyReviewWizardProps) {
  const [step, setStep] = useState(1);
  const [statuses, setStatuses] = useState<Record<number, StepStatus>>({});
  const [marketData, setMarketData]       = useState<MarketData | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      // Reset on close so next open starts fresh
      setStep(1);
      setStatuses({});
      setMarketData(null);
      setRecommendation(null);
      return;
    }
    setMarketLoading(true);
    fetch('/api/market-conditions')
      .then((r) => r.json())
      .then((data) => {
        setMarketData(data.marketData ?? null);
        setRecommendation(data.recommendation ?? null);
      })
      .catch(console.warn)
      .finally(() => setMarketLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const isSummary = step > TOTAL_STEPS;

  function advance(status: StepStatus) {
    setStatuses((prev) => ({ ...prev, [step]: status }));
    setStep((s) => s + 1);
  }

  function handleScrollTo(id: string) {
    onClose();
    scrollToPanel(id);
  }

  function handleApplyRecommendation() {
    if (!recommendation?.suggestedChanges) return;
    const newTargets: StrategyTargets = {
      ...strategyTargets,
      triplesPct:     recommendation.suggestedChanges.triplesPct     ?? strategyTargets.triplesPct,
      cornerstonePct: recommendation.suggestedChanges.cornerstonePct ?? strategyTargets.cornerstonePct,
      incomePct:      recommendation.suggestedChanges.incomePct      ?? strategyTargets.incomePct,
      hedgePct:       recommendation.suggestedChanges.hedgePct       ?? strategyTargets.hedgePct,
    };
    updateStrategyTargets(newTargets);
  }

  const stepTitles: Record<number, string> = {
    1: 'Market Pulse',
    2: 'Pillar Drift',
    3: 'Margin Health',
    4: 'Pending Orders',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-[#1a1d27] border border-[#2d3248] rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#2d3248]">
          <div>
            <h2 className="text-base font-bold text-white">Daily Review</h2>
            <p className="text-xs text-[#7c82a0] mt-0.5">
              {isSummary ? 'Summary' : `Step ${step} of ${TOTAL_STEPS} — ${stepTitles[step]}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[#7c82a0] hover:text-white hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Progress dots */}
        {!isSummary && (
          <div className="flex items-center gap-1.5 px-5 py-3">
            {STEP_META.map(({ id, label, Icon }) => {
              const done = id < step;
              const active = id === step;
              const s = statuses[id];
              return (
                <div key={id} className="flex-1 flex flex-col items-center gap-1">
                  <div className={`w-full h-1 rounded-full transition-all ${done ? (s === 'ok' ? 'bg-emerald-500' : s === 'warn' ? 'bg-yellow-500' : 'bg-red-500') : active ? 'bg-blue-500' : 'bg-[#2d3248]'}`} />
                  <span className={`text-[10px] font-medium transition-colors ${active ? 'text-white' : done ? 'text-[#7c82a0]' : 'text-[#4a5070]'}`}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {step === 1 && (
            <StepMarket
              marketData={marketData}
              recommendation={recommendation}
              loading={marketLoading}
              strategyTargets={strategyTargets}
              onApply={handleApplyRecommendation}
              onNext={advance}
            />
          )}
          {step === 2 && (
            <StepPillars
              pillarSummary={account.pillarSummary}
              strategyTargets={strategyTargets}
              totalValue={account.totalValue}
              onScrollTo={handleScrollTo}
              onNext={advance}
            />
          )}
          {step === 3 && (
            <StepMargin
              equity={account.equity}
              marginBalance={account.marginBalance}
              totalValue={account.totalValue}
              marginAlerts={account.marginAlerts}
              strategyTargets={strategyTargets}
              onScrollTo={handleScrollTo}
              onNext={advance}
            />
          )}
          {step === 4 && (
            <StepOrders
              accountHash={account.accountHash}
              pendingOrderCount={pendingOrderCount}
              onNext={advance}
            />
          )}
          {isSummary && (
            <StepSummary statuses={statuses} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
