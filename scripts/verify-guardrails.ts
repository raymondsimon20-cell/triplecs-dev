/**
 * Guards the margin/AFW projection math in lib/guardrails.ts.
 *
 * Regression this exists to prevent: `availableCash = equity − marginBalance`
 * manufactured ~$64K of phantom cash on a margin account holding none, so
 * every equity BUY under that figure projected zero AFW impact and zero
 * margin increase — $40K of margin draw passed a $10K AFW floor (verified
 * against real balances, 2026-08-05).
 *
 * Policy encoded here (user decision, 2026-08-05): margin IS buying power up
 * to Schwab's 50% wall. An equity BUY therefore consumes 0.5 × notional of
 * AFW (Reg-T initial requirement), and the full notional beyond true cash
 * lands on the margin balance.
 *
 * Run: npx tsx scripts/verify-guardrails.ts
 */

import {
  validateBatch, projectAfwImpact, projectMarginIncrease,
  type ProposedTrade, type GuardrailContext,
} from '../lib/guardrails';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// Real account shape: fully invested, margin debit, zero actual cash.
const ctx: GuardrailContext = {
  totalValue: 106_385, equity: 85_463, marginBalance: 20_922,
  afwDollars: 11_000,
  positions: [], pillars: [], recentTrades: [],
};

const buy5k: ProposedTrade = { symbol: 'TQQQ', instruction: 'BUY', shares: 50, price: 100, pillar: 'triples' };

check('equity BUY AFW impact = 50% of notional',
  projectAfwImpact(buy5k, ctx) === 2_500,
  `got ${projectAfwImpact(buy5k, ctx)}`);

check('equity BUY margin increase = full notional (no real cash)',
  projectMarginIncrease(buy5k, ctx) === 5_000,
  `got ${projectMarginIncrease(buy5k, ctx)}`);

// The exact scenario that slipped through: repeated $5K buys against an AFW
// $1K above the floor. First one passes (11,000 − 2,500 = 8,500 < 10,000 —
// actually blocks). Verify at least that not everything sails through.
const eight = Array.from({ length: 8 }, () => ({ ...buy5k }));
const res = validateBatch(eight, ctx);
check('repeated buys no longer bypass the AFW floor',
  res.blocked.length > 0,
  `allowed=${res.allowed.length} blocked=${res.blocked.length} (was allowed=8 blocked=0)`);

// Cash-rich account: $50K equity, no positions, no margin → buys are
// cash-funded, margin increase must be 0 but AFW still moves.
const cashCtx: GuardrailContext = {
  totalValue: 0, equity: 50_000, marginBalance: 0,
  afwDollars: 50_000, positions: [], pillars: [], recentTrades: [],
};
check('cash-funded BUY projects zero margin increase',
  projectMarginIncrease(buy5k, cashCtx) === 0,
  `got ${projectMarginIncrease(buy5k, cashCtx)}`);
check('cash-funded BUY still consumes AFW (Reg-T half)',
  projectAfwImpact(buy5k, cashCtx) === 2_500,
  `got ${projectAfwImpact(buy5k, cashCtx)}`);

// Short put math untouched by this change — cash-secured reserves the strike.
const csp: ProposedTrade = {
  symbol: 'O', instruction: 'SELL_TO_OPEN', shares: 1, price: 1.25, pillar: 'income',
  option: { kind: 'put', style: 'cash-secured', strike: 62.5, underlyingPrice: 63.5 },
};
check('cash-secured put AFW = strike × 100',
  projectAfwImpact(csp, ctx) === 6_250,
  `got ${projectAfwImpact(csp, ctx)}`);
check('cash-secured put margin increase = 0',
  projectMarginIncrease(csp, ctx) === 0,
  `got ${projectMarginIncrease(csp, ctx)}`);

console.log(failures === 0 ? '\nGuardrail projections hold.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
