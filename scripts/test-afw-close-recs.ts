/**
 * AFW close-recommendations tests.
 *
 * Covers the buildAfwCloseRecs helper that powers /api/options/close-recs.
 * Built around the user's situation: existing short puts opened before the
 * post-trade AFW guardrail are sitting below the $10K floor — this report
 * tells them which to close, profits-first.
 */

import assert from 'node:assert/strict';
import { buildAfwCloseRecs } from '../lib/options/afw-close-recs';
import type { SchwabPosition } from '../lib/schwab/types';

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

// ─── Fixture builders ────────────────────────────────────────────────────────

function shortPut(args: {
  underlying:  string;
  strike:      number;
  contracts:   number;
  currentMid:  number;     // current option mid per share — positive
  openCredit:  number;     // credit received when opened, per share — positive
  maintReq:    number;     // margin lock dollars
  description?: string;
}): SchwabPosition {
  // OCC symbol: "UPRO  240621P00050000" — we don't need exact formatting,
  // just a leading underlying token and a P-ish glyph so underlying parsing works.
  const sym = `${args.underlying}  240621P${String(Math.round(args.strike * 1000)).padStart(8, '0')}`;
  return {
    shortQuantity: args.contracts,
    averagePrice:  args.openCredit,    // credit received per share
    currentDayProfitLoss: 0,
    currentDayProfitLossPercentage: 0,
    longQuantity:  0,
    settledLongQuantity:  0,
    settledShortQuantity: args.contracts,
    instrument: {
      assetType:   'OPTION',
      symbol:      sym,
      description: args.description ?? `${args.underlying} put ${args.strike}`,
    },
    // marketValue is NEGATIVE for shorts (you'd pay to close at currentMid).
    marketValue:             -args.currentMid * args.contracts * 100,
    maintenanceRequirement:  args.maintReq,
    averageLongPrice:        0,
    taxLotAverageLongPrice:  0,
    longOpenProfitLoss:      0,
    previousSessionLongQuantity: 0,
    currentDayCost:          0,
  };
}

function longPut(args: {
  underlying:  string;
  strike:      number;
  contracts:   number;
  currentMid:  number;     // current option mid per share
  openDebit:   number;     // debit paid when opened, per share
  maintReq:    number;
}): SchwabPosition {
  const sym = `${args.underlying}  240621P${String(Math.round(args.strike * 1000)).padStart(8, '0')}`;
  return {
    shortQuantity: 0,
    averagePrice:  args.openDebit,
    currentDayProfitLoss: 0,
    currentDayProfitLossPercentage: 0,
    longQuantity:  args.contracts,
    settledLongQuantity:  args.contracts,
    settledShortQuantity: 0,
    instrument: {
      assetType: 'OPTION',
      symbol:    sym,
    },
    marketValue:             args.currentMid * args.contracts * 100,
    maintenanceRequirement:  args.maintReq,
    averageLongPrice:        args.openDebit,
    taxLotAverageLongPrice:  args.openDebit,
    longOpenProfitLoss:      (args.currentMid - args.openDebit) * args.contracts * 100,
    previousSessionLongQuantity: args.contracts,
    currentDayCost:          0,
  };
}

function equity(symbol: string, shares: number, marketValue: number): SchwabPosition {
  return {
    shortQuantity: 0,
    averagePrice:  marketValue / Math.max(1, shares),
    currentDayProfitLoss: 0,
    currentDayProfitLossPercentage: 0,
    longQuantity:  shares,
    settledLongQuantity:  shares,
    settledShortQuantity: 0,
    instrument: { assetType: 'EQUITY', symbol },
    marketValue,
    maintenanceRequirement: marketValue * 0.25,
    averageLongPrice: marketValue / Math.max(1, shares),
    taxLotAverageLongPrice: marketValue / Math.max(1, shares),
    longOpenProfitLoss: 0,
    previousSessionLongQuantity: shares,
    currentDayCost: 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\nbuildAfwCloseRecs');

test('returns alreadyHealthy + no closes when AFW already above floor', () => {
  const r = buildAfwCloseRecs([], 20_000, 10_000);
  assert.equal(r.alreadyHealthy, true);
  assert.equal(r.recommendedCloses.length, 0);
  assert.equal(r.afwBefore, 20_000);
  assert.equal(r.afwAfter,  20_000);
});

test('ignores equity positions — only operates on options', () => {
  const r = buildAfwCloseRecs(
    [equity('SCHD', 100, 8_000), equity('UPRO', 50, 2_500)],
    3_000,
    10_000,
  );
  assert.equal(r.alreadyHealthy, false);
  assert.equal(r.allOpenOptions.length, 0);
  assert.equal(r.recommendedCloses.length, 0);
});

test('sorts open options by P&L descending (profits first)', () => {
  // Three short puts. Opened at differing credits, all now at $1 mid.
  //   PUT_A: opened $3 credit, now $1   → P&L = (3 − 1) × 100 = +$200
  //   PUT_B: opened $0.50 credit, now $1 → P&L = (0.5 − 1) × 100 = −$50
  //   PUT_C: opened $5 credit, now $1   → P&L = (5 − 1) × 100 = +$400
  // Expected order: PUT_C, PUT_A, PUT_B
  const positions = [
    shortPut({ underlying: 'PUT_A', strike: 50, contracts: 1, currentMid: 1, openCredit: 3,   maintReq: 5_000 }),
    shortPut({ underlying: 'PUT_B', strike: 50, contracts: 1, currentMid: 1, openCredit: 0.5, maintReq: 5_000 }),
    shortPut({ underlying: 'PUT_C', strike: 50, contracts: 1, currentMid: 1, openCredit: 5,   maintReq: 5_000 }),
  ];
  const r = buildAfwCloseRecs(positions, 0, 10_000);
  const order = r.allOpenOptions.map((o) => o.underlying);
  assert.deepEqual(order, ['PUT_C', 'PUT_A', 'PUT_B'], `unexpected order: ${order.join(',')}`);
});

test('greedy minimum-set: stops once projected AFW clears floor', () => {
  // AFW = $2k, floor = $10k → need to free $8k.
  //   GREEN_BIG (P&L +$1000, frees $9k margin) ← should be enough alone
  //   GREEN_SMALL (P&L +$200, frees $3k)
  //   RED (P&L -$50, frees $5k)
  // Sorted: GREEN_BIG, GREEN_SMALL, RED. First one already gets us to $11k.
  const positions = [
    shortPut({ underlying: 'GREEN_BIG',   strike: 90, contracts: 1, currentMid: 0.1, openCredit: 10.1, maintReq: 9_000 }),
    shortPut({ underlying: 'GREEN_SMALL', strike: 30, contracts: 1, currentMid: 1,   openCredit: 3,    maintReq: 3_000 }),
    shortPut({ underlying: 'RED',         strike: 50, contracts: 1, currentMid: 1.5, openCredit: 1,    maintReq: 5_000 }),
  ];
  const r = buildAfwCloseRecs(positions, 2_000, 10_000);
  assert.equal(r.alreadyHealthy, false);
  assert.equal(r.recommendedCloses.length, 1, 'only the largest profit close should be needed');
  assert.equal(r.recommendedCloses[0].underlying, 'GREEN_BIG');
  assert.equal(r.afwAfter, 11_000);
});

test('greedy keeps adding when one close is insufficient', () => {
  // AFW = $0, floor = $10k. Each close frees only $3k.
  // Need 4 closes to reach $12k.
  const positions = [1, 2, 3, 4, 5].map((i) =>
    shortPut({
      underlying: `PUT_${i}`, strike: 30, contracts: 1, currentMid: 1,
      openCredit: 1 + i * 0.1, maintReq: 3_000,
    }),
  );
  const r = buildAfwCloseRecs(positions, 0, 10_000);
  // P&L per: (1+i*0.1 − 1) × 100 = i*10. So PUT_5 highest, PUT_1 lowest.
  // Need ceil(10000/3000) = 4 closes. afterAfter = 12000.
  assert.equal(r.recommendedCloses.length, 4);
  assert.equal(r.afwAfter, 12_000);
  // Order should be highest profit first.
  assert.deepEqual(
    r.recommendedCloses.map((o) => o.underlying),
    ['PUT_5', 'PUT_4', 'PUT_3', 'PUT_2'],
  );
});

test('emits SELL_TO_CLOSE for longs, BUY_TO_CLOSE for shorts', () => {
  const positions = [
    shortPut({ underlying: 'SHORTY', strike: 50, contracts: 1, currentMid: 1, openCredit: 3, maintReq: 5_000 }),
    longPut({  underlying: 'LONGY',  strike: 50, contracts: 1, currentMid: 4, openDebit: 1,  maintReq: 100 }),
  ];
  const r = buildAfwCloseRecs(positions, 0, 10_000);
  const shorty = r.allOpenOptions.find((o) => o.underlying === 'SHORTY')!;
  const longy  = r.allOpenOptions.find((o) => o.underlying === 'LONGY')!;
  assert.equal(shorty.closeInstruction, 'BUY_TO_CLOSE');
  assert.equal(longy.closeInstruction,  'SELL_TO_CLOSE');
  assert.equal(shorty.side, 'short');
  assert.equal(longy.side,  'long');
});

test('P&L math: short put profit = credit − close cost', () => {
  // Opened at $5 credit, now at $1 mid, 2 contracts.
  // P&L = (5 − 1) × 2 × 100 = $800
  const r = buildAfwCloseRecs(
    [shortPut({ underlying: 'TEST', strike: 50, contracts: 2, currentMid: 1, openCredit: 5, maintReq: 10_000 })],
    0,
    10_000,
  );
  const opt = r.allOpenOptions[0];
  assert.equal(opt.unrealizedPL, 800);
  assert.equal(opt.contracts, 2);
});

test('P&L math: long put profit = current value − debit', () => {
  // Opened at $1 debit, now at $4 mid, 1 contract.
  // P&L = (4 − 1) × 100 = $300
  const r = buildAfwCloseRecs(
    [longPut({ underlying: 'TEST', strike: 50, contracts: 1, currentMid: 4, openDebit: 1, maintReq: 100 })],
    20_000,
    10_000,
  );
  assert.equal(r.allOpenOptions[0].unrealizedPL, 300);
});

test('underlying extraction strips OCC padding', () => {
  const r = buildAfwCloseRecs(
    [shortPut({ underlying: 'UPRO', strike: 50, contracts: 1, currentMid: 1, openCredit: 3, maintReq: 5_000 })],
    0,
    10_000,
  );
  assert.equal(r.allOpenOptions[0].underlying, 'UPRO');
});

test('handles empty positions array gracefully', () => {
  const r = buildAfwCloseRecs([], 5_000, 10_000);
  assert.equal(r.alreadyHealthy, false);
  assert.equal(r.allOpenOptions.length, 0);
  assert.equal(r.recommendedCloses.length, 0);
  assert.equal(r.afwAfter, 5_000);    // unchanged — nothing to close
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
