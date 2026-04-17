'use client';

/**
 * Phase 7 — AI-Powered Portfolio Analysis + Trade Execution
 *
 * Analysis modes: Daily Pulse, Trade Plan, Rule Audit, What to Sell, Ask Anything
 * Trade execution: select AI recommendations → review modal → batch place via Schwab API
 */

import { useState, useCallback } from 'react';
import {
  Brain, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, AlertCircle,
  Zap, BarChart2, Shield, TrendingDown, MessageCircle, Loader2, RefreshCw,
  Copy, Check, ShoppingCart, X, Send,
} from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import { PutChainInline } from '@/components/PutChainInline';
import { forwardAnnualDividends, estimateAnnualDividend } from '@/lib/dividends/forward';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Alert {
  level: 'danger' | 'warn' | 'ok';
  rule: string;
  detail: string;
}

interface Recommendation {
  action: 'BUY' | 'SELL' | 'TRIM' | 'HOLD' | 'ROLL' | 'BOX' | 'CLOSE';
  ticker: string;
  rationale: string;
  urgency: 'immediate' | 'this_week' | 'monitor';
  size_hint?: string;
  dollar_amount?: number | null;
  sell_pct?: number | null;
  sell_shares?: number | null;
}

interface IncomeSnapshot {
  estimated_monthly_income: number | null;
  fire_progress_pct: number | null;
  margin_utilization_pct: number | null;
  margin_status: 'safe' | 'warn' | 'danger' | null;
}

interface PillarCompliance {
  triples_pct: number;        triples_target_pct: number;    triples_status: 'ok' | 'under' | 'over';
  cornerstone_pct: number;    cornerstone_target_pct: number; cornerstone_status: 'ok' | 'under' | 'over';
  income_pct: number;         income_target_pct: number;      income_status: 'ok' | 'under' | 'over';
}

interface AIAnalysis {
  mode: string;
  summary: string;
  alerts: Alert[];
  recommendations: Recommendation[];
  income_snapshot: IncomeSnapshot;
  pillar_compliance: PillarCompliance;
  raw_reasoning?: string;
  raw?: string;
  parse_error?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

// An editable row in the order review modal
interface OrderRow {
  recIdx:      number;
  ticker:      string;
  instruction: 'BUY' | 'SELL';
  shares:      number;       // editable
  orderType:   'MARKET' | 'LIMIT';
  limitPrice?: number;
  rationale:   string;
  size_hint:   string;
  aiMode:      string;
}

interface OrderResult {
  symbol:   string;
  orderId:  string | null;
  status:   'placed' | 'error';
  message?: string;
}

type AnalysisMode = 'daily_pulse' | 'trade_plan' | 'rule_audit' | 'what_to_sell' | 'open_question';

interface PillarSummary {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

interface AIAnalysisPanelProps {
  positions: EnrichedPosition[];
  totalValue: number;
  equity: number;
  marginBalance: number;
  pillarSummary: PillarSummary[];
  dividendsAnnual?: number;
  accountHash?: string;   // needed to place orders — passed from dashboard
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MODES = [
  { id: 'daily_pulse'   as AnalysisMode, label: 'Daily Pulse',  icon: <Zap       className="w-4 h-4" />, description: 'Quick compliance snapshot + top alerts',              fast: true  },
  { id: 'trade_plan'    as AnalysisMode, label: 'Trade Plan',   icon: <BarChart2  className="w-4 h-4" />, description: 'Full buy/sell/trim plan with 1/3 rule applied'                },
  { id: 'rule_audit'    as AnalysisMode, label: 'Rule Audit',   icon: <Shield     className="w-4 h-4" />, description: 'Compliance check against every Triple C rule'               },
  { id: 'what_to_sell'  as AnalysisMode, label: 'What to Sell', icon: <TrendingDown className="w-4 h-4" />, description: 'Margin relief via pressure valve hierarchy',         fast: true  },
  { id: 'open_question' as AnalysisMode, label: 'Ask Anything', icon: <MessageCircle className="w-4 h-4" />, description: 'Free-form question answered against the rules'             },
];

// Actions that can be turned into real Schwab orders
const EXECUTABLE_ACTIONS = new Set(['BUY', 'SELL', 'TRIM']);

const ACTION_COLORS: Record<string, string> = {
  BUY:   'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  SELL:  'bg-red-500/20    text-red-300    border-red-500/30',
  TRIM:  'bg-orange-500/20 text-orange-300 border-orange-500/30',
  HOLD:  'bg-blue-500/20   text-blue-300   border-blue-500/30',
  ROLL:  'bg-purple-500/20 text-purple-300 border-purple-500/30',
  BOX:   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  CLOSE: 'bg-pink-500/20   text-pink-300   border-pink-500/30',
};

const URGENCY_COLORS: Record<string, string> = {
  immediate: 'text-red-400',
  this_week: 'text-orange-400',
  monitor:   'text-[#7c82a0]',
};

const ALERT_ICON: Record<string, React.ReactNode> = {
  danger: <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />,
  warn:   <AlertCircle   className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />,
  ok:     <CheckCircle   className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />,
};

const ALERT_STYLE: Record<string, string> = {
  danger: 'bg-red-500/10 border-red-500/25 text-red-300',
  warn:   'bg-orange-500/10 border-orange-500/25 text-orange-300',
  ok:     'bg-emerald-500/10 border-emerald-500/25 text-emerald-300',
};

const STATUS_COLORS: Record<string, string> = {
  ok: 'text-emerald-400', under: 'text-orange-400', over: 'text-red-400',
};

const MARGIN_COLORS: Record<string, string> = {
  safe: 'text-emerald-400', warn: 'text-orange-400', danger: 'text-red-400',
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Clamp a recommendation's numeric fields to sane bounds */
function sanitizeRec(rec: Recommendation): Recommendation {
  return {
    ...rec,
    sell_pct:      rec.sell_pct      != null ? Math.min(100, Math.max(0, rec.sell_pct))          : null,
    dollar_amount: rec.dollar_amount != null ? Math.max(0, rec.dollar_amount)                    : null,
    sell_shares:   rec.sell_shares   != null ? Math.max(0, Math.floor(rec.sell_shares))           : null,
  };
}

/** Estimate shares from a recommendation + live positions */
function estimateShares(rec: Recommendation, positions: EnrichedPosition[]): number {
  const safe = sanitizeRec(rec);
  const pos = positions.find(
    (p) => p.instrument?.symbol?.toUpperCase() === safe.ticker.toUpperCase()
  );
  const maxShares = pos ? (pos.longQuantity || pos.shortQuantity || 999_999) : 999_999;

  if (safe.action === 'BUY' && safe.dollar_amount && safe.dollar_amount > 0) {
    const price = pos ? (pos.marketValue / (pos.longQuantity || 1)) : 1;
    if (price <= 0) return 1;
    return Math.min(999_999, Math.max(1, Math.floor(safe.dollar_amount / price)));
  }

  if ((safe.action === 'SELL' || safe.action === 'TRIM') && pos) {
    if (safe.sell_shares && safe.sell_shares > 0)
      return Math.min(safe.sell_shares, maxShares);
    if (safe.sell_pct && safe.sell_pct > 0)
      return Math.min(maxShares, Math.max(1, Math.floor((safe.sell_pct / 100) * pos.longQuantity)));
    return pos.longQuantity; // default: sell all
  }

  return 1;
}

// ─── Pillar Bar ─────────────────────────────────────────────────────────────────

function PillarBar({ label, actual, target, status }: {
  label: string; actual: number; target: number; status: 'ok' | 'under' | 'over';
}) {
  const color = status === 'ok' ? 'bg-emerald-500' : status === 'over' ? 'bg-red-500' : 'bg-orange-500';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[#7c82a0]">{label}</span>
        <span className={STATUS_COLORS[status]}>
          {actual.toFixed(1)}% <span className="text-[#4a5070]">/ {target}% target</span>
        </span>
      </div>
      <div className="relative h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(actual, 100)}%` }} />
        <div className="absolute top-0 h-full w-0.5 bg-white/30" style={{ left: `${Math.min(target, 100)}%` }} />
      </div>
    </div>
  );
}

// ─── Order Review Modal ─────────────────────────────────────────────────────────

function OrderReviewModal({
  rows,
  onChangeShares,
  onRemove,
  onConfirm,
  onClose,
  placing,
  results,
}: {
  rows: OrderRow[];
  onChangeShares: (idx: number, shares: number) => void;
  onRemove: (idx: number) => void;
  onConfirm: () => void;
  onClose: () => void;
  placing: boolean;
  results: OrderResult[];
}) {
  const allDone = results.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="bg-[#1a1d27] border border-[#2d3248] rounded-2xl w-full max-w-xl shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2d3248]">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-violet-400" />
            <span className="font-semibold text-white">
              {allDone ? 'Order Results' : `Review ${rows.length} Order${rows.length !== 1 ? 's' : ''}`}
            </span>
          </div>
          <button onClick={onClose} className="text-[#7c82a0] hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {/* Results view */}
          {allDone ? (
            results.map((r, i) => (
              <div key={i} className={`flex items-center gap-3 p-3 rounded-lg border text-sm ${
                r.status === 'placed'
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                  : 'bg-red-500/10 border-red-500/25 text-red-300'
              }`}>
                {r.status === 'placed'
                  ? <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                <div>
                  <span className="font-semibold">{r.symbol}</span>
                  {r.status === 'placed'
                    ? <span className="ml-2 text-xs opacity-70">Order #{r.orderId}</span>
                    : <span className="ml-2 text-xs opacity-70">{r.message}</span>}
                </div>
              </div>
            ))
          ) : (
            /* Review rows */
            rows.map((row, i) => (
              <div key={i} className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded border ${ACTION_COLORS[row.instruction]}`}>
                    {row.instruction}
                  </span>
                  <span className="font-semibold text-white">{row.ticker}</span>
                  <span className="text-xs text-[#7c82a0] ml-auto">{row.orderType}</span>
                  <button onClick={() => onRemove(i)} className="text-[#4a5070] hover:text-red-400 transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <label className="text-xs text-[#7c82a0] whitespace-nowrap">Shares:</label>
                  <input
                    type="number"
                    min={1}
                    value={row.shares}
                    onChange={(e) => onChangeShares(i, Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-24 bg-[#1a1d27] border border-[#2d3248] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-violet-500/50"
                  />
                  <span className="text-xs text-[#4a5070]">{row.size_hint}</span>
                </div>

                <p className="text-xs text-[#7c82a0]">{row.rationale}</p>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-[#2d3248]">
          {allDone ? (
            <button onClick={onClose} className="ml-auto bg-[#2d3248] hover:bg-[#3d4268] text-white px-5 py-2 rounded-lg text-sm transition-colors">
              Close
            </button>
          ) : (
            <>
              <div className="text-xs text-[#4a5070]">
                Orders placed as MARKET DAY orders via Schwab
              </div>
              <button
                onClick={onConfirm}
                disabled={placing || rows.length === 0}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {placing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {placing ? 'Placing…' : `Place ${rows.length} Order${rows.length !== 1 ? 's' : ''}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────────

export function AIAnalysisPanel({
  positions,
  totalValue,
  equity,
  marginBalance,
  pillarSummary,
  dividendsAnnual = 0,
  accountHash = '',
}: AIAnalysisPanelProps) {
  const [open,          setOpen]          = useState(false);
  const [mode,          setMode]          = useState<AnalysisMode>('daily_pulse');
  const [question,      setQuestion]      = useState('');
  const [loading,       setLoading]       = useState(false);
  const [analysis,      setAnalysis]      = useState<AIAnalysis | null>(null);
  const [error,         setError]         = useState<string | null>(null);
  const [copied,        setCopied]        = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  // Order flow state
  const [selectedRecs,  setSelectedRecs]  = useState<Set<number>>(new Set());
  const [showModal,     setShowModal]     = useState(false);
  const [orderRows,     setOrderRows]     = useState<OrderRow[]>([]);
  const [placing,       setPlacing]       = useState(false);
  const [orderResults,  setOrderResults]  = useState<OrderResult[]>([]);

  // ── Analysis ────────────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async () => {
    if (mode === 'open_question' && !question.trim()) return;

    setLoading(true);
    setError(null);
    setAnalysis(null);
    setSelectedRecs(new Set());

    const snapshot = {
      total_value: totalValue,
      equity,
      margin_balance: marginBalance,
      margin_utilization_pct: totalValue > 0 ? (marginBalance / totalValue) * 100 : 0,
      // FORWARD-projected annual dividend income based on CURRENT holdings × their
      // per-share annual distribution. This is what should be compared against the
      // FIRE target — it reflects the income the portfolio will generate going forward,
      // not what was paid during a (potentially very different) prior 12 months.
      dividends_annual_forward: forwardAnnualDividends(positions),
      // TRAILING 12-month realized dividends (from Schwab transaction history).
      // Provided for context only — do NOT use for FIRE gap calculation.
      dividends_annual_trailing: dividendsAnnual,
      // Legacy alias kept for backward compatibility. Set to the FORWARD figure
      // so older prompt paths also use the correct value.
      dividends_annual: forwardAnnualDividends(positions),
      pillar_summary: pillarSummary.map((p) => ({
        pillar: p.pillar,
        label: p.label,
        total_value: p.totalValue,
        portfolio_pct: p.portfolioPercent,
        position_count: p.positionCount,
      })),
      positions: positions.map((p) => ({
        symbol: p.instrument?.symbol ?? p.instrument?.assetType ?? 'UNKNOWN',
        pillar: p.pillar,
        market_value: p.marketValue,
        shares: p.longQuantity,
        avg_cost: p.averagePrice,
        day_pct: p.currentDayProfitLossPercentage,
        unrealized_gl: p.longOpenProfitLoss,
        pct_of_portfolio: totalValue > 0 ? +((p.marketValue / totalValue) * 100).toFixed(2) : 0,
        // Per-position forward annual dividend estimate — lets the AI see which
        // holdings drive projected income and identify gaps.
        forward_annual_dividend: +estimateAnnualDividend(p).toFixed(2),
      })),
    };

    // Client-side timeout: abort after 90 seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000);

    try {
      const res = await fetch('/api/ai-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode, portfolio: snapshot,
          question: mode === 'open_question' ? question : undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          const d = await res.json();
          throw new Error(d.error ?? `HTTP ${res.status}`);
        }
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200).trim()}`);
      }

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

      if (rawText.startsWith('{"error"')) {
        const e = JSON.parse(rawText) as { error: string };
        throw new Error(e.error);
      }

      const candidate = (() => {
        const xml   = rawText.match(/<json>([\s\S]*?)<\/json>/i);
        if (xml)   return xml[1].trim();
        const fence = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) return fence[1].trim();
        const f = rawText.indexOf('{'), l = rawText.lastIndexOf('}');
        if (f !== -1 && l > f) return rawText.slice(f, l + 1);
        return rawText;
      })();

      let data: AIAnalysis;
      try { data = JSON.parse(candidate) as AIAnalysis; }
      catch { throw new Error(`Could not parse AI response.\n\nRaw:\n${rawText.slice(0, 400)}`); }

      setAnalysis(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setError('Analysis timed out after 90 seconds. Try again or use a simpler query.');
      } else {
        setError(e instanceof Error ? e.message : 'Analysis failed — try again.');
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, [mode, question, positions, totalValue, equity, marginBalance, pillarSummary, dividendsAnnual]);

  // ── Order flow ──────────────────────────────────────────────────────────────

  const toggleRec = useCallback((idx: number) => {
    setSelectedRecs((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }, []);

  const openOrderModal = useCallback(() => {
    if (!analysis) return;
    const rows: OrderRow[] = [...selectedRecs]
      .sort((a, b) => a - b)
      .map((idx) => {
        const rec = analysis.recommendations[idx];
        const instruction: 'BUY' | 'SELL' =
          rec.action === 'BUY' ? 'BUY' : 'SELL';
        return {
          recIdx:      idx,
          ticker:      rec.ticker,
          instruction,
          shares:      estimateShares(rec, positions),
          orderType:   'MARKET',
          rationale:   rec.rationale,
          size_hint:   rec.size_hint ?? '',
          aiMode:      analysis.mode,
        };
      });
    setOrderRows(rows);
    setOrderResults([]);
    setShowModal(true);
  }, [analysis, selectedRecs, positions]);

  const placeOrders = useCallback(async () => {
    if (!accountHash) return;
    setPlacing(true);

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountHash,
          orders: orderRows.map((r) => ({
            symbol:      r.ticker,
            instruction: r.instruction,
            quantity:    r.shares,
            orderType:   r.orderType,
            rationale:   r.rationale,
            aiMode:      r.aiMode,
          })),
        }),
      });
      const data = await res.json() as { results: OrderResult[] };
      setOrderResults(data.results ?? []);
    } catch (e) {
      setOrderResults([{ symbol: 'ALL', orderId: null, status: 'error', message: String(e) }]);
    } finally {
      setPlacing(false);
    }
  }, [accountHash, orderRows]);

  const copyJSON = useCallback(() => {
    if (!analysis) return;
    navigator.clipboard.writeText(JSON.stringify(analysis, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [analysis]);

  const executableSelected = analysis
    ? [...selectedRecs].filter((i) => EXECUTABLE_ACTIONS.has(analysis.recommendations[i]?.action)).length
    : 0;

  const selectedMode = MODES.find((m) => m.id === mode)!;

  return (
    <>
      {/* Order review modal */}
      {showModal && (
        <OrderReviewModal
          rows={orderRows}
          onChangeShares={(i, s) => setOrderRows((prev) => prev.map((r, ri) => ri === i ? { ...r, shares: s } : r))}
          onRemove={(i) => setOrderRows((prev) => prev.filter((_, ri) => ri !== i))}
          onConfirm={placeOrders}
          onClose={() => { setShowModal(false); setOrderResults([]); }}
          placing={placing}
          results={orderResults}
        />
      )}

      <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <Brain className="w-5 h-5 text-violet-400" />
            <span className="font-semibold text-white text-sm">AI Portfolio Analysis</span>
            <span className="text-xs text-[#4a5070] bg-[#2d3248] px-2 py-0.5 rounded-full">Phase 7</span>
          </div>
          {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
        </button>

        {open && (
          <div className="px-5 pb-5 space-y-5 border-t border-[#2d3248] pt-5">
            {/* Mode selector */}
            <div>
              <p className="text-xs text-[#7c82a0] mb-2">Analysis Mode</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { setMode(m.id); setAnalysis(null); setError(null); setSelectedRecs(new Set()); }}
                    className={`flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all ${
                      mode === m.id
                        ? 'border-violet-500/60 bg-violet-500/10 text-white'
                        : 'border-[#2d3248] text-[#7c82a0] hover:border-[#4a5070] hover:text-white'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {m.icon}
                      <span className="text-xs font-medium">{m.label}</span>
                      {m.fast && <span className="text-[10px] text-violet-400/70 bg-violet-500/10 px-1 rounded">fast</span>}
                    </div>
                    <span className="text-[10px] text-[#4a5070] leading-tight">{m.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Question input */}
            {mode === 'open_question' && (
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Should I add more TQQQ or wait for a pullback? My margin is at 35%."
                rows={3}
                className="w-full bg-[#0f1117] border border-[#2d3248] rounded-lg px-4 py-3 text-sm text-white placeholder-[#4a5070] focus:outline-none focus:border-violet-500/50 resize-none"
              />
            )}

            {/* Run + status row */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={runAnalysis}
                disabled={loading || (mode === 'open_question' && !question.trim())}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
                {loading ? 'Analyzing…' : `Run ${selectedMode.label}`}
              </button>

              {analysis && !loading && (
                <button onClick={runAnalysis} className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors">
                  <RefreshCw className="w-3.5 h-3.5" /> Refresh
                </button>
              )}

              {/* Batch trade button — shown when executable recs are selected */}
              {executableSelected > 0 && accountHash && (
                <button
                  onClick={openOrderModal}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors ml-auto"
                >
                  <ShoppingCart className="w-4 h-4" />
                  Review {executableSelected} Trade{executableSelected !== 1 ? 's' : ''}
                </button>
              )}

              {analysis?.model && (
                <span className="text-xs text-[#4a5070]">
                  {analysis.model.includes('haiku') ? '⚡ Haiku' : '🧠 Sonnet'}
                  {analysis.usage && <> · {(analysis.usage.input_tokens + analysis.usage.output_tokens).toLocaleString()} tokens</>}
                </span>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-4 text-sm text-red-300">
                <AlertTriangle className="w-4 h-4 inline mr-2" />
                {error}
              </div>
            )}

            {/* Parse error fallback */}
            {analysis?.parse_error && (
              <div className="space-y-2">
                <div className="bg-orange-500/10 border border-orange-500/25 rounded-lg p-3 text-xs text-orange-300">{analysis.parse_error}</div>
                <pre className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-4 text-xs text-[#7c82a0] overflow-auto max-h-64">{analysis.raw}</pre>
              </div>
            )}

            {/* Results */}
            {analysis && !analysis.parse_error && (
              <div className="space-y-5">
                {/* Summary */}
                {analysis.summary && (
                  <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-4">
                    <p className="text-sm text-violet-200 leading-relaxed">{analysis.summary}</p>
                  </div>
                )}

                {/* Pillar Compliance */}
                {analysis.pillar_compliance && (
                  <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-4 space-y-3">
                    <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">Pillar Allocation</h3>
                    <PillarBar label="Triples (3× ETFs)"    actual={analysis.pillar_compliance.triples_pct}     target={analysis.pillar_compliance.triples_target_pct}     status={analysis.pillar_compliance.triples_status} />
                    <PillarBar label="Cornerstone (CLM/CRF)" actual={analysis.pillar_compliance.cornerstone_pct} target={analysis.pillar_compliance.cornerstone_target_pct} status={analysis.pillar_compliance.cornerstone_status} />
                    <PillarBar label="Core / Income"         actual={analysis.pillar_compliance.income_pct}      target={analysis.pillar_compliance.income_target_pct}      status={analysis.pillar_compliance.income_status} />
                  </div>
                )}

                {/* Income Snapshot */}
                {analysis.income_snapshot && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {analysis.income_snapshot.estimated_monthly_income != null && (
                      <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                        <div className="text-[10px] text-[#7c82a0] mb-1">Monthly Income Est.</div>
                        <div className="text-sm font-bold text-emerald-400">${analysis.income_snapshot.estimated_monthly_income.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                      </div>
                    )}
                    {analysis.income_snapshot.fire_progress_pct != null && (
                      <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                        <div className="text-[10px] text-[#7c82a0] mb-1">FIRE Progress</div>
                        <div className="text-sm font-bold text-violet-400">{analysis.income_snapshot.fire_progress_pct.toFixed(0)}%</div>
                      </div>
                    )}
                    {analysis.income_snapshot.margin_utilization_pct != null && (
                      <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                        <div className="text-[10px] text-[#7c82a0] mb-1">Margin Used</div>
                        <div className={`text-sm font-bold ${analysis.income_snapshot.margin_status ? MARGIN_COLORS[analysis.income_snapshot.margin_status] : 'text-white'}`}>
                          {analysis.income_snapshot.margin_utilization_pct.toFixed(1)}%
                        </div>
                      </div>
                    )}
                    {analysis.income_snapshot.margin_status && (
                      <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                        <div className="text-[10px] text-[#7c82a0] mb-1">Margin Status</div>
                        <div className={`text-sm font-bold capitalize ${MARGIN_COLORS[analysis.income_snapshot.margin_status]}`}>
                          {analysis.income_snapshot.margin_status}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Alerts */}
                {analysis.alerts?.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">Alerts ({analysis.alerts.length})</h3>
                    {analysis.alerts.map((alert, i) => (
                      <div key={i} className={`flex items-start gap-2.5 border rounded-lg px-3 py-2.5 text-sm ${ALERT_STYLE[alert.level]}`}>
                        {ALERT_ICON[alert.level]}
                        <div><span className="font-semibold">{alert.rule}: </span><span className="opacity-90">{alert.detail}</span></div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Recommendations */}
                {analysis.recommendations?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">
                        Recommendations ({analysis.recommendations.length})
                      </h3>
                      {accountHash && (
                        <span className="text-[10px] text-[#4a5070]">
                          Check BUY/SELL/TRIM rows to queue trades
                        </span>
                      )}
                    </div>

                    {analysis.recommendations.map((rec, i) => {
                      const isExecutable = EXECUTABLE_ACTIONS.has(rec.action);
                      const isSelected   = selectedRecs.has(i);

                      return (
                        <div
                          key={i}
                          className={`bg-[#0f1117] border rounded-lg p-3 space-y-2 transition-colors ${
                            isSelected ? 'border-emerald-500/40' : 'border-[#2d3248]'
                          }`}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            {/* Checkbox for executable actions */}
                            {isExecutable && accountHash && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleRec(i)}
                                className="w-4 h-4 accent-emerald-500 cursor-pointer"
                              />
                            )}
                            <span className={`text-xs font-bold px-2 py-0.5 rounded border ${ACTION_COLORS[rec.action] ?? 'bg-[#2d3248] text-white border-[#4a5070]'}`}>
                              {rec.action}
                            </span>
                            <span className="text-sm font-semibold text-white">{rec.ticker}</span>
                            <span className={`text-xs capitalize ml-auto ${URGENCY_COLORS[rec.urgency] ?? 'text-[#7c82a0]'}`}>
                              {rec.urgency === 'immediate' ? '🔴' : rec.urgency === 'this_week' ? '🟡' : '🔵'}{' '}
                              {rec.urgency.replace('_', ' ')}
                            </span>
                          </div>

                          {rec.size_hint && (
                            <div className="text-xs text-violet-300 bg-violet-500/10 px-2 py-1 rounded">
                              Size: {rec.size_hint}
                              {rec.dollar_amount && <span className="text-[#7c82a0] ml-2">(${rec.dollar_amount.toLocaleString()})</span>}
                              {rec.sell_pct      && <span className="text-[#7c82a0] ml-2">({rec.sell_pct}% of position)</span>}
                            </div>
                          )}

                          <p className="text-xs text-[#7c82a0] leading-relaxed">{rec.rationale}</p>

                          {/* Inline put chain — shown when rec involves put selling */}
                          {(rec.action === 'SELL' || rec.action === 'BUY') &&
                            rec.rationale?.toLowerCase().includes('put') && (
                              <PutChainInline ticker={rec.ticker} />
                            )}
                        </div>
                      );
                    })}

                    {/* Floating batch trade button below list */}
                    {executableSelected > 0 && accountHash && (
                      <button
                        onClick={openOrderModal}
                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-lg text-sm font-medium transition-colors mt-2"
                      >
                        <ShoppingCart className="w-4 h-4" />
                        Review & Place {executableSelected} Trade{executableSelected !== 1 ? 's' : ''}
                      </button>
                    )}
                  </div>
                )}

                {/* Reasoning */}
                {analysis.raw_reasoning && (
                  <div>
                    <button
                      onClick={() => setShowReasoning((v) => !v)}
                      className="flex items-center gap-1.5 text-xs text-[#4a5070] hover:text-[#7c82a0] transition-colors"
                    >
                      {showReasoning ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {showReasoning ? 'Hide' : 'Show'} reasoning
                    </button>
                    {showReasoning && (
                      <pre className="mt-2 bg-[#0f1117] border border-[#2d3248] rounded-lg p-4 text-xs text-[#7c82a0] overflow-auto max-h-48 whitespace-pre-wrap">
                        {analysis.raw_reasoning}
                      </pre>
                    )}
                  </div>
                )}

                <div className="flex justify-end">
                  <button onClick={copyJSON} className="flex items-center gap-1.5 text-xs text-[#4a5070] hover:text-[#7c82a0] transition-colors">
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied!' : 'Copy JSON'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
