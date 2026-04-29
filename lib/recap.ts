/**
 * Recap — outcome attribution for AI recommendations.
 *
 * Pure functions. No I/O. Callers load the blobs (trade-history, trade-inbox,
 * portfolio-snapshots) and pass them in.
 *
 * Two flavors of outcome:
 *   - Executed trades         → entry vs current mark (or realized at sell)
 *   - Dismissed inbox items   → counterfactual: price at stage vs price now,
 *                                in the direction the AI predicted
 *
 * Aggregations slice by `aiMode` so we can answer "how good are
 * sell_put recs vs rebalance_plan recs?" Hit rate is misleading on its own,
 * so every summary also reports expectancy = avg P&L per rec.
 */

import type { TradeHistoryEntry } from '@/app/api/orders/route';
import type { InboxItem } from './inbox';
import type { PortfolioSnapshot } from './storage';

// ─── Types ───────────────────────────────────────────────────────────────────

export type OutcomeKind = 'open' | 'closed' | 'dismissed';

export interface RecOutcome {
  id:           string;
  timestamp:    string;       // ISO of the rec/trade
  symbol:       string;
  instruction:  string;
  quantity:     number;
  aiMode:       string;       // best-effort; 'unknown' if missing
  source:       'executed' | 'dismissed';
  kind:         OutcomeKind;
  entryPrice:   number;       // for BUYs: avg cost; for SELLs: realized price; for dismissed: stage price
  markPrice:    number;       // current mark (or null if unknown — defaulted to entry)
  pnlPct:       number;       // signed; positive = AI was right
  pnlDollars:   number;
  daysHeld:     number;
  rationale?:   string;
  /** True if pnlPct >= +1% (winning), false if pnlPct <= -1% (losing), null if flat. */
  win:          boolean | null;
}

export interface ModeSummary {
  aiMode:        string;
  count:         number;
  wins:          number;
  losses:        number;
  flat:          number;
  hitRatePct:    number;     // wins / (wins + losses)
  avgWinPct:     number;
  avgLossPct:    number;
  expectancyPct: number;     // avg pnlPct across all (wins, losses, flat)
  totalPnlDollars: number;
}

export interface RegimeContext {
  windowDays:        number;
  spyReturnPct:      number | null;
  drawdownPct:       number;            // peak-to-current within window, magnitude
  startDate:         string;
  endDate:           string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBuy(instr: string): boolean {
  return instr === 'BUY' || instr === 'BUY_TO_OPEN' || instr === 'BUY_TO_CLOSE';
}

function isOption(instr: string): boolean {
  return instr.includes('_TO_OPEN') || instr.includes('_TO_CLOSE');
}

function withinWindow(timestampISO: string, lookbackDays: number, now = Date.now()): boolean {
  const t = new Date(timestampISO).getTime();
  if (Number.isNaN(t)) return false;
  return now - t <= lookbackDays * 24 * 60 * 60 * 1000;
}

function daysBetween(fromISO: string, toMs: number): number {
  const from = new Date(fromISO).getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, (toMs - from) / (24 * 60 * 60 * 1000));
}

/** Build a symbol → most-recent mark price map from the latest snapshot positions. */
function buildMarkMap(latest: PortfolioSnapshot | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!latest) return map;
  for (const p of latest.positions ?? []) {
    if (p.shares > 0 && p.marketValue > 0) {
      map.set(p.symbol, p.marketValue / p.shares);
    }
  }
  return map;
}

/**
 * Best-effort historical mark lookup: walk back through snapshots, find the
 * earliest snapshot on or after `dateISO` that has the symbol, return that
 * position's per-share value. Used to price dismissed items at stage-time.
 */
function priceAtDate(snapshots: PortfolioSnapshot[], symbol: string, dateISO: string): number | null {
  const target = new Date(dateISO).getTime();
  // Sort ascending, find first snapshot >= target with the symbol present
  const sorted = [...snapshots].sort((a, b) => a.savedAt - b.savedAt);
  for (const s of sorted) {
    if (s.savedAt < target) continue;
    const pos = s.positions?.find((p) => p.symbol === symbol);
    if (pos && pos.shares > 0 && pos.marketValue > 0) {
      return pos.marketValue / pos.shares;
    }
  }
  return null;
}

function classifyWin(pnlPct: number): boolean | null {
  if (pnlPct >= 1)  return true;
  if (pnlPct <= -1) return false;
  return null;
}

// ─── Outcomes from executed trades ───────────────────────────────────────────

export function computeExecutedOutcomes(
  trades: TradeHistoryEntry[],
  latestSnapshot: PortfolioSnapshot | null,
  lookbackDays: number,
  now = Date.now(),
): RecOutcome[] {
  const marks = buildMarkMap(latestSnapshot);
  const out: RecOutcome[] = [];

  for (const t of trades) {
    if (t.status !== 'placed') continue;
    if (!withinWindow(t.timestamp, lookbackDays, now)) continue;

    const entry = t.price ?? 0;
    if (entry <= 0) continue;

    // For options we don't have a clean current mark in the snapshot.
    // Skip pnl for option legs but still include them in the count by setting
    // mark = entry (pnl = 0, classified as flat).
    const markFromSnap = marks.get(t.symbol);
    const mark = isOption(t.instruction) ? entry : (markFromSnap ?? entry);

    const direction = isBuy(t.instruction) ? 1 : -1;     // SELL profits when price drops
    const pnlPct = entry > 0 ? ((mark - entry) / entry) * 100 * direction : 0;
    const pnlDollars = (mark - entry) * t.quantity * direction;
    const days = daysBetween(t.timestamp, now);

    out.push({
      id:          t.id,
      timestamp:   t.timestamp,
      symbol:      t.symbol,
      instruction: t.instruction,
      quantity:    t.quantity,
      aiMode:      t.aiMode ?? 'unknown',
      source:      'executed',
      kind:        markFromSnap ? 'open' : 'closed',
      entryPrice:  +entry.toFixed(4),
      markPrice:   +mark.toFixed(4),
      pnlPct:      +pnlPct.toFixed(2),
      pnlDollars:  +pnlDollars.toFixed(2),
      daysHeld:    +days.toFixed(1),
      rationale:   t.rationale,
      win:         classifyWin(pnlPct),
    });
  }
  return out;
}

// ─── Counterfactual outcomes from dismissed items ────────────────────────────

export function computeDismissedOutcomes(
  inboxItems: InboxItem[],
  snapshots: PortfolioSnapshot[],
  latestSnapshot: PortfolioSnapshot | null,
  lookbackDays: number,
  now = Date.now(),
): RecOutcome[] {
  const marks = buildMarkMap(latestSnapshot);
  const out: RecOutcome[] = [];

  for (const it of inboxItems) {
    if (it.status !== 'dismissed' && it.status !== 'expired') continue;
    const stageISO = new Date(it.createdAt).toISOString();
    if (!withinWindow(stageISO, lookbackDays, now)) continue;

    // Stage-time price: prefer the price stored on the inbox item, fall back
    // to a snapshot lookup, then fall back to current mark.
    const stagePrice = it.price ?? it.limitPrice ?? priceAtDate(snapshots, it.symbol, stageISO) ?? 0;
    if (stagePrice <= 0) continue;

    const currentMark = marks.get(it.symbol);
    if (!currentMark) continue;     // no mark means we can't score

    const direction = isBuy(it.instruction) ? 1 : -1;
    const pnlPct = ((currentMark - stagePrice) / stagePrice) * 100 * direction;
    // Notional impact if user had approved: shares * delta
    const pnlDollars = (currentMark - stagePrice) * it.quantity * direction;
    const days = daysBetween(stageISO, now);

    out.push({
      id:          it.id,
      timestamp:   stageISO,
      symbol:      it.symbol,
      instruction: it.instruction,
      quantity:    it.quantity,
      aiMode:      it.aiMode ?? 'unknown',
      source:      'dismissed',
      kind:        'dismissed',
      entryPrice:  +stagePrice.toFixed(4),
      markPrice:   +currentMark.toFixed(4),
      pnlPct:      +pnlPct.toFixed(2),
      pnlDollars:  +pnlDollars.toFixed(2),
      daysHeld:    +days.toFixed(1),
      rationale:   it.rationale,
      win:         classifyWin(pnlPct),
    });
  }
  return out;
}

// ─── Per-mode summary (hit rate + expectancy) ────────────────────────────────

export function summarizeByMode(outcomes: RecOutcome[]): ModeSummary[] {
  const byMode = new Map<string, RecOutcome[]>();
  for (const o of outcomes) {
    const arr = byMode.get(o.aiMode) ?? [];
    arr.push(o);
    byMode.set(o.aiMode, arr);
  }

  const summaries: ModeSummary[] = [];
  for (const [aiMode, group] of byMode) {
    const wins   = group.filter((o) => o.win === true);
    const losses = group.filter((o) => o.win === false);
    const flat   = group.filter((o) => o.win === null);
    const totalPnlDollars = group.reduce((acc, o) => acc + o.pnlDollars, 0);
    const avgWinPct  = wins.length   > 0 ? wins.reduce((a, o) => a + o.pnlPct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? losses.reduce((a, o) => a + o.pnlPct, 0) / losses.length : 0;
    const expectancyPct = group.length > 0 ? group.reduce((a, o) => a + o.pnlPct, 0) / group.length : 0;
    const decided = wins.length + losses.length;
    const hitRatePct = decided > 0 ? (wins.length / decided) * 100 : 0;
    summaries.push({
      aiMode,
      count: group.length,
      wins:  wins.length,
      losses: losses.length,
      flat:  flat.length,
      hitRatePct:    +hitRatePct.toFixed(1),
      avgWinPct:     +avgWinPct.toFixed(2),
      avgLossPct:    +avgLossPct.toFixed(2),
      expectancyPct: +expectancyPct.toFixed(2),
      totalPnlDollars: +totalPnlDollars.toFixed(2),
    });
  }
  // Sort by count desc so the most-active modes come first
  return summaries.sort((a, b) => b.count - a.count);
}

// ─── Regime context (interpreting "good" vs "bad" for the period) ────────────

export function computeRegime(snapshots: PortfolioSnapshot[], lookbackDays: number, now = Date.now()): RegimeContext {
  const cutoff = now - lookbackDays * 24 * 60 * 60 * 1000;
  const inWindow = snapshots
    .filter((s) => s.savedAt >= cutoff)
    .sort((a, b) => a.savedAt - b.savedAt);

  const start = inWindow[0];
  const end   = inWindow[inWindow.length - 1] ?? start;
  const startDate = start ? new Date(start.savedAt).toISOString().slice(0, 10) : '';
  const endDate   = end   ? new Date(end.savedAt).toISOString().slice(0, 10)   : startDate;

  // Filter to snapshots that actually carry spyClose — the field is optional
  // and may be missing on snapshots saved off-hours or before SPY tracking
  // landed. Fall back to the most recent pre-window snapshot with spyClose
  // when the window is sparse, so we still produce a number instead of —.
  const withSpyInWindow = inWindow.filter((s) => typeof s.spyClose === 'number' && s.spyClose! > 0);
  const preWindowAnchor = snapshots
    .filter((s) => s.savedAt < cutoff && typeof s.spyClose === 'number' && s.spyClose! > 0)
    .sort((a, b) => a.savedAt - b.savedAt)
    .at(-1);
  const spyStart = withSpyInWindow[0] ?? preWindowAnchor;
  const spyEnd   = withSpyInWindow.at(-1) ?? spyStart;

  let spyReturnPct: number | null = null;
  if (spyStart && spyEnd && spyStart !== spyEnd && spyStart.spyClose && spyStart.spyClose > 0 && spyEnd.spyClose) {
    spyReturnPct = +(((spyEnd.spyClose - spyStart.spyClose) / spyStart.spyClose) * 100).toFixed(2);
  }

  // Peak-to-current drawdown (magnitude, positive number)
  let peak = 0;
  let current = 0;
  for (const s of inWindow) {
    if (s.totalValue > peak) peak = s.totalValue;
    current = s.totalValue;
  }
  const drawdownPct = peak > 0 ? +(((peak - current) / peak) * 100).toFixed(2) : 0;

  return {
    windowDays: lookbackDays,
    spyReturnPct,
    drawdownPct: Math.max(0, drawdownPct),
    startDate,
    endDate,
  };
}

// ─── Convenience: full recap in one call ─────────────────────────────────────

export interface FullRecap {
  windowDays:    number;
  outcomes:      RecOutcome[];
  byMode:        ModeSummary[];
  regime:        RegimeContext;
  totals: {
    executedCount: number;
    dismissedCount: number;
    totalPnlDollars: number;
    overallHitRatePct: number;
    overallExpectancyPct: number;
  };
}

export function buildRecap(
  trades:    TradeHistoryEntry[],
  inbox:     InboxItem[],
  snapshots: PortfolioSnapshot[],
  latest:    PortfolioSnapshot | null,
  lookbackDays: number,
  now = Date.now(),
): FullRecap {
  const executed   = computeExecutedOutcomes(trades, latest, lookbackDays, now);
  const dismissed  = computeDismissedOutcomes(inbox, snapshots, latest, lookbackDays, now);
  const outcomes   = [...executed, ...dismissed].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const byMode = summarizeByMode(outcomes);
  const regime = computeRegime(snapshots, lookbackDays, now);

  const decided = outcomes.filter((o) => o.win !== null);
  const wins    = outcomes.filter((o) => o.win === true).length;
  const overallHitRatePct = decided.length > 0 ? (wins / decided.length) * 100 : 0;
  const overallExpectancyPct = outcomes.length > 0
    ? outcomes.reduce((a, o) => a + o.pnlPct, 0) / outcomes.length
    : 0;

  return {
    windowDays: lookbackDays,
    outcomes,
    byMode,
    regime,
    totals: {
      executedCount:        executed.length,
      dismissedCount:       dismissed.length,
      totalPnlDollars:      +outcomes.reduce((a, o) => a + o.pnlDollars, 0).toFixed(2),
      overallHitRatePct:    +overallHitRatePct.toFixed(1),
      overallExpectancyPct: +overallExpectancyPct.toFixed(2),
    },
  };
}
