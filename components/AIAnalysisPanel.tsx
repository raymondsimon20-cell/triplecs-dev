'use client';

/**
 * Phase 7 — AI-Powered Portfolio Analysis
 *
 * Provides four analysis modes powered by the Anthropic Claude API:
 *   • Daily Pulse   — quick rule-compliance snapshot
 *   • Trade Plan    — specific buy/sell/trim recommendations
 *   • Rule Audit    — comprehensive Triple C rulebook check
 *   • What to Sell  — margin pressure valve recommendations
 *   • Ask Anything  — free-form question answered against the rules
 */

import { useState, useCallback } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle,
  AlertCircle,
  Zap,
  BarChart2,
  Shield,
  TrendingDown,
  MessageCircle,
  Loader2,
  RefreshCw,
  Copy,
  Check,
} from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';

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
}

interface IncomeSnapshot {
  estimated_monthly_income: number | null;
  fire_progress_pct: number | null;
  margin_utilization_pct: number | null;
  margin_status: 'safe' | 'warn' | 'danger' | null;
}

interface PillarCompliance {
  triples_pct: number;
  triples_target_pct: number;
  triples_status: 'ok' | 'under' | 'over';
  cornerstone_pct: number;
  cornerstone_target_pct: number;
  cornerstone_status: 'ok' | 'under' | 'over';
  income_pct: number;
  income_target_pct: number;
  income_status: 'ok' | 'under' | 'over';
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
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MODES: { id: AnalysisMode; label: string; icon: React.ReactNode; description: string; fast?: boolean }[] = [
  {
    id: 'daily_pulse',
    label: 'Daily Pulse',
    icon: <Zap className="w-4 h-4" />,
    description: 'Quick rule-compliance snapshot + top alerts',
    fast: true,
  },
  {
    id: 'trade_plan',
    label: 'Trade Plan',
    icon: <BarChart2 className="w-4 h-4" />,
    description: 'Specific buy / sell / trim recommendations with rationale',
  },
  {
    id: 'rule_audit',
    label: 'Rule Audit',
    icon: <Shield className="w-4 h-4" />,
    description: 'Full compliance check against every Triple C rule',
  },
  {
    id: 'what_to_sell',
    label: 'What to Sell',
    icon: <TrendingDown className="w-4 h-4" />,
    description: 'Margin relief via the pressure valve hierarchy',
    fast: true,
  },
  {
    id: 'open_question',
    label: 'Ask Anything',
    icon: <MessageCircle className="w-4 h-4" />,
    description: 'Free-form question answered against Triple C rules',
  },
];

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
  immediate:  'text-red-400',
  this_week:  'text-orange-400',
  monitor:    'text-[#7c82a0]',
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
  ok:    'text-emerald-400',
  under: 'text-orange-400',
  over:  'text-red-400',
};

const MARGIN_STATUS_COLORS: Record<string, string> = {
  safe:   'text-emerald-400',
  warn:   'text-orange-400',
  danger: 'text-red-400',
};

// ─── Helper Components ──────────────────────────────────────────────────────────

function PillarBar({
  label,
  actual,
  target,
  status,
}: {
  label: string;
  actual: number;
  target: number;
  status: 'ok' | 'under' | 'over';
}) {
  const barWidth = Math.min(actual, 100);
  const barColor = status === 'ok' ? 'bg-emerald-500' : status === 'over' ? 'bg-red-500' : 'bg-orange-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[#7c82a0]">{label}</span>
        <span className={STATUS_COLORS[status]}>
          {actual.toFixed(1)}% <span className="text-[#4a5070]">/ {target}% target</span>
        </span>
      </div>
      <div className="relative h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${barWidth}%` }}
        />
        {/* Target marker */}
        <div
          className="absolute top-0 h-full w-0.5 bg-white/30"
          style={{ left: `${Math.min(target, 100)}%` }}
        />
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
}: AIAnalysisPanelProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AnalysisMode>('daily_pulse');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  const runAnalysis = useCallback(async () => {
    if (mode === 'open_question' && !question.trim()) return;

    setLoading(true);
    setError(null);
    setAnalysis(null);

    // Build a lean portfolio snapshot — only essential fields to keep the prompt small
    const snapshot = {
      total_value: totalValue,
      equity,
      margin_balance: marginBalance,
      margin_utilization_pct: totalValue > 0 ? (marginBalance / totalValue) * 100 : 0,
      dividends_annual: dividendsAnnual,
      pillar_summary: pillarSummary.map((p) => ({
        pillar: p.pillar,
        label: p.label,
        total_value: p.totalValue,
        portfolio_pct: p.portfolioPercent,
        position_count: p.positionCount,
      })),
      // Trim positions to the fields the AI actually needs
      positions: positions.map((p) => ({
        symbol: p.instrument?.symbol ?? p.instrument?.assetType ?? 'UNKNOWN',
        pillar: p.pillar,
        market_value: p.marketValue,
        shares: p.longQuantity,
        avg_cost: p.averagePrice,
        day_pct: p.currentDayProfitLossPercentage,
        unrealized_gl: p.longOpenProfitLoss,
        pct_of_portfolio: totalValue > 0 ? +((p.marketValue / totalValue) * 100).toFixed(2) : 0,
      })),
    };

    try {
      const res = await fetch('/api/ai-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          portfolio: snapshot,
          question: mode === 'open_question' ? question : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        // Non-streaming error (auth failure, 503, etc.) — may be JSON or HTML
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          const data = await res.json();
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).trim()}`);
      }

      // Read the streamed plain-text response chunk by chunk
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        // Stop consuming once we see the sentinel
        if (accumulated.includes('__DONE__')) break;
      }

      const rawText = accumulated.replace('__DONE__', '').trim();

      // Check if the model returned an error object
      if (rawText.startsWith('{"error"')) {
        const errObj = JSON.parse(rawText) as { error: string };
        throw new Error(errObj.error);
      }

      // Extract and parse JSON from the accumulated text
      const candidate = (() => {
        const xmlMatch = rawText.match(/<json>([\s\S]*?)<\/json>/i);
        if (xmlMatch) return xmlMatch[1].trim();
        const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) return fenceMatch[1].trim();
        const first = rawText.indexOf('{');
        const last  = rawText.lastIndexOf('}');
        if (first !== -1 && last > first) return rawText.slice(first, last + 1);
        return rawText;
      })();

      let data: AIAnalysis;
      try {
        data = JSON.parse(candidate) as AIAnalysis;
      } catch {
        throw new Error(`Could not parse AI response as JSON.\n\nRaw output:\n${rawText.slice(0, 400)}`);
      }

      setAnalysis(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed — try again.');
    } finally {
      setLoading(false);
    }
  }, [mode, question, positions, totalValue, equity, marginBalance, pillarSummary, dividendsAnnual]);

  const copyJSON = useCallback(() => {
    if (!analysis) return;
    navigator.clipboard.writeText(JSON.stringify(analysis, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [analysis]);

  const selectedMode = MODES.find((m) => m.id === mode)!;

  return (
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
                  onClick={() => { setMode(m.id); setAnalysis(null); setError(null); }}
                  className={`flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all ${
                    mode === m.id
                      ? 'border-violet-500/60 bg-violet-500/10 text-white'
                      : 'border-[#2d3248] text-[#7c82a0] hover:border-[#4a5070] hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {m.icon}
                    <span className="text-xs font-medium">{m.label}</span>
                    {m.fast && (
                      <span className="text-[10px] text-violet-400/70 bg-violet-500/10 px-1 rounded">fast</span>
                    )}
                  </div>
                  <span className="text-[10px] text-[#4a5070] leading-tight">{m.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Question input for open_question mode */}
          {mode === 'open_question' && (
            <div>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Should I add more TQQQ here or wait for a pullback? My margin is at 35%."
                rows={3}
                className="w-full bg-[#0f1117] border border-[#2d3248] rounded-lg px-4 py-3 text-sm text-white placeholder-[#4a5070] focus:outline-none focus:border-violet-500/50 resize-none"
              />
            </div>
          )}

          {/* Run button */}
          <div className="flex items-center gap-3">
            <button
              onClick={runAnalysis}
              disabled={loading || (mode === 'open_question' && !question.trim())}
              className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Brain className="w-4 h-4" />
              )}
              {loading ? 'Analyzing…' : `Run ${selectedMode.label}`}
            </button>

            {analysis && (
              <button
                onClick={runAnalysis}
                disabled={loading}
                className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            )}

            {analysis?.model && (
              <span className="text-xs text-[#4a5070]">
                {analysis.model.includes('haiku') ? '⚡ Haiku' : '🧠 Sonnet'}
                {analysis.usage && (
                  <> · {(analysis.usage.input_tokens + analysis.usage.output_tokens).toLocaleString()} tokens</>
                )}
              </span>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-4 text-sm text-red-300">
              <AlertTriangle className="w-4 h-4 inline mr-2" />
              {error}
              {error.includes('ANTHROPIC_API_KEY') && (
                <p className="mt-2 text-xs text-red-400/70">
                  Add <code className="bg-red-900/30 px-1 rounded">ANTHROPIC_API_KEY</code> to your Netlify
                  environment variables (Site settings → Environment variables).
                </p>
              )}
            </div>
          )}

          {/* Raw / parse error fallback */}
          {analysis?.parse_error && (
            <div className="space-y-2">
              <div className="bg-orange-500/10 border border-orange-500/25 rounded-lg p-3 text-xs text-orange-300">
                {analysis.parse_error}
              </div>
              <pre className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-4 text-xs text-[#7c82a0] overflow-auto max-h-64">
                {analysis.raw}
              </pre>
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
                  <PillarBar
                    label="Triples (3× ETFs)"
                    actual={analysis.pillar_compliance.triples_pct}
                    target={analysis.pillar_compliance.triples_target_pct}
                    status={analysis.pillar_compliance.triples_status}
                  />
                  <PillarBar
                    label="Cornerstone (CLM/CRF)"
                    actual={analysis.pillar_compliance.cornerstone_pct}
                    target={analysis.pillar_compliance.cornerstone_target_pct}
                    status={analysis.pillar_compliance.cornerstone_status}
                  />
                  <PillarBar
                    label="Core / Income"
                    actual={analysis.pillar_compliance.income_pct}
                    target={analysis.pillar_compliance.income_target_pct}
                    status={analysis.pillar_compliance.income_status}
                  />
                </div>
              )}

              {/* Income Snapshot */}
              {analysis.income_snapshot && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {analysis.income_snapshot.estimated_monthly_income != null && (
                    <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                      <div className="text-[10px] text-[#7c82a0] mb-1">Monthly Income Est.</div>
                      <div className="text-sm font-bold text-emerald-400">
                        ${analysis.income_snapshot.estimated_monthly_income.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </div>
                    </div>
                  )}
                  {analysis.income_snapshot.fire_progress_pct != null && (
                    <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                      <div className="text-[10px] text-[#7c82a0] mb-1">FIRE Progress</div>
                      <div className="text-sm font-bold text-violet-400">
                        {analysis.income_snapshot.fire_progress_pct.toFixed(0)}%
                      </div>
                    </div>
                  )}
                  {analysis.income_snapshot.margin_utilization_pct != null && (
                    <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                      <div className="text-[10px] text-[#7c82a0] mb-1">Margin Used</div>
                      <div className={`text-sm font-bold ${
                        analysis.income_snapshot.margin_status
                          ? MARGIN_STATUS_COLORS[analysis.income_snapshot.margin_status]
                          : 'text-white'
                      }`}>
                        {analysis.income_snapshot.margin_utilization_pct.toFixed(1)}%
                      </div>
                    </div>
                  )}
                  {analysis.income_snapshot.margin_status && (
                    <div className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3">
                      <div className="text-[10px] text-[#7c82a0] mb-1">Margin Status</div>
                      <div className={`text-sm font-bold capitalize ${MARGIN_STATUS_COLORS[analysis.income_snapshot.margin_status]}`}>
                        {analysis.income_snapshot.margin_status}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Alerts */}
              {analysis.alerts && analysis.alerts.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">
                    Alerts ({analysis.alerts.length})
                  </h3>
                  {analysis.alerts.map((alert, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2.5 border rounded-lg px-3 py-2.5 text-sm ${ALERT_STYLE[alert.level]}`}
                    >
                      {ALERT_ICON[alert.level]}
                      <div>
                        <span className="font-semibold">{alert.rule}: </span>
                        <span className="opacity-90">{alert.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Recommendations */}
              {analysis.recommendations && analysis.recommendations.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-[#7c82a0] uppercase tracking-wide">
                    Recommendations ({analysis.recommendations.length})
                  </h3>
                  {analysis.recommendations.map((rec, i) => (
                    <div
                      key={i}
                      className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
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
                        </div>
                      )}
                      <p className="text-xs text-[#7c82a0] leading-relaxed">{rec.rationale}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Raw Reasoning (collapsible) */}
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

              {/* Copy JSON */}
              <div className="flex justify-end">
                <button
                  onClick={copyJSON}
                  className="flex items-center gap-1.5 text-xs text-[#4a5070] hover:text-[#7c82a0] transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy JSON'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
