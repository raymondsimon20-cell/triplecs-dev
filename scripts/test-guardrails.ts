/**
 * Guardrail tests — focus on the AFW-headroom check + option margin projection.
 *
 * Compile + run via the same harness as test-engine-rules:
 *     tsc --project scripts/tsconfig.guardrails.test.json
 *     NODE_PATH=$PWD/node_modules node <outdir>/scripts/test-guardrails.js
 *
 * What's covered:
 *   - projectMarginDraw across BUY equity / BUY_TO_OPEN long option /
 *     SELL_TO_OPEN cash-secured put / SELL_TO_OPEN naked put / covered call /
 *     naked call / closes.
 *   - checkAfwHeadroom blocks when projected post-trade AFW < floor.
 *   - checkAfwHeadroom is silent when ctx.afwDollars is undefined.
 *   - checkMargin now catches short options (used to skip them entirely).
 *   - Equity SELL never blocked by AFW gate (releases collateral).
 */

import assert from 'node:assert/strict';
import {
  validateProposedTrade,
  projectMarginDraw,
  DEFAULT_LIMITS,
  type GuardrailContext,
  type ProposedTrade,
} from '../lib/guardrails';

// ─── Harness ─────────────────────────────────────────────────────────────────

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

// ─── Fixtures ────────────────────────────────────────────────────────────────

function baseCtx(over: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    totalValue:    200_000,
    equity:        120_000,
    marginBalance: 80_000,
    afwDollars:    30_000,
    positions:     [],
    pillars:       [],
    recentTrades:  [],
    ...over,
  };
}

// ─── projectMarginDraw ───────────────────────────────────────────────────────

console.log('\nprojectMarginDraw');

test('equity BUY: notional minus available cash', () => {
  // available cash = equity − marginBalance = 120k − 80k = 40k.
  // BUY $50k → margin draw = $10k.
  const t: ProposedTrade = { symbol: 'SCHD', instruction: 'BUY', shares: 625, price: 80, pillar: 'income' };
  assert.equal(projectMarginDraw(t, baseCtx()), 10_000);
});

test('equity BUY fully covered by cash: zero draw', () => {
  const t: ProposedTrade = { symbol: 'SCHD', instruction: 'BUY', shares: 100, price: 80, pillar: 'income' };
  assert.equal(projectMarginDraw(t, baseCtx()), 0);
});

test('equity SELL: zero draw (releases collateral)', () => {
  const t: ProposedTrade = { symbol: 'SCHD', instruction: 'SELL', shares: 100, price: 80, pillar: 'income' };
  assert.equal(projectMarginDraw(t, baseCtx()), 0);
});

test('SELL_TO_OPEN cash-secured put: strike × 100 × contracts', () => {
  // 2 contracts × strike $50 × 100 = $10,000 lock.
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 2, price: 1.50, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 50, underlyingPrice: 55 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 10_000);
});

test('SELL_TO_OPEN naked put OTM: Reg-T 20% underlying − OTM amount', () => {
  // Underlying 55, strike 50, OTM = 5. 20% × 55 = 11. 11 − 5 = 6. Floor: 10% × 50 = 5. → 6 wins.
  // 2 contracts × 6 × 100 = $1,200.
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 2, price: 1.50, pillar: 'triples',
    option: { kind: 'put', style: 'naked', strike: 50, underlyingPrice: 55 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 1_200);
});

test('SELL_TO_OPEN naked put ITM: hits 10% strike floor', () => {
  // Underlying 40, strike 50, OTM = 0 (ITM). 20% × 40 = 8 vs 10% × 50 = 5. → 8 wins.
  // 1 contract × 8 × 100 = $800.
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 1, price: 11.00, pillar: 'triples',
    option: { kind: 'put', style: 'naked', strike: 50, underlyingPrice: 40 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 800);
});

test('SELL_TO_OPEN covered call: zero draw (collateralized by long equity)', () => {
  const t: ProposedTrade = {
    symbol: 'SCHD', instruction: 'SELL_TO_OPEN', shares: 1, price: 1.20, pillar: 'income',
    option: { kind: 'call', style: 'covered', strike: 85, underlyingPrice: 80 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 0);
});

test('BUY_TO_OPEN long put: full premium debit × 100 × contracts', () => {
  // 2 contracts × $3.50 premium × 100 = $700 debit.
  const t: ProposedTrade = {
    symbol: 'SPY', instruction: 'BUY_TO_OPEN', shares: 2, price: 3.50, pillar: 'hedge',
    option: { kind: 'put', style: 'naked', strike: 500, underlyingPrice: 520 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 700);
});

test('SELL_TO_CLOSE: zero draw (releases margin)', () => {
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_CLOSE', shares: 2, price: 0.30, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 50, underlyingPrice: 55 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 0);
});

test('BUY_TO_CLOSE: zero draw (conservative)', () => {
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'BUY_TO_CLOSE', shares: 2, price: 0.30, pillar: 'triples',
    option: { kind: 'put', style: 'naked', strike: 50, underlyingPrice: 55 },
  };
  assert.equal(projectMarginDraw(t, baseCtx()), 0);
});

// ─── checkAfwHeadroom ────────────────────────────────────────────────────────

console.log('\ncheckAfwHeadroom');

test('blocks a short put that consumes most of AFW headroom', () => {
  // AFW = $15k. Cash-secured short put with strike $50 × 100 × 3 = $15k margin lock.
  // Post-trade AFW = $0 → below the $10k default floor. BLOCK.
  const ctx = baseCtx({ afwDollars: 15_000 });
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 3, price: 1.50, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 50, underlyingPrice: 55 },
  };
  const result = validateProposedTrade(t, ctx);
  assert.equal(result.allowed, false, 'expected to be blocked');
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(afwViolation, 'expected afw_headroom violation');
  assert.equal(afwViolation!.severity, 'block');
  // Sanity: message should mention AFW.
  assert.match(afwViolation!.message, /AFW/);
});

test('allows a small short put with plenty of AFW headroom', () => {
  // AFW = $50k. 1-contract cash-secured put strike $20 × 100 = $2k lock.
  // Post-trade AFW = $48k, well above the $10k floor. ALLOW.
  const ctx = baseCtx({ afwDollars: 50_000 });
  const t: ProposedTrade = {
    symbol: 'SOXL', instruction: 'SELL_TO_OPEN', shares: 1, price: 0.40, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 20, underlyingPrice: 22 },
  };
  const result = validateProposedTrade(t, ctx);
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(!afwViolation, `expected no afw_headroom violation; got: ${JSON.stringify(afwViolation)}`);
});

test('blocks at exact floor boundary (post-trade AFW < floor, not ≤)', () => {
  // AFW = $15k, draw = $5,001 → post = $9,999 < $10k floor. BLOCK.
  const ctx = baseCtx({
    afwDollars: 15_000,
    equity:     100_000,    // → available cash = equity − marginBalance per draw formula
    marginBalance: 50_000,
  });
  // Equity BUY of $55,001 → cash 50k → draw 5,001.
  const t: ProposedTrade = {
    symbol: 'SCHD', instruction: 'BUY', shares: 1, price: 55_001, pillar: 'income',
  };
  const result = validateProposedTrade(t, ctx);
  // Note: 50%-cap margin_cap check could ALSO fire on this; we care about the AFW one being present.
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(afwViolation, 'expected afw_headroom violation at boundary');
});

test('allows exactly at floor boundary (post-trade AFW === floor)', () => {
  // AFW = $15k, draw = $5,000 → post = $10k === floor. ALLOW (gate is < floor).
  const ctx = baseCtx({
    afwDollars: 15_000,
    equity:     100_000,
    marginBalance: 50_000,
    totalValue: 200_000,    // keep utilization comfortable so margin_cap doesn't fire
  });
  const t: ProposedTrade = {
    symbol: 'SCHD', instruction: 'BUY', shares: 1, price: 55_000, pillar: 'income',
  };
  const result = validateProposedTrade(t, ctx);
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(!afwViolation, `expected no afw_headroom violation at boundary; got: ${JSON.stringify(afwViolation)}`);
});

test('skips AFW check entirely when ctx.afwDollars is undefined (legacy compat)', () => {
  const ctx = baseCtx({ afwDollars: undefined });
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 3, price: 1.50, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 50, underlyingPrice: 55 },
  };
  const result = validateProposedTrade(t, ctx);
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(!afwViolation, 'AFW check should be skipped when afwDollars undefined');
});

test('equity SELL never blocked by AFW (zero draw)', () => {
  const ctx = baseCtx({ afwDollars: 1_000 });   // way below floor
  const t: ProposedTrade = {
    symbol: 'SCHD', instruction: 'SELL', shares: 10, price: 80, pillar: 'income',
  };
  const result = validateProposedTrade(t, ctx);
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(!afwViolation, 'equity SELL should never trip AFW gate');
});

test('respects custom minAfwHeadroomAfterTrade limit', () => {
  // Override floor to $25k. AFW = $30k, draw = $10k → post = $20k < $25k. BLOCK.
  const ctx = baseCtx({
    afwDollars: 30_000,
    limits: { minAfwHeadroomAfterTrade: 25_000 },
  });
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 2, price: 1.50, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 50, underlyingPrice: 55 },
  };
  const result = validateProposedTrade(t, ctx);
  const afwViolation = result.violations.find((v) => v.code === 'afw_headroom');
  assert.ok(afwViolation, 'should respect runtime floor override');
});

test('default floor is $10k (sanity check on DEFAULT_LIMITS)', () => {
  assert.equal(DEFAULT_LIMITS.minAfwHeadroomAfterTrade, 10_000);
});

// ─── checkMargin (short options newly visible) ───────────────────────────────

console.log('\ncheckMargin (short options)');

test('short option margin counts toward 50% utilization cap', () => {
  // Build a scenario where the short put pushes utilization above 50%.
  // totalValue 100k, marginBalance 45k = 45% util. Short put adds $10k draw.
  // Post: margin 55k, total 110k → 50%. Right at the boundary. Bump strike to push over.
  const ctx = baseCtx({
    totalValue:    100_000,
    equity:        55_000,
    marginBalance: 45_000,
    afwDollars:    50_000,      // make sure AFW gate doesn't intercept
  });
  // 4 contracts × strike $50 × 100 = $20k draw → util 45+20=65 / 120 ≈ 54%.
  const t: ProposedTrade = {
    symbol: 'UPRO', instruction: 'SELL_TO_OPEN', shares: 4, price: 1.50, pillar: 'triples',
    option: { kind: 'put', style: 'cash-secured', strike: 50, underlyingPrice: 55 },
  };
  const result = validateProposedTrade(t, ctx);
  const marginCap = result.violations.find((v) => v.code === 'margin_cap');
  assert.ok(marginCap, `expected margin_cap on short option; got violations: ${result.violations.map((v) => v.code).join(',')}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
