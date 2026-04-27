'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp, BarChart2, Gauge, ClipboardList,
  CheckCircle, AlertTriangle, AlertCircle, X, ChevronRight,
  ExternalLink, RefreshCw, Brain, Loader2, Zap, Inbox, Send,
} from 'lucide-react';
import { PendingOrdersPanel } from '@/components/PendingOrdersPanel';
import type { PillarType, EnrichedPosition } from '@/lib/schwab/types';
import type { StrategyTargets } from '@/lib/utils';
import type { RuleAlert } from '@/lib/classify';
import { fmt$, gainLossColor } from '@/lib/utils';
import { updateStrategyTargets } from '@/components/SettingsPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AIPulseAlert {
  level: 'danger' | 'warn' | 'ok';
  rule: string;
  detail: string;
}

interface AIPulse {
  summary: string;
  alerts: AIPulseAlert[];
}

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

/** Subset of the rebalance-plan response we render inline for the Apply preview. */
interface PreviewOrder {
  symbol:         string;
  instruction:    'BUY' | 'SELL';
  shares:         number;
  currentPrice:   number;
  estimatedValue: number;
  pillar:         string;
  rationale:      string;
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
    positions: EnrichedPosition[];
  };
  strategyTargets: StrategyTargets;
  pendingOrderCount: number;
  dividendsAnnual?: number;
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

const ALERT_STYLE: Record<string, string> = {
  danger: 'bg-red-500/10 border-red-500/25 text-red-300',
  warn:   'bg-orange-500/10 border-orange-500/25 text-orange-300',
  ok:     'bg-emerald-500/10 border-emerald-500/25 text-emerald-300',
};
const ALERT_ICON: Record<string, React.ReactNode> = {
  danger: <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />,
  warn:   <AlertCircle   className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />,
  ok:     <CheckCircle   className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />,
};

// Step 1 — Market Pulse
function StepMarket({
  marketData, recommendation, loading, strategyTargets, onApply, onNext,
  aiPulse, aiPulseLoading, aiPulseError, onGetAIPulse,
  previewOrders, previewSummary, previewLoading, previewError,
  previewStaging, previewStaged, onStagePreview,
}: {
  marketData: MarketData | null;
  recommendation: Recommendation | null;
  loading: boolean;
  strategyTargets: StrategyTargets;
  onApply: () => void;
  onNext: (status: StepStatus) => void;
  aiPulse: AIPulse | null;
  aiPulseLoading: boolean;
  aiPulseError: string | null;
  onGetAIPulse: () => void;
  previewOrders: PreviewOrder[];
  previewSummary: string;
  previewLoading: boolean;
  previewError: string | null;
  previewStaging: boolean;
  previewStaged: boolean;
  onStagePreview: () => void;
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

  const topAlerts = aiPulse?.alerts
    .sort((a, b) => {
      const order = { danger: 0, warn: 1, ok: 2 };
      return order[a.level] - order[b.level];
    })
    .slice(0, 4) ?? [];

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
          <p className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">Market Signal</p>
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

      {/* AI Daily Pulse */}
      {!aiPulse && !aiPulseLoading && (
        <button
          onClick={onGetAIPulse}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 text-sm font-medium transition-colors"
        >
          <Zap className="w-4 h-4" />
          Get AI Daily Pulse
        </button>
      )}

      {aiPulseLoading && (
        <div className="flex items-center justify-center gap-2 py-3 text-violet-300 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Analysing portfolio…
        </div>
      )}

      {aiPulseError && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          {aiPulseError}
        </div>
      )}

      {aiPulse && (
        <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-violet-400 flex-shrink-0" />
            <p className="text-xs font-semibold text-violet-300 uppercase tracking-wide">AI Daily Pulse</p>
          </div>
          <p className="text-sm text-violet-100 leading-relaxed">{aiPulse.summary}</p>
          {topAlerts.length > 0 && (
            <div className="space-y-1.5">
              {topAlerts.map((alert, i) => (
                <div key={i} className={`flex items-start gap-2 border rounded-lg px-2.5 py-2 text-xs ${ALERT_STYLE[alert.level]}`}>
                  {ALERT_ICON[alert.level]}
                  <div><span className="font-semibold">{alert.rule}:</span> {alert.detail}</div>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={onGetAIPulse}
            className="flex items-center gap-1 text-[11px] text-violet-400/60 hover:text-violet-300 transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {hasChanges && previewOrders.length === 0 && !previewStaged && (
          <button
            onClick={onApply}
            disabled={previewLoading}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {previewLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Building trade preview…
              </>
            ) : (
              'Apply & Preview Trades'
            )}
          </button>
        )}
        <button
          onClick={() => onNext(status)}
          className={`flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-lg transition-colors ${(hasChanges && previewOrders.length === 0 && !previewStaged) ? 'px-4 text-[#7c82a0] hover:text-white hover:bg-white/5' : 'flex-1 bg-[#1a1d27] hover:bg-[#2d3248] text-white border border-[#2d3248]'}`}
        >
          {(hasChanges && previewOrders.length === 0 && !previewStaged) ? 'Skip' : previewStaged ? 'Continue' : 'Looks Good'} <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Apply preview — proposed trades from rebalance-plan with preview:true */}
      {previewError && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
          {previewError}
        </div>
      )}

      {previewOrders.length > 0 && !previewStaged && (
        <div className="bg-blue-500/5 border border-blue-500/25 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-400 flex-shrink-0" />
            <p className="text-xs font-semibold text-blue-300 uppercase tracking-wide">
              Proposed Trades · {previewOrders.length}
            </p>
          </div>
          {previewSummary && (
            <p className="text-xs text-blue-100/80 leading-relaxed">{previewSummary}</p>
          )}
          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {previewOrders.map((o, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-[#0f1117] border border-[#2d3248] rounded-lg px-2.5 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`font-bold ${o.instruction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {o.instruction}
                  </span>
                  <span className="font-semibold text-white tabular-nums">{o.shares}</span>
                  <span className="font-semibold text-white truncate">{o.symbol}</span>
                  <span className="text-[10px] text-[#4a5070] uppercase">{o.pillar}</span>
                </div>
                <span className="text-white/80 tabular-nums flex-shrink-0">
                  {fmt$(o.estimatedValue)}
                </span>
              </div>
            ))}
          </div>
          <button
            onClick={onStagePreview}
            disabled={previewStaging}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
          >
            {previewStaging ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Staging…
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Stage to Trade Inbox
              </>
            )}
          </button>
        </div>
      )}

      {previewStaged && (
        <div className="bg-emerald-500/5 border border-emerald-500/25 rounded-xl p-3 flex items-start gap-2">
          <Inbox className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-emerald-200 leading-relaxed">
            <span className="font-semibold">Staged.</span> {previewOrders.length} order{previewOrders.length === 1 ? '' : 's'} are waiting in your Trade Inbox for one-click approval.
          </div>
        </div>
      )}
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
  isOpen, onClose, account, strategyTargets, pendingOrderCount, dividendsAnnual = 0,
}: DailyReviewWizardProps) {
  const [step, setStep] = useState(1);
  const [statuses, setStatuses] = useState<Record<number, StepStatus>>({});
  const [marketData, setMarketData]       = useState<MarketData | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);

  const [aiPulse,        setAiPulse]        = useState<AIPulse | null>(null);
  const [aiPulseLoading, setAiPulseLoading] = useState(false);
  const [aiPulseError,   setAiPulseError]   = useState<string | null>(null);

  // Apply-and-preview flow state — populated when user clicks "Apply & Preview"
  // on Step 1. Orders are returned by /api/rebalance-plan with preview:true and
  // are NOT yet staged to the inbox; staging happens when user clicks
  // "Stage to Trade Inbox", which POSTs to /api/inbox.
  const [previewOrders,  setPreviewOrders]  = useState<PreviewOrder[]>([]);
  const [previewSummary, setPreviewSummary] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError,   setPreviewError]   = useState<string | null>(null);
  const [previewStaging, setPreviewStaging] = useState(false);
  const [previewStaged,  setPreviewStaged]  = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setStatuses({});
      setMarketData(null);
      setRecommendation(null);
      setAiPulse(null);
      setAiPulseError(null);
      setPreviewOrders([]);
      setPreviewSummary('');
      setPreviewError(null);
      setPreviewStaged(false);
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

  const handleGetAIPulse = useCallback(async () => {
    setAiPulseLoading(true);
    setAiPulseError(null);
    setAiPulse(null);

    const snapshot = {
      total_value:            account.totalValue,
      equity:                 account.equity,
      margin_balance:         account.marginBalance,
      margin_utilization_pct: account.totalValue > 0
        ? (Math.abs(account.marginBalance) / account.totalValue) * 100 : 0,
      dividends_annual: dividendsAnnual,
      pillar_summary: account.pillarSummary.map((p) => ({
        pillar:        p.pillar,
        label:         p.label,
        total_value:   p.totalValue,
        portfolio_pct: p.portfolioPercent,
        position_count: p.positionCount,
      })),
      positions: account.positions.map((p) => ({
        symbol:           p.instrument?.symbol ?? 'UNKNOWN',
        pillar:           p.pillar,
        market_value:     p.marketValue,
        shares:           p.longQuantity,
        avg_cost:         p.averagePrice,
        day_pct:          p.currentDayProfitLossPercentage,
        unrealized_gl:    p.longOpenProfitLoss,
        pct_of_portfolio: account.totalValue > 0
          ? +((p.marketValue / account.totalValue) * 100).toFixed(2) : 0,
      })),
    };

    try {
      const res = await fetch('/api/ai-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'daily_pulse', portfolio: snapshot }),
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

      const rawText = accumulated.replace('__DONE__', '').trim();
      const xmlMatch   = rawText.match(/<json>([\s\S]*?)<\/json>/i);
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate  = xmlMatch ? xmlMatch[1].trim()
        : fenceMatch ? fenceMatch[1].trim()
        : rawText.slice(rawText.indexOf('{'), rawText.lastIndexOf('}') + 1);

      const parsed = JSON.parse(candidate);
      setAiPulse({ summary: parsed.summary ?? '', alerts: parsed.alerts ?? [] });
    } catch (e) {
      setAiPulseError(e instanceof Error ? e.message : 'AI analysis failed — try again.');
    } finally {
      setAiPulseLoading(false);
    }
  }, [account, dividendsAnnual]);

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

  /**
   * Apply Daily Pulse recommendation, then immediately fetch a rebalance
   * preview against the NEW targets. Orders are rendered inline; they only
   * stage to the inbox when the user clicks "Stage to Trade Inbox".
   */
  async function handleApplyAndPreview() {
    if (!recommendation?.suggestedChanges) return;
    const newTargets: StrategyTargets = {
      ...strategyTargets,
      triplesPct:     recommendation.suggestedChanges.triplesPct     ?? strategyTargets.triplesPct,
      cornerstonePct: recommendation.suggestedChanges.cornerstonePct ?? strategyTargets.cornerstonePct,
      incomePct:      recommendation.suggestedChanges.incomePct      ?? strategyTargets.incomePct,
      hedgePct:       recommendation.suggestedChanges.hedgePct       ?? strategyTargets.hedgePct,
    };
    updateStrategyTargets(newTargets);

    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewOrders([]);
    setPreviewSummary('');
    setPreviewStaged(false);

    try {
      const res = await fetch('/api/rebalance-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalValue:    account.totalValue,
          equity:        account.equity,
          positions:     account.positions,
          pillarSummary: account.pillarSummary,
          targets:       newTargets,
          preview:       true,
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

      const resultMatch = accumulated.match(/__RESULT__([\s\S]*?)\n__DONE__/);
      if (!resultMatch) throw new Error('No result in response stream');
      const parsed = JSON.parse(resultMatch[1].trim()) as {
        orders?:  PreviewOrder[];
        summary?: string;
        paused?:  boolean;
        error?:   string;
      };
      if (parsed.error)  throw new Error(parsed.error);
      if (parsed.paused) throw new Error('Automation paused — re-enable to generate trades');

      setPreviewOrders(parsed.orders ?? []);
      setPreviewSummary(parsed.summary ?? '');
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to generate preview');
    } finally {
      setPreviewLoading(false);
    }
  }

  /** Stage the previewed orders into the Trade Inbox via POST /api/inbox. */
  async function handleStagePreview() {
    if (previewOrders.length === 0) return;
    setPreviewStaging(true);
    setPreviewError(null);
    try {
      const items = previewOrders.map((o) => ({
        source:      'rebalance' as const,
        symbol:      o.symbol,
        instruction: o.instruction,
        quantity:    o.shares,
        orderType:   'MARKET' as const,
        price:       o.currentPrice,
        pillar:      o.pillar,
        rationale:   o.rationale,
        aiMode:      'rebalance_plan',
      }));
      const res = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreviewStaged(true);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to stage to inbox');
    } finally {
      setPreviewStaging(false);
    }
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
              onApply={handleApplyAndPreview}
              onNext={advance}
              aiPulse={aiPulse}
              aiPulseLoading={aiPulseLoading}
              aiPulseError={aiPulseError}
              onGetAIPulse={handleGetAIPulse}
              previewOrders={previewOrders}
              previewSummary={previewSummary}
              previewLoading={previewLoading}
              previewError={previewError}
              previewStaging={previewStaging}
              previewStaged={previewStaged}
              onStagePreview={handleStagePreview}
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
