/** Guardrails tests — run with `npm run test:guardrails`. */
import assert from 'node:assert';
import { validateTrade, projectMarginDraw, GUARDRAIL_CONFIG } from '../lib/guardrails';
import type { EnginePosition, EngineBalances, ProposedTrade } from '../lib/signals/types';

const positions: EnginePosition[] = [
  { symbol: 'UPRO', marketValue: 100_000, quantity: 1000, price: 100 },
  { symbol: 'XDTE', marketValue: 600_000, quantity: 12000, price: 50 },
];
const balances: EngineBalances = {
  equity: 1_000_000,
  afw: 300_000, // AFW (Available For Withdrawal)
  marginDebit: 0,
  maintenanceRequirement: 350_000,
  cash: 50_000,
};

const buy = (notional: number, symbol = 'TQQQ'): ProposedTrade => ({
  symbol,
  side: 'BUY',
  notional,
  pillar: 'triples',
});

// 1. Reasonable trade passes
assert.ok(validateTrade(buy(20_000), positions, balances).allowed);

// 2. Max order size: >10% of portfolio blocked
{
  const r = validateTrade(buy(150_000), positions, balances);
  assert.ok(!r.allowed);
  assert.ok(r.checks.find((c) => c.name === 'max-order-size' && !c.passed));
}

// 3. Concentration: post-trade >20% blocked
{
  const r = validateTrade(
    { symbol: 'XDTE', side: 'BUY', notional: 90_000, pillar: 'income' },
    positions,
    { ...balances, equity: 3_000_000 } // keep order-size + overdrift checks passing
  );
  // 600K + 90K = 690K / 3M = 23% > 20%
  assert.ok(!r.allowed);
  assert.ok(r.checks.find((c) => c.name === 'max-concentration' && !c.passed));
}

// 4. AFW floor: projected post-trade AFW below $10K blocked
{
  const tight: EngineBalances = { ...balances, afw: 25_000 };
  const r = validateTrade(buy(20_000), positions, tight);
  assert.ok(!r.allowed, 'AFW floor blocks');
  assert.ok(r.checks.find((c) => c.name === 'afw-floor' && !c.passed));
  // A sell always improves AFW → passes floor
  const sell: ProposedTrade = { symbol: 'UPRO', side: 'SELL', notional: 20_000, pillar: 'triples' };
  const rs = validateTrade(sell, positions, tight);
  assert.ok(rs.checks.find((c) => c.name === 'afw-floor')!.passed);
}

// 5. Options margin math
{
  const csp: ProposedTrade = {
    symbol: 'SOXL', side: 'SELL', notional: 500, pillar: 'triples',
    optionKind: 'cash-secured-put', strike: 20, contracts: 5,
  };
  assert.equal(projectMarginDraw(csp), 20 * 100 * 5, 'CSP holds full strike collateral');
  const naked: ProposedTrade = { ...csp, optionKind: 'naked-put' };
  assert.equal(projectMarginDraw(naked), 0.2 * 20 * 100 * 5, 'naked put ~20% requirement');
  const cc: ProposedTrade = { ...csp, optionKind: 'covered-call' };
  assert.equal(projectMarginDraw(cc), 0, 'covered call draws nothing');
  // AFW floor applies to option collateral too
  const tight: EngineBalances = { ...balances, afw: 12_000 };
  const r = validateTrade(csp, positions, tight); // draw 10K → AFW 2K < 10K floor
  assert.ok(r.checks.find((c) => c.name === 'afw-floor' && !c.passed), 'AFW floor covers options');
}

// 6. Broker margin cap: projected utilization >50% blocked
{
  const levered: EngineBalances = { ...balances, equity: 100_000, afw: 200_000, marginDebit: 90_000, cash: 0 };
  const r = validateTrade(buy(9_000), positions, levered);
  // proj debit 99K, gross 199K → 49.7% OK; push further:
  const r2 = validateTrade(buy(9_999), positions, { ...levered, marginDebit: 95_000 });
  assert.ok(r2.checks.find((c) => c.name === 'broker-margin-cap' && !c.passed), 'Schwab 50% cap enforced');
  void r;
}

// 7. Pillar overdrift blocked
{
  const r = validateTrade(buy(95_000, 'UPRO'), positions, { ...balances, equity: 1_000_000 });
  // triples 100K + 95K = 195K → 19.5% vs 10% target = 9.5% overdrift < 10% max — passes overdrift but fails order size (9.5%< 10 ok? order 9.5% of 1M passes)
  // Push over: use bigger existing base via smaller equity
  const r2 = validateTrade(buy(60_000, 'UPRO'), positions, { ...balances, equity: 700_000 });
  // triples (100K+60K)/700K = 22.9% vs 10% → 12.9% overdrift > 10%
  assert.ok(r2.checks.find((c) => c.name === 'max-pillar-overdrift' && !c.passed));
  void r;
}

assert.equal(GUARDRAIL_CONFIG.afwFloorDollars, 10_000);
console.log('✓ test-guardrails passed');
