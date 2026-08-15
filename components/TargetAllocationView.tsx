'use client';

/**
 * TargetAllocationView — Tools → Allocation.
 *
 * Blended yield, bucket (pillar) allocations vs targets, rebalance insights,
 * a whole-share contribution calculator, and a scored ticker table.
 *
 * Bucket targets are editable inline. Edits live in a draft that every figure
 * on the page reads, so drift, insights and the contribution plan all preview
 * the change before it's saved; Save writes at the current account scope (or
 * global on the combined view) via updateStrategyTargets.
 *
 * The calculator's suggestions can be placed as MARKET buys through
 * /api/orders — same path RebalanceWorkflow uses — after unchecking names,
 * adjusting share counts, and passing an explicit review step. That review
 * runs the batch through /api/orders/preflight first, so the guardrail layer
 * (post-trade AFW floor, concentration, margin, wash-sale) applies here even
 * though /api/orders itself doesn't enforce it. Blocked orders are dropped
 * from the batch; warnings must be acknowledged before placing.
 *
 * Scoring inputs (per the Vol-7 playbook):
 *   - Price vs a selectable 50/100/200-day SMA (below = accumulation zone)
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
import { Crosshair, RefreshCw, Calculator, Lightbulb, DollarSign, Layers, TrendingUp, AlertTriangle, Focus, SlidersHorizontal, ShoppingCart } from 'lucide-react';
import { StatCard as Stat } from '@/components/StatCard';
import { useSort, SortTh } from '@/components/sortable';
import type { AllocationRow } from '@/app/api/target-allocation/route';
import type { DividendRecord } from '@/components/DividendsView';
import { deriveCadence, annualiseFromHistory } from '@/lib/portfolio/dividend-cadence';
import { SMA_PERIODS, DEFAULT_SMA_PERIOD, SMA_PERIOD_HELP, type SmaPeriod } from '@/lib/portfolio/sma';
import { useStrategyTargets, updateStrategyTargets } from '@/components/SettingsPanel';

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
  growth: 'Growth', cornerstone: 'CEFs', income: 'High Yield', triples: 'Leveraged', other: 'Other',
};

/** The four bucket target fields, and the pillar each one governs. */
type TargetKey = 'growthPct' | 'cornerstonePct' | 'incomePct' | 'triplesPct';
type BucketTargets = Record<TargetKey, number>;

const TARGET_KEYS: TargetKey[] = ['incomePct', 'cornerstonePct', 'growthPct', 'triplesPct'];

const PILLAR_TARGET_KEY: Record<string, TargetKey> = {
  growth: 'growthPct', cornerstone: 'cornerstonePct', income: 'incomePct', triples: 'triplesPct',
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
  /** Price vs the *selected* moving average — the value the SMA factor scored.
   *  Distinct from AllocationRow.vsSmaPct, which holds every period. */
  vsSmaSelectedPct: number | null;
}

interface PillarSummaryRow { pillar: string; totalValue: number }

// ─── Guardrail preflight ──────────────────────────────────────────────────────
// Response shape of POST /api/orders/preflight. See that route for why manual
// placements have to opt into the guardrail layer explicitly.

interface PreflightViolation {
  code:     string;
  message:  string;
  severity: 'block' | 'warn';
}

interface PreflightRow {
  symbol:     string;
  allowed:    boolean;
  violations: PreflightViolation[];
}

interface PreflightResponse {
  results:      PreflightRow[];
  allowedCount: number;
  blockedCount: number;
  warnCount:    number;
  context: {
    afwDollars:          number;
    projectedAfwDollars: number;
    totalValue:          number;
    marginBalance:       number;
  };
}

interface Props {
  accountHash?:   string;
  totalValue:     number;
  pillarSummary:  PillarSummaryRow[];
  targets:        BucketTargets;
  /** Dividend payment history, used to derive real yields. Optional — falls
   *  back to Schwab's quoted yield and the static table when absent. */
  dividends?:     DividendRecord[];
  /** Dollars to pre-fill the contribution calculator with, from the tracker. */
  prefillContribution?: number;
  /** Changes on each hand-off so repeat clicks of the same amount re-fill. */
  prefillKey?:    number;
}

/**
 * Sanity bound on derived yield. A payment-history yield can blow up when the
 * share count grew sharply mid-window (trailing payments were earned on far
 * fewer shares than are held now) or when a special distribution lands in the
 * sample. Past this, trust the quoted figure instead of a number built from a
 * distorted denominator.
 */
const MAX_DERIVED_YIELD_PCT = 150;

// ─── Scoring weights ──────────────────────────────────────────────────────────

/**
 * The six scoring factors, as user-adjustable weights.
 *
 * Each factor contributes a normalised −1…+1 signal; the weight sets how many
 * points that signal is worth. Weights are relative and are normalised to a
 * fixed total swing so raising one factor genuinely trades off against the
 * others rather than just inflating every score.
 */
export interface ScoringWeights {
  sma:         number;  // price vs moving average — below = accumulation zone
  nav:         number;  // CEF premium/discount
  totalReturn: number;  // 12/24-month total return
  yieldW:      number;  // distribution yield
  maintenance: number;  // margin maintenance efficiency
  catchUp:     number;  // bucket under/over its target
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  sma: 15, nav: 10, totalReturn: 13, yieldW: 15, maintenance: 10, catchUp: 8,
};

const WEIGHT_LABELS: Record<keyof ScoringWeights, string> = {
  sma:         'vs Moving Avg',
  nav:         'NAV Disc/Prem',
  totalReturn: 'Total Return',
  yieldW:      'Yield',
  maintenance: 'Margin Efficiency',
  catchUp:     'Catch-Up',
};

const WEIGHT_HELP: Record<keyof ScoringWeights, string> = {
  sma:         'Rewards buying below the moving average.',
  nav:         'Rewards discounts, penalises premiums. CEFs only.',
  totalReturn: 'Price return plus estimated distributions, 12 and 24 month.',
  yieldW:      'Distribution yield. Credit is capped at 40pp regardless of weight — a decay trap paying 90% cannot buy the top rank.',
  maintenance: 'Lower margin maintenance frees more equity per dollar.',
  catchUp:     'Boosts tickers whose bucket is under target; penalises over-target buckets.',
};

const WEIGHTS_KEY = 'triple-c-alloc-weights';

/** Total point swing shared across the factors — keeps scores comparable as weights move. */
const WEIGHT_BUDGET = 71;   // sum of DEFAULT_WEIGHTS

function normaliseWeights(w: ScoringWeights): ScoringWeights {
  const sum = Object.values(w).reduce((s, v) => s + Math.max(0, v), 0);
  if (sum <= 0) return DEFAULT_WEIGHTS;
  const k = WEIGHT_BUDGET / sum;
  return {
    sma:         Math.max(0, w.sma) * k,
    nav:         Math.max(0, w.nav) * k,
    totalReturn: Math.max(0, w.totalReturn) * k,
    yieldW:      Math.max(0, w.yieldW) * k,
    maintenance: Math.max(0, w.maintenance) * k,
    catchUp:     Math.max(0, w.catchUp) * k,
  };
}

function loadWeights(): ScoringWeights {
  try {
    const raw = localStorage.getItem(WEIGHTS_KEY);
    if (!raw) return DEFAULT_WEIGHTS;
    const parsed = JSON.parse(raw) as Partial<ScoringWeights>;
    return { ...DEFAULT_WEIGHTS, ...parsed };
  } catch { return DEFAULT_WEIGHTS; }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreRow(
  r: AllocationRow,
  navDiscPct: number | null,
  catchUp: boolean,
  overweight: boolean,
  /** Yield to score on — payment-derived where available, else r.yieldPct. */
  effYieldPct: number,
  w: ScoringWeights,
  /** Price vs the selected moving average, in percent. Null when unavailable. */
  vsSmaPct: number | null,
): { score: number; signal: Signal; tr12: number | null; tr24: number | null } {
  let score = 50;

  // Each factor produces a −1…+1 signal, then scales by its weight. The band
  // thresholds are unchanged from the fixed-point version; only the magnitude
  // is now user-controlled.

  // vs moving average — below the average is the accumulation zone.
  // Fractions are exact (2/3, 1/5, …) rather than rounded decimals so that at
  // default weights this reproduces the previous fixed-point scores exactly.
  // Approximating them drifted results by a point, which is enough to flip a
  // signal band at its boundary.
  if (vsSmaPct !== null) {
    const s = vsSmaPct <= -10 ? 1
            : vsSmaPct <= -3  ? 2 / 3
            : vsSmaPct <= 3   ? 1 / 5
            : vsSmaPct <= 10  ? -1 / 3
            :                   -2 / 3;
    score += s * w.sma;
  }

  // NAV premium/discount (CEFs with data).
  if (navDiscPct !== null) {
    const s = navDiscPct <= -5 ? 1
            : navDiscPct <= 0  ? 0.5
            : navDiscPct <= 15 ? 0
            : navDiscPct <= 30 ? -0.5
            :                    -1.5;
    score += s * w.nav;
  }

  // Total return incl. estimated distributions. Split ~60/40 across the two
  // horizons so the 12-month figure leads and 24-month confirms.
  const tr12 = r.ret12Pct !== null ? r.ret12Pct + effYieldPct : null;
  const tr24 = r.ret24Pct !== null ? r.ret24Pct + effYieldPct * 2 : null;
  if (tr12 !== null) {
    const s = tr12 > 10 ? 1 : tr12 > 0 ? 0.5 : tr12 > -10 ? -0.5 : -1.25;
    score += s * w.totalReturn * (8 / 13);
  }
  if (tr24 !== null) {
    const s = tr24 > 20 ? 1 : tr24 > 0 ? 0.4 : -1;
    score += s * w.totalReturn * (5 / 13);
  }

  // Yield. The 40pp cap is deliberately NOT weight-scaled — it is the guard
  // that stops a fund distributing 90% while its NAV bleeds from buying the
  // top rank. Raising the yield weight increases how much yield matters, but
  // never lets an extreme yield dominate on its own.
  score += (Math.min(effYieldPct, 40) / 40) * w.yieldW;

  // Margin maintenance — low-maintenance names free more equity per dollar.
  const maintSignal = Math.max(-1, Math.min(1, (60 - r.maintenancePct) / 60));
  score += maintSignal * w.maintenance;

  // Catch-up: this ticker's bucket is under target → contributions belong here.
  if (catchUp) score += w.catchUp;
  if (overweight) score -= w.catchUp;

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

export function TargetAllocationView({
  accountHash, totalValue, pillarSummary, targets, dividends = [],
  prefillContribution, prefillKey,
}: Props) {
  const [rows, setRows]         = useState<AllocationRow[]>([]);
  const [navMap, setNavMap]     = useState<Record<string, number>>({});
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [contribution, setContribution] = useState('');

  /**
   * Fill the contribution box when arriving from the contribution tracker.
   *
   * Keyed on `prefillKey` rather than the amount so two hand-offs of the same
   * dollar figure both take effect — otherwise the second click would look
   * like no change and silently do nothing. Deliberately does not run on
   * mount without a key, so opening the tab normally leaves the box alone.
   */
  useEffect(() => {
    if (prefillKey === undefined || prefillContribution === undefined) return;
    setContribution(String(Math.round(prefillContribution)));
  }, [prefillKey, prefillContribution]);

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

  // ── Set Targets from Current ────────────────────────────────────────────────
  // The shipped bucket defaults are placeholders — the P2P material prescribes
  // no percentages. Snapshotting the live allocation gives a real starting
  // point, which matters because every drift figure and the whole contribution
  // planner are measured against these numbers.
  const liveTargets = useStrategyTargets(accountHash);
  const [snapshotState, setSnapshotState] = useState<'idle' | 'saved'>('idle');

  // ── Inline target editing ───────────────────────────────────────────────────
  // Targets can also be edited in the Settings modal, but drift, the insights
  // list and the whole contribution planner are all measured against them —
  // so editing them here, next to the numbers they move, is where the feedback
  // actually is. `draftTargets` is non-null exactly while editing, and every
  // downstream calculation reads `effTargets`, so the page previews the draft
  // live and nothing is written until Save.
  const [draftTargets, setDraftTargets] = useState<BucketTargets | null>(null);
  const editing = draftTargets !== null;
  const effTargets: BucketTargets = draftTargets ?? targets;
  const draftSum = useMemo(
    () => TARGET_KEYS.reduce((s, k) => s + effTargets[k], 0),
    [effTargets],
  );

  const beginEdit = () => {
    setDraftTargets({ ...targets });
    // The target column only exists in the "% Portfolio" basis — editing while
    // showing share-of-invested would hide the fields being edited.
    setShowAsPortfolioPct(true);
  };
  const cancelEdit = () => setDraftTargets(null);

  const setDraftPillar = (key: TargetKey, raw: number) => {
    setDraftTargets((prev) => {
      const base = prev ?? { ...targets };
      const value = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
      const next: BucketTargets = { ...base, [key]: value };

      // Same give-way rule as the Settings sliders: if the four now exceed 100,
      // pull the excess from the largest other buckets first. Without it you
      // can't raise a bucket without lowering another one first, which makes
      // the sliders feel stuck at the top end.
      let sum = TARGET_KEYS.reduce((s, k) => s + next[k], 0);
      if (sum > 100) {
        const others = TARGET_KEYS
          .filter((k) => k !== key)
          .sort((a, b) => next[b] - next[a]);
        for (const other of others) {
          const reduction = Math.min(next[other], sum - 100);
          next[other] -= reduction;
          sum -= reduction;
          if (sum <= 100) break;
        }
      }
      return next;
    });
  };

  /** Push whatever is unallocated into the largest bucket so the four hit 100. */
  const balanceDraft = () => {
    setDraftTargets((prev) => {
      const base = prev ?? { ...targets };
      const sum = TARGET_KEYS.reduce((s, k) => s + base[k], 0);
      if (sum === 100) return base;
      const biggest = [...TARGET_KEYS].sort((a, b) => base[b] - base[a])[0];
      return { ...base, [biggest]: Math.max(0, base[biggest] + (100 - sum)) };
    });
  };

  const saveTargets = () => {
    // Drift math, the gap-weighted contribution split and the target blended
    // yield all assume the four buckets total 100. Saving anything else would
    // quietly corrupt every figure on this page, so it's blocked rather than
    // auto-corrected — auto-correcting would move a number the user just set.
    if (!draftTargets || draftSum !== 100) return;
    updateStrategyTargets({ ...liveTargets, ...draftTargets }, accountHash);
    setDraftTargets(null);
    setSnapshotState('saved');
    setTimeout(() => setSnapshotState('idle'), 2500);
  };

  const setTargetsFromCurrent = () => {
    if (totalValue <= 0) return;
    const pctOf = (pillar: string) => {
      const v = pillarSummary
        .filter((p) => p.pillar === pillar)
        .reduce((s, p) => s + p.totalValue, 0);
      return totalValue > 0 ? (v / totalValue) * 100 : 0;
    };

    // Round to whole points, then push any rounding residue into High Yield so
    // the four buckets total exactly 100 — drift math assumes that.
    const growth = Math.round(pctOf('growth'));
    const cornerstone = Math.round(pctOf('cornerstone'));
    const triples = Math.round(pctOf('triples'));
    const income = 100 - growth - cornerstone - triples;
    const snapshot: BucketTargets = {
      growthPct: growth, cornerstonePct: cornerstone, incomePct: income, triplesPct: triples,
    };

    // Mid-edit, the snapshot seeds the draft instead of committing — otherwise
    // this button would silently discard the edit in progress.
    if (editing) {
      setDraftTargets(snapshot);
      return;
    }

    updateStrategyTargets({ ...liveTargets, ...snapshot }, accountHash);
    setSnapshotState('saved');
    setTimeout(() => setSnapshotState('idle'), 2500);
  };

  // Put as much of the contribution into whole shares as possible. Off means
  // the residual after the bucket split simply stays in cash.
  const [maximiseDeployment, setMaximiseDeployment] = useState(true);

  // Whether scores drive within-bucket allocation. Off keeps the bucket
  // weights but splits evenly across a wider set of Add-rated names.
  const [applyScores, setApplyScores] = useState(true);

  // Percentage basis for the bucket rows. Portfolio % compares against targets;
  // share-of-invested answers "how is my invested capital actually split",
  // which differs whenever cash or unclassified holdings are material.
  const [showAsPortfolioPct, setShowAsPortfolioPct] = useState(true);

  // Moving-average period driving the SMA scoring factor.
  const [smaPeriod, setSmaPeriod] = useState<SmaPeriod>(DEFAULT_SMA_PERIOD);
  useEffect(() => {
    try {
      const raw = Number(localStorage.getItem('triple-c-alloc-sma'));
      if ((SMA_PERIODS as readonly number[]).includes(raw)) setSmaPeriod(raw as SmaPeriod);
    } catch { /* ignore */ }
  }, []);
  const pickSmaPeriod = (n: SmaPeriod) => {
    setSmaPeriod(n);
    try { localStorage.setItem('triple-c-alloc-sma', String(n)); } catch { /* ignore */ }
  };

  // Signal filter. Empty set means no filter — the table shows everything.
  const [signalFilter, setSignalFilter] = useState<Set<Signal>>(new Set());
  const toggleSignal = (s: Signal) =>
    setSignalFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });

  // ── Scoring weights ─────────────────────────────────────────────────────────
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [showWeights, setShowWeights] = useState(false);

  // Read from localStorage after mount — reading during initial state would
  // diverge between server and client render.
  useEffect(() => { setWeights(loadWeights()); }, []);

  const setWeight = (key: keyof ScoringWeights, value: number) => {
    setWeights((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const resetWeights = () => {
    setWeights(DEFAULT_WEIGHTS);
    try { localStorage.removeItem(WEIGHTS_KEY); } catch { /* ignore */ }
  };

  const normalisedWeights = useMemo(() => normaliseWeights(weights), [weights]);
  const weightsAreDefault = useMemo(
    () => (Object.keys(DEFAULT_WEIGHTS) as (keyof ScoringWeights)[])
      .every((k) => weights[k] === DEFAULT_WEIGHTS[k]),
    [weights],
  );
  const weightSum = useMemo(
    () => Object.values(weights).reduce((s, v) => s + Math.max(0, v), 0),
    [weights],
  );

  /** True while the targets still look like the untouched shipped defaults. */
  const targetsLookDefault =
    effTargets.growthPct === 20 && effTargets.cornerstonePct === 20 &&
    effTargets.incomePct === 50 && effTargets.triplesPct === 10;

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
    const actual: Record<string, number> = { growth: 0, cornerstone: 0, income: 0, triples: 0, other: 0 };
    for (const p of pillarSummary) actual[p.pillar] = (actual[p.pillar] ?? 0) + p.totalValue;
    const targetPct: Record<string, number> = {
      growth: effTargets.growthPct, cornerstone: effTargets.cornerstonePct,
      income: effTargets.incomePct, triples: effTargets.triplesPct, other: 0,
    };
    return (['income', 'cornerstone', 'growth', 'triples'] as const).map((pillar) => {
      const actual$ = actual[pillar] ?? 0;
      const actualPct = totalValue > 0 ? (actual$ / totalValue) * 100 : 0;
      const gapPp = targetPct[pillar] - actualPct;
      return { pillar, actual$, actualPct, targetPct: targetPct[pillar], gapPp, gap$: (gapPp / 100) * totalValue };
    });
  }, [pillarSummary, effTargets, totalValue]);

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

    // Rows served from a cache written before multi-period support carry only
    // the legacy sma50 fields; fall back rather than scoring everything null.
    const vsSmaSelectedPct = r.vsSmaPct?.[smaPeriod] ?? (smaPeriod === 50 ? r.vsSma50Pct ?? null : null);

    const s = scoreRow(r, navDiscPct, catchUp, over, effYieldPct, normalisedWeights, vsSmaSelectedPct);
    return { ...r, navDiscPct, catchUp, effYieldPct, effYieldSource, vsSmaSelectedPct, ...s };
  }), [rows, navMap, underTarget, overTarget, derivedYieldBySymbol, normalisedWeights, smaPeriod]);

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
  // Signal counts are computed off the focus-filtered set but before the signal
  // filter itself, so the chips keep showing what is available to select rather
  // than collapsing to the current selection.
  const signalCounts = useMemo(() => {
    const c = new Map<Signal, number>();
    for (const r of visibleScored) c.set(r.signal, (c.get(r.signal) ?? 0) + 1);
    return c;
  }, [visibleScored]);

  const signalFiltered = useMemo(
    () => (signalFilter.size === 0 ? visibleScored : visibleScored.filter((r) => signalFilter.has(r.signal))),
    [visibleScored, signalFilter],
  );

  const tableRows = useMemo(() => sortRows(signalFiltered, {
    symbol: (r) => r.symbol,
    pillar: (r) => r.pillar,
    score:  (r) => r.score,
    // Tie-break within a signal band by score, so the order stays meaningful.
    signal: (r) => SIGNAL_RANK[r.signal] * 1000 + r.score,
    sma:    (r) => r.vsSmaSelectedPct ?? Number.NEGATIVE_INFINITY,
    tr12:   (r) => r.tr12 ?? Number.NEGATIVE_INFINITY,
    tr24:   (r) => r.tr24 ?? Number.NEGATIVE_INFINITY,
    yield:  (r) => r.effYieldPct,
    nav:    (r) => r.navDiscPct ?? Number.NEGATIVE_INFINITY,
    margin: (r) => r.maintenancePct,
  }), [signalFiltered, sortRows]);

  // ── Blended yield (scored universe, value-weighted) ────────────────────────
  const blended = useMemo(() => {
    let v = 0, y = 0;
    for (const r of scored) { v += r.marketValue; y += r.marketValue * (r.effYieldPct / 100); }
    return v > 0 ? (y / v) * 100 : 0;
  }, [scored]);

  /**
   * Per-bucket blended yield, value-weighted within each bucket.
   *
   * This is where the portfolio figure gets its shape: a single blended number
   * hides that one bucket is doing nearly all the income work while another
   * contributes almost none. Growth in particular should read low by design —
   * it is there to appreciate and support margin equity, not to pay.
   */
  const bucketYields = useMemo(() => {
    const acc = new Map<string, { value: number; income: number }>();
    for (const r of scored) {
      const cur = acc.get(r.pillar) ?? { value: 0, income: 0 };
      cur.value  += r.marketValue;
      cur.income += r.marketValue * (r.effYieldPct / 100);
      acc.set(r.pillar, cur);
    }
    return acc;
  }, [scored]);

  const yieldFor = (pillar: string) => {
    const a = bucketYields.get(pillar);
    return a && a.value > 0 ? (a.income / a.value) * 100 : 0;
  };

  /**
   * A bucket's share of invested capital, as opposed to share of portfolio.
   * The two diverge when cash or unclassified holdings are material — the
   * portfolio figure is what targets are measured against, while this one
   * answers how the money actually at work is split.
   */
  const investedTotal = useMemo(
    () => buckets.reduce((s, b) => s + b.actual$, 0),
    [buckets],
  );
  const bucketShareOf = (b: { actual$: number }) =>
    investedTotal > 0 ? (b.actual$ / investedTotal) * 100 : 0;

  /**
   * Blended yield the portfolio would carry at the target weights, holding each
   * bucket's current yield constant. Answers "if I rebalance to target, what
   * happens to my income?" — which is not obvious when the underweight bucket
   * happens to be the low-yielding one.
   */
  const targetBlendedYield = useMemo(() => {
    const w: Record<string, number> = {
      growth: effTargets.growthPct, cornerstone: effTargets.cornerstonePct,
      income: effTargets.incomePct, triples: effTargets.triplesPct,
    };
    let sum = 0, weightSum = 0;
    for (const [pillar, pct] of Object.entries(w)) {
      const y = yieldFor(pillar);
      // A bucket with no holdings has no observed yield; excluding it avoids
      // dragging the projection to zero on the strength of an empty sleeve.
      if (!bucketYields.has(pillar)) continue;
      sum += pct * y;
      weightSum += pct;
    }
    return weightSum > 0 ? sum / weightSum : 0;
  }, [effTargets, bucketYields]);

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

    // 2. Within each bucket: pick the addable tickers and split the bucket's
    //    dollars across them. With scores applied, higher-scored names take
    //    proportionally more and the field narrows to the top 3. With scores
    //    off, the split is even across a wider field — useful when you want the
    //    bucket weights honoured but don't want the scoring model deciding
    //    which names inside the bucket get the money.
    const buys = new Map<string, { shares: number; price: number; score: number; signal: Signal; pillar: string }>();
    const bucketDetail: { pillar: string; allocated: number; deployed: number; reason?: string }[] = [];
    let spent = 0;

    for (const [pillar, alloc] of Object.entries(bucketAlloc)) {
      if (alloc < 1) continue;
      const candidates = scored
        .filter((r) => r.pillar === pillar && (r.signal === 'Strong Add' || r.signal === 'Add') && r.price > 0)
        .filter((r) => !focus || focusedSet.has(r.symbol))
        .sort((a, b) => b.score - a.score)
        .slice(0, applyScores ? 3 : 8);

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
        const dollars = applyScores
          ? alloc * (c.score / wSum)
          : alloc / candidates.length;
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

    // 3. Residual sweep — put as much of the contribution into whole shares as
    //    possible without recreating the original bug.
    //
    //    The version this replaces called find() on a score-sorted list every
    //    iteration, so it kept selecting the same top ticker and dumped the
    //    entire residual into one symbol. This walks the candidates round-robin
    //    instead: one share each, highest score first, repeating while a full
    //    pass still places something. Deployment ends up just as high, spread
    //    across names in roughly score order.
    let sweepSpent = 0;
    let leftover = cash - spent;

    if (maximiseDeployment) {
      const candidates = scored
        .filter((r) => (r.signal === 'Strong Add' || r.signal === 'Add') && r.price > 0)
        .filter((r) => !focus || focusedSet.has(r.symbol))
        .sort((a, b) => b.score - a.score);

      const record = (c: ScoredRow) => {
        const prev = buys.get(c.symbol);
        buys.set(c.symbol, {
          shares: (prev?.shares ?? 0) + 1, price: c.price,
          score: c.score, signal: c.signal, pillar: c.pillar,
        });
        sweepSpent += c.price;
        leftover -= c.price;
      };

      // Round-robin passes.
      let guard = 2000;
      let placedThisPass = true;
      while (placedThisPass && guard > 0) {
        placedThisPass = false;
        for (const c of candidates) {
          if (guard-- <= 0) break;
          if (c.price <= leftover) { record(c); placedThisPass = true; }
        }
      }

      // Final squeeze: once no full pass fits, keep taking the cheapest share
      // that still fits. This is what actually drives leftover toward zero —
      // without it, anything cheaper than the cheapest candidate's next share
      // would sit idle purely because the round-robin had stalled.
      const byPrice = [...candidates].sort((a, b) => a.price - b.price);
      guard = 2000;
      while (guard-- > 0) {
        const next = byPrice.find((r) => r.price <= leftover);
        if (!next) break;
        record(next);
      }
    }

    spent += sweepSpent;

    const list = [...buys.entries()]
      .map(([symbol, b]) => ({ symbol, ...b, cost: b.shares * b.price }))
      .sort((a, b) => b.cost - a.cost);

    return {
      list, spent, leftover: cash - spent, cash, allAtTarget, sweepSpent,
      deployedPct: cash > 0 ? (spent / cash) * 100 : 0,
      bucketDetail: bucketDetail.sort((a, b) => b.allocated - a.allocated),
    };
  }, [contribution, buckets, scored, totalValue, focus, focusedSet, maximiseDeployment, applyScores]);

  // ── Staging plan rows into real orders ──────────────────────────────────────
  // The plan is a suggestion; these turn a chosen subset of it into MARKET buys
  // via /api/orders — the same path RebalanceWorkflow and the cornerstone card
  // use. Nothing reaches Schwab without an explicit review step.
  const [excluded, setExcluded]           = useState<Set<string>>(new Set());
  const [shareOverride, setShareOverride] = useState<Record<string, number>>({});
  const [confirming, setConfirming]       = useState(false);
  const [placing, setPlacing]             = useState(false);
  const [placeError, setPlaceError]       = useState<string | null>(null);
  const [orderResults, setOrderResults]   = useState<Record<string, { ok: boolean; text: string }> | null>(null);

  // Guardrail preflight. /api/orders places straight to Schwab, so the
  // guardrail layer (post-trade AFW floor, concentration, margin, wash-sale)
  // only runs if we ask for it — /api/orders/preflight dry-runs the batch
  // cumulatively and reports what would be blocked.
  const [preflight, setPreflight]         = useState<PreflightResponse | null>(null);
  const [preflighting, setPreflighting]   = useState(false);
  const [warnOverride, setWarnOverride]   = useState(false);

  /** Identity of the current plan. Any change means the staged edits below
   *  describe a plan that no longer exists, so they're discarded. */
  const planKey = plan ? plan.list.map((b) => `${b.symbol}:${b.shares}`).join(',') : '';
  useEffect(() => {
    setExcluded(new Set());
    setShareOverride({});
    setConfirming(false);
    setPlaceError(null);
    setOrderResults(null);
    setPreflight(null);
    setWarnOverride(false);
  }, [planKey]);

  const toggleExcluded = (symbol: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
      return next;
    });

  const stagedOrders = useMemo(() => {
    if (!plan) return [];
    return plan.list
      .filter((b) => !excluded.has(b.symbol))
      .map((b) => {
        const shares = shareOverride[b.symbol] ?? b.shares;
        return { ...b, shares, cost: shares * b.price };
      })
      .filter((b) => b.shares > 0);
  }, [plan, excluded, shareOverride]);

  const stagedCost = useMemo(() => stagedOrders.reduce((s, b) => s + b.cost, 0), [stagedOrders]);

  const blockedSymbols = useMemo(
    () => new Set((preflight?.results ?? []).filter((r) => !r.allowed).map((r) => r.symbol)),
    [preflight],
  );

  /** Staged orders that cleared the guardrails — the only ones that get placed. */
  const clearedOrders = useMemo(
    () => stagedOrders.filter((b) => !blockedSymbols.has(b.symbol)),
    [stagedOrders, blockedSymbols],
  );
  const clearedCost = useMemo(() => clearedOrders.reduce((s, b) => s + b.cost, 0), [clearedOrders]);

  /** Allowed-but-flagged orders. Warnings don't block, but must be acknowledged. */
  const pendingWarnings = useMemo(
    () => (preflight?.results ?? []).filter((r) => r.allowed && r.violations.some((v) => v.severity === 'warn')),
    [preflight],
  );

  /** Orders need a specific Schwab account; the "All" view has no hash to place against. */
  const canReview  = Boolean(accountHash) && stagedOrders.length > 0 && !placing && !preflighting;
  const canConfirm = Boolean(accountHash) && preflight !== null && clearedOrders.length > 0
    && !placing && (pendingWarnings.length === 0 || warnOverride);

  /**
   * Run the guardrail dry-run, then open the confirm panel. Fails closed: if
   * the check itself errors we surface it and stay out of the confirm step
   * rather than letting unvalidated orders through on a network blip.
   */
  const runPreflight = async () => {
    if (!accountHash || stagedOrders.length === 0) return;
    setPreflighting(true);
    setPlaceError(null);
    setPreflight(null);
    setWarnOverride(false);
    try {
      const res = await fetch('/api/orders/preflight', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountHash,
          orders: stagedOrders.map((b) => ({
            symbol:      b.symbol,
            instruction: 'BUY',
            quantity:    b.shares,
            price:       b.price,
            pillar:      b.pillar,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setPreflight(data as PreflightResponse);
      setConfirming(true);
    } catch (e) {
      setPlaceError(e instanceof Error ? e.message : 'Guardrail check failed — orders not placed.');
    } finally {
      setPreflighting(false);
    }
  };

  const placeStagedOrders = async () => {
    if (!accountHash || clearedOrders.length === 0 || !preflight) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      const res = await fetch('/api/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountHash,
          orders: clearedOrders.map((b) => ({
            symbol:      b.symbol,
            instruction: 'BUY',
            quantity:    b.shares,
            orderType:   'MARKET',
            rationale:   `Allocation planner: ${b.signal} (score ${b.score}) in ${PILLAR_LABEL[b.pillar] ?? b.pillar}`,
            aiMode:      'target_allocation',
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      // Results come back positionally, in the order the orders were sent.
      const list = (data.equityResults ?? data.results ?? []) as { status?: string; orderId?: string | null; message?: string }[];
      const map: Record<string, { ok: boolean; text: string }> = {};
      // Blocked orders never reached Schwab; record why so the row explains
      // itself rather than just going quiet.
      for (const r of preflight.results) {
        if (r.allowed) continue;
        map[r.symbol] = { ok: false, text: r.violations.find((v) => v.severity === 'block')?.message ?? 'Blocked by guardrails' };
      }
      clearedOrders.forEach((b, i) => {
        const r = list[i];
        map[b.symbol] = r?.status === 'placed'
          ? { ok: true,  text: r.orderId ? `Placed · ${r.orderId}` : 'Placed' }
          : { ok: false, text: r?.message ?? 'Rejected' };
      });
      setOrderResults(map);
      setConfirming(false);
    } catch (e) {
      setPlaceError(e instanceof Error ? e.message : 'Order submission failed');
    } finally {
      setPlacing(false);
    }
  };

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
          <div className="flex items-center gap-0.5" title="Moving-average period used by the vs-SMA scoring factor">
            <span className="text-[10px] text-[#4a5070] mr-1">SMA</span>
            {SMA_PERIODS.map((n) => (
              <button
                key={n}
                onClick={() => pickSmaPeriod(n)}
                title={SMA_PERIOD_HELP[n]}
                className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  smaPeriod === n
                    ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
                    : 'text-[#7c82a0] hover:text-white border border-transparent'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowWeights((v) => !v)}
            title="Adjust how much each factor counts toward the score"
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
              showWeights || !weightsAreDefault
                ? 'bg-violet-600/20 text-violet-300 border-violet-500/30'
                : 'text-[#9aa2c0] hover:text-white border-[#2d3248] hover:border-[#3d4468]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Weights{!weightsAreDefault && ' •'}
          </button>
          <button
            onClick={setTargetsFromCurrent}
            disabled={totalValue <= 0}
            title={editing
              ? 'Load your current allocation into the draft below'
              : 'Snapshot your current bucket allocation as the target'}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
              snapshotState === 'saved'
                ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30'
                : 'text-[#9aa2c0] hover:text-white border-[#2d3248] hover:border-[#3d4468]'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            {snapshotState === 'saved' ? 'Targets set' : editing ? 'Use Current' : 'Set Targets from Current'}
          </button>
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
        <Stat
          icon={DollarSign}
          label="Est. Blended Yield"
          value={`${blended.toFixed(2)}%`}
          sub={`at target weights: ${targetBlendedYield.toFixed(2)}%`}
          valueClass="text-emerald-400"
          accentClass="border-t-violet-500/60"
          index={0}
        />
        <Stat icon={Layers} label="Scored Tickers" value={String(scored.length)} sub="full universe · seeds never rated below Neutral" accentClass="border-t-violet-500/60" index={1} />
        <Stat icon={TrendingUp} label="Strong Add / Add" value={String(scored.filter((r) => r.signal === 'Strong Add' || r.signal === 'Add').length)} accentClass="border-t-violet-500/60" index={2} />
        <Stat icon={AlertTriangle} label="Hold / Trim" value={String(scored.filter((r) => r.signal === 'Hold' || r.signal === 'Trim').length)} iconClass="text-orange-400/60" accentClass="border-t-violet-500/60" index={3} />
      </div>

      {/* Bucket allocations */}
      <div className={`bg-[#12151f] border rounded-lg p-4 space-y-3 transition-colors ${
        editing ? 'border-violet-500/40' : 'border-[#1f2334]'
      }`}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">Bucket Allocations</span>
            {editing && (
              <span
                className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded border ${
                  draftSum === 100
                    ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                    : 'text-yellow-300 border-yellow-500/30 bg-yellow-500/10'
                }`}
              >
                {draftSum}% allocated
                {draftSum < 100 && ` · ${100 - draftSum}pp unassigned`}
                {draftSum > 100 && ` · ${draftSum - 100}pp over`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {editing ? (
              <>
                {draftSum !== 100 && (
                  <button
                    onClick={balanceDraft}
                    title="Move the unassigned points into the largest bucket so the four total 100"
                    className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] transition-colors"
                  >
                    Balance to 100
                  </button>
                )}
                <button
                  onClick={cancelEdit}
                  className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveTargets}
                  disabled={draftSum !== 100}
                  title={draftSum === 100
                    ? `Save to ${accountHash ? 'this account' : 'global targets'}`
                    : 'Buckets must total exactly 100% — drift and the contribution planner assume it'}
                  className="text-[11px] px-2 py-1 rounded border bg-violet-600/20 text-violet-200 border-violet-500/40 hover:bg-violet-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Save targets
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-0.5 text-[10px]">
                  {([['% Portfolio', true], ['% Invested', false]] as const).map(([label, val]) => (
                    <button
                      key={label}
                      onClick={() => setShowAsPortfolioPct(val)}
                      className={`px-2 py-1 rounded transition-colors ${
                        showAsPortfolioPct === val
                          ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
                          : 'text-[#7c82a0] hover:text-white border border-transparent'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={beginEdit}
                  title="Set your bucket targets here — drift and the calculator update as you drag"
                  className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] transition-colors"
                >
                  <SlidersHorizontal className="w-3 h-3" />
                  Edit targets
                </button>
              </>
            )}
          </div>
        </div>

        {editing && (
          <p className="text-[10px] text-violet-200/70 leading-snug">
            Previewing unsaved targets — drift, insights and the contribution plan below all reflect
            these numbers. Saving writes to {accountHash ? 'this account only' : 'your global targets'}.
          </p>
        )}

        {buckets.map((b) => {
          const key = PILLAR_TARGET_KEY[b.pillar];
          return (
            <div key={b.pillar} className="space-y-1">
              <div className="flex justify-between items-center text-[11px] gap-2">
                <span className="text-[#9aa2c0]">
                  {PILLAR_LABEL[b.pillar]}
                  <span
                    className="ml-1.5 text-[10px] text-emerald-400/80 tabular-nums"
                    title={`Blended yield within ${PILLAR_LABEL[b.pillar]}, value-weighted`}
                  >
                    {yieldFor(b.pillar).toFixed(1)}% yld
                  </span>
                </span>
                <span className="tabular-nums text-[#7c82a0] flex items-center gap-1">
                  <span>{fmt$(b.actual$, 0)} ·</span>
                  {showAsPortfolioPct ? (
                    <>
                      <span>{b.actualPct.toFixed(1)}% /</span>
                      {editing ? (
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={effTargets[key]}
                          onChange={(e) => setDraftPillar(key, Number(e.target.value))}
                          aria-label={`${PILLAR_LABEL[b.pillar]} target percent`}
                          className="w-12 bg-[#0f1117] border border-violet-500/40 rounded px-1 py-0.5 text-[11px] text-white text-right tabular-nums focus:outline-none focus:border-violet-400"
                        />
                      ) : (
                        <span>{b.targetPct}%</span>
                      )}
                      <span>target ·</span>
                    </>
                  ) : (
                    <span>{bucketShareOf(b).toFixed(1)}% of invested ·</span>
                  )}
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
              {editing && (
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={effTargets[key]}
                  onChange={(e) => setDraftPillar(key, Number(e.target.value))}
                  aria-label={`${PILLAR_LABEL[b.pillar]} target slider`}
                  className="w-full accent-violet-500"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Scoring weights */}
      {showWeights && (
        <div className="bg-[#12151f] border border-violet-500/25 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="text-sm font-semibold text-white">Scoring Weights</span>
              <p className="text-[10px] text-[#4a5070] mt-0.5">
                Relative importance of each factor. Values normalise to a fixed total, so raising one
                factor trades against the others instead of inflating every score.
              </p>
            </div>
            <button
              onClick={resetWeights}
              disabled={weightsAreDefault}
              className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Reset
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
            {(Object.keys(DEFAULT_WEIGHTS) as (keyof ScoringWeights)[]).map((key) => {
              const share = weightSum > 0 ? (Math.max(0, weights[key]) / weightSum) * 100 : 0;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-[#9aa2c0]" title={WEIGHT_HELP[key]}>{WEIGHT_LABELS[key]}</span>
                    <span className="tabular-nums text-[#7c82a0]">
                      {share.toFixed(0)}%
                      {weights[key] !== DEFAULT_WEIGHTS[key] && (
                        <span className="ml-1 text-violet-300">•</span>
                      )}
                    </span>
                  </div>
                  <input
                    type="range" min={0} max={30} step={1}
                    value={weights[key]}
                    onChange={(e) => setWeight(key, Number(e.target.value))}
                    className="w-full accent-violet-500"
                    aria-label={WEIGHT_LABELS[key]}
                  />
                  <p className="text-[10px] text-[#4a5070] mt-0.5 leading-snug">{WEIGHT_HELP[key]}</p>
                </div>
              );
            })}
          </div>

          {weights.yieldW >= 25 && (
            <p className="text-[10px] text-yellow-200/80 mt-3 border-t border-[#1f2334] pt-2">
              Yield is weighted heavily. The 40pp credit cap still applies, but note that
              distribution yield and total return can point in opposite directions — a fund paying
              50% while its NAV erodes scores well on yield and badly on total return. Consider
              whether Total Return deserves comparable weight.
            </p>
          )}
        </div>
      )}

      {/* Insights + calculator side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <Lightbulb className="w-4 h-4 text-yellow-300" />
            <span className="text-sm font-semibold text-white">Rebalance Insights</span>
          </div>
          {/* Every insight below is drift measured against the targets. If those
              are still the shipped placeholders, the drift is meaningless and
              saying so is more useful than listing it. */}
          {targetsLookDefault && (
            <div className="text-xs leading-relaxed flex gap-2 text-yellow-200/90 border border-yellow-500/20 bg-yellow-500/5 rounded p-2 mb-1">
              <span className="flex-shrink-0">⚑</span>
              <span>
                These are the shipped default targets, not yours — the P2P material
                prescribes no bucket percentages. Everything below is drift against a
                placeholder until you set real ones. &ldquo;Set Targets from Current&rdquo;
                snapshots where you actually are.
              </span>
            </div>
          )}
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
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[#9aa2c0] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={maximiseDeployment}
                onChange={(e) => setMaximiseDeployment(e.target.checked)}
                className="accent-blue-500"
              />
              <span title="After the bucket split, keep buying single shares round-robin down the score order until nothing else fits.">
                Max whole shares
              </span>
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-[#9aa2c0] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyScores}
              onChange={(e) => setApplyScores(e.target.checked)}
              className="accent-violet-500"
            />
            <span title="On: higher-scored tickers take proportionally more of each bucket's allocation, narrowed to the top 3. Off: bucket weights still apply, but the money splits evenly across a wider set of Add-rated names.">
              Apply scores to allocation
            </span>
            <span className="text-[10px] text-[#4a5070]">
              {applyScores ? 'score-weighted, top 3' : 'even split, top 8'}
            </span>
          </label>
          {plan && plan.list.length > 0 && (
            <div className="space-y-1.5">
              {plan.list.map((b) => {
                const result   = orderResults?.[b.symbol];
                const staged   = !excluded.has(b.symbol);
                const shares   = shareOverride[b.symbol] ?? b.shares;
                const locked   = Boolean(orderResults) || confirming || placing || preflighting;
                const check    = preflight?.results.find((r) => r.symbol === b.symbol);
                const blocker  = check && !check.allowed
                  ? check.violations.find((v) => v.severity === 'block')
                  : undefined;
                const warning  = check?.allowed
                  ? check.violations.find((v) => v.severity === 'warn')
                  : undefined;
                return (
                  <div key={b.symbol} className={`flex items-center gap-2 text-xs ${staged ? '' : 'opacity-40'}`}>
                    <input
                      type="checkbox"
                      checked={staged}
                      disabled={locked}
                      onChange={() => toggleExcluded(b.symbol)}
                      aria-label={`Include ${b.symbol} in the order`}
                      className="accent-blue-500 disabled:opacity-50"
                    />
                    <span className="w-14 font-mono font-semibold text-white">{b.symbol}</span>
                    <span className="text-[10px] text-[#4a5070] w-20">{PILLAR_LABEL[b.pillar]}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${SIGNAL_CLASS[b.signal]}`}>{b.signal}</span>
                    <span className="ml-auto flex items-center gap-1 tabular-nums text-[#9aa2c0]">
                      {locked ? (
                        <span>{shares}</span>
                      ) : (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={shares}
                          onChange={(e) => {
                            const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                            setShareOverride((prev) => ({ ...prev, [b.symbol]: n }));
                          }}
                          aria-label={`${b.symbol} share count`}
                          className="w-14 bg-[#0f1117] border border-[#1f2334] rounded px-1 py-0.5 text-right text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
                        />
                      )}
                      <span>× {fmt$(b.price)}</span>
                    </span>
                    <span className={`w-20 text-right tabular-nums ${blocker ? 'text-[#4a5070] line-through' : 'text-white'}`}>
                      {fmt$(shares * b.price)}
                    </span>
                    {result ? (
                      <span className={`w-32 text-right text-[10px] truncate ${result.ok ? 'text-emerald-400' : 'text-red-400'}`} title={result.text}>
                        {result.ok ? '✓' : '✗'} {result.text}
                      </span>
                    ) : blocker ? (
                      <span className="w-32 text-right text-[10px] text-red-400 truncate cursor-help" title={blocker.message}>
                        ⛔ {blocker.code.replace(/_/g, ' ')}
                      </span>
                    ) : warning ? (
                      <span className="w-32 text-right text-[10px] text-yellow-300 truncate cursor-help" title={warning.message}>
                        ⚠ {warning.code.replace(/_/g, ' ')}
                      </span>
                    ) : preflight ? (
                      <span className="w-32 text-right text-[10px] text-emerald-400/70">✓ cleared</span>
                    ) : null}
                  </div>
                );
              })}
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
              <div className="flex justify-between text-xs">
                <span className="text-[#7c82a0]">Deployed %</span>
                <span className={`tabular-nums ${plan.deployedPct >= 98 ? 'text-emerald-400' : 'text-[#9aa2c0]'}`}>
                  {plan.deployedPct.toFixed(1)}%
                </span>
              </div>

              {plan.leftover > 1 && (
                <div className="border-t border-[#1f2334] pt-1.5 mt-1.5 space-y-1">
                  <div className="text-[10px] text-[#7c82a0]">
                    {maximiseDeployment
                      ? `${fmt$(plan.leftover)} left over — less than the cheapest Add-rated share still available.`
                      : `${fmt$(plan.leftover)} unallocated — held as cash rather than forced into whole shares.`}
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

              {/* ── Place the plan ───────────────────────────────────────────
                  Suggestions become real MARKET buys here. The review step is
                  deliberate: the plan recomputes on every weight, focus and
                  contribution change, so the list can shift under you between
                  reading it and acting on it. */}
              <div className="border-t border-[#1f2334] pt-2 mt-2 space-y-2">
                {placeError && (
                  <div className="flex items-start gap-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/25 rounded p-2">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                    <span>{placeError}</span>
                  </div>
                )}

                {orderResults ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[#9aa2c0]">
                      {Object.values(orderResults).filter((r) => r.ok).length} placed
                      {Object.values(orderResults).some((r) => !r.ok) &&
                        ` · ${Object.values(orderResults).filter((r) => !r.ok).length} failed`}
                      {' '}— check Trade Hub for fills.
                    </span>
                    <button
                      onClick={() => { setOrderResults(null); setExcluded(new Set()); setShareOverride({}); }}
                      className="ml-auto text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] transition-colors"
                    >
                      Start over
                    </button>
                  </div>
                ) : confirming && preflight ? (
                  <div className="space-y-2 bg-blue-500/5 border border-blue-500/25 rounded p-2.5">
                    <div className="text-[11px] text-blue-200 leading-snug">
                      Placing <span className="font-semibold">{clearedOrders.length}</span> market buy
                      {clearedOrders.length === 1 ? '' : 's'} for <span className="font-semibold tabular-nums">{fmt$(clearedCost)}</span>.
                      Market orders fill at the going price, so the actual cost will differ from this estimate.
                    </div>

                    {clearedOrders.length > 0 && (
                      <div className="text-[10px] text-[#9aa2c0] tabular-nums leading-relaxed">
                        {clearedOrders.map((b) => `${b.shares} ${b.symbol}`).join(' · ')}
                      </div>
                    )}

                    {/* AFW is the number the guardrail floor is defending —
                        showing the projected landing point makes the block
                        (or the near-miss) legible rather than abstract. */}
                    <div className="text-[10px] text-[#7c82a0] tabular-nums border-t border-[#1f2334] pt-1.5">
                      AFW after these fills: {fmt$(preflight.context.projectedAfwDollars, 0)}{' '}
                      <span className="text-[#4a5070]">(from {fmt$(preflight.context.afwDollars, 0)})</span>
                    </div>

                    {preflight.blockedCount > 0 && (
                      <div className="space-y-1 bg-red-500/10 border border-red-500/25 rounded p-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-300">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          {preflight.blockedCount} order{preflight.blockedCount === 1 ? '' : 's'} blocked by guardrails
                        </div>
                        {preflight.results.filter((r) => !r.allowed).map((r) => (
                          <div key={r.symbol} className="text-[10px] text-red-200/90 leading-snug">
                            <span className="font-mono font-semibold">{r.symbol}</span>{' '}
                            {r.violations.find((v) => v.severity === 'block')?.message}
                          </div>
                        ))}
                        <p className="text-[10px] text-red-200/60 pt-0.5">
                          These are dropped from the order — the rest can still go through.
                        </p>
                      </div>
                    )}

                    {pendingWarnings.length > 0 && (
                      <div className="space-y-1 bg-yellow-500/10 border border-yellow-500/25 rounded p-2">
                        {pendingWarnings.map((r) => (
                          <div key={r.symbol} className="text-[10px] text-yellow-100/90 leading-snug">
                            <span className="font-mono font-semibold">{r.symbol}</span>{' '}
                            {r.violations.filter((v) => v.severity === 'warn').map((v) => v.message).join(' ')}
                          </div>
                        ))}
                        <label className="flex items-center gap-1.5 text-[10px] text-yellow-200 cursor-pointer select-none pt-0.5">
                          <input
                            type="checkbox"
                            checked={warnOverride}
                            onChange={(e) => setWarnOverride(e.target.checked)}
                            className="accent-yellow-500"
                          />
                          I&rsquo;ve read the warnings and want to proceed
                        </label>
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setConfirming(false); setPreflight(null); setWarnOverride(false); }}
                        disabled={placing}
                        className="text-[11px] px-2 py-1 rounded border border-[#2d3248] text-[#9aa2c0] hover:text-white hover:border-[#3d4468] disabled:opacity-40 transition-colors"
                      >
                        Back
                      </button>
                      <button
                        onClick={placeStagedOrders}
                        disabled={!canConfirm}
                        title={clearedOrders.length === 0
                          ? 'Every staged order was blocked by guardrails'
                          : pendingWarnings.length > 0 && !warnOverride
                            ? 'Acknowledge the warnings first'
                            : 'Send these orders to Schwab'}
                        className="ml-auto flex items-center gap-1.5 text-[11px] px-3 py-1 rounded border bg-emerald-600/20 text-emerald-200 border-emerald-500/40 hover:bg-emerald-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {placing && <div className="w-3 h-3 border-2 border-emerald-300/30 border-t-emerald-300 rounded-full animate-spin" />}
                        {placing ? 'Placing…' : `Confirm ${clearedOrders.length} buy${clearedOrders.length === 1 ? '' : 's'}`}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[#7c82a0] tabular-nums">
                      {stagedOrders.length} selected · {fmt$(stagedCost)}
                    </span>
                    {stagedCost > plan.cash && (
                      <span className="text-[10px] text-yellow-300/80 tabular-nums">
                        {fmt$(stagedCost - plan.cash)} over your contribution — the difference draws on margin.
                      </span>
                    )}
                    {!accountHash && (
                      <span className="text-[10px] text-yellow-300/80">
                        Pick a single account to place orders — the combined view has no account to trade in.
                      </span>
                    )}
                    <button
                      onClick={runPreflight}
                      disabled={!canReview}
                      title={accountHash ? 'Run the guardrail check, then review before anything goes to Schwab' : 'Select a single account first'}
                      className="ml-auto flex items-center gap-1.5 text-[11px] px-3 py-1 rounded border bg-blue-600/20 text-blue-200 border-blue-500/40 hover:bg-blue-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {preflighting
                        ? <div className="w-3 h-3 border-2 border-blue-300/30 border-t-blue-300 rounded-full animate-spin" />
                        : <ShoppingCart className="w-3 h-3" />}
                      {preflighting
                        ? 'Checking guardrails…'
                        : `Review ${stagedOrders.length} order${stagedOrders.length === 1 ? '' : 's'}`}
                    </button>
                  </div>
                )}
              </div>
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
          {!plan && <p className="text-[10px] text-[#4a5070]">Enter an amount to see a score-weighted, bucket-aware buy plan. You can then uncheck names, adjust share counts, and place the rest as market buys.</p>}
        </div>
      </div>

      {/* Scored table */}
      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[#1f2334] flex-wrap">
          <span className="text-[10px] text-[#4a5070] mr-1">Filter:</span>
          {(['Strong Add', 'Add', 'Neutral', 'Hold', 'Trim'] as Signal[]).map((s) => {
            const count = signalCounts.get(s) ?? 0;
            const active = signalFilter.has(s);
            return (
              <button
                key={s}
                onClick={() => toggleSignal(s)}
                disabled={count === 0 && !active}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  active ? SIGNAL_CLASS[s] : 'bg-[#1a1e2e] text-[#7c82a0] border border-transparent hover:text-white'
                }`}
              >
                {s} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
          {signalFilter.size > 0 && (
            <button
              onClick={() => setSignalFilter(new Set())}
              className="text-[10px] px-1.5 py-0.5 rounded text-blue-400 hover:text-blue-300 ml-1"
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-[10px] text-[#4a5070] tabular-nums">
            {tableRows.length} of {scored.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1a1e2e]">
                <SortTh id="symbol" label="Ticker"    first sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="pillar" label="Bucket"    sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="score"  label="Score"     align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="signal" label="Signal"    sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
                <SortTh id="sma"    label={`vs ${smaPeriod} SMA`} align="right" sortKey={sortKey} sortDir={sortDir} onSort={requestSort} />
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
                  {signalFilter.size > 0
                    ? 'No tickers match the selected signals.'
                    : focus ? 'No positions in the current focus set.'
                    : 'No equity positions found to score.'}
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
                  <td className={`px-2 py-2 text-right tabular-nums ${r.vsSmaSelectedPct !== null ? plColor(-r.vsSmaSelectedPct) : 'text-[#4a5070]'}`}>
                    {r.vsSmaSelectedPct !== null ? signedPct(r.vsSmaSelectedPct) : '—'}
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
