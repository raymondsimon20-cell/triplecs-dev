/**
 * Engine rule sanity tests.
 *
 * No external test framework — uses node's built-in `assert`. Run with:
 *
 *     npx tsc --project scripts/tsconfig.test.json
 *     node scripts/dist/test-engine-rules.js
 *
 * Or via the helper script `scripts/run-tests.sh` (compile + run in one shot).
 *
 * Covers the Phase 2 rules added in the autopilot work:
 *   - MAINTENANCE_RANKED_TRIM: fires when margin > 30%, sells highest-maint
 *     position, pairs with 1/3 rotation into UPRO/TQQQ
 *   - PILLAR_FILL: fires when income pillar is meaningfully under target,
 *     suggests new tickers not currently held, respects margin gate
 *
 * Each test prints PASS/FAIL with a short label. Exit code 0 on all pass,
 * non-zero on any failure.
 */

import assert from 'node:assert/strict';
import {
  runSignalEngine,
  type EngineInputs,
  type EnginePosition,
  type TradeSignal,
} from '../lib/signals/engine';
import { defaultSignalState } from '../lib/signals/state';
import { getFundMetadata } from '../lib/data/fund-metadata';

// ─── Test harness ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function test(label: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${label}\n        ${msg}`);
  }
}

function enrichedPosition(symbol: string, shares: number, marketValue: number): EnginePosition {
  const meta = getFundMetadata(symbol);
  return {
    symbol,
    shares,
    marketValue,
    ...(meta
      ? {
          pillar:               meta.pillar,
          family:               meta.family,
          maintenancePct:       meta.maintenancePct,
          maintenancePctSource: meta.maintenancePctSource,
        }
      : {}),
  };
}

function baseInputs(overrides: Partial<EngineInputs> = {}): EngineInputs {
  return {
    positions:  [],
    cash:       10_000,
    marginDebt: 0,
    prices:     { UPRO: 50, TQQQ: 50, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    spyHistory: Array(25).fill(500),
    vix:        18,
    state:      defaultSignalState(),
    pillarTargets: { triplesPct: 10, cornerstonePct: 20, incomePct: 65, hedgePct: 5 },
    recentSells30d:       [],
    buyingPowerAvailable: 10_000,
    ...overrides,
  };
}

function findSignals(signals: TradeSignal[], rule: string): TradeSignal[] {
  return signals.filter((s) => s.rule === rule);
}

// ─── MAINTENANCE_RANKED_TRIM tests ───────────────────────────────────────────

console.log('\nMAINTENANCE_RANKED_TRIM');

test('does not fire when margin utilization is below threshold', () => {
  const result = runSignalEngine(baseInputs({
    positions:  [enrichedPosition('OXLC', 1000, 8_000), enrichedPosition('SCHD', 100, 8_000)],
    marginDebt: 1_000, // 1k / (16k positions + 10k cash) = ~3.8% util — below 30%
  }));
  assert.equal(findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM').length, 0);
});

test('fires when margin utilization > 30% with high-maint position', () => {
  // Positions: OXLC $40k (100% maint), SCHD $20k (30% maint). totalValue=60k+cash5k=65k.
  // Margin debt = $25k → utilization ~38% (> 30%).
  const result = runSignalEngine(baseInputs({
    positions:  [enrichedPosition('OXLC', 5000, 40_000), enrichedPosition('SCHD', 250, 20_000)],
    cash:       5_000,
    marginDebt: 25_000,
  }));
  const fires = findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM');
  // Expect at least one SELL signal on OXLC (highest maint), and a paired BUY rotation.
  const sells = fires.filter((s) => s.direction === 'SELL');
  const buys  = fires.filter((s) => s.direction === 'BUY');
  assert.ok(sells.length >= 1, `expected SELL signal, got ${sells.length}`);
  assert.equal(sells[0].ticker, 'OXLC', `expected to trim OXLC, got ${sells[0].ticker}`);
  assert.ok(buys.length >= 1, 'expected paired rotation BUY');
  assert.ok(['UPRO', 'TQQQ'].includes(buys[0].ticker), `expected UPRO/TQQQ rotation, got ${buys[0].ticker}`);
});

test('skips when in defense mode (equity ratio ≤ 40%)', () => {
  // Equity ratio = (totalValue - marginDebt) / totalValue. If we deeply leverage
  // so equity ratio is < 40%, defense mode wins and MAINTENANCE_RANKED_TRIM bails.
  // Positions $20k + cash $5k = totalValue $25k; marginDebt $20k →
  // equityValue $5k, equityRatio = 0.20 = 20%. That puts us in defense.
  const result = runSignalEngine(baseInputs({
    positions:  [enrichedPosition('OXLC', 1000, 20_000)],
    cash:       5_000,
    marginDebt: 20_000,
  }));
  assert.equal(result.inDefenseMode, true, 'expected to be in defense mode');
  assert.equal(findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM').length, 0);
});

test('rotation BUY is roughly 1/3 of trim size', () => {
  const result = runSignalEngine(baseInputs({
    positions:  [enrichedPosition('OXLC', 5000, 40_000), enrichedPosition('SCHD', 250, 20_000)],
    cash:       5_000,
    marginDebt: 25_000,
  }));
  const fires = findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM');
  const sell = fires.find((s) => s.direction === 'SELL');
  const buy  = fires.find((s) => s.direction === 'BUY');
  assert.ok(sell && buy);
  const ratio = buy.sizeDollars / sell.sizeDollars;
  // 1/3 with some rounding tolerance.
  assert.ok(ratio > 0.30 && ratio < 0.36, `expected ~0.33 rotation ratio, got ${ratio.toFixed(3)}`);
});

// ─── PILLAR_FILL tests ───────────────────────────────────────────────────────

console.log('\nPILLAR_FILL');

test('does not fire when income pillar is at target', () => {
  // 65% target, 65% actual = no gap.
  const result = runSignalEngine(baseInputs({
    positions: [enrichedPosition('SCHD', 813, 65_000)],
    cash:      35_000,
  }));
  assert.equal(findSignals(result.signals, 'PILLAR_FILL').length, 0);
});

test('fires when income pillar gap > 5pp and proposes a non-held ticker', () => {
  // Total = $100k. Target income 65% = $65k. Hold only SCHD $50k → 50% actual.
  // Gap = 15pp, well above the 5pp threshold.
  const result = runSignalEngine(baseInputs({
    positions: [enrichedPosition('SCHD', 625, 50_000)],
    cash:      50_000,
  }));
  const fires = findSignals(result.signals, 'PILLAR_FILL');
  assert.ok(fires.length >= 1, `expected PILLAR_FILL signals, got ${fires.length}`);
  // Should NOT propose SCHD (already held).
  const tickers = fires.map((s) => s.ticker);
  assert.ok(!tickers.includes('SCHD'), `should not re-propose held ticker SCHD; got ${tickers.join(',')}`);
  // All proposals should be BUYs in the curated income subset.
  for (const f of fires) {
    assert.equal(f.direction, 'BUY');
    assert.ok(f.sizeDollars > 0);
  }
});

test('skips when margin utilization > 35% (PILLAR_FILL hard ceiling)', () => {
  // Total $100k = $50k positions + $50k cash. Margin debt $40k → utilization 40%.
  // PILLAR_FILL should bail entirely.
  const result = runSignalEngine(baseInputs({
    positions:  [enrichedPosition('SCHD', 625, 50_000)],
    cash:       50_000,
    marginDebt: 40_000,
  }));
  assert.equal(findSignals(result.signals, 'PILLAR_FILL').length, 0);
});

test('skips wash-sale candidates', () => {
  // Underweight income, but every curated income candidate is in recentSells30d.
  // Skipping all wash-sale candidates means it shouldn't propose anything that's in the skip set.
  const result = runSignalEngine(baseInputs({
    positions: [enrichedPosition('SCHD', 625, 50_000)],
    cash:      50_000,
    recentSells30d: [
      { symbol: 'JEPI',  soldDate: new Date().toISOString(), isLoss: true },
      { symbol: 'XDTE',  soldDate: new Date().toISOString(), isLoss: true },
    ],
  }));
  const fires = findSignals(result.signals, 'PILLAR_FILL');
  const tickers = fires.map((s) => s.ticker);
  assert.ok(!tickers.includes('JEPI'), 'should skip JEPI (wash-sale)');
  assert.ok(!tickers.includes('XDTE'), 'should skip XDTE (wash-sale)');
});

test('respects PILLAR_FILL_MAX_CANDIDATES cap (≤ 2 proposals per pillar)', () => {
  const result = runSignalEngine(baseInputs({
    positions: [enrichedPosition('SCHD', 625, 50_000)],
    cash:      50_000,
  }));
  const fires = findSignals(result.signals, 'PILLAR_FILL');
  assert.ok(fires.length <= 2, `expected ≤2 candidates, got ${fires.length}`);
});

test('runtime marginThresholds override CONFIG defaults', () => {
  // At 35% utilization, default CONFIG would fire MAINTENANCE_RANKED_TRIM
  // (threshold 30%). With runtime marginThresholds.trimAbovePct = 47, the
  // same portfolio should NOT fire (35% is below 47%).
  // Margin debt = $35k, totalValue = $100k → utilization = 35%.
  const positionsAndCash = {
    positions: [enrichedPosition('OXLC', 5000, 40_000), enrichedPosition('SCHD', 250, 20_000)],
    cash:      40_000,    // total $100k
    marginDebt: 35_000,
  };

  const defaultResult = runSignalEngine(baseInputs(positionsAndCash));
  assert.ok(
    findSignals(defaultResult.signals, 'MAINTENANCE_RANKED_TRIM').length > 0,
    'expected default (30%) threshold to fire at 35% utilization',
  );

  const runtimeResult = runSignalEngine(baseInputs({
    ...positionsAndCash,
    marginThresholds: { trimAbovePct: 47, trimTargetPct: 42, newBuyCeilingPct: 47 },
  }));
  assert.equal(
    findSignals(runtimeResult.signals, 'MAINTENANCE_RANKED_TRIM').length, 0,
    'expected runtime threshold (47%) to suppress firing at 35% utilization',
  );
});

test('PILLAR_FILL respects runtime newBuyCeilingPct', () => {
  // Underweight income (50% of $70k vs 65% target → 15pp gap), 30% utilization.
  //   positions $35k + cash $35k = totalValue $70k
  //   income% = 35/70 = 50% (gap 15pp ✓)
  //   marginDebt $21k → util ≈ 30%
  const inputs = {
    positions: [enrichedPosition('SCHD', 437, 35_000)],
    cash:       35_000,
    marginDebt: 21_000,
  };

  const defaultResult = runSignalEngine(baseInputs(inputs));
  assert.ok(
    findSignals(defaultResult.signals, 'PILLAR_FILL').length > 0,
    'expected default ceiling (35%) to allow PILLAR_FILL at 30% utilization',
  );

  const tightenedResult = runSignalEngine(baseInputs({
    ...inputs,
    marginThresholds: { trimAbovePct: 30, trimTargetPct: 25, newBuyCeilingPct: 25 },
  }));
  assert.equal(
    findSignals(tightenedResult.signals, 'PILLAR_FILL').length, 0,
    'expected runtime ceiling (25%) to suppress PILLAR_FILL at 30% utilization',
  );
});

test('individual proposal stays within PILLAR_FILL_MAX_DOLLARS = $5,000', () => {
  // Huge gap, plenty of cash — still each proposal should be capped at $5k.
  const result = runSignalEngine(baseInputs({
    positions: [],   // 0% income — gap = full target
    cash:      500_000,
    buyingPowerAvailable: 500_000,
  }));
  const fires = findSignals(result.signals, 'PILLAR_FILL');
  for (const f of fires) {
    assert.ok(f.sizeDollars <= 5_000 + 0.01, `proposal ${f.ticker} ${f.sizeDollars} exceeds $5k cap`);
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
