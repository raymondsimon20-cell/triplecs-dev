/**
 * POST /api/signals/shadow
 *
 * Shadow-mode rule testing. Takes an optional set of CONFIG overrides and
 * pillar-target overrides, replays the engine over recent real snapshots, and
 * returns a diff: signals that would fire under the overrides vs signals that
 * would fire under production rules.
 *
 * No persistence, no inbox staging, no notifications. Pure read-only "what
 * would happen if I changed this threshold?".
 *
 * Body (all optional):
 *   {
 *     limit?: number,                // snapshots to replay, default 60, max 365
 *     configOverrides?: Partial<CONFIG>,    // any subset of engine CONFIG
 *     pillarTargets?: Partial<PillarTargets>, // override pillar targets
 *   }
 *
 * Returns:
 *   {
 *     production: { byRule, totalFires },        // baseline counts
 *     shadow:     { byRule, totalFires },        // override counts
 *     diff:       { added: {rule, n}[], removed: {rule, n}[], unchanged: {rule, n}[] },
 *     diffDays:   { date, productionFires, shadowFires, addedRules, removedRules }[],
 *   }
 *
 * Practical use: tweak PILLAR_FILL_GAP_THRESHOLD_PP from 5 to 3 and see
 * whether PILLAR_FILL would have fired more often historically; if it would
 * have fired every day, the threshold's too aggressive.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getSnapshotHistory } from '@/lib/storage';
import { getServerStrategyTargets } from '@/lib/strategy-store';
import { getFundMetadata } from '@/lib/data/fund-metadata';
import {
  runSignalEngine,
  CONFIG as PROD_CONFIG,
  type EngineInputs,
  type EnginePosition,
  type PillarTargets,
} from '@/lib/signals/engine';
import { defaultSignalState, type SignalEngineState } from '@/lib/signals/state';

export const dynamic = 'force-dynamic';

interface ShadowBody {
  limit?:           number;
  configOverrides?: Record<string, number>;
  pillarTargets?:   Partial<PillarTargets>;
}

interface DayDiff {
  date:            string;
  productionFires: number;
  shadowFires:     number;
  addedRules:      string[];   // rules that fire in shadow but not production
  removedRules:    string[];   // rules that fire in production but not shadow
}

interface RuleCounts {
  byRule:     Record<string, number>;
  totalFires: number;
}

function countByRule(signals: Array<{ rule: string }>): RuleCounts {
  const byRule: Record<string, number> = {};
  for (const s of signals) {
    byRule[s.rule] = (byRule[s.rule] ?? 0) + 1;
  }
  return { byRule, totalFires: signals.length };
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ShadowBody = {};
  try { body = await req.json(); } catch { /* empty body fine — full defaults */ }

  const limit = Math.max(1, Math.min(365, Math.floor(Number(body.limit) || 60)));

  try {
    const [snapshots, strategy] = await Promise.all([
      getSnapshotHistory(limit),
      getServerStrategyTargets(),
    ]);

    const realChronological = snapshots
      .filter((s) => !s.synthetic)
      .sort((a, b) => a.savedAt - b.savedAt);

    if (realChronological.length === 0) {
      return NextResponse.json({
        production: { byRule: {}, totalFires: 0 },
        shadow:     { byRule: {}, totalFires: 0 },
        diff:       { added: [], removed: [], unchanged: [] },
        diffDays:   [],
        notice:     'No real snapshots in storage to replay.',
      });
    }

    // Resolve pillar targets — body overrides → server strategy → defaults.
    const pillarTargets: PillarTargets = {
      triplesPct:     body.pillarTargets?.triplesPct     ?? strategy.triplesPct,
      cornerstonePct: body.pillarTargets?.cornerstonePct ?? strategy.cornerstonePct,
      incomePct:      body.pillarTargets?.incomePct      ?? strategy.incomePct,
      hedgePct:       body.pillarTargets?.hedgePct       ?? strategy.hedgePct,
    };

    // Apply CONFIG overrides by mutating a copy of the engine config in
    // place. The engine reads `CONFIG` directly so we have to use the live
    // export. We snapshot original values and restore them after the shadow
    // run — single-threaded server-side execution means no race.
    const overrides = body.configOverrides ?? {};
    const snapshotConfig: Record<string, unknown> = {};
    const writableConfig = PROD_CONFIG as unknown as Record<string, unknown>;

    const applyOverrides = (): void => {
      for (const [k, v] of Object.entries(overrides)) {
        if (k in writableConfig) {
          snapshotConfig[k] = writableConfig[k];
          writableConfig[k] = v;
        }
      }
    };
    const restoreOverrides = (): void => {
      for (const [k, v] of Object.entries(snapshotConfig)) {
        writableConfig[k] = v;
      }
    };

    // Build SPY-history series once — reused across both production and shadow runs.
    const spyByDate: Array<{ date: string; spy: number }> = realChronological
      .filter((s) => typeof s.spyClose === 'number' && (s.spyClose as number) > 0)
      .map((s) => ({
        date: new Date(s.savedAt).toISOString().slice(0, 10),
        spy:  s.spyClose as number,
      }));

    const buildInputs = (
      snap: typeof realChronological[number],
      state: SignalEngineState,
      dateIso: string,
    ): EngineInputs => {
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
      const spyHistory = spyByDate
        .filter((x) => x.date <= dateIso)
        .map((x) => x.spy)
        .slice(-25);
      const prices: Record<string, number> = {};
      for (const p of snap.positions ?? []) {
        if (p.shares > 0 && p.marketValue > 0) prices[p.symbol] = p.marketValue / p.shares;
      }
      if (typeof snap.spyClose === 'number') prices['SPY'] = snap.spyClose;
      const marginDebt    = Math.abs(snap.marginBalance ?? 0);
      const holdingsTotal = (snap.positions ?? []).reduce((s, p) => s + (p.marketValue || 0), 0);
      const cash          = Math.max(0, snap.equity - holdingsTotal + marginDebt);
      return {
        positions, cash, marginDebt, prices, spyHistory,
        vix:   20, state,
        pillarTargets,
        recentSells30d:       [],
        buyingPowerAvailable: cash,
      };
    };

    // ─── Production pass ────────────────────────────────────────────────────
    let prodState = defaultSignalState();
    const prodSignals: Array<{ rule: string; date: string }> = [];
    const prodFireByDate: Record<string, Set<string>> = {};
    for (const snap of realChronological) {
      const dateIso = new Date(snap.savedAt).toISOString().slice(0, 10);
      const r = runSignalEngine(buildInputs(snap, prodState, dateIso));
      prodState = r.nextState;
      const rulesToday = new Set<string>();
      for (const s of r.signals) {
        prodSignals.push({ rule: s.rule, date: dateIso });
        rulesToday.add(s.rule);
      }
      prodFireByDate[dateIso] = rulesToday;
    }

    // ─── Shadow pass ────────────────────────────────────────────────────────
    applyOverrides();
    let shadowState = defaultSignalState();
    const shadowSignals: Array<{ rule: string; date: string }> = [];
    const shadowFireByDate: Record<string, Set<string>> = {};
    try {
      for (const snap of realChronological) {
        const dateIso = new Date(snap.savedAt).toISOString().slice(0, 10);
        const r = runSignalEngine(buildInputs(snap, shadowState, dateIso));
        shadowState = r.nextState;
        const rulesToday = new Set<string>();
        for (const s of r.signals) {
          shadowSignals.push({ rule: s.rule, date: dateIso });
          rulesToday.add(s.rule);
        }
        shadowFireByDate[dateIso] = rulesToday;
      }
    } finally {
      restoreOverrides();
    }

    // ─── Diff ───────────────────────────────────────────────────────────────
    const production = countByRule(prodSignals);
    const shadow     = countByRule(shadowSignals);

    const allRules = new Set([
      ...Object.keys(production.byRule),
      ...Object.keys(shadow.byRule),
    ]);
    const added: Array<{ rule: string; n: number }> = [];
    const removed: Array<{ rule: string; n: number }> = [];
    const unchanged: Array<{ rule: string; n: number }> = [];
    for (const rule of allRules) {
      const p = production.byRule[rule] ?? 0;
      const s = shadow.byRule[rule] ?? 0;
      const delta = s - p;
      if      (delta > 0)  added.push({ rule,   n: delta });
      else if (delta < 0)  removed.push({ rule, n: -delta });
      else                 unchanged.push({ rule, n: p });
    }
    added.sort((a, b) => b.n - a.n);
    removed.sort((a, b) => b.n - a.n);

    // Day-level diff — only days where prod and shadow differ.
    const diffDays: DayDiff[] = [];
    const allDates = new Set([
      ...Object.keys(prodFireByDate),
      ...Object.keys(shadowFireByDate),
    ]);
    for (const date of Array.from(allDates).sort()) {
      const pSet = prodFireByDate[date]   ?? new Set<string>();
      const sSet = shadowFireByDate[date] ?? new Set<string>();
      const addedToday   = [...sSet].filter((r) => !pSet.has(r));
      const removedToday = [...pSet].filter((r) => !sSet.has(r));
      if (addedToday.length === 0 && removedToday.length === 0) continue;
      diffDays.push({
        date,
        productionFires: pSet.size,
        shadowFires:     sSet.size,
        addedRules:      addedToday,
        removedRules:    removedToday,
      });
    }

    return NextResponse.json({
      snapshotCount:   realChronological.length,
      configOverrides: overrides,
      pillarTargets,
      production,
      shadow,
      diff:            { added, removed, unchanged },
      diffDays,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[signals/shadow] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
