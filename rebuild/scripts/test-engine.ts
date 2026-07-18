/** Signals engine tests — pure, no I/O. Run with `npm run test:engine`. */
import assert from 'node:assert';
import { runEngine, airbagFactor, CONFIG } from '../lib/signals/engine';
import { emptyState, type EngineInput } from '../lib/signals/types';

function baseInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    positions: [
      { symbol: 'UPRO', marketValue: 100_000, quantity: 1000, price: 100 },
      { symbol: 'CLM', marketValue: 200_000, quantity: 20000, price: 10 },
      { symbol: 'XDTE', marketValue: 630_000, quantity: 12600, price: 50, maintenanceRequirement: 315_000 },
      { symbol: 'SQQQ', marketValue: 50_000, quantity: 5000, price: 10 },
    ],
    balances: {
      equity: 1_000_000,
      afw: 400_000,
      marginDebit: 0,
      maintenanceRequirement: 350_000,
      cash: 20_000,
    },
    market: { spyPrice: 500, spyHigh: 500, vix: 14 },
    state: { ...emptyState(), spyHigh: 500, afwHigh: 400_000 },
    today: '2026-07-18',
    ...overrides,
  };
}

// 1. Calm market, near-target book → no critical alerts, no AFW trigger
{
  const { signals } = runEngine(baseInput());
  assert.ok(!signals.some((s) => s.rule === 'AFW_TRIGGER'), 'no AFW trigger at highs');
  assert.ok(!signals.some((s) => s.rule === 'MARGIN_TIER'), 'no margin alert with zero debit');
}

// 2. AFW_TRIGGER fires at -10% SPY drawdown
{
  const input = baseInput();
  input.market.spyPrice = 450; // -10% from 500 high
  const { signals } = runEngine(input);
  const trig = signals.find((s) => s.rule === 'AFW_TRIGGER');
  assert.ok(trig, 'AFW trigger fires at -10%');
  assert.equal(trig!.trade!.side, 'BUY');
  assert.equal(trig!.trade!.notional, CONFIG.AFW_TRIGGER.buyNotionalPer10Pct);
}

// 3. AIRBAG scales sizes with VIX
{
  assert.equal(airbagFactor(10), 1);
  assert.equal(airbagFactor(50), CONFIG.AIRBAG.minSizeFactor);
  const mid = airbagFactor((CONFIG.AIRBAG.vixCalm + CONFIG.AIRBAG.vixPanic) / 2);
  assert.ok(mid > CONFIG.AIRBAG.minSizeFactor && mid < 1);
}

// 4. TRIPLES_TRIM fires when triples exceed target by >5%
{
  const input = baseInput();
  input.positions[0].marketValue = 120_000; // 12% of 1M vs 10% target → 20% over
  const { signals } = runEngine(input);
  const trim = signals.find((s) => s.rule === 'TRIPLES_TRIM');
  assert.ok(trim, 'trim fires above threshold');
  assert.equal(trim!.trade!.side, 'SELL');
}

// 5. MARGIN_TIER + MAINTENANCE_RANKED_TRIM at 30%+ utilization
{
  const input = baseInput();
  input.balances.marginDebit = 500_000; // util = 500/1500 = 33%
  const { signals } = runEngine(input);
  assert.ok(signals.some((s) => s.rule === 'MARGIN_TIER' && s.severity === 'high'));
  const mrt = signals.filter((s) => s.rule === 'MAINTENANCE_RANKED_TRIM');
  assert.ok(mrt.length >= 2, 'trim + 1/3 rotation companion');
  assert.equal(mrt[0].trade!.symbol, 'XDTE', 'ranks maintenance-heavy income name');
  const rotation = mrt.find((s) => s.trade?.side === 'BUY');
  assert.ok(
    Math.abs(rotation!.trade!.notional - mrt[0].trade!.notional / 3) < 1,
    '1/3 of proceeds into triples'
  );
}

// 6. Dip ladder: SOXL weighted 2× (TACTICAL), anchor resets on new highs
{
  const input = baseInput();
  input.positions.push({ symbol: 'SOXL', marketValue: 10_000, quantity: 500, price: 20 });
  input.state.dipLadder.anchors = { SOXL: 25, UPRO: 100, TQQQ: 80 };
  // SOXL at 20 vs anchor 25 = -20% → 4 rungs; UPRO flat
  const { signals, nextState } = runEngine(input);
  const soxl = signals.find((s) => s.rule === 'TRIPLES_DIP_LADDER' && s.trade?.symbol === 'SOXL');
  assert.ok(soxl, 'SOXL rung fires');
  const weightSum = Object.values(CONFIG.DIP_LADDER.weights).reduce((a, b) => a + b, 0);
  const expected = 4 * (CONFIG.DIP_LADDER.budgetPerRung * CONFIG.DIP_LADDER.weights.SOXL) / weightSum;
  assert.ok(Math.abs(soxl!.trade!.notional - expected) < 1, `SOXL 2× weighted budget (${expected})`);
  // New high resets anchor
  const input2 = baseInput();
  input2.positions.push({ symbol: 'SOXL', marketValue: 15_000, quantity: 500, price: 30 });
  input2.state.dipLadder.anchors = { SOXL: 25 };
  input2.state.dipLadder.deployed = { SOXL: 5000 };
  const out2 = runEngine(input2);
  assert.equal(out2.nextState.dipLadder.anchors.SOXL, 30, 'anchor resets on new high');
  assert.equal(out2.nextState.dipLadder.deployed.SOXL, 0, 'deployment cycle resets');
  void nextState;
}

// 7. PIVOT_DEADLINE kill switch on runaway margin debt
{
  const input = baseInput();
  input.balances.marginDebit = 130_000;
  input.state.marginDebtHistory = [
    { date: '2026-07-08', debit: 100_000 },
    { date: '2026-07-17', debit: 120_000 },
  ];
  const { signals } = runEngine(input);
  assert.ok(
    signals.some((s) => s.rule === 'PIVOT_DEADLINE' && s.severity === 'critical'),
    'kill switch fires at +30% debt growth'
  );
}

// 8. HEDGE_FLOOR: below 1% hedges → refill signal
{
  const input = baseInput();
  input.positions = input.positions.filter((p) => p.symbol !== 'SQQQ');
  const { signals } = runEngine(input);
  assert.ok(signals.some((s) => s.rule === 'HEDGE_FLOOR'), 'hedge floor refill fires');
}

// 9. CONCENTRATION: >20% position → high alert
{
  const input = baseInput();
  input.positions[2].marketValue = 250_000; // XDTE 25%
  const { signals } = runEngine(input);
  assert.ok(signals.some((s) => s.rule === 'CONCENTRATION' && s.severity === 'high'));
}

// 10. DEFENSE suppresses buys
{
  const input = baseInput();
  input.balances.marginDebit = 600_000; // equity ratio 1000/1600 = 62.5% < 70%
  input.market.spyPrice = 450; // would otherwise fire AFW trigger
  const { signals } = runEngine(input);
  assert.ok(signals.some((s) => s.rule === 'DEFENSE'));
  assert.ok(!signals.some((s) => s.rule === 'AFW_TRIGGER'), 'DEFENSE gates AFW buys');
}

console.log('✓ test-engine passed');
