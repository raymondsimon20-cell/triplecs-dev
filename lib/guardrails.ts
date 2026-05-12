/**
 * Guardrails — pure validators for AI-proposed trades.
 *
 * The point of one-click approval is speed. The point of guardrails is to
 * make sure speed doesn't become recklessness. Every AI-generated trade
 * runs through `validateProposedTrade()` before it's surfaced to the user;
 * trades that violate hard limits are returned as `blockedTrades` with a
 * human-readable explanation rather than silently dropped.
 *
 * All checks are pure functions over a `GuardrailContext` — data loading
 * happens at the route level, validation happens here.
 */

import type { CashFlowEvent, PortfolioSnapshot } from './storage';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProposedTrade {
  symbol:      string;
  instruction: 'BUY' | 'SELL' | 'BUY_TO_OPEN' | 'SELL_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE';
  shares:      number;
  price:       number;
  pillar:      string;
}

export interface PositionContext {
  symbol:      string;
  pillar:      string;
  marketValue: number;
  shares:      number;
}

export interface PillarTargetContext {
  pillar:    string;
  currentPct: number;
  targetPct: number;
}

export interface RecentTrade {
  timestamp:   string;     // ISO
  symbol:      string;
  instruction: ProposedTrade['instruction'];
  shares:      number;
  price?:      number;
}

export interface GuardrailLimits {
  /** Max single-order size as fraction of total portfolio value. */
  maxOrderPctOfPortfolio: number;     // default 0.05  (5%)
  /** Max single-position concentration after the trade. */
  maxConcentrationPct: number;        // default 25
  /** Max pillar drift above target after the trade, in percentage points. */
  maxPillarOverdriftPp: number;       // default 8
  /** Max margin utilization after the trade. */
  maxMarginUtilizationPct: number;    // default 50
  /** Max number of orders placed today (across the trade-history blob). */
  maxOrdersPerDay: number;            // default 8
  /** Wash-sale lookback window in days. */
  washSaleWindowDays: number;         // default 30
  /** Drawdown over the lookback that triggers the circuit breaker. */
  drawdownTriggerPct: number;         // default 10 (negative drop, magnitude)
  drawdownLookbackDays: number;       // default 14
}

export const DEFAULT_LIMITS: GuardrailLimits = {
  maxOrderPctOfPortfolio: 0.05,
  maxConcentrationPct:    25,
  maxPillarOverdriftPp:   8,
  maxMarginUtilizationPct: 50,
  maxOrdersPerDay:        8,
  washSaleWindowDays:     30,
  drawdownTriggerPct:     10,
  drawdownLookbackDays:   14,
};

export interface GuardrailContext {
  totalValue:    number;
  equity:        number;
  marginBalance: number;            // absolute value
  positions:     PositionContext[];
  pillars:       PillarTargetContext[];
  recentTrades:  RecentTrade[];     // for wash-sale + daily count + duplicate
  snapshots?:    PortfolioSnapshot[];   // for drawdown breaker
  cashFlows?:    CashFlowEvent[];       // not used yet, reserved for future
  limits?:       Partial<GuardrailLimits>;
}

export type ViolationCode =
  | 'order_size_cap'
  | 'concentration_cap'
  | 'pillar_overdrift'
  | 'margin_cap'
  | 'daily_order_count'
  | 'wash_sale'
  | 'drawdown_breaker';

export interface GuardrailViolation {
  code:       ViolationCode;
  message:    string;
  severity:   'block' | 'warn';
}

export interface ValidationResult {
  allowed:    boolean;
  violations: GuardrailViolation[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBuy(instr: ProposedTrade['instruction']): boolean {
  return instr === 'BUY' || instr === 'BUY_TO_OPEN' || instr === 'BUY_TO_CLOSE';
}

function tradeNotional(t: ProposedTrade): number {
  return t.shares * t.price;
}

function withinDays(timestampISO: string, days: number, now = Date.now()): boolean {
  const t = new Date(timestampISO).getTime();
  return now - t <= days * 24 * 60 * 60 * 1000;
}

// ─── Individual checks ───────────────────────────────────────────────────────

function checkOrderSize(t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  if (ctx.totalValue <= 0) return null;
  const notional = tradeNotional(t);
  const pct      = notional / ctx.totalValue;
  if (pct > limits.maxOrderPctOfPortfolio) {
    return {
      code: 'order_size_cap',
      severity: 'block',
      message: `${t.instruction} ${t.shares} ${t.symbol} (~$${Math.round(notional).toLocaleString()}) is ${(pct * 100).toFixed(1)}% of portfolio — cap is ${(limits.maxOrderPctOfPortfolio * 100).toFixed(0)}%.`,
    };
  }
  return null;
}

function checkConcentration(t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  if (!isBuy(t.instruction) || ctx.totalValue <= 0) return null;
  const existing = ctx.positions.find((p) => p.symbol === t.symbol)?.marketValue ?? 0;
  const post     = existing + tradeNotional(t);
  const pct      = (post / ctx.totalValue) * 100;
  if (pct > limits.maxConcentrationPct) {
    return {
      code: 'concentration_cap',
      severity: 'block',
      message: `${t.symbol} would become ${pct.toFixed(1)}% of portfolio after this BUY — concentration cap is ${limits.maxConcentrationPct}%.`,
    };
  }
  return null;
}

function checkPillarOverdrift(t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  if (!isBuy(t.instruction) || ctx.totalValue <= 0) return null;
  const target = ctx.pillars.find((p) => p.pillar === t.pillar);
  if (!target) return null;
  const currentDollars = (target.currentPct / 100) * ctx.totalValue;
  const postDollars    = currentDollars + tradeNotional(t);
  const postPct        = (postDollars / ctx.totalValue) * 100;
  const overdrift      = postPct - target.targetPct;
  if (overdrift > limits.maxPillarOverdriftPp) {
    return {
      code: 'pillar_overdrift',
      severity: 'block',
      message: `BUY would push ${t.pillar} to ${postPct.toFixed(1)}% (target ${target.targetPct}%, overdrift +${overdrift.toFixed(1)}pp). Cap is +${limits.maxPillarOverdriftPp}pp.`,
    };
  }
  return null;
}

function checkMargin(t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  if (!isBuy(t.instruction)) return null;
  if (ctx.totalValue <= 0) return null;

  // Best-effort post-trade margin estimate: assume any BUY beyond available cash
  // dips into margin. We approximate available cash as (equity − marginBalance).
  const availableCash = Math.max(0, ctx.equity - ctx.marginBalance);
  const notional      = tradeNotional(t);
  const newMarginDraw = Math.max(0, notional - availableCash);
  const projectedMargin = ctx.marginBalance + newMarginDraw;
  const projectedTotal  = ctx.totalValue + newMarginDraw;
  const pct = projectedTotal > 0 ? (projectedMargin / projectedTotal) * 100 : 0;

  if (pct > limits.maxMarginUtilizationPct) {
    return {
      code: 'margin_cap',
      severity: 'block',
      message: `BUY would push margin utilization to ${pct.toFixed(1)}% — cap is ${limits.maxMarginUtilizationPct}%.`,
    };
  }
  return null;
}

function checkDailyCount(_t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  const today = new Date().toISOString().slice(0, 10);
  const todaysCount = ctx.recentTrades.filter((rt) => rt.timestamp.slice(0, 10) === today).length;
  if (todaysCount >= limits.maxOrdersPerDay) {
    return {
      code: 'daily_order_count',
      severity: 'block',
      message: `Daily order cap (${limits.maxOrdersPerDay}) already reached — ${todaysCount} orders placed today.`,
    };
  }
  return null;
}

function checkWashSale(t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  if (!isBuy(t.instruction)) return null;
  // A simple wash-sale heuristic: any SELL of the same symbol within the
  // window. We don't have realized P&L here, so this is conservative — the
  // user can override if the prior sale was a gain.
  const recentSell = ctx.recentTrades.find((rt) =>
    rt.symbol === t.symbol &&
    (rt.instruction === 'SELL' || rt.instruction === 'SELL_TO_CLOSE') &&
    withinDays(rt.timestamp, limits.washSaleWindowDays),
  );
  if (recentSell) {
    return {
      code: 'wash_sale',
      severity: 'warn',
      message: `${t.symbol} was sold on ${recentSell.timestamp.slice(0, 10)} — wash-sale window (${limits.washSaleWindowDays}d) still open. If that sale was at a loss, this BUY disallows the deduction.`,
    };
  }
  return null;
}

function checkDrawdown(_t: ProposedTrade, ctx: GuardrailContext, limits: GuardrailLimits): GuardrailViolation | null {
  if (!ctx.snapshots || ctx.snapshots.length < 2) return null;
  const sorted = [...ctx.snapshots].sort((a, b) => a.savedAt - b.savedAt);
  const cutoff = Date.now() - limits.drawdownLookbackDays * 24 * 60 * 60 * 1000;
  const window = sorted.filter((s) => s.savedAt >= cutoff);
  if (window.length < 2) return null;

  const peak    = Math.max(...window.map((s) => s.totalValue));
  const current = window[window.length - 1].totalValue;
  if (peak <= 0) return null;
  const drawdownPct = ((peak - current) / peak) * 100;

  if (drawdownPct >= limits.drawdownTriggerPct) {
    return {
      code: 'drawdown_breaker',
      severity: 'warn',
      message: `Portfolio is down ${drawdownPct.toFixed(1)}% from peak in the last ${limits.drawdownLookbackDays}d. Drawdown breaker triggered — confirm before adding aggressive exposure.`,
    };
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a single proposed trade against all guardrails. Returns
 * `{ allowed, violations }` — `allowed` is false if any violation has
 * severity 'block'.
 */
export function validateProposedTrade(trade: ProposedTrade, ctx: GuardrailContext): ValidationResult {
  const limits: GuardrailLimits = { ...DEFAULT_LIMITS, ...(ctx.limits ?? {}) };
  const checks = [
    checkOrderSize(trade, ctx, limits),
    checkConcentration(trade, ctx, limits),
    checkPillarOverdrift(trade, ctx, limits),
    checkMargin(trade, ctx, limits),
    checkDailyCount(trade, ctx, limits),
    checkWashSale(trade, ctx, limits),
    checkDrawdown(trade, ctx, limits),
  ];
  const violations = checks.filter((v): v is GuardrailViolation => v !== null);
  const allowed = !violations.some((v) => v.severity === 'block');
  return { allowed, violations };
}

/**
 * Validate a batch of trades. Returns separated allowed + blocked lists,
 * each carrying their violations (allowed trades may still have warnings).
 */
export function validateBatch<T extends ProposedTrade>(
  trades: T[],
  ctx: GuardrailContext,
): {
  allowed: Array<T & { violations: GuardrailViolation[] }>;
  blocked: Array<T & { violations: GuardrailViolation[] }>;
} {
  const allowed: Array<T & { violations: GuardrailViolation[] }> = [];
  const blocked: Array<T & { violations: GuardrailViolation[] }> = [];
  for (const t of trades) {
    const { allowed: ok, violations } = validateProposedTrade(t, ctx);
    const enriched = { ...t, violations };
    if (ok) allowed.push(enriched);
    else    blocked.push(enriched);
  }
  return { allowed, blocked };
}

// ─── Kill switch helpers ─────────────────────────────────────────────────────

const PAUSE_KEY = 'pause-flag';

/**
 * Check whether the user has tripped the global "Pause Automation" kill switch.
 * Persisted in the `system-state` blob so it survives across requests.
 *
 * Implemented as a free function rather than a class so it can be tree-shaken
 * out of bundles that don't need it.
 */
export async function isAutomationPaused(): Promise<boolean> {
  const { getStore } = await import('@netlify/blobs');
  try {
    const v = await getStore('system-state').get(PAUSE_KEY, { type: 'json' }) as { paused?: boolean } | null;
    return Boolean(v?.paused);
  } catch {
    return false;
  }
}

export async function setAutomationPaused(paused: boolean): Promise<void> {
  const { getStore } = await import('@netlify/blobs');
  await getStore('system-state').setJSON(PAUSE_KEY, { paused, updatedAt: Date.now() });
}

// ─── Combined automation gate (user pause + signal-engine flags) ─────────────

/**
 * Identifies which gate is currently active. Routes that stage trades use this
 * to decide whether to bail; the `source` field tells the UI/log WHICH gate
 * fired, since the three are conceptually different:
 *   - 'user'         : Raymond toggled the pause flag manually
 *   - 'kill-switch'  : signal engine tripped the margin kill switch
 *   - 'defense-mode' : signal engine flipped defense mode (equity ratio breach)
 *   - null           : nothing active, automation flows normally
 */
export type AutomationGateSource = 'user' | 'kill-switch' | 'defense-mode';

export interface AutomationGateState {
  paused: boolean;
  source: AutomationGateSource | null;
  reason: string;
  /** ms epoch when the gate flipped (null for user-toggle). */
  since:  number | null;
}

/**
 * Combined automation gate. Returns the FIRST gate that's currently active in
 * priority order (user > kill-switch > defense-mode). Other routes use this
 * instead of bare `isAutomationPaused()` so they respect signal-engine flags
 * without needing to know about the engine internals.
 *
 * Dynamically imports the signal-engine state module to avoid a hard
 * dependency — guardrails is broadly imported, signals/state is narrow.
 */
export async function getAutomationGate(): Promise<AutomationGateState> {
  if (await isAutomationPaused()) {
    return { paused: true, source: 'user', reason: 'Automation paused by user', since: null };
  }

  try {
    const { getSignalGates } = await import('./signals/state');
    const gates = await getSignalGates();
    if (gates.killSwitch.active) {
      return {
        paused: true,
        source: 'kill-switch',
        reason: gates.killSwitch.reason || 'Margin kill switch tripped',
        since:  gates.killSwitch.since,
      };
    }
    if (gates.defenseMode.active) {
      return {
        paused: true,
        source: 'defense-mode',
        reason: `Defense mode active — equity ratio ${(gates.defenseMode.equityRatio * 100).toFixed(1)}%`,
        since:  gates.defenseMode.since,
      };
    }
  } catch (err) {
    // Signal-engine state blob may not exist yet on a fresh install. Treat as
    // "no gates active" — fall through to normal flow rather than blocking.
    console.warn('[guardrails] could not read signal-engine gates:', err);
  }

  return { paused: false, source: null, reason: '', since: null };
}
