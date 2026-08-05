/**
 * Guards `validateBatchCumulative` in lib/guardrails.ts — the batch validator
 * behind POST /api/orders/preflight.
 *
 * Regression this exists to prevent: validating each order of a plan against
 * the same opening snapshot. The allocation planner deploys a lump sum across
 * several names at once, so a set of buys that each individually clear the
 * $10K post-trade AFW floor can jointly go straight through it. Only a
 * cumulative fold catches that.
 *
 * Policy under test (matches verify-guardrails.ts): an equity BUY consumes
 * 0.5 × notional of AFW (Reg-T initial requirement).
 *
 * Run: npx tsx scripts/verify-batch-cumulative.ts
 */

import {
  validateBatch, validateBatchCumulative,
  type ProposedTrade, type GuardrailContext,
} from '../lib/guardrails';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ─── Fixture ─────────────────────────────────────────────────────────────────
// AFW $16K against the $10K floor: $6K of usable headroom, so $12K of buys.
// Each order below draws $2,500 of AFW (0.5 × $5,000 notional), so the first
// two clear and the third is the one that would breach the floor.
const baseCtx = (): GuardrailContext => ({
  totalValue:    500_000,
  equity:        400_000,
  marginBalance: 100_000,
  afwDollars:    16_000,
  positions:     [],
  pillars:       [],
  recentTrades:  [],
});

const buy = (symbol: string): ProposedTrade =>
  ({ symbol, instruction: 'BUY', shares: 50, price: 100, pillar: 'triples' });

const plan = [buy('UPRO'), buy('TQQQ'), buy('SOXL'), buy('SCHD')];

// ─── 1. The bug this replaces ────────────────────────────────────────────────
// Snapshot-based validation sees $16K AFW for every order and lets all four
// through — jointly $10K of AFW draw, landing at $6K, under the floor.
const snapshot = validateBatch(plan, baseCtx());
check('snapshot validateBatch passes the whole plan (the gap being closed)',
  snapshot.allowed.length === 4 && snapshot.blocked.length === 0,
  `allowed ${snapshot.allowed.length}, blocked ${snapshot.blocked.length}`);

// ─── 2. Cumulative catches it ────────────────────────────────────────────────
const { results, finalContext } = validateBatchCumulative(plan, baseCtx());

check('cumulative allows the first two orders',
  results[0].allowed && results[1].allowed);

check('cumulative blocks once the AFW floor would break',
  !results[2].allowed && !results[3].allowed,
  `3rd allowed=${results[2].allowed}, 4th allowed=${results[3].allowed}`);

check('block cites the AFW floor',
  results[2].violations.some((v) => v.code === 'afw_headroom' && v.severity === 'block'),
  results[2].violations.map((v) => v.code).join(',') || 'none');

check('projected AFW reflects only the accepted orders',
  finalContext.afwDollars === 16_000 - 2 * 2_500,
  `got ${finalContext.afwDollars}, want 11000`);

check('projected AFW stays above the floor',
  (finalContext.afwDollars ?? 0) >= 10_000,
  `got ${finalContext.afwDollars}`);

// ─── 3. Blocked orders leave no trace ────────────────────────────────────────
check('blocked orders do not enter positions',
  !finalContext.positions.some((p) => p.symbol === 'SOXL' || p.symbol === 'SCHD'),
  finalContext.positions.map((p) => p.symbol).join(',') || 'none');

check('accepted orders do enter positions',
  finalContext.positions.length === 2 &&
  finalContext.positions.every((p) => p.marketValue === 5_000 && p.shares === 50));

// ─── 4. Caller's context is never mutated ────────────────────────────────────
const original = baseCtx();
validateBatchCumulative(plan, original);
check('input context is not mutated',
  original.afwDollars === 16_000 && original.positions.length === 0 &&
  original.marginBalance === 100_000,
  `afw ${original.afwDollars}, positions ${original.positions.length}`);

// ─── 5. Order matters, and headroom is finite ────────────────────────────────
// Reversing the plan should still admit exactly two orders — whichever two
// come first. This is the property that makes the caller's ordering meaningful.
const reversed = validateBatchCumulative([...plan].reverse(), baseCtx());
check('reversing the plan still admits exactly two orders',
  reversed.results.filter((r) => r.allowed).length === 2,
  `${reversed.results.filter((r) => r.allowed).map((r) => r.symbol).join(',')}`);

check('reversed run admits the first two of the reversed order',
  reversed.results[0].allowed && reversed.results[1].allowed &&
  reversed.results[0].symbol === 'SCHD' && reversed.results[1].symbol === 'SOXL');

// ─── 6. A plan that fits is untouched ────────────────────────────────────────
const small = validateBatchCumulative([buy('UPRO'), buy('TQQQ')], baseCtx());
check('a plan within headroom passes entirely',
  small.results.every((r) => r.allowed),
  small.results.filter((r) => !r.allowed).map((r) => r.symbol).join(',') || 'all passed');

// ─── 7. Sells release rather than consume ────────────────────────────────────
// A SELL has no AFW draw, so it must not eat into the headroom a later buy
// needs. Position is oversized so the always-keep-one-share rule doesn't fire.
const withPosition = (): GuardrailContext => ({
  ...baseCtx(),
  positions: [{ symbol: 'TQQQ', pillar: 'triples', marketValue: 50_000, shares: 500 }],
});
const mixed = validateBatchCumulative(
  [{ symbol: 'TQQQ', instruction: 'SELL', shares: 50, price: 100, pillar: 'triples' }, buy('UPRO'), buy('SOXL')],
  withPosition(),
);
check('a SELL does not consume AFW headroom',
  mixed.results.every((r) => r.allowed),
  mixed.results.filter((r) => !r.allowed).map((r) => `${r.symbol}:${r.violations.map((v) => v.code).join('/')}`).join(',') || 'all passed');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
