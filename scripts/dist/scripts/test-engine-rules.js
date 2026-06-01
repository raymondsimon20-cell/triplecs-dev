"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../lib/signals/engine");
const state_1 = require("../lib/signals/state");
const fund_metadata_1 = require("../lib/data/fund-metadata");
const cron_1 = require("../lib/rebalance/cron");
// ─── Test harness ────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function test(label, fn) {
    try {
        fn();
        pass += 1;
        console.log(`  PASS  ${label}`);
    }
    catch (err) {
        fail += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  FAIL  ${label}\n        ${msg}`);
    }
}
function enrichedPosition(symbol, shares, marketValue) {
    const meta = (0, fund_metadata_1.getFundMetadata)(symbol);
    return {
        symbol,
        shares,
        marketValue,
        ...(meta
            ? {
                pillar: meta.pillar,
                family: meta.family,
                maintenancePct: meta.maintenancePct,
                maintenancePctSource: meta.maintenancePctSource,
            }
            : {}),
    };
}
function baseInputs(overrides = {}) {
    return {
        positions: [],
        cash: 10000,
        marginDebt: 0,
        prices: { UPRO: 50, TQQQ: 50, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
        spyHistory: Array(25).fill(500),
        vix: 18,
        state: (0, state_1.defaultSignalState)(),
        pillarTargets: { triplesPct: 10, cornerstonePct: 20, incomePct: 65, hedgePct: 5 },
        recentSells30d: [],
        buyingPowerAvailable: 10000,
        ...overrides,
    };
}
function findSignals(signals, rule) {
    return signals.filter((s) => s.rule === rule);
}
// ─── MAINTENANCE_RANKED_TRIM tests ───────────────────────────────────────────
console.log('\nMAINTENANCE_RANKED_TRIM');
test('does not fire when margin utilization is below threshold', () => {
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('OXLC', 1000, 8000), enrichedPosition('SCHD', 100, 8000)],
        marginDebt: 1000, // 1k / (16k positions + 10k cash) = ~3.8% util — below 30%
    }));
    strict_1.default.equal(findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM').length, 0);
});
test('fires when margin utilization > 30% with high-maint position', () => {
    // Positions: OXLC $40k (100% maint), SCHD $20k (30% maint). totalValue=60k+cash5k=65k.
    // Margin debt = $25k → utilization ~38% (> 30%).
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('OXLC', 5000, 40000), enrichedPosition('SCHD', 250, 20000)],
        cash: 5000,
        marginDebt: 25000,
    }));
    const fires = findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM');
    // Expect at least one SELL signal on OXLC (highest maint), and a paired BUY rotation.
    const sells = fires.filter((s) => s.direction === 'SELL');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.ok(sells.length >= 1, `expected SELL signal, got ${sells.length}`);
    strict_1.default.equal(sells[0].ticker, 'OXLC', `expected to trim OXLC, got ${sells[0].ticker}`);
    strict_1.default.ok(buys.length >= 1, 'expected paired rotation BUY');
    strict_1.default.ok(['UPRO', 'TQQQ'].includes(buys[0].ticker), `expected UPRO/TQQQ rotation, got ${buys[0].ticker}`);
});
test('skips when in defense mode (equity ratio ≤ 40%)', () => {
    // Equity ratio = (totalValue - marginDebt) / totalValue. If we deeply leverage
    // so equity ratio is < 40%, defense mode wins and MAINTENANCE_RANKED_TRIM bails.
    // Positions $20k + cash $5k = totalValue $25k; marginDebt $20k →
    // equityValue $5k, equityRatio = 0.20 = 20%. That puts us in defense.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('OXLC', 1000, 20000)],
        cash: 5000,
        marginDebt: 20000,
    }));
    strict_1.default.equal(result.inDefenseMode, true, 'expected to be in defense mode');
    strict_1.default.equal(findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM').length, 0);
});
test('rotation BUY is roughly 1/3 of trim size', () => {
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('OXLC', 5000, 40000), enrichedPosition('SCHD', 250, 20000)],
        cash: 5000,
        marginDebt: 25000,
    }));
    const fires = findSignals(result.signals, 'MAINTENANCE_RANKED_TRIM');
    const sell = fires.find((s) => s.direction === 'SELL');
    const buy = fires.find((s) => s.direction === 'BUY');
    strict_1.default.ok(sell && buy);
    const ratio = buy.sizeDollars / sell.sizeDollars;
    // 1/3 with some rounding tolerance.
    strict_1.default.ok(ratio > 0.30 && ratio < 0.36, `expected ~0.33 rotation ratio, got ${ratio.toFixed(3)}`);
});
// ─── PILLAR_FILL tests ───────────────────────────────────────────────────────
console.log('\nPILLAR_FILL');
test('does not fire when income pillar is at target', () => {
    // 65% target, 65% actual = no gap.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 813, 65000)],
        cash: 35000,
    }));
    strict_1.default.equal(findSignals(result.signals, 'PILLAR_FILL').length, 0);
});
test('fires when income pillar gap > 5pp and proposes a non-held ticker', () => {
    // Total = $100k. Target income 65% = $65k. Hold only SCHD $50k → 50% actual.
    // Gap = 15pp, well above the 5pp threshold.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 625, 50000)],
        cash: 50000,
    }));
    const fires = findSignals(result.signals, 'PILLAR_FILL');
    strict_1.default.ok(fires.length >= 1, `expected PILLAR_FILL signals, got ${fires.length}`);
    // Should NOT propose SCHD (already held).
    const tickers = fires.map((s) => s.ticker);
    strict_1.default.ok(!tickers.includes('SCHD'), `should not re-propose held ticker SCHD; got ${tickers.join(',')}`);
    // All proposals should be BUYs in the curated income subset.
    for (const f of fires) {
        strict_1.default.equal(f.direction, 'BUY');
        strict_1.default.ok(f.sizeDollars > 0);
    }
});
test('skips when margin utilization > 35% (PILLAR_FILL hard ceiling)', () => {
    // Total $100k = $50k positions + $50k cash. Margin debt $40k → utilization 40%.
    // PILLAR_FILL should bail entirely.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 625, 50000)],
        cash: 50000,
        marginDebt: 40000,
    }));
    strict_1.default.equal(findSignals(result.signals, 'PILLAR_FILL').length, 0);
});
test('skips wash-sale candidates', () => {
    // Underweight income, but every curated income candidate is in recentSells30d.
    // Skipping all wash-sale candidates means it shouldn't propose anything that's in the skip set.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 625, 50000)],
        cash: 50000,
        recentSells30d: [
            { symbol: 'JEPI', soldDate: new Date().toISOString(), isLoss: true },
            { symbol: 'XDTE', soldDate: new Date().toISOString(), isLoss: true },
        ],
    }));
    const fires = findSignals(result.signals, 'PILLAR_FILL');
    const tickers = fires.map((s) => s.ticker);
    strict_1.default.ok(!tickers.includes('JEPI'), 'should skip JEPI (wash-sale)');
    strict_1.default.ok(!tickers.includes('XDTE'), 'should skip XDTE (wash-sale)');
});
test('respects PILLAR_FILL_MAX_CANDIDATES cap (≤ 2 proposals per pillar)', () => {
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 625, 50000)],
        cash: 50000,
    }));
    const fires = findSignals(result.signals, 'PILLAR_FILL');
    strict_1.default.ok(fires.length <= 2, `expected ≤2 candidates, got ${fires.length}`);
});
test('runtime marginThresholds override CONFIG defaults', () => {
    // At 35% utilization, default CONFIG would fire MAINTENANCE_RANKED_TRIM
    // (threshold 30%). With runtime marginThresholds.trimAbovePct = 47, the
    // same portfolio should NOT fire (35% is below 47%).
    // Margin debt = $35k, totalValue = $100k → utilization = 35%.
    const positionsAndCash = {
        positions: [enrichedPosition('OXLC', 5000, 40000), enrichedPosition('SCHD', 250, 20000)],
        cash: 40000, // total $100k
        marginDebt: 35000,
    };
    const defaultResult = (0, engine_1.runSignalEngine)(baseInputs(positionsAndCash));
    strict_1.default.ok(findSignals(defaultResult.signals, 'MAINTENANCE_RANKED_TRIM').length > 0, 'expected default (30%) threshold to fire at 35% utilization');
    const runtimeResult = (0, engine_1.runSignalEngine)(baseInputs({
        ...positionsAndCash,
        marginThresholds: { trimAbovePct: 47, trimTargetPct: 42, newBuyCeilingPct: 47 },
    }));
    strict_1.default.equal(findSignals(runtimeResult.signals, 'MAINTENANCE_RANKED_TRIM').length, 0, 'expected runtime threshold (47%) to suppress firing at 35% utilization');
});
test('PILLAR_FILL respects runtime newBuyCeilingPct', () => {
    // Underweight income (50% of $70k vs 65% target → 15pp gap), 30% utilization.
    //   positions $35k + cash $35k = totalValue $70k
    //   income% = 35/70 = 50% (gap 15pp ✓)
    //   marginDebt $21k → util ≈ 30%
    const inputs = {
        positions: [enrichedPosition('SCHD', 437, 35000)],
        cash: 35000,
        marginDebt: 21000,
    };
    const defaultResult = (0, engine_1.runSignalEngine)(baseInputs(inputs));
    strict_1.default.ok(findSignals(defaultResult.signals, 'PILLAR_FILL').length > 0, 'expected default ceiling (35%) to allow PILLAR_FILL at 30% utilization');
    const tightenedResult = (0, engine_1.runSignalEngine)(baseInputs({
        ...inputs,
        marginThresholds: { trimAbovePct: 30, trimTargetPct: 25, newBuyCeilingPct: 25 },
    }));
    strict_1.default.equal(findSignals(tightenedResult.signals, 'PILLAR_FILL').length, 0, 'expected runtime ceiling (25%) to suppress PILLAR_FILL at 30% utilization');
});
test('individual proposal stays within PILLAR_FILL_MAX_DOLLARS = $5,000', () => {
    // Huge gap, plenty of cash — still each proposal should be capped at $5k.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [], // 0% income — gap = full target
        cash: 500000,
        buyingPowerAvailable: 500000,
    }));
    const fires = findSignals(result.signals, 'PILLAR_FILL');
    for (const f of fires) {
        strict_1.default.ok(f.sizeDollars <= 5000 + 0.01, `proposal ${f.ticker} ${f.sizeDollars} exceeds $5k cap`);
    }
});
// ─── AFW_TRIGGER tests ───────────────────────────────────────────────────────
console.log('\nAFW_TRIGGER (Available For Withdrawal)');
test('skips deployment when afwDollars below minimum headroom', () => {
    // SPY drops 12% off the 7-day max → dip condition met. But AFW = $4000,
    // below the $10k minimum headroom → rule should emit an INFO note, not BUYs.
    const spyHistory = [500, 500, 500, 500, 500, 500, 440]; // -12% off max
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 100, 8000)],
        cash: 100,
        spyHistory,
        afwDollars: 4000,
    }));
    const fires = findSignals(result.signals, 'AFW_TRIGGER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 0, `expected no BUYs when AFW < $10k headroom; got ${buys.length}`);
    const infos = fires.filter((s) => s.direction === 'INFO');
    strict_1.default.ok(infos.length > 0, 'expected an INFO note explaining the skip');
});
test('fires deployment when SPY dips AND afwDollars sufficient', () => {
    const spyHistory = [500, 500, 500, 500, 500, 500, 440]; // -12% off max
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 100, 8000)],
        cash: 15000,
        spyHistory,
        afwDollars: 15000, // well above the $10k headroom floor
    }));
    const fires = findSignals(result.signals, 'AFW_TRIGGER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.ok(buys.length >= 1, `expected BUY signals when AFW ≥ $10k; got ${buys.length}`);
});
test('fires when afwDollars is undefined (legacy / replay path)', () => {
    // When AFW data isn't available, the rule should still fire on the dip
    // (the guardrail layer will enforce the 50% Schwab ceiling at stage time).
    const spyHistory = [500, 500, 500, 500, 500, 500, 440];
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 100, 8000)],
        cash: 10000,
        spyHistory,
        // afwDollars intentionally omitted
    }));
    const fires = findSignals(result.signals, 'AFW_TRIGGER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.ok(buys.length >= 1, 'expected BUYs when AFW data is unavailable (fallback to SPY-only)');
});
// ─── AIRBAG_SCALE tests ──────────────────────────────────────────────────────
console.log('\nAIRBAG_SCALE');
test('skips sub-$100 hedge buys on small / empty accounts', () => {
    // Empty account (totalValue ≈ cash only, ~$500). At AIRBAG_NORMAL=1% target
    // with currentW=0, raw size would be 0.01 × $500 = $5 — well below the $100
    // floor. Pre-fix this produced ghost tier-1 BUYs that signalsToInbox then
    // rejected (shares=0). The min-size guard should skip emitting them.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [],
        cash: 500,
        spyHistory: Array(25).fill(500),
        vix: 18,
    }));
    const fires = findSignals(result.signals, 'AIRBAG_SCALE');
    strict_1.default.equal(fires.length, 0, `expected no AIRBAG signals when size < $100; got ${fires.length}`);
});
test('emits SPXU/SQQQ buys when the diff × totalValue clears the $100 floor', () => {
    // $20k account, currentW=0, target=1% → size = $200 per ticker, above floor.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [enrichedPosition('SCHD', 100, 20000)],
        cash: 0,
        spyHistory: Array(25).fill(500),
        vix: 18,
    }));
    const fires = findSignals(result.signals, 'AIRBAG_SCALE');
    const tickers = fires.map((s) => s.ticker).sort();
    strict_1.default.deepEqual(tickers, ['SPXU', 'SQQQ'], `expected SPXU+SQQQ signals; got ${tickers.join(',')}`);
    for (const f of fires) {
        strict_1.default.ok(f.sizeDollars >= 100, `${f.ticker} size $${f.sizeDollars} below floor`);
    }
});
// ─── CLM_CRF_TRIM tests ──────────────────────────────────────────────────────
console.log('\nCLM_CRF_TRIM');
test('skips sub-$100 trims on small accounts barely above the cap', () => {
    // $1,000 portfolio with CLM+CRF combined just over the 12% MAX → trim
    // would be tiny ($5 per side). Pre-fix this produced ghost tier-1 SELLs.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [
            enrichedPosition('CLM', 30, 60),
            enrichedPosition('CRF', 30, 60),
            enrichedPosition('SCHD', 10, 880),
        ],
        cash: 0,
        prices: { CLM: 2, CRF: 2, SCHD: 88, UPRO: 50, TQQQ: 50, SPY: 500 },
    }));
    const fires = findSignals(result.signals, 'CLM_CRF_TRIM');
    strict_1.default.equal(fires.length, 0, `expected no CLM_CRF_TRIM signals on tiny account; got ${fires.length}`);
});
test('emits CLM+CRF trims when each half clears the $100 floor', () => {
    // Large portfolio meaningfully over the CLM+CRF cap → trims are substantial.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [
            enrichedPosition('CLM', 5000, 50000),
            enrichedPosition('CRF', 5000, 50000),
            enrichedPosition('SCHD', 100, 8000),
        ],
        cash: 0,
        prices: { CLM: 10, CRF: 10, SCHD: 80, UPRO: 50, TQQQ: 50, SPY: 500 },
    }));
    const fires = findSignals(result.signals, 'CLM_CRF_TRIM');
    const tickers = fires.map((s) => s.ticker).sort();
    strict_1.default.deepEqual(tickers, ['CLM', 'CRF'], `expected CLM+CRF SELLs; got ${tickers.join(',')}`);
    for (const f of fires) {
        strict_1.default.ok(f.sizeDollars >= 100, `${f.ticker} size $${f.sizeDollars} below floor`);
    }
});
// ─── PILLAR_FILL per-candidate floor test ────────────────────────────────────
console.log('\nPILLAR_FILL per-candidate floor');
test('skips when per-candidate size would be sub-$100 even with budget ≥ $100', () => {
    // Construct a gap small enough that deployBudget * 1/3 / pickN < $100 but
    // > $100 total. Budget guard alone would let this through pre-fix.
    // Pillar gap of ~6pp on a $2k portfolio → fullGap ≈ $120, budget ≈ $40
    // (33% fraction) — but the budget guard catches that. Use a $5k portfolio
    // with a ~5.5pp gap so budget ≈ $90 — under budget guard.
    // Instead: $4.5k portfolio, 6pp gap → fullGap=270, budget=90 (under guard),
    // so this case never reaches the per-candidate floor. Pick portfolio where
    // budget > 100 but per-candidate < 100: $5.5k, 6pp gap → fullGap=330,
    // budget=110, per-candidate=55. This is the exact pre-fix bug.
    const result = (0, engine_1.runSignalEngine)(baseInputs({
        positions: [
            // No income holdings — gap is the full target.
            enrichedPosition('SCHD', 70, 5500), // cornerstone-ish
        ],
        cash: 1000,
        marginDebt: 0,
        pillarTargets: { triplesPct: 10, cornerstonePct: 20, incomePct: 6, hedgePct: 5 },
    }));
    const fires = findSignals(result.signals, 'PILLAR_FILL');
    // With per-candidate floor, no signals when each would be sub-$100.
    for (const f of fires) {
        strict_1.default.ok(f.sizeDollars >= 100, `PILLAR_FILL ${f.ticker} size $${f.sizeDollars} below per-candidate floor`);
    }
});
// ─── TRIPLES_DIP_LADDER tests ────────────────────────────────────────────────
//
// The ladder fires a fixed-size BUY each fresh 5% drop below a per-ticker
// anchor high, only when:
//   - combined SOXL+UPRO+TQQQ weight < 10%
//   - AFW headroom ≥ $10k (or undefined for legacy paths)
//   - not in defense mode, not killSwitch, AFW_TRIGGER didn't fire this run.
// State carries anchorHigh + lastFiredStep per ticker between runs.
console.log('\nTRIPLES_DIP_LADDER');
// Helper: build a fresh state with a pre-seeded ladder anchor for one or more tickers.
function stateWithLadder(anchors) {
    const s = (0, state_1.defaultSignalState)();
    for (const [sym, { anchorHigh, lastFiredStep }] of Object.entries(anchors)) {
        s.triplesDipLadder[sym] = { anchorHigh, lastFiredStep: lastFiredStep ?? 0 };
    }
    return s;
}
// Common: empty portfolio (low triples weight so the 10% gate doesn't fire),
// enough cash for AFW to pass, flat SPY history so AFW_TRIGGER doesn't fire.
function ladderInputs(overrides = {}) {
    return baseInputs({
        positions: [],
        cash: 100000,
        afwDollars: 50000,
        spyHistory: Array(25).fill(500),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 20, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
        ...overrides,
    });
}
test('seeds anchor on first run and does not fire (no prior anchor)', () => {
    const result = (0, engine_1.runSignalEngine)(ladderInputs({ state: (0, state_1.defaultSignalState)() }));
    const fires = findSignals(result.signals, 'TRIPLES_DIP_LADDER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 0, 'no BUYs on first run — anchor just being seeded');
    // Anchor should be seeded for each configured ticker.
    for (const sym of ['SOXL', 'UPRO', 'TQQQ']) {
        const slot = result.nextState.triplesDipLadder[sym];
        strict_1.default.ok(slot, `expected anchor seeded for ${sym}`);
        strict_1.default.equal(slot.lastFiredStep, 0);
    }
});
test('fires once when a single ticker drops a fresh 5% below its anchor', () => {
    // Anchor SOXL at 20, drop price to 18.9 (= -5.5%, step 1).
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        state: stateWithLadder({ SOXL: { anchorHigh: 20 }, UPRO: { anchorHigh: 50 }, TQQQ: { anchorHigh: 50 } }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 18.9, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    const fires = findSignals(result.signals, 'TRIPLES_DIP_LADDER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 1, `expected exactly 1 BUY (MAX_STEPS_PER_RUN=1); got ${buys.length}`);
    strict_1.default.equal(buys[0].ticker, 'SOXL', `expected SOXL to fire first; got ${buys[0].ticker}`);
    // SOXL gets 50% of the $1k per-step budget = $500.
    strict_1.default.ok(Math.abs(buys[0].sizeDollars - 500) < 0.01, `expected $500 size, got $${buys[0].sizeDollars}`);
    // State should reflect the step bump.
    strict_1.default.equal(result.nextState.triplesDipLadder.SOXL.lastFiredStep, 1);
});
test('does not refire on bounce back above the step', () => {
    // SOXL already fired step 1 at -5%. Price bounces back to -3% (above step 1
    // but still below anchor). Should NOT refire.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        state: stateWithLadder({
            SOXL: { anchorHigh: 20, lastFiredStep: 1 },
            UPRO: { anchorHigh: 50 },
            TQQQ: { anchorHigh: 50 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 19.4, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    const buys = findSignals(result.signals, 'TRIPLES_DIP_LADDER').filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 0, 'should not refire on a bounce within already-fired step');
    strict_1.default.equal(result.nextState.triplesDipLadder.SOXL.lastFiredStep, 1, 'step should not regress');
});
test('rearms on new anchor high and resumes laddering from fresh anchor', () => {
    // SOXL had fired step 2 at the old anchor (20). New price 22 sets new high.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        state: stateWithLadder({
            SOXL: { anchorHigh: 20, lastFiredStep: 2 },
            UPRO: { anchorHigh: 50 },
            TQQQ: { anchorHigh: 50 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 22, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    strict_1.default.equal(result.nextState.triplesDipLadder.SOXL.anchorHigh, 22, 'anchor should be reset to new high');
    strict_1.default.equal(result.nextState.triplesDipLadder.SOXL.lastFiredStep, 0, 'lastFiredStep should reset to 0');
});
test('fires next step when ladder progresses past the previous fire', () => {
    // SOXL anchor 20, lastFiredStep=1 (so step 1 / -5% already taken).
    // Price drops to 17.9 → drawdown = 10.5% → currentStep = 2 → fires.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        state: stateWithLadder({
            SOXL: { anchorHigh: 20, lastFiredStep: 1 },
            UPRO: { anchorHigh: 50 },
            TQQQ: { anchorHigh: 50 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 17.9, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    const buys = findSignals(result.signals, 'TRIPLES_DIP_LADDER').filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 1);
    strict_1.default.equal(buys[0].ticker, 'SOXL');
    strict_1.default.equal(result.nextState.triplesDipLadder.SOXL.lastFiredStep, 2);
});
test('skips entirely when combined triples weight ≥ 10% (re-added gate)', () => {
    // Build a portfolio where SOXL+UPRO+TQQQ together are ~12% of $100k total.
    // SOXL drops below step 1 — without the gate this would fire.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        positions: [
            enrichedPosition('UPRO', 100, 5000),
            enrichedPosition('TQQQ', 100, 5000),
            enrichedPosition('SOXL', 100, 2000),
            enrichedPosition('SCHD', 1100, 88000),
        ],
        cash: 0,
        state: stateWithLadder({
            SOXL: { anchorHigh: 25 },
            UPRO: { anchorHigh: 60 },
            TQQQ: { anchorHigh: 60 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 20, SCHD: 80, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60 },
    }));
    const fires = findSignals(result.signals, 'TRIPLES_DIP_LADDER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 0, 'gate should suppress BUYs when combined weight ≥ 10%');
    // Should still emit the INFO gate notice since a step would have fired.
    const infos = fires.filter((s) => s.direction === 'INFO');
    strict_1.default.ok(infos.length >= 1, 'expected INFO note explaining the gate');
});
test('skips when AFW headroom < $10k floor (and surfaces INFO)', () => {
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        afwDollars: 4000,
        state: stateWithLadder({
            SOXL: { anchorHigh: 20 },
            UPRO: { anchorHigh: 50 },
            TQQQ: { anchorHigh: 50 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 18.9, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    const fires = findSignals(result.signals, 'TRIPLES_DIP_LADDER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 0, 'no BUYs when AFW < $10k headroom');
    const infos = fires.filter((s) => s.direction === 'INFO');
    strict_1.default.ok(infos.length >= 1, 'expected INFO note explaining the AFW skip');
});
test('skips when AFW_TRIGGER fires the same run (avoids double-buy at -10%)', () => {
    // SPY dip + SOXL anchor drop. AFW_TRIGGER fires on the SPY -12%; ladder
    // should yield to it for the day.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        spyHistory: [500, 500, 500, 500, 500, 500, 440], // -12% triggers AFW
        state: stateWithLadder({
            SOXL: { anchorHigh: 20 },
            UPRO: { anchorHigh: 50 },
            TQQQ: { anchorHigh: 50 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 18.9, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    const afwFires = findSignals(result.signals, 'AFW_TRIGGER').filter((s) => s.direction === 'BUY');
    strict_1.default.ok(afwFires.length >= 1, 'expected AFW_TRIGGER to fire first');
    const ladderBuys = findSignals(result.signals, 'TRIPLES_DIP_LADDER').filter((s) => s.direction === 'BUY');
    strict_1.default.equal(ladderBuys.length, 0, 'ladder should yield to AFW_TRIGGER same-day');
});
test('skips SOXL fire when SOXL is at its 5% per-ticker cap, still fires next eligible ticker', () => {
    // SOXL position = $6k of $100k portfolio = 6% (above 5% cap).
    // UPRO/TQQQ small enough that combined triples stays under 10%.
    // SOXL price drops a fresh step — should skip SOXL, fire UPRO instead.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        positions: [
            enrichedPosition('SOXL', 300, 6000), // 6% of $100k → over 5% cap
            enrichedPosition('UPRO', 20, 1000), // 1% → low
            enrichedPosition('TQQQ', 20, 1000), // 1% → low; combined 8% < 10% gate
            enrichedPosition('SCHD', 1150, 92000),
        ],
        cash: 0,
        state: stateWithLadder({
            SOXL: { anchorHigh: 25 }, // price 18.9 → -24%, step 4
            UPRO: { anchorHigh: 52.7 }, // price 50  → -5.1%, step 1
            TQQQ: { anchorHigh: 50 }, // price 50  → flat, no step
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 18.9, SCHD: 80, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60 },
    }));
    const fires = findSignals(result.signals, 'TRIPLES_DIP_LADDER');
    const buys = fires.filter((s) => s.direction === 'BUY');
    // Exactly one BUY, and it should be UPRO (not SOXL).
    strict_1.default.equal(buys.length, 1, `expected 1 BUY (UPRO); got ${buys.length}: ${buys.map((b) => b.ticker).join(',')}`);
    strict_1.default.equal(buys[0].ticker, 'UPRO', `expected UPRO fire when SOXL capped; got ${buys[0].ticker}`);
    // INFO note about the SOXL cap should be present.
    const capInfo = fires.find((s) => s.direction === 'INFO' && s.ticker === 'SOXL');
    strict_1.default.ok(capInfo, 'expected INFO note explaining SOXL cap skip');
    // SOXL lastFiredStep should bump to the current step so we don't re-emit
    // the INFO on every subsequent run while price stays below.
    strict_1.default.ok(result.nextState.triplesDipLadder.SOXL.lastFiredStep > 0, 'expected SOXL lastFiredStep to advance even when cap-skipped');
});
test('SOXL cap does not affect UPRO/TQQQ fires when SOXL is under the cap', () => {
    // SOXL at 3% (well under 5% cap). All three drop a fresh step.
    // Per the iteration order (SOXL first in CONFIG.TRIPLES_DIP_WEIGHTS), SOXL
    // should fire — no cap interference.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        positions: [
            enrichedPosition('SOXL', 150, 3000), // 3% < cap
            enrichedPosition('UPRO', 20, 1000),
            enrichedPosition('TQQQ', 20, 1000),
            enrichedPosition('SCHD', 1200, 95000),
        ],
        cash: 0,
        state: stateWithLadder({
            SOXL: { anchorHigh: 25 },
            UPRO: { anchorHigh: 52.7 },
            TQQQ: { anchorHigh: 52.7 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 18.9, SCHD: 79, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60 },
    }));
    const buys = findSignals(result.signals, 'TRIPLES_DIP_LADDER').filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 1);
    strict_1.default.equal(buys[0].ticker, 'SOXL', 'SOXL should fire normally when under its cap');
});
test('skips in defense mode (equity ratio ≤ 40%)', () => {
    // Force defense by deep margin: equity ratio = 20%.
    const result = (0, engine_1.runSignalEngine)(ladderInputs({
        positions: [enrichedPosition('OXLC', 1000, 20000)],
        cash: 5000,
        marginDebt: 20000,
        state: stateWithLadder({
            SOXL: { anchorHigh: 20 },
            UPRO: { anchorHigh: 50 },
            TQQQ: { anchorHigh: 50 },
        }),
        prices: { UPRO: 50, TQQQ: 50, SOXL: 18.9, SPY: 500, OXLC: 8, ULTY: 7, JEPI: 60, SCHD: 80 },
    }));
    strict_1.default.equal(result.inDefenseMode, true, 'expected defense mode');
    const buys = findSignals(result.signals, 'TRIPLES_DIP_LADDER').filter((s) => s.direction === 'BUY');
    strict_1.default.equal(buys.length, 0, 'no BUYs in defense mode');
});
// ─── pickTrimTarget (rebalance) tests ────────────────────────────────────────
//
// SOXL-first trim preference for the triples pillar — the bounce-side half
// of the decay guardrail (pairs with the SOXL per-ticker cap in the ladder).
console.log('\npickTrimTarget (rebalance triples preference)');
test('triples pillar: prefers SOXL over the largest holding when SOXL meets the min-value floor', () => {
    // Largest is UPRO ($10k). SOXL is smaller ($2k) but above the $500 floor.
    // With the preference rule, SOXL should be picked.
    const sorted = [
        { symbol: 'UPRO', marketValue: 10000 },
        { symbol: 'TQQQ', marketValue: 6000 },
        { symbol: 'SOXL', marketValue: 2000 },
    ];
    const picked = (0, cron_1.pickTrimTarget)('triples', sorted);
    strict_1.default.equal(picked.symbol, 'SOXL', `expected SOXL preference, got ${picked.symbol}`);
});
test('triples pillar: falls back to largest when SOXL position is below the $500 floor', () => {
    // SOXL only $200 — not worth trimming. Falls back to largest (UPRO).
    const sorted = [
        { symbol: 'UPRO', marketValue: 10000 },
        { symbol: 'TQQQ', marketValue: 6000 },
        { symbol: 'SOXL', marketValue: 200 },
    ];
    const picked = (0, cron_1.pickTrimTarget)('triples', sorted);
    strict_1.default.equal(picked.symbol, 'UPRO', `expected fallback to UPRO, got ${picked.symbol}`);
});
test('triples pillar: falls back to largest when SOXL is not held at all', () => {
    const sorted = [
        { symbol: 'UPRO', marketValue: 10000 },
        { symbol: 'TQQQ', marketValue: 6000 },
    ];
    const picked = (0, cron_1.pickTrimTarget)('triples', sorted);
    strict_1.default.equal(picked.symbol, 'UPRO');
});
test('non-triples pillars: no preference, just picks largest', () => {
    // Income pillar — no SOXL preference applies. SCHD largest wins.
    const sorted = [
        { symbol: 'SCHD', marketValue: 20000 },
        { symbol: 'JEPI', marketValue: 10000 },
    ];
    const picked = (0, cron_1.pickTrimTarget)('income', sorted);
    strict_1.default.equal(picked.symbol, 'SCHD');
});
// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
