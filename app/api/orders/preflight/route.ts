/**
 * POST /api/orders/preflight
 *
 * Dry-run a batch of equity orders through lib/guardrails without placing
 * anything. Returns per-order violations so a UI can show what would be
 * blocked before the user commits.
 *
 * This exists because POST /api/orders talks straight to Schwab — the
 * guardrail layer only ran inside the signal engine's auto-execute path, so
 * every manual placement (rebalance workflow, cornerstone card, the allocation
 * planner) bypassed the $10K post-trade AFW floor and its siblings. Rather
 * than change the behaviour of every existing manual path at once, callers
 * opt in by checking here first.
 *
 * Cumulative by design — see validateBatchCumulative in lib/guardrails.ts.
 * Checking each order against the same opening snapshot would pass a set of
 * buys that individually clear the AFW floor but jointly breach it.
 *
 * Body:
 *   {
 *     accountHash: string,
 *     orders: Array<{ symbol, instruction: 'BUY'|'SELL', quantity, price, pillar? }>
 *   }
 *
 * Response:
 *   {
 *     results: Array<{ symbol, instruction, quantity, allowed, violations[] }>,
 *     allowedCount, blockedCount, warnCount,
 *     context: { afwDollars, projectedAfwDollars, totalValue, marginBalance }
 *   }
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import {
  validateBatchCumulative,
  type GuardrailContext,
  type GuardrailViolation,
  type ProposedTrade,
  type RecentTrade,
} from '@/lib/guardrails';
import { fetchAccountState } from '@/lib/portfolio/fetch';
import { getServerStrategyTargets } from '@/lib/strategy-store';
import type { TradeHistoryEntry } from '../route';

export const dynamic = 'force-dynamic';

interface PreflightOrder {
  symbol:      string;
  instruction: 'BUY' | 'SELL';
  quantity:    number;
  price:       number;
  pillar?:     string;
}

export interface PreflightResult {
  symbol:      string;
  instruction: 'BUY' | 'SELL';
  quantity:    number;
  allowed:     boolean;
  violations:  GuardrailViolation[];
}

/**
 * Recent trades feed the wash-sale and daily-count checks. Scoped to this
 * account where the history records one — entries written before the
 * accountHash field shipped have none, and are included rather than dropped
 * so the daily-count breaker fails safe.
 */
async function loadRecentTrades(accountHash: string): Promise<RecentTrade[]> {
  try {
    const store = getStore('trade-history');
    const log = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
    if (!Array.isArray(log)) return [];
    const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;   // widest window any check uses (30d) plus slack
    return log
      .filter((e) => e.status === 'placed')
      .filter((e) => !e.accountHash || e.accountHash === accountHash)
      .filter((e) => new Date(e.timestamp).getTime() >= cutoff)
      .map((e) => ({
        timestamp:   e.timestamp,
        symbol:      e.symbol,
        instruction: e.instruction,
        shares:      e.quantity,
        price:       e.price,
      }));
  } catch (err) {
    // An unreadable history blob shouldn't fail the whole preflight — the
    // portfolio-side checks (AFW, margin, concentration) are the ones that
    // matter most here and they don't depend on it.
    console.warn('[preflight] trade-history read failed:', err);
    return [];
  }
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { accountHash?: string; orders?: PreflightOrder[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { accountHash, orders = [] } = body;
  if (!accountHash || typeof accountHash !== 'string')
    return NextResponse.json({ error: 'Missing accountHash' }, { status: 400 });
  if (orders.length === 0)
    return NextResponse.json({ error: 'No orders provided' }, { status: 400 });

  for (const o of orders) {
    if (!o.symbol) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });
    if (!['BUY', 'SELL'].includes(o.instruction))
      return NextResponse.json({ error: `Invalid instruction for ${o.symbol}` }, { status: 400 });
    if (!o.quantity || o.quantity < 1)
      return NextResponse.json({ error: `Invalid quantity for ${o.symbol}` }, { status: 400 });
  }

  try {
    const [state, targets, recentTrades] = await Promise.all([
      fetchAccountState(accountHash),
      getServerStrategyTargets(accountHash),
      loadRecentTrades(accountHash),
    ]);

    // Bucket context for the overdrift check. Pillar keys match the P2P
    // taxonomy used by summarizeByPillar; anything outside the four (e.g.
    // 'other') has no target and the check skips it.
    const targetByPillar: Record<string, number> = {
      growth:      targets.growthPct,
      cornerstone: targets.cornerstonePct,
      income:      targets.incomePct,
      triples:     targets.triplesPct,
    };
    const pillars = Object.entries(targetByPillar).map(([pillar, targetPct]) => ({
      pillar,
      currentPct: state.pillarSummary.find((p) => p.pillar === pillar)?.portfolioPercent ?? 0,
      targetPct,
    }));

    // Working context, mutated as accepted orders are folded in.
    const ctx: GuardrailContext = {
      totalValue:    state.totalValue,
      equity:        state.equity,
      marginBalance: state.marginBalance,
      afwDollars:    state.afwDollars,
      positions: state.positions.map((p) => ({
        symbol:      p.instrument.symbol,
        pillar:      p.pillar,
        marketValue: p.marketValue,
        shares:      p.longQuantity,
      })),
      pillars,
      recentTrades,
      limits: {
        // Honour the user's own margin ceiling when it's tighter than the
        // guardrail default. Schwab's hard 50% still backstops either way.
        maxMarginUtilizationPct: Math.min(50, targets.marginLimitPct || 50),
      },
    };

    /** Pillar for a symbol: caller's hint first, then the live position. */
    const pillarFor = (o: PreflightOrder) =>
      o.pillar ?? ctx.positions.find((p) => p.symbol === o.symbol)?.pillar ?? 'other';

    const proposed: ProposedTrade[] = orders.map((o) => ({
      symbol:      o.symbol,
      instruction: o.instruction,
      shares:      o.quantity,
      price:       o.price ?? 0,
      pillar:      pillarFor(o),
    }));

    const { results: validated, finalContext } = validateBatchCumulative(proposed, ctx);

    const results: PreflightResult[] = validated.map((r, i) => ({
      symbol:      r.symbol,
      instruction: orders[i].instruction,
      quantity:    orders[i].quantity,
      allowed:     r.allowed,
      violations:  r.violations,
    }));

    return NextResponse.json({
      results,
      allowedCount: results.filter((r) => r.allowed).length,
      blockedCount: results.filter((r) => !r.allowed).length,
      warnCount:    results.reduce((s, r) => s + r.violations.filter((v) => v.severity === 'warn').length, 0),
      context: {
        afwDollars:          state.afwDollars,
        projectedAfwDollars: finalContext.afwDollars,
        totalValue:          state.totalValue,
        marginBalance:       state.marginBalance,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Preflight API error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
