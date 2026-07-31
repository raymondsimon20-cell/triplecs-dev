'use client';

/**
 * TargetAllocationView — Tools → Allocation.
 *
 * Blended yield, bucket (pillar) allocations vs targets, rebalance insights,
 * a whole-share contribution calculator, and a scored ticker table.
 *
 * Scoring inputs (per the Vol-7 playbook):
 *   - Price vs 50-day SMA (below = accumulation zone)
 *   - NAV premium/discount (CLM/CRF via the cornerstone feed; 30%+ premium
 *     is the Vol-7 box/sell signal → hard Trim)
 *   - 12/24-month total return (price return + estimated distributions)
 *   - Margin maintenance % (lower frees more equity per dollar)
 *   - Distribution yield (credit capped at 40pp — decay-trap guard)
 *   - Catch-up need (bucket under its target gets a boost)
 *
 * Signals: Strong Add / Add / Neutral / Hold / Trim.
 *
 * Universe: every equity position, seeds included. Sub-$500 bookmarks are
 * scored precisely because scale-up decisions are what they exist for, but the
 * seed convention keeps them out of Trim/Hold — they aren't harvestable
 * positions, so a sell rating on one is not an action anyone can take.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Crosshair, RefreshCw, Calculator, Lightbulb, DollarSign, Layers, TrendingUp, AlertTriangle, Focus } from 'lucide-react';
import { StatCard as Stat } from '@/components/StatCard';
import { useSort, SortTh } from '@/components/sortable';
import type { AllocationRow } from '@/app/api/target-allocation/route';
import type { DividendRecord } from '@/components/DividendsView';
import { deriveCadence, annualiseFromHistory } from '@/lib/portfolio/dividend-cadence';

const fmt$ = (n: number, dec = 2) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const signedPct = (n: number, dec = 1) => (n >= 0 ? '+' : '') + n.toFixed(dec) + '%';
const plColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[#9aa2c0]');

type Signal = 'Strong Add' | 'Add' | 'Neutral' | 'Hold' | 'Trim';

/**
 * Sort rank for the Signal column. Sorting on raw score looks equivalent but
 * isn't: the 30% NAV-premium rule and the seed convention both override the
 * signal independently of score, so a forced Trim would otherwise sort as
 * though it were still top-rated.
 */
const SIGNAL_RANK: Record<Signal, number> = {
  'Strong Add': 5, 'Add': 4, 'Neutral': 3, 'Hold': 2, 'Trim': 1,
};

const SIGNAL_CLASS: Record<Signal, string> = {
  'Strong Add': 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
  'Add':        'bg-emerald-500/10 text-emerald-400/90 border border-emerald-500/15',
  'Neutral':    'bg-[#2d3248] text-[#9aa2c0] border border-transparent',
  'Hold':       'bg-yellow-500/10 text-yellow-300 border border-yellow-500/15',
  'Trim':       'bg-red-500/15 text-red-300 border border-red-500/25',
};

const PILLAR_LABEL: Record<string, string> = {
  triples: 'Triples', cornerstone: 'Cornerstone', income: 'Income', hedge: 'Hedge', other: 'Other',
};

export interface ScoredRow extends AllocationRow {
  navDiscPct: number | null;   // positive = premium, negative = discount
  tr12:       number | null;   // total return incl. est. distributions
  tr24:       number | null;
  score:      number;
  signal:     Signal;
  catchUp:    boolean;
  /** Yield actually used for scoring — derived from payments where possible. */
  effYieldPct:   number;
  effYieldSource: 'derived' | AllocationRow['yieldSource'];
}

interface PillarSummaryRow { pillar: string; totalValue: number }

interface Props {
  accountHash?:   string;
  totalValue:     number;
  pillarSummary:  PillarSummaryRow[];
  targets:        { triplesPct: number; cornerstonePct: number; incomePct: number; hedgePct: number };
  /** Dividend payment history, used to derive real yields. Optional — falls
   *  back to Schwab's quoted yield and the static table when absent. */
  dividends?:     DividendRecord[];
}

/**
 * Sanity bound on derived yield. A payment-history yield can blow up when the
 * share count grew sharply mid-window (trailing payments were earned on far
 * fewer shares than are held now) or when a special distribution lands in the
 * sample. Past this, trust the quoted figure instead of a number built from a
 * distorted denominator.
 */
const MAX_DERIVED_YIELD_PCT = 150;

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreRow(
  r: AllocationRow,
  navDiscPct: number | null,
  catchUp: boolean,
  overweight: boolean,
  /** Yield to score on — payment-derived where available, else r.yieldPct. */
  effYieldPct: number,
): { score: number; signal: Signal; tr12: number | null; tr24: number | null } {
  let score = 50;

  // vs 50-day SMA — below the average is the accumulation zone.
  if (r.vsSma50Pct !== null) {
    if (r.vsSma50Pct <= -10)     score += 15;
    else if (r.vsSma50Pct <= -3) score += 10;
    else if (r.vsSma50Pct <= 3)  score += 3;
    else if (r.vsSma50Pct <= 10) score -= 5;
    else                         score -= 10;
  }

  // NAV premium/discount (CEFs with data).
  if (navDiscPct !== null) {
    if (navDiscPct <= -5)      score += 10;
    else if (navDiscPct <= 0)  score += 5;
    else if (navDiscPct <= 15) score += 0;
    else if (navDiscPct <= 30) score -= 5;
    else                       score -= 15;
  }

  // Total return incl. estimated distributions.
  const tr12 = r.ret12Pct !== null ? r.ret12Pct + effYieldPct : null;
  const tr24 = r.ret24Pct !== null ? r.ret24Pct + effYieldPct * 2 : null;
  if (tr12 !== null) {
    if (tr12 > 10)       score += 8;
    else if (tr12 > 0)   score += 4;
    else if (tr12 > -10) score -= 4;
    else                 score -= 10;
  }
  if (tr24 !== null) {
    if (tr24 > 20)     score += 5;
    else if (tr24 > 0) score += 2;
    else               score -= 5;
  }

  // Yield credit, capped at 40pp so decay traps can't buy the top rank.
  score += (Math.min(effYieldPct, 40) / 40) * 15;

  // Margin maintenance — low-maintenance names free more equity per dollar.
  score += Math.max(-10, Math.min(10, ((60 - r.maintenancePct) / 60) * 10));

  // Catch-up: this ticker's bucket is under target → contributions belong here.
  if (catchUp) score += 8;
  if (overweight) score -= 8;

  score = Math.round(Math.max(0, Math.min(100, score)));

  // Hard override: Vol-7 box/sell rule at 30%+ NAV premium.
  let signal: Signal;
  if (navDiscPct !== null && navDiscPct > 30) signal = 'Trim';
  else if (score >= 72) signal = 'Strong Add';
  else if (score >= 58) signal = 'Add';
  else if (score >= 45) signal = 'Neutral';
  else if (score >= 32) signal = 'Hold';
  else signal = 'Trim';

  // Seed convention: 1-share universe bookmarks are scale-up candidates only —
  // never rated below Neutral (they aren't harvestable positions).
  if (r.isSeed && (signal === 'Hold' || signal === 'Trim')) signal = 'Neutral';

  return { score, signal, tr12, tr24 };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TargetAllocationView({ accountHash, totalValue, pillarSummary, targets, dividends = [] }: Props) {
  const [rows, setRows]         = useState<AllocationRow[]>([]);
  const [navMap, setNavMap]     = useState<Record<string, number>>({});
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [contribution, setContribution] = useState('');

  // Focus mode — concentrate the table + calculator on the top-N scored
  // tickers. Persisted so the preference survives reloads.
  const [focus, setFocus]   = useState<boolean>(() => {
    try { return localStorage.getItem('triple-c-alloc-focus') === '1'; } catch { return false; }
  });
  const [focusN, setFocusN] = useState<number>(() => {
    try { const n = Number(localStorage.getItem('triple-c-alloc-focus-n')); return [5, 10, 15].includes(n) ? n : 10; } catch { return 10; }
  });
  const toggleFocus = () => setFocus((v) => {
    try { localStorage.setItem('triple-c-alloc-focus', v ? '0' : '1'); } catch { /* ignore */ }
    return !v;
  });
  const pickFocusN = (n: number) => {
    setFocusN(n);
    try { localStorage.setItem('triple-c-alloc-focus-n', String(n)); } catch { /* ignore */ }
  };

  const [pending, setPending] = useState(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (accountHash) params.set('accountHash', accountHash);
      const [allocRes, navRes] = await Promise.all([
        fetch(`/api/target-allocation?${params.toString()}`),
        fetch('/api/cornerstone').catch(() => null),
      ]);
      if (!allocRes.ok) throw new Error(`HTTP ${allocRes.status}`);
      const alloc = await allocRes.json() as { rows?: AllocationRow[]; pending?: number };
      setRows(Array.isArray(alloc.rows) ? alloc.rows : []);
      setPending(alloc.pending ?? 0);
      if (navRes?.ok) {
        const nav = await navRes.json() as { funds?: { ticker: string; premiumDiscount: number }[] };
        const m: Record<string, number> = {};
        for (const f of nav.funds ?? []) {
          if (f.ticker && typeof f.premiumDiscount === 'number') m[f.ticker.toUpperCase()] = f.premiumDiscount;
        }
        setNavMap(m);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load allocation metrics');
    } finally {
      setLoading(false);
    }
  }, [accountHash]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Progressive warm-up: each request scores ~40 more tickers' history; keep
  // polling until the whole universe is warm.
  useEffect(() => {
    if (pending <= 0 || loading || error) return;
    const t = setTimeout(() => fetchData(), 2_000);
    return () => clearTimeout(t);
  }, [pending, loading, error, fetchData]);

  // ── Bucket state vs targets ─────────────────────────────────────────────────
  const buckets = useMemo(() => {
    const actual: Record<string, number> = { triples: 0, cornerstone: 0, income: 0, hedge: 0, other: 0 };
    for (const p of pillarSummary) actual[p.pillar] = (actual[p.pillar] ?? 0) + p.totalValue;
    const targetPct: Record<string, number> = {
      triples: targets.triplesPct, cornerstone: targets.cornerstonePct,
      income: targets.incomePct, hedge: targets.hedgePct, other: 0,
    };
    return (['income', 'cornerstone', 'triples', 'hedge'] as const).map((pillar) => {
      const actual$ = actual[pillar] ?? 0;
      const actualPct = totalValue > 0 ? (actual$ / totalValue) * 100 : 0;
      const gapPp = targetPct[pillar] - actualPct;
      return { pillar, actual$, actualPct, targetPct: targetPct[pillar], gapPp, gap$: (gapPp / 100) * totalValue };
    });
  }, [pillarSummary, targets, totalValue]);

  const underTarget = useMemo(() => new Set(buckets.filter((b) => b.gapPp > 2).map((b) => b.pillar as string)), [buckets]);
  const overTarget  = useMemo(() => new Set(buckets.filter((b) => b.gapPp < -2).map((b) => b.pillar as string)), [buckets]);

  // ── Payment-derived yields ──────────────────────────────────────────────────
  // The API's yieldPct comes from Schwab's quoted divYield with a static
  // fallback table. Both go stale — the same problem that had the YieldMax
  // weeklies projected at a quarter of their real income. Where we have enough
  // payment history to establish a cadence, annualising observed payments is
  // strictly better evidence than a quoted number.
  const derivedYieldBySymbol = useMemo(() => {
    if (dividends.length === 0) return new Map<string, number>();

    const bySymbol = new Map<string, { date: string; amount: number }[]>();
    for (const d of dividends) {
      const list = bySymbol.get(d.symbol) ?? [];
      list.push({ date: d.date, amount: d.amount });
      bySymbol.set(d.symbol, list);
    }

    const out = new Map<string, number>();
    for (const r of rows) {
      const history = bySymbol.get(r.symbol);
      if (!history || history.length < 2 || r.marketValue <= 0) continue;

      const cadence = deriveCadence(history.map((h) => h.date));
      // Only trust a cadence we actually measured. A fallback cadence would
      // just reintroduce the static table through a longer path.
      if (!cadence.derived) continue;

      const annual = annualiseFromHistory(history, cadence);
      if (annual <= 0) continue;

      const pct = (annual / r.marketValue) * 100;
      if (!Number.isFinite(pct) || pct <= 0 || pct > MAX_DERIVED_YIELD_PCT) continue;
      out.set(r.symbol, Math.round(pct * 100) / 100);
    }
    return out;
  }, [dividends, rows]);

  // ── Scored rows ─────────────────────────────────────────────────────────────
  const scored: ScoredRow[] = useMemo(() => rows.map((r) => {
    const navDiscPct = navMap[r.symbol] ?? null;
    const catchUp    = underTarget.has(r.pillar);
    const over       = overTarget.has(r.pillar);

    const derived = derivedYieldBySymbol.get(r.symbol);
    const effYieldPct = derived ?? r.yieldPct;
    const effYieldSource: ScoredRow['effYieldSource'] = derived !== undefined ? 'derived' : r.yieldSource;

    const s = scoreRow(r, navDiscPct, catchUp, over, effYieldPct);
    return { ...r, navDiscPct, catchUp, effYieldPct, effYieldSource, ...s };
  }), [rows, navMap, underTarget, overTarget, derivedYieldBySymbol]);

  // Top-N scored symbols for focus mode.
  const focusedSet = useMemo(() => {
    const top = [...scored].sort((a, b) => b.score - a.score).slice(0, focusN);
    return new Set(top.map((r) => r.symbol));
  }, [scored, focusN]);

  const visibleScored = useMemo(
    () => (focus ? scored.filter((r) => focusedSet.has(r.symbol)) : scored),
    [scored, focus, focusedSet],
  );

  const { sortKey, sortDir, requestSort, sortRows } = useSort<ScoredRow>('score');
  const tableRows = useMemo(() => sortRows(visibleScored, {
    symbol: (r) => r.symbol,
    pillar: (r) => r.pillar,
    score:  (r) => r.score,
    // Tie-break within a signal band by score, so the order stays meaningful.
    signal: (r) => SIGNAL_RANK[r.signal] * 1000 + r.score,
    sma:    (r) => r.vsSma50Pct ?? Number.NEGATIVE_INFINITY,
    tr12:   (r) => r.tr12 ?? Number.NEGATIVE_INFINITY,
    tr24:   (r) => r.tr24 ?? Number.NEGATIVE_INFINITY,
    yield:  (r) => r.effYieldPct,
    nav:    (r) => r.navDiscPct ?? Number.NEGATIVE_INFINITY,
    margin: (r) => r.maintenancePct,
  }), [visibleScored, sortRows]);

  // ── Blended yield (scored universe, value-weighted) ────────────────────────
  const blended = useMemo(() => {
    let v = 0, y = 0;
    for (const r of scored) { v += r.marketValue; y += r.marketValue * (r.effYieldPct / 100); }
    return v > 0 ? (y / v) * 100 : 0;
  }, [scored]);

  // ── Rebalance insights ──────────────────────────────────────────────────────
  const insights = useMemo(() => {
    const out: { text: string; warn?: boolean }[] = [];
    for (const b of buckets) {
      if (b.gapPp > 2)  out.push({ text: `${PILLAR_LABEL[b.pillar]} is ${b.gapPp.toFixed(1)}pp under target — needs ~${fmt$(Math.abs(b.gap$), 0)} of catch-up contributions.` });
      if (b.gapPp < -2) out.push({ text: `${PILLAR_LABEL[b.pillar]} is ${Math.abs(b.gapPp).toFixed(1)}pp over target (${fmt$(Math.abs(b.gap$), 0)} excess) — trim on up days per Vol-7.`, warn: true });
    }
    const strongAdds = scored.filter((r) => r.signal === 'Strong Add').map((r) => r.symbol);
    if (strongAdds.length) out.push({ text: `Strong Add: ${strongAdds.join(', ')} — best-scored homes for new capital.` });
    const trims = scored.filter((r) => r.signal === 'Trim').map((r) => r.symbol);
    if (trims.length) out.push({ text: `Trim candidates: ${trims.join(', ')}.`, warn: true });
    for (const r of scored) {
      if (r.navDiscPct === null || r.navDiscPct <= 30) continue;
      // Seeds get their Trim upgraded to Neutral in the table, so telling the
      // user to box/sell one here would contradict the row they're looking at.
      // The premium still matters for a seed — it argues against scaling up —
      // so the warning stays, worded as the action actually available.
      out.push(r.isSeed
        ? { text: `${r.symbol} (seed) trades at a ${r.navDiscPct.toFixed(1)}% NAV premium — above the Vol-7 30% threshold, so hold off on scaling this one up.`, warn: true }
        : { text: `${r.symbol} trades at a ${r.navDiscPct.toFixed(1)}% NAV premium — Vol-7 box/sell threshold (30%) breached.`, warn: true });
    }
    if (out.length === 0) out.push({ text: 'All buckets within 2pp of target and no signal outliers — nothing urgent.' });
    return out;
  }, [buckets, scored]);

  // ── Whole-share contribution calculator ─────────────────────────────────────
  const plan = useMemo(() => {
    const cash = Number(contribution);
    if (!Number.isFinite(cash) || cash <= 0) return null;

    // 1. Split the contribution across buckets in proportion to how far each is
    //    below its target, measured against the post-contribution total.
    const newTotal = totalValue + cash;
    const gaps = buckets.map((b) => ({
      pillar: b.pillar as string,
      gap: Math.max(0, (b.targetPct / 100) * newTotal - b.actual$),
    }));
    const gapSum = gaps.reduce((s, g) => s + g.gap, 0);
    const bucketAlloc: Record<string, number> = {};

    // Every bucket at or above target. Previously this dumped the entire
    // contribution into Income, which is an arbitrary choice that quietly
    // overweights one bucket. Split by target weights instead, so a deposit
    // made when you're already balanced preserves the balance.
    const allAtTarget = gapSum <= 0;
    if (allAtTarget) {
      const targetSum = buckets.reduce((s, b) => s + b.targetPct, 0);
      for (const b of buckets) {
        if (targetSum > 0) bucketAlloc[b.pillar as string] = cash * (b.targetPct / targetSum);
      }
    } else {
      // Cap each bucket at the dollars needed to reach its target; anything
      // left over stays unassigned rather than being forced somewhere.
      for (const g of gaps) {
        bucketAlloc[g.pillar] = Math.min(g.gap, (g.gap / gapSum) * cash);
      }
    }

    // 2. Within each bucket: top-scored addable tickers (max 3), score-weighted,
    //    whole shares only.
    const buys = new Map<string, { shares: number; price: number; score: number; signal: Signal; pillar: string }>();
    const bucketDetail: { pillar: string; allocated: number; deployed: number; reason?: string }[] = [];
    let spent = 0;

    for (const [pillar, alloc] of Object.entries(bucketAlloc)) {
      if (alloc < 1) continue;
      const candidates = scored
        .filter((r) => r.pillar === pillar && (r.signal === 'Strong Add' || r.signal === 'Add') && r.price > 0)
        .filter((r) => !focus || focusedSet.has(r.symbol))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (candidates.length === 0) {
        bucketDetail.push({
          pillar, allocated: alloc, deployed: 0,
          reason: focus ? 'no Add-rated candidates in focus set' : 'no Add-rated candidates',
        });
        continue;
      }

      const wSum = candidates.reduce((s, c) => s + c.score, 0);
      let bucketSpent = 0;
      for (const c of candidates) {
        const dollars = alloc * (c.score / wSum);
        const shares = Math.floor(dollars / c.price);
        if (shares <= 0) continue;
        const prev = buys.get(c.symbol);
        buys.set(c.symbol, { shares: (prev?.shares ?? 0) + shares, price: c.price, score: c.score, signal: c.signal, pillar });
        bucketSpent += shares * c.price;
      }
      spent += bucketSpent;
      bucketDetail.push({
        pillar, allocated: alloc, deployed: bucketSpent,
        reason: bucketSpent === 0 ? 'share prices exceed the bucket allocation' : undefined,
      });
    }

    // No greedy sweep. Buying single shares of the top-scored name until the
    // cash runs out concentrates the residual into one ticker and discards the
    // bucket split computed above — in the all-at-target case it could route the
    // entire deposit into one symbol. Unspent cash is reported as cash.
    const list = [...buys.entries()]
      .map(([symbol, b]) => ({ symbol, ...b, cost: b.shares * b.price }))
      .sort((a, b) => b.cost - a.cost);

    return {
      list, spent, leftover: cash - spent, cash, allAtTarget,
      bucketDetail: bucketDetail.sort((a, b) => b.allocated - a.allocated),
    };
  }, [contribution, buckets, scored, totalValue, focus, focusedSet]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
          <Crosshair className="w-[18px] h-[18px] text-violet-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Target Allocation</h1>
          <p className="text-xs text-[#7c82a0] mt-0.5">Scored universe, bucket targets, and a whole-share contribution planner</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {focus && (
            <div className="flex items-center gap-0.5">
              {[5, 10, 15].map((n) => (
                <button
                  key={n}
                  onClick={() => pickFocusN(n)}
                  className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                    focusN === n ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30' : 'text-[#7c82a0] hover:text-white border border-transparent'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={toggleFocus}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
              focus
                ? 'bg-violet-600/20 text-violet-300 border-violet-500/40'
                : 'text-[#7c82a0] hover:text-white border-[#2d3248]'
            }`}
            title="Concentrate the table and calculator on the top-scored tickers"
          >
            <Focus className="w-3.5 h-3.5" />
            Focus {focus ? 'on' : 'off'}
          </button>
          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-[#7c82a0] hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {focus && (
        <div className="flex items-center gap-2 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2 text-xs text-violet-200">
          <Focus className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            Focus mode: showing the top {focusN} of {scored.length} scored tickers — the calculator
            only deploys into these names.
          </span>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/25 text-red-300 text-xs rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />{error}
        </div>
      )}

      {pending > 0 && (
        <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-200">
          <div className="w-3.5 h-3.5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin flex-shrink-0" />
          <span>
            Warming up price history for the full universe — {pending} ticker{pending === 1 ? '' : 's'} remaining.
            Scores refine automatically as metrics land.
          </span>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={DollarSign} label="Est. Blended Yield" value={`${blended.toFixed(2)}%`} sub="value-weighted, scored universe" valueClass="text-emerald-400" accentClass="border-t-violet-500/60" index={0} />
        <Stat icon={Layers} label="Scored Tickers" value={String(scored.length)} sub="full universe · seeds never rated below Neutral" accentClass="border-t-violet-500/60" index={1} />
        <Stat icon={TrendingUp} label="Strong Add / Add" value={String(scored.filter((r) => r.signal === 'Strong Add' || r.signal === 'Add').length)} accentClass="border-t-violet-500/60" index={2} />
        <Stat icon={AlertTriangle} label="Hold / Trim" value={String(scored.filter((r) => r.signal === 'Hold' || r.signal === 'Trim').length)} iconClass="text-orange-400/60" accentClass="border-t-violet-500/60" index={3} />
      </div>

      {/* Bucket allocations */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4 space-y-3">
        <span className="text-sm font-semibold text-white">Bucket Allocations</span>
        {buckets.map((b) => (
          <div key={b.pillar} className="space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-[#9aa2c0]">{PILLAR_LABEL[b.pillar]}</span>
              <span className="tabular-nums text-[#7c82a0]">
                {b.actualPct.toFixed(1)}% / {b.targetPct}% target ·{' '}
                <span className={b.gapPp > 2 ? 'text-emerald-400' : b.gapPp < -2 ? 'text-orange-300' : 'text-[#4a5070]'}>
                  {b.gapPp > 0 ? `${fmt$(b.gap$, 0)} to add` : b.gapPp < 0 ? `${fmt$(Math.abs(b.gap$), 0)} over` : 'on target'}
                </span>
              </span>
            </div>
            <div className="relative w-full h-2.5 bg-[#1f2334] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${b.gapPp < -2 ? 'bg-orange-500/80' : 'bg-blue-500/80'}`}
                style={{ width: `${Math.min((b.actualPct / Math.max(b.targetPct, 1)) * 100, 100)}%` }}
              />
              <div className="absolute top-0 bottom-0 w-px bg-white/40" style={{ left: '100%' }} />
            </div>
          </div>
        ))}
      </div>

      {/* Insights + calculator side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <Lightbulb className="w-4 h-4 text-yellow-300" />
            <span className="text-sm font-semibold text-white">Rebalance Insights</span>
          </div>
          {insights.map((i, idx) => (
            <div key={idx} className={`text-xs leading-relaxed flex gap-2 ${i.warn ? 'text-orange-200' : 'text-[#9aa2c0]'}`}>
              <span className="flex-shrink-0">{i.warn ? '⚠' : '•'}</span>
              <span>{i.text}</span>
            </div>
          ))}
        </div>

        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold text-white">Rebalance Calculator</span>
            <span className="text-[10px] text-[#4a5070]">whole shares only</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#7c82a0]">Contribution $</span>
            <input
              type="number"
              min="0"
              value={contribution}
              onChange={(e) => setContribution(e.target.value)}
              placeholder="e.g. 5000"
              className="w-32 bg-[#0f1117] border border-[#1f2334] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 tabular-nums"
            />
          </div>
          {plan && plan.list.length > 0 && (
            <div className="space-y-1.5">
              {plan.list.map((b) => (
                <div key={b.symbol} className="flex items-center gap-2 text-xs">
                  <span className="w-14 font-mono font-semibold text-white">{b.symbol}</span>
                  <span className="text-[10px] text-[#4a5070] w-20">{PILLAR_LABEL[b.pillar]}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${SIGNAL_CLASS[b.signal]}`}>{b.signal}</span>
                  <span className="ml-auto tabular-nums text-[#9aa2c0]">{b.shares} × {fmt$(b.price)}</span>
                  <span className="w-20 text-right tabular-nums text-white">{fmt$(b.cost)}</span>
                </div>
              ))}
              <div className="border-t border-[#1f2334] pt-1.5 flex justify-between text-xs font-semibold">
                <span className="text-[#7c82a0]">Deployed</span>
                <span className="text-white tabular-nums">{fmt$(plan.spent)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#7c82a0]">Cash remaining</span>
                <span className="text-[#9aa2c0] tabular-nums">{fmt$(plan.leftover)}</span>
              </div>

              {/* Where the money went, and why any of it didn't. Whole-share
                  rounding always leaves a remainder; naming the cause keeps it
                  from looking like the planner silently dropped cash. */}
              {plan.leftover > 1 && (
                <div className="border-t border-[#1f2334] pt-1.5 mt-1.5 space-y-1">
                  <div className="text-[10px] text-[#7c82a0]">
                    {fmt$(plan.leftover)} unallocated — held as cash rather than forced into whole shares.
                  </div>
                  {plan.bucketDetail.filter((d) => d.reason).map((d) => (
                    <div key={d.pillar} className="text-[10px] text-[#4a5070]">
                      {PILLAR_LABEL[d.pillar] ?? d.pillar}: {fmt$(d.allocated, 0)} allocated, none deployed — {d.reason}.
                    </div>
                  ))}
                </div>
              )}

              {plan.allAtTarget && (
                <p className="text-[10px] text-[#4a5070] pt-1">
                  All buckets are at or above target, so this splits by target weights to preserve the
                  current mix rather than favoring any one bucket.
                </p>
              )}
            </div>
          )}
          {plan && plan.list.length === 0 && (
            <div className="space-y-1">
              <p className="text-xs text-[#4a5070]">
                Nothing to buy at {fmt$(plan.cash, 0)} — the full amount stays in cash.
              </p>
              {plan.bucketDetail.filter((d) => d.reason).map((d) => (
                <p key={d.pillar} className="text-[10px] text-[#4a5070]">
                  {PILLAR_LABEL[d.pillar] ?? d.pillar}: {fmt$(d.allocated, 0)} allocated — {d.reason}.
                </p>
              ))}
            </div>
          )}
          {!plan && <p className="text-[10px] text-[#4a5070]">Enter an amount to see a score-weighted, bucket-aware buy plan. Informational only — stage orders through the normal workflow.</p>}
        </div>
      </div>

      {/* Scored table */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1a1e2e]">
                <SortTh id="symbol" label="Ticker"    first sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="pillar" label="Bucket"    sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="score"  label="Score"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="signal" label="Signal"    sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="sma"    label="vs 50 SMA" align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="tr12"   label="12 MO"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="tr24"   label="24 MO"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="yield"  label="Yield"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="nav"    label="NAV Disc"  align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="margin" label="Margin"    align="right" last sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={10} className="px-4 py-6 text-[#4a5070]">Computing metrics (price history for the whole universe — first load takes a moment)…</td></tr>}
              {!loading && tableRows.length === 0 && !error && (
                <tr><td colSpan={10} className="px-4 py-6 text-[#4a5070]">
                  {focus ? 'No positions in the current focus set.' : 'No equity positions found to score.'}
                </td></tr>
              )}
              {tableRows.map((r) => (
                <tr key={r.symbol} className="border-b border-[#1a1e2e] hover:bg-[#161a28]">
                  <td className="px-4 py-2 font-mono font-semibold text-white whitespace-nowrap">
                    {r.symbol}
                    {r.isSeed && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-[#2d3248] text-[#7c82a0] font-sans" title="1-share universe bookmark — scale-up candidate">seed</span>}
                    {r.catchUp && <span className="ml-1.5 text-[9px] text-emerald-400/80" title="Bucket under target — catch-up contributions favored">↑</span>}
                  </td>
                  <td className="px-2 py-2 text-[#9aa2c0]">{PILLAR_LABEL[r.pillar] ?? r.pillar}</td>
                  <td className="px-2 py-2 text-right">
                    <span className={`tabular-nums font-semibold ${r.score >= 58 ? 'text-emerald-400' : r.score >= 45 ? 'text-[#9aa2c0]' : 'text-orange-300'}`}>{r.score}</span>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${SIGNAL_CLASS[r.signal]}`}>{r.signal}</span>
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${r.vsSma50Pct !== null ? plColor(-r.vsSma50Pct) : 'text-[#4a5070]'}`}>
                    {r.vsSma50Pct !== null ? signedPct(r.vsSma50Pct) : '—'}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${r.tr12 !== null ? plColor(r.tr12) : 'text-[#4a5070]'}`}>
                    {r.tr12 !== null ? signedPct(r.tr12) : '—'}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${r.tr24 !== null ? plColor(r.tr24) : 'text-[#4a5070]'}`}>
                    {r.tr24 !== null ? signedPct(r.tr24) : '—'}
                  </td>
                  <td
                    className={`px-2 py-2 text-right tabular-nums ${r.effYieldSource === 'derived' ? 'text-emerald-400/90' : 'text-emerald-400/50'}`}
                    title={
                      r.effYieldSource === 'derived'
                        ? `Derived from actual payments${derivedYieldBySymbol.has(r.symbol) && r.yieldPct > 0 ? ` — quoted yield is ${r.yieldPct.toFixed(1)}%` : ''}`
                        : r.effYieldSource === 'live' ? 'Schwab quoted yield'
                        : r.effYieldSource === 'fallback' ? 'Static fallback table — no live or payment data'
                        : 'No yield data'
                    }
                  >
                    {r.effYieldPct > 0 ? `${r.effYieldPct.toFixed(1)}%` : '—'}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${r.navDiscPct !== null ? (r.navDiscPct > 30 ? 'text-red-400' : r.navDiscPct < 0 ? 'text-emerald-400' : 'text-[#9aa2c0]') : 'text-[#4a5070]'}`}>
                    {r.navDiscPct !== null ? signedPct(r.navDiscPct) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#9aa2c0]">{r.maintenancePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[10px] text-[#4a5070] leading-relaxed">
        Score = 50-day SMA position + NAV premium/discount (where available) + 12/24-month total return
        (price return + estimated distributions) + yield (capped at 40pp) + margin maintenance + bucket
        catch-up need. NAV data covers CLM/CRF via the Cornerstone feed. Seeds (sub-$500 bookmarks) are
        scored as scale-up candidates but never rated below Neutral. Informational — signals do not
        stage orders.
      </p>
    </div>
  );
}
