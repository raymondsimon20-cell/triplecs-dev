/**
 * GET /api/signals/replay
 *
 * Backtest replay harness. Re-runs the signal engine over every stored REAL
 * portfolio snapshot (synthetic backfill days are skipped — they don't carry
 * the data fidelity needed for honest replay) and reports what signals would
 * have fired on each day.
 *
 * What this DOES tell you:
 *   - Whether the rule thresholds are well-calibrated against your actual
 *     historical state. Fires too often? Never? Right on cue?
 *   - For Phase 2 rules (MAINTENANCE_RANKED_TRIM, PILLAR_FILL), how often the
 *     engine would have proposed action over the captured period.
 *
 * What this does NOT tell you:
 *   - What WOULD have happened if you'd executed the proposal — that's a
 *     forward-looking sim that needs price paths. Replay only answers "would
 *     this rule have fired?", not "would executing it have been a good idea?".
 *   - Anything about rules that depend on transient state (SPY/VIX history,
 *     month-boundary kill-switch comparison). Those degrade gracefully but the
 *     replay isn't load-bearing for them.
 *
 * Query params:
 *   limit  — max number of snapshots to replay (default 60, max 365)
 *   rule   — filter to a single rule name (e.g. ?rule=PILLAR_FILL)
 *
 * Returns JSON: { days: ReplayDay[], summary: { byRule, totalFires } }
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getSnapshotHistory, type PortfolioSnapshot } from '@/lib/storage';
import { getServerStrategyTargets } from '@/lib/strategy-store';
import { getFundMetadata } from '@/lib/data/fund-metadata';
import {
  runSignalEngine,
  type EngineInputs,
  type EnginePosition,
  type TradeSignal,
} from '@/lib/signals/engine';
import { loadSignalState } from '@/lib/signals/state';

export const dynamic = 'force-dynamic';

interface ReplayDay {
  date:                 string;
  totalValue:           number;
  marginUtilizationPct: number;
  signalsFired: Array<{
    rule:        string;
    direction:   TradeSignal['direction'];
    ticker:      string;
    sizeDollars: number;
    priority:    TradeSignal['priority'];
    reason:      string;
  }>;
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url        = new URL(req.url);
  const limit      = Math.max(1, Math.min(365, Number(url.searchParams.get('limit') || 60)));
  const ruleFilter = url.searchParams.get('rule')?.trim() || null;

  try {
    const [snapshots, strategy, state] = await Promise.all([
      getSnapshotHistory(limit),
      getServerStrategyTargets(),
      loadSignalState(),
    ]);

    // Replay newest-last so output reads chronologically.
    const realChronological = snapshots
      .filter((s) => !s.synthetic)
      .sort((a, b) => a.savedAt - b.savedAt);

    if (realChronological.length === 0) {
      return NextResponse.json({
        days:    [],
        summary: { byRule: {}, totalFires: 0 },
        notice:  'No real snapshots in storage to replay. Synthetic days are excluded.',
      });
    }

    // Build a rolling SPY-history series so the SPY-dependent rules get a
    // best-effort context per day. We use each snapshot's `spyClose` and feed
    // the last 25 values up to that day.
    const spyByDate: Array<{ date: string; spy: number }> = realChronological
      .filter((s) => typeof s.spyClose === 'number' && (s.spyClose as number) > 0)
      .map((s) => ({
        date: new Date(s.savedAt).toISOString().slice(0, 10),
        spy:  s.spyClose as number,
      }));

    const days: ReplayDay[] = [];
    const fireCountsByRule: Record<string, number> = {};

    for (let i = 0; i < realChronological.length; i += 1) {
      const snap = realChronological[i];
      const dateIso = new Date(snap.savedAt).toISOString().slice(0, 10);

      // Reconstruct EngineInputs from snapshot + current metadata.
      const positions: EnginePosition[] = (snap.positions ?? []).map((p) => {
        const meta = getFundMetadata(p.symbol);
        return {
          symbol:      p.symbol,
          shares:      p.shares,
          marketValue: p.marketValue,
          ...(meta
            ? {
                pillar:               meta.pillar,
                family:               meta.family,
                maintenancePct:       meta.maintenancePct,
                maintenancePctSource: meta.maintenancePctSource,
              }
            : {}),
        };
      });

      // Synthesize a rolling 25-day SPY history up to this snapshot date.
      const spyHistory = spyByDate
        .filter((x) => x.date <= dateIso)
        .map((x) => x.spy)
        .slice(-25);

      // Best-effort prices map from positions (use last known); engine prefers marketValue.
      const prices: Record<string, number> = {};
      for (const p of snap.positions ?? []) {
        if (p.shares > 0 && p.marketValue > 0) {
          prices[p.symbol] = p.marketValue / p.shares;
        }
      }
      if (typeof snap.spyClose === 'number') prices['SPY'] = snap.spyClose;

      // Margin debt from snapshot's marginBalance (already absolute in our schema).
      const marginDebt = Math.abs(snap.marginBalance ?? 0);
      // Cash isn't stored on snapshots — derive: cash ≈ equity − Σ(marketValue) + marginDebt
      // (since equity = positions + cash − marginDebt). Conservative: clamp ≥ 0.
      const holdingsTotal = (snap.positions ?? []).reduce((s, p) => s + (p.marketValue || 0), 0);
      const cash = Math.max(0, snap.equity - holdingsTotal + marginDebt);

      const inputs: EngineInputs = {
        positions,
        cash,
        marginDebt,
        prices,
        spyHistory,
        vix: 20,   // replay doesn't have historical VIX — AIRBAG-dependent rules degrade
        state,
        pillarTargets: {
          triplesPct:     strategy.triplesPct,
          cornerstonePct: strategy.cornerstonePct,
          incomePct:      strategy.incomePct,
          hedgePct:       strategy.hedgePct,
        },
        recentSells30d:      [],   // replay doesn't reconstruct trade history per day
        buyingPowerAvailable: cash,
      };

      const result = runSignalEngine(inputs);
      const fired = result.signals
        .filter((s) => !ruleFilter || s.rule === ruleFilter)
        .map((s) => ({
          rule:        s.rule,
          direction:   s.direction,
          ticker:      s.ticker,
          sizeDollars: s.sizeDollars,
          priority:    s.priority,
          reason:      s.reason,
        }));

      for (const f of fired) {
        fireCountsByRule[f.rule] = (fireCountsByRule[f.rule] ?? 0) + 1;
      }

      days.push({
        date:                 dateIso,
        totalValue:           snap.totalValue,
        marginUtilizationPct: snap.marginUtilizationPct,
        signalsFired:         fired,
      });
    }

    const totalFires = Object.values(fireCountsByRule).reduce((a, b) => a + b, 0);

    return NextResponse.json({
      days,
      summary: {
        snapshotCount: realChronological.length,
        byRule:        fireCountsByRule,
        totalFires,
      },
      caveats: [
        'VIX is held at 20 — AIRBAG-dependent rules may under-fire.',
        'recentSells30d is empty during replay — wash-sale filter does not engage.',
        'Engine state (defenseMode, killSwitch) uses the current persisted state, not a replayed timeline.',
        'Fund metadata (pillar, family, maintenance %) is sourced from the current canonical table; historical reclassifications are not preserved.',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[signals/replay] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Helper used internally — exported for tests/scripts that want to reuse the
// replay logic without an HTTP call.
export type { PortfolioSnapshot };
