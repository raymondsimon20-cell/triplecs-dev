'use client';

/**
 * Phase 5 — Options & Put Strategy Engine
 *
 * Rules source: Vol 5 (buying puts / boxing) + Vol 6 (selling puts for income)
 *
 * Section 1 — Put Protection Tracker (Vol 5)
 *   • Bought SPY/QQQ puts ~30 days out, strike ~10% below market
 *   • Roll signal: <14 days to expiry → Roll Now; 14-21 → Roll Soon
 *   • Cover when RSI oversold / VIX spikes
 *   • "Get AI Rec" → BUY_TO_OPEN protective put via /api/option-plan
 *
 * Section 2 — Sell-Put Income Engine (Vol 6)
 *   • Sell LEAPs on indexed ETFs with LOW share price (UPRO, TQQQ, income ETFs)
 *   • Shows suggested strike (10% below), assignment risk, premium quality score
 *   • "Get AI Rec" per candidate → SELL_TO_OPEN via /api/option-plan → place order
 *
 * Section 3 — Boxing Tracker (Vol 5, Ch 4-5)
 *   • Short CLM/CRF when: equity low, premium > 20%, RO announced, black-swan recourse
 */

import { useState } from 'react';
import {
  Shield, DollarSign, Layers, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle, Clock, TrendingDown, RefreshCw,
  Sparkles, Loader2, ShoppingCart, X,
} from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';
import { TRIPLES_SYMBOLS, INCOME_SYMBOLS, CORNERSTONE_SYMBOLS } from '@/lib/classify';
import { PutChainInline } from '@/components/PutChainInline';

// ─── API types ────────────────────────────────────────────────────────────────

interface SelectedContract {
  expiration:       string;
  dte:              number;
  strike:           number;
  otmPct:           number;
  delta:            number;
  bid:              number;
  ask:              number;
  mid:              number;
  iv:               number;
  annualisedReturn: number;
  breakeven:        number;
  closeTarget75:    number;
}

interface OptionPlanResponse {
  occSymbol:        string;
  instruction:      'BUY_TO_OPEN' | 'SELL_TO_OPEN';
  contracts:        number;
  limitPrice:       number;
  rationale:        string;
  selectedContract: SelectedContract;
  validationPassed: boolean;
  symbol:           string;
  underlyingPrice:  number;
  mode:             string;
}

interface RecState {
  loading:      boolean;
  plan:         OptionPlanResponse | null;
  error:        string | null;
  contracts:    number;
  placing:      boolean;
  orderResult:  string | null;
}

const initRec = (): RecState => ({
  loading: false, plan: null, error: null,
  contracts: 1, placing: false, orderResult: null,
});

// Reads the streaming response from /api/option-plan and extracts __RESULT__ JSON
async function fetchOptionPlan(body: Record<string, unknown>): Promise<OptionPlanResponse> {
  const res = await fetch('/api/option-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const err = await res.json();
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    throw new Error(`Server error (HTTP ${res.status})`);
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
  const idx = accumulated.lastIndexOf('__RESULT__');
  if (idx === -1) throw new Error('No result received from server');
  const resultStr = accumulated.slice(idx + '__RESULT__'.length).replace('__DONE__', '').trim();
  const data = JSON.parse(resultStr) as OptionPlanResponse & { error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}

// ─── OCC Option Symbol Parser ─────────────────────────────────────────────────

interface ParsedOption {
  underlying: string;
  expiry: Date;
  type: 'P' | 'C';
  strike: number;
  daysToExpiry: number;
}

function parseOptionSymbol(symbol: string, description?: string): ParsedOption | null {
  try {
    const cleaned = symbol.replace(/\s+/g, '');
    const occMatch = cleaned.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([PC])(\d{8})$/);
    if (occMatch) {
      const [, root, yy, mm, dd, typeChar, strikeRaw] = occMatch;
      const year = 2000 + parseInt(yy);
      const expiry = new Date(year, parseInt(mm) - 1, parseInt(dd));
      const strike = parseInt(strikeRaw) / 1000;
      const now = new Date();
      const daysToExpiry = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
      return { underlying: root, expiry, type: typeChar as 'P' | 'C', strike, daysToExpiry };
    }
    if (description) {
      const descMatch = description.match(
        /^(\w+)\s+(\w+)\s+(\d+)\s+(\d{4})\s+([\d.]+)\s+(Put|Call)/i,
      );
      if (descMatch) {
        const [, root, month, day, year, strikeStr, typeStr] = descMatch;
        const months: Record<string, number> = {
          Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
          Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
        };
        const expiry = new Date(parseInt(year), months[month] ?? 0, parseInt(day));
        const now = new Date();
        const daysToExpiry = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000);
        return {
          underlying: root, expiry,
          type: typeStr.toLowerCase() === 'put' ? 'P' : 'C',
          strike: parseFloat(strikeStr), daysToExpiry,
        };
      }
    }
  } catch { /* parsing failed */ }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number, dec = 0) {
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return n < 0 ? `-$${s}` : `$${s}`;
}

function rollUrgency(daysToExpiry: number): { label: string; color: string; bg: string } {
  if (daysToExpiry <= 0)
    return { label: 'Expired', color: 'text-red-500', bg: 'bg-red-600/20 border-red-600/30' };
  if (daysToExpiry <= 14)
    return { label: 'Roll Now', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/25' };
  if (daysToExpiry <= 21)
    return { label: 'Roll Soon', color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/25' };
  return { label: 'Holding', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25' };
}

function premiumQualityScore(pos: EnrichedPosition): number {
  let score = 0;
  const price = pos.quote?.lastPrice ?? pos.averagePrice;
  const symbol = pos.instrument.symbol;
  if (TRIPLES_SYMBOLS.has(symbol)) score += 40;
  else if (INCOME_SYMBOLS.has(symbol)) score += 25;
  else score += 10;
  if (price < 30) score += 30;
  else if (price < 60) score += 20;
  else if (price < 100) score += 10;
  else score -= 10;
  const iv = pos.quote?.volatility ?? 0;
  if (iv > 50) score += 30;
  else if (iv > 30) score += 20;
  else if (iv > 15) score += 10;
  return Math.max(0, Math.min(100, score));
}

function candidateTier(symbol: string, price: number): { tier: 1|2|3; label: string; color: string } {
  const TIER1 = new Set(['TQQQ','UPRO','QQQY','XDTE','FEPI','JEPI','JEPQ','SPYI','AIPI','SPXL','KLIP']);
  const TIER2 = new Set(['QQQ','NVDA','IWMY','JEPY','QDVO','SPYG']);
  if (TIER1.has(symbol)) return { tier: 1, label: 'Tier 1', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' };
  if (TIER2.has(symbol) || (price > 60 && price < 200)) return { tier: 2, label: 'Tier 2', color: 'text-blue-400 bg-blue-500/10 border-blue-500/25' };
  return { tier: 3, label: 'Tier 3', color: 'text-orange-400 bg-orange-500/10 border-orange-500/25' };
}

function approxDelta(otmPct: number): number {
  return Math.max(0.05, Math.round((0.50 - otmPct / 100 * 1.6) * 100) / 100);
}

function soldPutSignal(dte: number, profitPct: number): {
  label: string; color: string; bg: string; icon: 'close'|'roll'|'hold'|'manage';
} {
  if (profitPct >= 75)
    return { label: 'Close (75%+)', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25', icon: 'close' };
  if (dte <= 14 && profitPct < 75)
    return { label: 'Roll Now', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/25', icon: 'roll' };
  if (dte <= 21 && profitPct >= 25)
    return { label: 'Roll Soon', color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/25', icon: 'roll' };
  if (profitPct < -30)
    return { label: 'Manage', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/25', icon: 'manage' };
  return { label: 'Hold', color: 'text-[#7c82a0]', bg: 'bg-[#22263a] border-[#3d4260]', icon: 'hold' };
}

// ─── AI Rec Card ──────────────────────────────────────────────────────────────

function AiRecCard({
  rec,
  mode,
  onContractsChange,
  onPlace,
  onDismiss,
}: {
  rec: RecState;
  mode: 'sell_put' | 'buy_put';
  onContractsChange: (n: number) => void;
  onPlace: () => void;
  onDismiss: () => void;
}) {
  if (rec.loading) {
    return (
      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-violet-500/10 border border-violet-500/20 rounded-lg text-xs text-violet-300">
        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
        <span>AI analysing live options chain…</span>
      </div>
    );
  }

  if (rec.error) {
    return (
      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="flex-1">{rec.error}</span>
        <button onClick={onDismiss} className="text-red-400 hover:text-red-200"><X className="w-3 h-3" /></button>
      </div>
    );
  }

  if (!rec.plan) return null;

  const { plan } = rec;
  const c = plan.selectedContract;
  const expDisplay = new Date(c.expiration + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  const isSell = mode === 'sell_put';
  const accentClass = isSell ? 'border-violet-500/30 bg-violet-500/8' : 'border-blue-500/30 bg-blue-500/8';
  const badgeClass  = isSell ? 'bg-violet-600/30 text-violet-200' : 'bg-blue-600/30 text-blue-200';

  return (
    <div className={`mt-2 border rounded-lg overflow-hidden ${accentClass}`}>
      {/* Rec header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
        <div className="flex items-center gap-1.5 text-[10px]">
          <Sparkles className="w-3 h-3 text-violet-400" />
          <span className="text-[#7c82a0]">AI Recommendation</span>
          {!plan.validationPassed && (
            <span className="text-orange-400 text-[9px]">⚠ fallback scoring</span>
          )}
        </div>
        <button onClick={onDismiss} className="text-[#4a5070] hover:text-white"><X className="w-3 h-3" /></button>
      </div>

      {/* Main rec line */}
      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${badgeClass}`}>
            {isSell ? 'SELL TO OPEN' : 'BUY TO OPEN'}
          </span>
          <span className="font-mono font-semibold text-white text-xs">
            {plan.symbol} ${c.strike.toFixed(0)}P {expDisplay}
          </span>
        </div>

        {/* Metrics row */}
        <div className="grid grid-cols-4 gap-1.5 text-[10px]">
          <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
            <div className="text-[#4a5070]">DTE</div>
            <div className="text-white font-mono font-semibold">{c.dte}d</div>
          </div>
          <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
            <div className="text-[#4a5070]">OTM%</div>
            <div className="text-blue-300 font-mono font-semibold">{c.otmPct.toFixed(1)}%</div>
          </div>
          <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
            <div className="text-[#4a5070]">Delta</div>
            <div className="text-violet-300 font-mono font-semibold">{c.delta.toFixed(2)}</div>
          </div>
          <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
            <div className="text-[#4a5070]">IV</div>
            <div className="text-orange-300 font-mono font-semibold">{c.iv.toFixed(0)}%</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
          <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
            <div className="text-[#4a5070]">Limit Price</div>
            <div className="text-emerald-400 font-mono font-semibold">${plan.limitPrice.toFixed(2)}</div>
          </div>
          {isSell ? (
            <>
              <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
                <div className="text-[#4a5070]">Close @ 75%</div>
                <div className="text-orange-300 font-mono">${c.closeTarget75.toFixed(2)}</div>
              </div>
              <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
                <div className="text-[#4a5070]">Ann. Ret</div>
                <div className={`font-mono font-semibold ${c.annualisedReturn >= 15 ? 'text-emerald-400' : 'text-blue-400'}`}>
                  {c.annualisedReturn.toFixed(1)}%
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
                <div className="text-[#4a5070]">Breakeven</div>
                <div className="text-[#7c82a0] font-mono">${c.breakeven.toFixed(2)}</div>
              </div>
              <div className="bg-[#1a1d27] rounded px-2 py-1 text-center">
                <div className="text-[#4a5070]">Bid / Ask</div>
                <div className="text-[#7c82a0] font-mono">{c.bid.toFixed(2)} / {c.ask.toFixed(2)}</div>
              </div>
            </>
          )}
        </div>

        {/* Rationale */}
        <p className="text-[10px] text-[#7c82a0] leading-relaxed">{plan.rationale}</p>

        {/* Contracts adjuster + place */}
        {rec.orderResult ? (
          <div className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded ${
            rec.orderResult.startsWith('✓') ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300'
          }`}>
            {rec.orderResult}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-[#7c82a0]">
              <span>Contracts:</span>
              <button
                onClick={() => onContractsChange(Math.max(1, rec.contracts - 1))}
                className="w-5 h-5 rounded bg-[#2d3248] text-white hover:bg-[#3d4268] flex items-center justify-center text-sm leading-none"
              >−</button>
              <span className="w-5 text-center font-mono text-white">{rec.contracts}</span>
              <button
                onClick={() => onContractsChange(Math.min(3, rec.contracts + 1))}
                className="w-5 h-5 rounded bg-[#2d3248] text-white hover:bg-[#3d4268] flex items-center justify-center text-sm leading-none"
              >+</button>
            </div>
            <button
              onClick={onPlace}
              disabled={rec.placing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white transition-colors ml-auto"
            >
              {rec.placing ? (
                <><Loader2 className="w-3 h-3 animate-spin" />Placing…</>
              ) : (
                <><ShoppingCart className="w-3 h-3" />Place Order</>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section 1: Put Protection Tracker ───────────────────────────────────────

function PutProtectionSection({
  positions,
  accountHash,
  vix,
  marketTrend,
}: {
  positions:    EnrichedPosition[];
  accountHash:  string;
  vix?:         number;
  marketTrend?: 'bullish' | 'neutral' | 'bearish';
}) {
  const [buyRec, setBuyRec]     = useState<Record<string, RecState>>({});
  const [selectedSym, setSelectedSym] = useState<'SPY' | 'QQQ'>('SPY');

  const longOptions = positions.filter(
    (p) => p.instrument.assetType === 'OPTION' && p.longQuantity > 0,
  );
  const boughtPuts = longOptions.filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return parsed?.type === 'P';
  });

  const getAiRec = async (symbol: string) => {
    setBuyRec((prev) => ({ ...prev, [symbol]: { ...initRec(), loading: true } }));
    try {
      const data = await fetchOptionPlan({ symbol, mode: 'buy_put', contracts: 1, vix, marketTrend });
      setBuyRec((prev) => ({ ...prev, [symbol]: { ...initRec(), plan: data, contracts: 1 } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'AI request failed';
      setBuyRec((prev) => ({ ...prev, [symbol]: { ...initRec(), error: msg } }));
    }
  };

  const placeOrder = async (symbol: string) => {
    const rec = buyRec[symbol];
    if (!rec?.plan || !accountHash) return;
    setBuyRec((prev) => ({ ...prev, [symbol]: { ...prev[symbol], placing: true } }));
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountHash,
          optionOrders: [{
            occSymbol:   rec.plan.occSymbol,
            instruction: 'BUY_TO_OPEN',
            contracts:   rec.contracts,
            limitPrice:  rec.plan.limitPrice,
            rationale:   rec.plan.rationale,
            aiMode:      'buy_put',
          }],
        }),
      });
      const data = await res.json();
      const placed = data.optionResults?.[0];
      const result = placed?.status === 'placed'
        ? `✓ Order placed — ID ${placed.orderId ?? 'pending'}`
        : `✗ ${placed?.message ?? data.error ?? 'Unknown error'}`;
      setBuyRec((prev) => ({ ...prev, [symbol]: { ...prev[symbol], placing: false, orderResult: result } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Order failed';
      setBuyRec((prev) => ({ ...prev, [symbol]: { ...prev[symbol], placing: false, orderResult: `✗ ${msg}` } }));
    }
  };

  const updateContracts = (symbol: string, n: number) => {
    setBuyRec((prev) => ({ ...prev, [symbol]: { ...prev[symbol], contracts: n } }));
  };

  const dismissRec = (symbol: string) => {
    setBuyRec((prev) => ({ ...prev, [symbol]: initRec() }));
  };

  return (
    <div className="space-y-4">
      <div className="text-xs text-[#7c82a0] space-y-1">
        <p>Vol 5 rules: SPY/QQQ puts ~30 days out, strike ~10% below market. Monthly roll strategy — cheapest insurance that moves most in a crash.</p>
        <p className="text-[10px] text-[#4a5070]">Buy when: RSI overbought or market melting. Cover when: RSI oversold, VIX spikes, or ~75% profit reached. Budget: $100-$300/mo.</p>
      </div>

      {boughtPuts.length === 0 ? (
        <div className="bg-[#22263a] rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-orange-400 text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-semibold">No put protection detected</span>
          </div>
          <p className="text-xs text-[#7c82a0]">
            Consider buying 1-2 SPY or QQQ put contracts ~30 days out, strike ~10% below current price.
            When VIX is low (below 15), premiums are cheapest — ideal time to buy insurance.
          </p>
          <div className="bg-[#1a1d27] rounded p-3 space-y-1 text-xs">
            <p className="text-white font-semibold">Quick sizing guide:</p>
            <p className="text-[#7c82a0]">SPY @ ~$500 → suggested strike ~$450 (10% OTM) • ~30 DTE</p>
            <p className="text-[#7c82a0]">QQQ @ ~$440 → suggested strike ~$396 (10% OTM) • ~30 DTE</p>
            <p className="text-[#4a5070]">Cost: typically $100-$300/contract/month depending on VIX</p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                <th className="text-left px-3 py-2">Option</th>
                <th className="text-right px-3 py-2">Strike</th>
                <th className="text-right px-3 py-2">Expiry</th>
                <th className="text-right px-3 py-2">DTE</th>
                <th className="text-right px-3 py-2">Contracts</th>
                <th className="text-right px-3 py-2">Value</th>
                <th className="text-right px-3 py-2">G/L</th>
                <th className="text-right px-3 py-2">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2d3248]">
              {boughtPuts.map((pos) => {
                const parsed = parseOptionSymbol(pos.instrument.symbol, pos.instrument.description);
                if (!parsed) return null;
                const urgency = rollUrgency(parsed.daysToExpiry);
                const gl = pos.gainLoss;
                const contracts = pos.longQuantity;
                return (
                  <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                    <td className="px-3 py-2">
                      <div className="font-mono font-semibold text-white">{parsed.underlying} Put</div>
                      <div className="text-[10px] text-[#7c82a0]">{pos.instrument.description ?? pos.instrument.symbol}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-white">${parsed.strike.toFixed(0)}</td>
                    <td className="px-3 py-2 text-right text-[#7c82a0]">
                      {parsed.expiry.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${urgency.color}`}>
                      {parsed.daysToExpiry}d
                    </td>
                    <td className="px-3 py-2 text-right text-[#e8eaf0]">{contracts}</td>
                    <td className="px-3 py-2 text-right font-mono text-white">{fmt$(pos.marketValue)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmt$(gl)}
                      <div className="text-[10px] opacity-70">
                        {pos.gainLossPercent >= 0 ? '+' : ''}{pos.gainLossPercent.toFixed(0)}%
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${urgency.bg} ${urgency.color}`}>
                        {urgency.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Roll reminder */}
      {boughtPuts.some((p) => {
        const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
        return parsed && parsed.daysToExpiry <= 21;
      }) && (
        <div className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/25 rounded-lg px-3 py-2 text-xs text-orange-300">
          <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>Roll approaching: sell the expiring put(s) to salvage remaining value, then buy new contracts ~30 DTE. Do this on a market down day (or when VIX is low) for cheaper replacement puts.</span>
        </div>
      )}

      {/* AI buy rec section */}
      {accountHash && (
        <div className="border border-[#2d3248] rounded-lg p-3 space-y-2 bg-[#0f1117]">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-xs font-semibold text-white">Buy Protective Put</span>
            <span className="text-[10px] text-[#4a5070]">Vol 5 · ~30 DTE · 10% OTM</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#7c82a0]">Symbol:</span>
            {(['SPY', 'QQQ'] as const).map((sym) => (
              <button
                key={sym}
                onClick={() => setSelectedSym(sym)}
                className={`px-2.5 py-1 rounded text-xs font-mono font-semibold transition-colors ${
                  selectedSym === sym
                    ? 'bg-blue-600 text-white'
                    : 'bg-[#22263a] text-[#7c82a0] hover:text-white border border-[#3d4260]'
                }`}
              >
                {sym}
              </button>
            ))}
            <button
              onClick={() => getAiRec(selectedSym)}
              disabled={buyRec[selectedSym]?.loading}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/40 disabled:opacity-50 transition-colors ml-auto"
            >
              {buyRec[selectedSym]?.loading ? (
                <><Loader2 className="w-3 h-3 animate-spin" />Analysing…</>
              ) : (
                <><Sparkles className="w-3 h-3" />Get AI Rec</>
              )}
            </button>
          </div>
          {buyRec[selectedSym] && (buyRec[selectedSym].loading || buyRec[selectedSym].plan || buyRec[selectedSym].error) && (
            <AiRecCard
              rec={buyRec[selectedSym]}
              mode="buy_put"
              onContractsChange={(n) => updateContracts(selectedSym, n)}
              onPlace={() => placeOrder(selectedSym)}
              onDismiss={() => dismissRec(selectedSym)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section 2: Sell-Put Income Engine ───────────────────────────────────────

function SellPutIncomeSection({
  positions,
  totalValue,
  accountHash,
  vix,
  marketTrend,
}: {
  positions:    EnrichedPosition[];
  totalValue:   number;
  accountHash:  string;
  vix?:         number;
  marketTrend?: 'bullish' | 'neutral' | 'bearish';
}) {
  const [aiRecs, setAiRecs] = useState<Record<string, RecState>>({});

  const soldPuts = positions.filter(
    (p) => p.instrument.assetType === 'OPTION' && p.shortQuantity > 0,
  ).filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return parsed?.type === 'P';
  });

  const equityPositions = positions.filter(
    (p) => p.instrument.assetType === 'EQUITY' || p.instrument.assetType === 'MUTUAL_FUND',
  );

  const candidates = equityPositions
    .map((pos) => ({
      pos,
      score: premiumQualityScore(pos),
      price: pos.quote?.lastPrice ?? pos.averagePrice,
    }))
    .filter(({ score }) => score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const getAiRec = async (symbol: string, pos: EnrichedPosition) => {
    setAiRecs((prev) => ({ ...prev, [symbol]: { ...initRec(), loading: true } }));
    try {
      const data = await fetchOptionPlan({
        symbol, mode: 'sell_put', contracts: 1, vix, marketTrend,
        position: { shares: pos.longQuantity, value: pos.marketValue, pillar: pos.pillar ?? 'income' },
      });
      setAiRecs((prev) => ({ ...prev, [symbol]: { ...initRec(), plan: data, contracts: data.contracts } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'AI request failed';
      setAiRecs((prev) => ({ ...prev, [symbol]: { ...initRec(), error: msg } }));
    }
  };

  const placeOrder = async (symbol: string) => {
    const rec = aiRecs[symbol];
    if (!rec?.plan || !accountHash) return;
    setAiRecs((prev) => ({ ...prev, [symbol]: { ...prev[symbol], placing: true } }));
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountHash,
          optionOrders: [{
            occSymbol:   rec.plan.occSymbol,
            instruction: 'SELL_TO_OPEN',
            contracts:   rec.contracts,
            limitPrice:  rec.plan.limitPrice,
            rationale:   rec.plan.rationale,
            aiMode:      'sell_put',
          }],
        }),
      });
      const data = await res.json();
      const placed = data.optionResults?.[0];
      const result = placed?.status === 'placed'
        ? `✓ Order placed — ID ${placed.orderId ?? 'pending'}`
        : `✗ ${placed?.message ?? data.error ?? 'Unknown error'}`;
      setAiRecs((prev) => ({ ...prev, [symbol]: { ...prev[symbol], placing: false, orderResult: result } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Order failed';
      setAiRecs((prev) => ({ ...prev, [symbol]: { ...prev[symbol], placing: false, orderResult: `✗ ${msg}` } }));
    }
  };

  const updateContracts = (symbol: string, n: number) => {
    setAiRecs((prev) => ({ ...prev, [symbol]: { ...prev[symbol], contracts: n } }));
  };

  const dismissRec = (symbol: string) => {
    setAiRecs((prev) => ({ ...prev, [symbol]: initRec() }));
  };

  return (
    <div className="space-y-4">
      <div className="text-xs text-[#7c82a0]">
        Vol 6 rules: sell 1 LEAP put on indexed ETFs you WANT to own. Premium lowers cost basis and margin interest.
        Prefer LOW share price names to keep assignment risk manageable. Close when ~75% of premium recovered.
      </div>

      {/* Active sold puts */}
      {soldPuts.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-white">Active Sold Puts</h4>
          <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                  <th className="text-left px-3 py-2">Option</th>
                  <th className="text-right px-3 py-2">Strike</th>
                  <th className="text-right px-3 py-2">DTE</th>
                  <th className="text-right px-3 py-2">Contracts</th>
                  <th className="text-right px-3 py-2">Assignment $</th>
                  <th className="text-right px-3 py-2">Premium P/L</th>
                  <th className="text-right px-3 py-2">Signal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2d3248]">
                {soldPuts.map((pos) => {
                  const parsed = parseOptionSymbol(pos.instrument.symbol, pos.instrument.description);
                  if (!parsed) return null;
                  const contracts = pos.shortQuantity;
                  const assignmentRisk = parsed.strike * 100 * contracts;
                  const gl = pos.gainLoss;
                  const glPct = pos.gainLossPercent;
                  const sig = soldPutSignal(parsed.daysToExpiry, glPct);
                  const dteColor = parsed.daysToExpiry <= 14 ? 'text-red-400' : parsed.daysToExpiry <= 21 ? 'text-orange-400' : 'text-[#7c82a0]';
                  return (
                    <tr key={pos.instrument.symbol} className={`hover:bg-[#22263a]/60 ${
                      sig.icon === 'roll' ? 'bg-orange-500/5' :
                      sig.icon === 'close' ? 'bg-emerald-500/5' :
                      sig.icon === 'manage' ? 'bg-red-500/5' : ''
                    }`}>
                      <td className="px-3 py-2">
                        <div className="font-mono font-semibold text-white">{parsed.underlying} Put</div>
                        <div className="text-[10px] text-[#7c82a0]">Short · {contracts} contract{contracts !== 1 ? 's' : ''}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white">${parsed.strike.toFixed(0)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${dteColor}`}>
                        {parsed.daysToExpiry}d
                        {parsed.daysToExpiry <= 21 && <div className="text-[10px] opacity-70">⚠ gamma risk</div>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-orange-300">
                        {fmt$(assignmentRisk)}
                        <div className="text-[10px] opacity-70">if assigned</div>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmt$(gl)}
                        <div className="text-[10px] opacity-70">{glPct.toFixed(0)}% captured</div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${sig.bg} ${sig.color}`}>
                          {sig.icon === 'roll' && <RefreshCw className="w-2.5 h-2.5" />}
                          {sig.label}
                        </span>
                        {sig.icon === 'roll' && (
                          <div className="text-[9px] text-orange-400/70 mt-0.5">→ Roll to 60–90 DTE</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sell-put candidates */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-white">
            Sell-Put Candidates
            <span className="ml-2 text-[#4a5070] font-normal">from current holdings</span>
          </h4>
          <div className="flex items-center gap-2 text-[10px] text-[#4a5070]">
            <span className="text-emerald-400">Tier 1</span> ideal ·
            <span className="text-blue-400">Tier 2</span> good ·
            <span className="text-orange-400">Tier 3</span> caution
          </div>
        </div>

        {candidates.length === 0 ? (
          <p className="text-xs text-[#4a5070] py-2">No suitable sell-put candidates in current positions.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map(({ pos, score, price }) => {
              const iv      = pos.quote?.volatility ?? 0;
              const symbol  = pos.instrument.symbol;
              const isTriple = TRIPLES_SYMBOLS.has(symbol);
              const isIncome = INCOME_SYMBOLS.has(symbol);
              const tier    = candidateTier(symbol, price);
              const scoreColor = score >= 70 ? 'text-emerald-400' : score >= 50 ? 'text-yellow-400' : 'text-orange-400';
              const rec     = aiRecs[symbol];
              const hasRec  = rec && (rec.loading || rec.plan !== null || rec.error !== null);

              const strikes = [
                { label: 'Conservative', otm: 15, delta: approxDelta(15) },
                { label: 'Moderate',     otm: 10, delta: approxDelta(10) },
                { label: 'Aggressive',   otm:  5, delta: approxDelta(5)  },
              ];

              return (
                <div key={symbol} className="bg-[#0f1117] border border-[#2d3248] rounded-lg p-3 space-y-2.5">
                  {/* Header row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-semibold text-white text-sm">{symbol}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${tier.color}`}>{tier.label}</span>
                    <span className="text-xs text-[#7c82a0]">
                      {isTriple ? '3× Leveraged' : isIncome ? 'Income ETF' : 'Equity'} · ${price.toFixed(2)}
                    </span>
                    {iv > 0 && (
                      <span className={`text-xs ml-auto ${iv > 40 ? 'text-emerald-400' : iv > 25 ? 'text-blue-400' : 'text-[#7c82a0]'}`}>
                        IV {iv.toFixed(0)}% {iv > 40 ? '↑ rich' : iv > 25 ? 'ok' : '↓ thin'}
                      </span>
                    )}
                    <span className={`text-xs font-bold ${scoreColor}`}>Score {score}</span>
                  </div>

                  {/* Strike scenarios */}
                  <div className="grid grid-cols-3 gap-2">
                    {strikes.map(({ label, otm, delta }) => {
                      const strike  = price * (1 - otm / 100);
                      const assign  = strike * 100;
                      const isMod   = otm === 10;
                      return (
                        <div key={label} className={`rounded p-2 space-y-0.5 text-[10px] ${isMod ? 'bg-violet-500/10 border border-violet-500/20' : 'bg-[#1a1d27]'}`}>
                          <div className={`font-semibold ${isMod ? 'text-violet-300' : 'text-[#7c82a0]'}`}>{label}</div>
                          <div className="text-white font-mono">${strike.toFixed(2)} strike</div>
                          <div className="text-[#7c82a0]">−{otm}% OTM · Δ {delta.toFixed(2)}</div>
                          <div className="text-[#4a5070]">~{(100 - delta * 100).toFixed(0)}% PoP</div>
                          <div className={`font-mono ${assign > 20000 ? 'text-orange-400' : 'text-[#7c82a0]'}`}>
                            ${(assign / 1000).toFixed(1)}k/contract
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* DTE recommendation */}
                  <div className="text-[10px] text-[#4a5070] flex items-center gap-3">
                    <span>Optimal DTE: <span className="text-white">60–90 days</span></span>
                    <span>Max contracts: <span className="text-white">{price < 60 ? '3' : price < 150 ? '2' : '1'}</span></span>
                    <span>Assignment: <span className={price > 200 ? 'text-orange-400' : 'text-white'}>
                      {price < 60 ? 'manageable' : price < 150 ? 'moderate' : 'large — size carefully'}
                    </span></span>
                  </div>

                  {/* AI Rec button + chain */}
                  <div className="flex items-center gap-3 pt-0.5">
                    <PutChainInline ticker={symbol} />
                    {accountHash && (
                      <button
                        onClick={() => !hasRec && getAiRec(symbol, pos)}
                        disabled={rec?.loading}
                        className="flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-200 disabled:opacity-50 transition-colors ml-auto whitespace-nowrap"
                      >
                        {rec?.loading ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin" />Analysing…</>
                        ) : (
                          <><Sparkles className="w-3.5 h-3.5" />Get AI Rec</>
                        )}
                      </button>
                    )}
                  </div>

                  {/* AI rec card */}
                  {hasRec && (
                    <AiRecCard
                      rec={rec}
                      mode="sell_put"
                      onContractsChange={(n) => updateContracts(symbol, n)}
                      onPlace={() => placeOrder(symbol)}
                      onDismiss={() => dismissRec(symbol)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="text-[10px] text-[#4a5070] space-y-0.5 pt-1">
          <p>PoP = estimated probability of expiring worthless (delta-based approximation). Actual PoP depends on IV and time.</p>
          <p>Vol 6: "I always sell puts on stocks I WANT to own anyway — assignment is the goal, not the risk."</p>
          <p>Roll rule: when DTE &lt; 21 and profit between 25–75%, roll to 60–90 DTE rather than holding through gamma risk zone.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Section 3: Boxing Tracker ────────────────────────────────────────────────

function BoxingTrackerSection({
  positions,
  cornerstonePremiumPct,
}: {
  positions: EnrichedPosition[];
  cornerstonePremiumPct?: number;
}) {
  const boxedPositions = positions.filter(
    (p) => CORNERSTONE_SYMBOLS.has(p.instrument.symbol) && p.shortQuantity > 0,
  );

  const premiumHigh = (cornerstonePremiumPct ?? 0) > 20;

  const boxSignals = [
    {
      label: 'Premium > 20% above NAV',
      active: premiumHigh,
      desc: 'Best arbitrage opportunity — short CLM/CRF, cover at NAV or lower',
    },
    {
      label: 'Equity too low / margin pressure',
      active: false,
      desc: 'Boxing immediately raises equity by lowering maintenance requirements',
    },
    {
      label: 'RO announced',
      active: false,
      desc: 'Box before RO subscription — cover at discount after rights offering closes',
    },
    {
      label: 'Black-swan / market overbought',
      active: false,
      desc: 'Broad market overbought: short Cornerstone as index proxy hedge',
    },
  ];

  const activeSignals = boxSignals.filter((s) => s.active);

  return (
    <div className="space-y-4">
      <div className="text-xs text-[#7c82a0]">
        Vol 5 Ch 4-5: Short-selling CLM/CRF ("boxing") protects the CEF side of your portfolio while raising equity through lower maintenance.
        Cornerstone IS the index — boxing it hedges your whole income portfolio.
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-white">Box Signals</p>
        {boxSignals.map((signal, i) => (
          <div
            key={i}
            className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
              signal.active
                ? 'bg-orange-500/10 border-orange-500/25'
                : 'bg-[#22263a] border-[#2d3248]'
            }`}
          >
            {signal.active ? (
              <AlertTriangle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle className="w-3.5 h-3.5 text-[#3d4260] flex-shrink-0 mt-0.5" />
            )}
            <div>
              <div className={`font-semibold ${signal.active ? 'text-orange-300' : 'text-[#4a5070]'}`}>
                {signal.label}
              </div>
              <div className={signal.active ? 'text-orange-400/70' : 'text-[#3d4260]'}>
                {signal.desc}
              </div>
            </div>
          </div>
        ))}
      </div>

      {boxedPositions.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-white">Active Boxing Positions</p>
          <div className="overflow-x-auto rounded-lg border border-[#2d3248]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#22263a] text-[#7c82a0] uppercase tracking-wide text-[10px]">
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Short Shares</th>
                  <th className="text-right px-3 py-2">Market Value</th>
                  <th className="text-right px-3 py-2">P/L</th>
                  <th className="text-right px-3 py-2">Today</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2d3248]">
                {boxedPositions.map((pos) => {
                  const gl = pos.gainLoss;
                  const today = pos.todayGainLoss ?? 0;
                  return (
                    <tr key={pos.instrument.symbol} className="hover:bg-[#22263a]/60">
                      <td className="px-3 py-2">
                        <div className="font-mono font-semibold text-white">{pos.instrument.symbol}</div>
                        <div className="text-[10px] text-red-400">Short / Boxed</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-400">
                        -{pos.shortQuantity.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-white">
                        {fmt$(pos.marketValue)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${gl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmt$(gl)}
                        <div className="opacity-70 text-[10px]">{pos.gainLossPercent.toFixed(1)}%</div>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${today >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {today !== 0 ? fmt$(today) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={`rounded-lg px-3 py-2.5 text-xs border ${
          activeSignals.length > 0
            ? 'bg-orange-500/10 border-orange-500/25 text-orange-300'
            : 'bg-[#22263a] border-[#2d3248] text-[#4a5070]'
        }`}>
          {activeSignals.length > 0 ? (
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                {activeSignals.length} box signal{activeSignals.length > 1 ? 's' : ''} active — consider shorting CLM/CRF.
                Use "Sell Short" (not "Sell") at market order. Cover at lows.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <CheckCircle className="w-3.5 h-3.5 text-[#3d4260]" />
              <span>No active boxing. No signals triggered — holding long only in Cornerstone is appropriate.</span>
            </div>
          )}
        </div>
      )}

      <div className="text-[10px] text-[#4a5070] space-y-0.5">
        <p>Boxing advantages: lowers maintenance → raises equity immediately • Less decay than put options • Short borrow rate often below margin rate • Protects entire CEF exposure since C's track the index.</p>
        <p>Cover strategy: buy to cover at lows, then DCA long Cornerstone and ride back to the top.</p>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

interface Props {
  positions:             EnrichedPosition[];
  totalValue:            number;
  accountHash:           string;
  cornerstonePremiumPct?: number;
  vix?:                  number;
  marketTrend?:          'bullish' | 'neutral' | 'bearish';
}

const SECTIONS = [
  { id: 'protection', label: 'Put Protection Tracker', icon: Shield },
  { id: 'income', label: 'Sell-Put Income Engine', icon: DollarSign },
  { id: 'boxing', label: 'Boxing Tracker (CLM/CRF Short)', icon: Layers },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function OptionsStrategyPanel({
  positions,
  totalValue,
  accountHash,
  cornerstonePremiumPct,
  vix,
  marketTrend,
}: Props) {
  const [expanded, setExpanded] = useState<Set<SectionId>>(new Set(['protection', 'income']));

  const toggleSection = (id: SectionId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const optionPositions = positions.filter((p) => p.instrument.assetType === 'OPTION');
  const boughtPuts = optionPositions.filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return p.longQuantity > 0 && parsed?.type === 'P';
  });
  const soldPuts = optionPositions.filter((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return p.shortQuantity > 0 && parsed?.type === 'P';
  });
  const boxedPositions = positions.filter(
    (p) => CORNERSTONE_SYMBOLS.has(p.instrument.symbol) && p.shortQuantity > 0,
  );

  const rollAlert = boughtPuts.some((p) => {
    const parsed = parseOptionSymbol(p.instrument.symbol, p.instrument.description);
    return parsed && parsed.daysToExpiry <= 14;
  });

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-purple-400" />
          <h2 className="text-sm font-semibold text-white">Options & Put Strategy</h2>
          <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/30">
            Phase 5
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#4a5070]">
          {rollAlert && (
            <span className="flex items-center gap-1 text-red-400">
              <Clock className="w-3 h-3" />
              Roll alert
            </span>
          )}
          {boughtPuts.length > 0 && (
            <span>{boughtPuts.length} put{boughtPuts.length > 1 ? 's' : ''} owned</span>
          )}
          {soldPuts.length > 0 && (
            <span>{soldPuts.length} put{soldPuts.length > 1 ? 's' : ''} sold</span>
          )}
          {boxedPositions.length > 0 && (
            <span className="text-orange-400">{boxedPositions.length} boxed</span>
          )}
        </div>
      </div>

      {/* Accordion sections */}
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const isOpen = expanded.has(id);
        return (
          <div key={id} className="border border-[#2d3248] rounded-lg overflow-hidden">
            <button
              onClick={() => toggleSection(id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-[#22263a] hover:bg-[#2a2f45] transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5 text-purple-400" />
                <span className="text-sm font-medium text-white">{label}</span>
                {id === 'protection' && rollAlert && (
                  <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/30">Roll!</span>
                )}
              </div>
              {isOpen ? (
                <ChevronUp className="w-4 h-4 text-[#7c82a0]" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[#7c82a0]" />
              )}
            </button>

            {isOpen && (
              <div className="px-4 py-4">
                {id === 'protection' && (
                  <PutProtectionSection
                    positions={positions}
                    accountHash={accountHash}
                    vix={vix}
                    marketTrend={marketTrend}
                  />
                )}
                {id === 'income' && (
                  <SellPutIncomeSection
                    positions={positions}
                    totalValue={totalValue}
                    accountHash={accountHash}
                    vix={vix}
                    marketTrend={marketTrend}
                  />
                )}
                {id === 'boxing' && (
                  <BoxingTrackerSection
                    positions={positions}
                    cornerstonePremiumPct={cornerstonePremiumPct}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="text-[10px] text-[#4a5070] border-t border-[#2d3248] pt-3">
        Vol 5: Buy SPY/QQQ puts ~30 DTE, 10% OTM, roll monthly ($100-$300/mo insurance). Box CLM/CRF at premium highs or when equity low.
        Vol 6: Sell 1 LEAP put on indexed names you want to own — premium lowers cost basis and margin. Close at 75% profit.
      </div>
    </div>
  );
}
