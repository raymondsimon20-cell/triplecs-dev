"use strict";
/**
 * Triple C's Signal Engine — TypeScript port.
 *
 * Pure function. Takes a snapshot of portfolio truth (positions/cash/margin
 * fetched from Schwab) plus the persisted engine state (gate flags, pivot
 * history, etc) plus market data (prices, SPY history, VIX), and returns:
 *
 *   - the set of trade signals + alerts + info items the engine wants to surface
 *   - the updated engine state to persist back to the blob
 *
 * No I/O happens here. The route handler does the fetching, calls this
 * function, then persists `nextState` and stages `actionableTrades` into the
 * inbox.
 *
 * ─── Cuts from the original Python engine ──────────────────────────────────
 *  - `LEVERAGE_REDUCTION` is ALERT-only (no SELL signal). Engine emits
 *    "update your Triples target to X%" — rebalance-plan executes the actual
 *    trim on its next drift run. See memory: triple_c_signal_engine.md.
 *  - `CLM_CRF_WEIGHT` buy side is removed — rebalance-plan's Cornerstone
 *    pillar drift owns cornerstone buys. Trim side (>20% combined) is kept
 *    as confirmed by the user (overrides the prior "never sell cornerstone"
 *    rule).
 *  - `AIRBAG_SCALE` is the sole owner of SPXU/SQQQ sizing — rebalance-plan
 *    no longer emits hedge orders.
 *  - `DEFENSE_MODE` and `MARGIN_KILL_SWITCH` write to the gate flags in
 *    `nextState`. Other endpoints consult those flags.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
exports.valuePortfolio = valuePortfolio;
exports.runSignalEngine = runSignalEngine;
const fund_metadata_1 = require("../data/fund-metadata");
// ─── Config ──────────────────────────────────────────────────────────────────
exports.CONFIG = {
    // ── AFW (Available For Withdrawal) deployment trigger ─────────────────────
    // AFW is Schwab's margin-headroom metric: equity minus maintenance
    // requirement. As the market drops, equity drops, AFW drops in lockstep.
    // Vol-7 rule: when AFW drops 10% (equivalent to a 10% market drop), deploy
    // capital from available margin into Triples to buy the dip.
    //
    // Current implementation uses SPY 7-day drawdown as the proxy for AFW
    // drawdown (we don't yet snapshot AFW history per day). The PROXY fires on
    // the same condition Vol-7 describes; the SOURCE of deployed capital is
    // your available margin (AFW). Future: store afwDollars on PortfolioSnapshot
    // so we can switch to true AFW-drawdown detection.
    AFW_LOOKBACK: 7,
    AFW_DRAWDOWN_THRESHOLD: 0.90, // fire when SPY ≤ 90% of 7-day max
    AFW_DEPLOY: 1000, // total $ deployed per fire
    /** Skip the rule entirely when available AFW dollars fall below this. The
     *  deployment itself is $1k; the $10k headroom keeps a 10× buffer so the
     *  buy doesn't push utilization right up to the Schwab 50% wall. */
    AFW_MIN_HEADROOM: 10000,
    // Defense
    DEFENSE_EQUITY_RATIO: 0.40,
    // Airbag
    AIRBAG_NORMAL: 0.01,
    AIRBAG_VIX_MED: 0.025,
    AIRBAG_VIX_HIGH: 0.075,
    // CLM/CRF — trim only (buy is owned by rebalance-plan Cornerstone pillar)
    CLM_CRF_TARGET: 0.19,
    CLM_CRF_MAX: 0.20,
    // Pivot
    PIVOT_THRESHOLD: 1.05,
    PIVOT_HARD_DEADLINE: new Date('2026-06-26'),
    PIVOT_AMBER_DAYS: 30,
    PIVOT_RED_DAYS: 14,
    // Leverage reduction thresholds (ALERT-only — no trade signals)
    LEVERAGE_150K_TARGET: 0.07,
    LEVERAGE_200K_TARGET: 0.05,
    LEVERAGE_EXIT_PORTFOLIO_SIZE: 300000,
    // Kill switch
    KILL_SWITCH_DEBT_GROWTH: 500,
    // Freedom ratio
    FREEDOM_RATIO_MONTHLY_GAIN: 0.02,
    // ── Phase 2 — Maintenance-ranked trim ─────────────────────────────────────
    /** Margin utilization above which a margin-relief SELL fires. */
    MARGIN_TRIM_THRESHOLD: 0.30,
    /** Trim sizes the SELL to bring utilization back down to this level. */
    MARGIN_TRIM_TARGET: 0.25,
    /** Don't sell more than this fraction of any single position in one signal. */
    MARGIN_TRIM_MAX_FRACTION_OF_POSITION: 0.5,
    /** Vol-7 rotation rule: trim proceeds rotate 1/3 into Triple ETFs. */
    ROTATION_INTO_TRIPLES_PCT: 0.33,
    // ── Phase 2 — Pillar fill (new-position suggestions) ──────────────────────
    /** PILLAR_FILL fires when actual is this many pp below target. */
    PILLAR_FILL_GAP_THRESHOLD_PP: 5,
    /** Each run proposes this fraction of the gap (averages in over runs). */
    PILLAR_FILL_GAP_FRACTION: 0.33,
    /** Hard ceiling per single PILLAR_FILL signal. Matches auto-execute per-trade cap. */
    PILLAR_FILL_MAX_DOLLARS: 5000,
    /** At most this many new tickers per pillar per run. */
    PILLAR_FILL_MAX_CANDIDATES: 2,
    /** When margin > 30%, skip candidates whose maintenancePct exceeds this. */
    PILLAR_FILL_HIGH_MARGIN_MAINT_CEILING: 60,
    /** Penalize candidates whose family is already above this % of portfolio. */
    PILLAR_FILL_FAMILY_PENALTY_PCT: 10,
    /**
     * Absolute margin-utilization ceiling for ANY new-buy rule. Above this,
     * PILLAR_FILL is skipped entirely — MAINTENANCE_RANKED_TRIM is what should
     * be firing first to relieve margin pressure, not new buys that add to it.
     */
    PILLAR_FILL_MAX_MARGIN_PCT: 0.35,
    /**
     * AFW-dollar floor for PILLAR_FILL. When afwDollars is available, prefer
     * this absolute check over the ratio gate — it's more honest math. If AFW
     * headroom is below this, no new positions proposed regardless of pillar gap.
     */
    PILLAR_FILL_MIN_AFW_DOLLARS: 5000,
    // ── TRIPLES_DIP_LADDER — buy-the-dip ladder on triple-leveraged ETFs ──────
    // Per-ticker pivot-anchored ladder. Every fresh 5% drop below the anchor
    // high fires one BUY of fixed size. Bounces don't refire (only NEW lows
    // past the most recently fired step). The anchor self-resets when the
    // ticker prints a new high (price > anchorHigh).
    //
    // Differences vs AFW_TRIGGER:
    //   - 5% step (vs 10%)
    //   - Per-ticker anchor (vs SPY shared)
    //   - Fires REGARDLESS of current Triples weight (AFW_TRIGGER gates at <10%)
    //   - Skips when AFW_TRIGGER fired this run, to avoid double-buying at -10%.
    //
    // Margin safety: same AFW headroom floor as AFW_TRIGGER ($10K). Skipped in
    // defense mode and when killSwitch active. Per-trade size stays under the
    // auto-execute $5K cap.
    //
    // Vol-7 note: SOXL is a sector triple ("decays badly over time" per
    // Triple-Cs-Volume-7-Rules.md §2). Included per user request — keep an eye
    // on its position size and trim on bounces. UPRO/TQQQ are the
    // long-term-friendly core.
    TRIPLES_DIP_STEP_PCT: 0.05, // 5% step
    TRIPLES_DIP_PER_STEP_DOLLARS: 1000, // total $ deployed per fresh step
    /** Weighted split of the per-step budget across tickers. Must sum to 1.0. */
    TRIPLES_DIP_WEIGHTS: {
        SOXL: 0.50, // prioritized "for now"
        UPRO: 0.25,
        TQQQ: 0.25,
    },
    /** AFW headroom floor — same as AFW_TRIGGER. Below this the rule skips. */
    TRIPLES_DIP_MIN_AFW_HEADROOM: 10000,
    /** Per-ticker minimum order size after weighting. Sub-floor fires are skipped. */
    TRIPLES_DIP_MIN_TICKER_DOLLARS: 100,
    /** Cap the step count we'll fire in one run (safety against bad anchor data). */
    TRIPLES_DIP_MAX_STEPS_PER_RUN: 1,
    /**
     * Hard ceiling on combined triples (sum of TRIPLES_DIP_WEIGHTS tickers) as
     * a fraction of total portfolio. At or above this, the ladder hard-skips —
     * keeps the position from over-concentrating past Vol-7's "10% sweet spot
     * in a bull market" target. AFW_TRIGGER's QDTE-divert covers what happens
     * above this gate; this rule stays in its lane.
     */
    TRIPLES_DIP_MAX_COMBINED_WEIGHT: 0.10,
    /**
     * Per-ticker hard ceilings as a fraction of total portfolio. When a ticker
     * is at or above its cap, the ladder skips THAT ticker's fire but continues
     * to the next one in TRIPLES_DIP_WEIGHTS. Tickers not listed have no
     * per-ticker cap (the combined-weight gate still applies).
     *
     * SOXL is capped because it's a sector triple that decays badly during
     * flat/choppy periods (Triple-Cs-Volume-7-Rules.md §2: "Sector-specific
     * triples (SOXL, TECL, LABU) decay badly over time"). Pairs with the
     * SOXL-first trim preference in lib/rebalance/cron.ts — ladder fills it
     * heavy on dips, trim drains it heavy on bounces, never lets it sit and
     * decay past 5%.
     */
    TRIPLES_DIP_PER_TICKER_MAX_WEIGHT: {
        SOXL: 0.05,
    },
};
// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeSignalFactory(runTimestamp) {
    let counter = 0;
    return function makeSignal(rule, action, ticker, direction, sizeDollars, priority, reason, data = {}) {
        counter += 1;
        return {
            id: `${rule}_${counter}_${Date.parse(runTimestamp)}`,
            rule,
            action,
            ticker,
            direction,
            sizeDollars: Math.round(sizeDollars * 100) / 100,
            priority,
            reason,
            data,
            timestamp: runTimestamp,
        };
    };
}
function daysUntil(target) {
    return Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}
function currentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// ─── Valuation ───────────────────────────────────────────────────────────────
function valuePortfolio(positions, cash, marginDebt, prices) {
    let holdingsValue = 0;
    const weightDollars = {};
    for (const pos of positions) {
        // Prefer Schwab's marketValue. Fall back to shares × price only if
        // Schwab returned 0 or negative (rare — e.g. a position that priced
        // mid-fetch).
        const fallback = pos.shares * (prices[pos.symbol] ?? 0);
        const val = pos.marketValue > 0 ? pos.marketValue : fallback;
        holdingsValue += val;
        weightDollars[pos.symbol] = (weightDollars[pos.symbol] ?? 0) + val;
    }
    const totalValue = holdingsValue + cash;
    const equityValue = totalValue - marginDebt;
    const equityRatio = totalValue > 0 ? equityValue / totalValue : 1;
    const weightPcts = {};
    for (const [t, v] of Object.entries(weightDollars)) {
        weightPcts[t] = totalValue > 0 ? Math.round((v / totalValue) * 10000) / 100 : 0;
    }
    return {
        holdingsValue: Math.round(holdingsValue * 100) / 100,
        cash: Math.round(cash * 100) / 100,
        marginDebt: Math.round(marginDebt * 100) / 100,
        totalValue: Math.round(totalValue * 100) / 100,
        equityValue: Math.round(equityValue * 100) / 100,
        equityRatio: Math.round(equityRatio * 10000) / 10000,
        weightPcts,
    };
}
function evalDefenseMode(valuation, makeSignal) {
    const signals = [];
    const { equityRatio, weightPcts, totalValue } = valuation;
    if (equityRatio <= exports.CONFIG.DEFENSE_EQUITY_RATIO) {
        signals.push(makeSignal('DEFENSE_MODE', 'STOP_ALL_DEPLOYMENTS', 'PORTFOLIO', 'ALERT', 0, 'CRITICAL', `Equity ratio ${(equityRatio * 100).toFixed(1)}% ≤ ${exports.CONFIG.DEFENSE_EQUITY_RATIO * 100}% — defense mode active`, { equityRatio, equityValue: valuation.equityValue }));
        // The TRIM_QDTE action survives — it's defense-mode specific and doesn't
        // collide with rebalance-plan (which doesn't react to equity ratio).
        const qdteW = (weightPcts['QDTE'] ?? 0) / 100;
        if (qdteW > 0.20) {
            // Same $100 floor as the other size-based rules — keeps tiny accounts
            // from emitting sub-tradeable defense trims that signalsToInbox would
            // reject anyway.
            const trimDollars = (qdteW - 0.15) * totalValue;
            if (trimDollars >= 100) {
                signals.push(makeSignal('DEFENSE_MODE', 'TRIM_QDTE', 'QDTE', 'SELL', trimDollars, 'CRITICAL', `Defense mode: QDTE at ${(qdteW * 100).toFixed(1)}% > 20% — trim to 15%`, { currentWeight: qdteW }));
            }
        }
    }
    return signals;
}
/**
 * AFW_TRIGGER — Vol-7 "dip deployment from Available For Withdrawal."
 *
 * AFW = Available For Withdrawal — Schwab's margin headroom dollar metric.
 * Vol-7 rule: when AFW drops ~10% (because the market dropped and equity
 * eroded), deploy $1000 of available margin into Triples to buy the dip.
 *
 * The proxy: we don't yet snapshot AFW per day, so we fire on SPY 7-day
 * drawdown — a correlated signal. When AFW history is in the snapshot blob
 * (todo), this rule can fire on true AFW drawdown.
 *
 * Headroom gate: even when the dip condition fires, if `afwDollars` is below
 * the deploy amount, the rule skips with an INFO note rather than emit a
 * BUY that the broker would reject at the 50% margin ceiling.
 */
function evalAfwTrigger(spyHistory, valuation, inDefense, afwDollars, makeSignal) {
    if (inDefense || spyHistory.length < exports.CONFIG.AFW_LOOKBACK) {
        return { signals: [], fired: false };
    }
    const signals = [];
    const recent = spyHistory.slice(-exports.CONFIG.AFW_LOOKBACK);
    const spy7dMax = Math.max(...recent);
    const spyNow = spyHistory[spyHistory.length - 1];
    const spyDrawdownPct = (1 - spyNow / spy7dMax) * 100;
    if (spyNow > exports.CONFIG.AFW_DRAWDOWN_THRESHOLD * spy7dMax) {
        return { signals: [], fired: false };
    }
    // AFW headroom gate. When we don't have AFW data (replay/legacy), skip the
    // gate and let the guardrail layer enforce the 50% Schwab ceiling.
    if (typeof afwDollars === 'number' && afwDollars < exports.CONFIG.AFW_MIN_HEADROOM) {
        signals.push(makeSignal('AFW_TRIGGER', 'AFW_HEADROOM_LOW', 'AFW', 'INFO', 0, 'HIGH', `Dip detected (SPY ${spyDrawdownPct.toFixed(1)}% off 7d high) but AFW is only $${Math.round(afwDollars)} — ` +
            `below the $${exports.CONFIG.AFW_MIN_HEADROOM} minimum headroom. Skipping deployment to avoid hitting Schwab's 50% margin cap.`, { spy: spyNow, spy7dMax, spyDrawdownPct, afwDollars, threshold: exports.CONFIG.AFW_MIN_HEADROOM }));
        return { signals, fired: false };
    }
    const triplesW = ((valuation.weightPcts['UPRO'] ?? 0) + (valuation.weightPcts['TQQQ'] ?? 0)) / 100;
    const afwNote = typeof afwDollars === 'number' ? ` (AFW headroom: $${Math.round(afwDollars)})` : '';
    if (triplesW < 0.10) {
        signals.push(makeSignal('AFW_TRIGGER', 'BUY_UPRO', 'UPRO', 'BUY', exports.CONFIG.AFW_DEPLOY * 0.5, 'HIGH', `Dip: SPY ${spyDrawdownPct.toFixed(1)}% off 7d high — deploy $500 AFW into UPRO${afwNote}`, { spy: spyNow, spy7dMax, spyDrawdownPct, triplesWeight: triplesW, afwDollars }));
        signals.push(makeSignal('AFW_TRIGGER', 'BUY_TQQQ', 'TQQQ', 'BUY', exports.CONFIG.AFW_DEPLOY * 0.5, 'HIGH', `Dip: SPY ${spyDrawdownPct.toFixed(1)}% off 7d high — deploy $500 AFW into TQQQ${afwNote}`, { spy: spyNow, spy7dMax, spyDrawdownPct, triplesWeight: triplesW, afwDollars }));
    }
    else {
        signals.push(makeSignal('AFW_TRIGGER', 'BUY_QDTE', 'QDTE', 'BUY', exports.CONFIG.AFW_DEPLOY, 'HIGH', `Dip: SPY ${spyDrawdownPct.toFixed(1)}% off 7d high — Triples at ${(triplesW * 100).toFixed(1)}%, deploy $1000 AFW into QDTE${afwNote}`, { spy: spyNow, spy7dMax, spyDrawdownPct, triplesWeight: triplesW, afwDollars }));
    }
    return { signals, fired: true };
}
/**
 * TRIPLES_DIP_LADDER — buy-the-dip ladder on triple-leveraged ETFs.
 *
 * Per-ticker pivot-anchored ladder. For each configured triple (SOXL, UPRO,
 * TQQQ) we track an anchorHigh and the lastFiredStep in engine state. On each
 * run:
 *
 *   1. If price > anchorHigh → bump anchor up, reset lastFiredStep to 0
 *      (rearms the ladder after a recovery to new highs).
 *   2. Compute currentStep = floor((1 - price/anchor) / 5%).
 *   3. If currentStep > lastFiredStep → fire one BUY, bump lastFiredStep.
 *      (Capped at MAX_STEPS_PER_RUN per run as a safety against bad data.)
 *
 * The "bounces don't refire" behavior falls out naturally — lastFiredStep
 * only ever increments while below the anchor. The ladder rearms only on a
 * NEW anchor high.
 *
 * Unlike AFW_TRIGGER this fires regardless of current Triples weight — the
 * user explicitly wants to keep buying on dips even when triples are already
 * at or above the 10% target. The hard backstop remains AFW headroom and the
 * Schwab 50% margin ceiling (enforced by guardrails downstream).
 *
 * Skipped when:
 *   - inDefense (equity ratio ≤ 0.40 — same as AFW_TRIGGER)
 *   - killSwitchActive
 *   - afwDollars < TRIPLES_DIP_MIN_AFW_HEADROOM
 *   - afwTriggerFired this run (avoid double-buying at the -10% mark)
 *   - missing/zero price data for the ticker (no fire on bad data)
 *
 * State mutation: returns nextLadder (a fresh map) — the caller writes it
 * back into nextState.triplesDipLadder. No I/O in this function.
 */
function evalTriplesDipLadder(prices, valuation, inDefense, killSwitchActive, afwDollars, afwTriggerFired, ladderState, makeSignal) {
    const nextLadder = {};
    // Always carry forward the existing ladder slots, even if we skip firing.
    // The anchor needs to keep tracking new highs even during defense mode so
    // that when conditions clear, the ladder picks up from the right anchor
    // rather than re-anchoring on a depressed price.
    for (const sym of Object.keys(exports.CONFIG.TRIPLES_DIP_WEIGHTS)) {
        const prev = ladderState[sym] ?? { anchorHigh: null, lastFiredStep: 0 };
        const price = prices[sym];
        if (typeof price === 'number' && price > 0) {
            if (prev.anchorHigh == null || price > prev.anchorHigh) {
                // New high → rearm the ladder.
                nextLadder[sym] = { anchorHigh: price, lastFiredStep: 0 };
            }
            else {
                nextLadder[sym] = { ...prev };
            }
        }
        else {
            // No price → carry prev unchanged.
            nextLadder[sym] = { ...prev };
        }
    }
    const signals = [];
    // Gate ordering: cheap-first, INFO-emit on the gates the user most needs to
    // see surfaced (AFW low, combined-weight cap). The other gates fail silently
    // — they're either dominant rules already emitting their own signals
    // (defense/killSwitch) or expected coordination (AFW fired same day).
    if (inDefense || killSwitchActive)
        return { signals, nextLadder };
    if (afwTriggerFired)
        return { signals, nextLadder };
    // Combined-triples weight gate — keep the ladder out of "over-concentration"
    // territory. AFW_TRIGGER still fires above this (with its QDTE redirect),
    // so the user isn't blind to bigger dips — they just don't get the extra
    // ladder leg into triples on top of an already-large position.
    const combinedTriplesPct = Object.keys(exports.CONFIG.TRIPLES_DIP_WEIGHTS)
        .reduce((acc, sym) => acc + (valuation.weightPcts[sym] ?? 0), 0) / 100;
    if (combinedTriplesPct >= exports.CONFIG.TRIPLES_DIP_MAX_COMBINED_WEIGHT) {
        // Surface only when a step would have fired — otherwise the digest gets
        // noisy with "ladder gated" lines on uneventful days.
        const anyWouldFire = Object.entries(nextLadder).some(([sym, s]) => {
            const price = prices[sym];
            if (!price || s.anchorHigh == null)
                return false;
            const step = Math.floor((1 - price / s.anchorHigh) / exports.CONFIG.TRIPLES_DIP_STEP_PCT);
            return step > s.lastFiredStep;
        });
        if (anyWouldFire) {
            signals.push(makeSignal('TRIPLES_DIP_LADDER', 'WEIGHT_GATE', 'TRIPLES', 'INFO', 0, 'MEDIUM', `Dip ladder gated: combined triples (${Object.keys(exports.CONFIG.TRIPLES_DIP_WEIGHTS).join('+')}) at ` +
                `${(combinedTriplesPct * 100).toFixed(1)}% ≥ ${(exports.CONFIG.TRIPLES_DIP_MAX_COMBINED_WEIGHT * 100).toFixed(0)}% cap. ` +
                `Skipping ladder fire. AFW_TRIGGER's QDTE redirect still covers deeper dips.`, {
                combinedTriplesPct: Math.round(combinedTriplesPct * 10000) / 100,
                capPct: exports.CONFIG.TRIPLES_DIP_MAX_COMBINED_WEIGHT * 100,
                tickers: Object.keys(exports.CONFIG.TRIPLES_DIP_WEIGHTS),
            }));
        }
        return { signals, nextLadder };
    }
    if (typeof afwDollars === 'number' && afwDollars < exports.CONFIG.TRIPLES_DIP_MIN_AFW_HEADROOM) {
        // Surface the gate so the user understands why the ladder isn't firing
        // even when prices are below trigger steps. Mirrors AFW_TRIGGER's pattern.
        const anyBelowStep = Object.entries(nextLadder).some(([sym, s]) => {
            const price = prices[sym];
            if (!price || s.anchorHigh == null)
                return false;
            const step = Math.floor((1 - price / s.anchorHigh) / exports.CONFIG.TRIPLES_DIP_STEP_PCT);
            return step > s.lastFiredStep;
        });
        if (anyBelowStep) {
            signals.push(makeSignal('TRIPLES_DIP_LADDER', 'AFW_HEADROOM_LOW', 'AFW', 'INFO', 0, 'MEDIUM', `Triples dip ladder ready to fire but AFW is only $${Math.round(afwDollars)} — ` +
                `below the $${exports.CONFIG.TRIPLES_DIP_MIN_AFW_HEADROOM} minimum headroom. Skipping to stay under Schwab's 50% margin cap.`, { afwDollars, threshold: exports.CONFIG.TRIPLES_DIP_MIN_AFW_HEADROOM }));
        }
        return { signals, nextLadder };
    }
    // Validate weights sum (defensive — catches typos in CONFIG edits).
    const weightSum = Object.values(exports.CONFIG.TRIPLES_DIP_WEIGHTS).reduce((a, b) => a + b, 0);
    if (Math.abs(weightSum - 1) > 0.001) {
        signals.push(makeSignal('TRIPLES_DIP_LADDER', 'CONFIG_ERROR', 'CONFIG', 'INFO', 0, 'HIGH', `TRIPLES_DIP_WEIGHTS sum to ${weightSum.toFixed(3)}, not 1.0 — fix CONFIG before this rule will fire.`, { weights: exports.CONFIG.TRIPLES_DIP_WEIGHTS }));
        return { signals, nextLadder };
    }
    let stepsFiredThisRun = 0;
    for (const [sym, weight] of Object.entries(exports.CONFIG.TRIPLES_DIP_WEIGHTS)) {
        if (stepsFiredThisRun >= exports.CONFIG.TRIPLES_DIP_MAX_STEPS_PER_RUN)
            break;
        const slot = nextLadder[sym];
        const price = prices[sym];
        if (!slot || slot.anchorHigh == null || !price || price <= 0)
            continue;
        const drawdown = 1 - price / slot.anchorHigh;
        const currentStep = Math.floor(drawdown / exports.CONFIG.TRIPLES_DIP_STEP_PCT);
        if (currentStep <= slot.lastFiredStep)
            continue;
        const sizeDollars = exports.CONFIG.TRIPLES_DIP_PER_STEP_DOLLARS * weight;
        if (sizeDollars < exports.CONFIG.TRIPLES_DIP_MIN_TICKER_DOLLARS)
            continue;
        const currentW = (valuation.weightPcts[sym] ?? 0) / 100;
        const afwNote = typeof afwDollars === 'number' ? ` (AFW headroom: $${Math.round(afwDollars)})` : '';
        // Per-ticker cap — skip this ticker if it's already at/above its
        // individual ceiling (e.g. SOXL at 5%). Iteration continues to the next
        // eligible ticker in TRIPLES_DIP_WEIGHTS rather than aborting the run.
        // Surfaces an INFO note the first time it bites so the user understands
        // why SOXL didn't fire despite the drop.
        const perTickerCap = exports.CONFIG.TRIPLES_DIP_PER_TICKER_MAX_WEIGHT[sym];
        if (typeof perTickerCap === 'number' && currentW >= perTickerCap) {
            signals.push(makeSignal('TRIPLES_DIP_LADDER', `TICKER_CAP_${sym}`, sym, 'INFO', 0, 'MEDIUM', `Dip ladder: ${sym} at ${(currentW * 100).toFixed(1)}% ≥ ${(perTickerCap * 100).toFixed(0)}% per-ticker cap. ` +
                `Skipping ${sym} fire (decay guardrail). Other ladder tickers may still fire.`, {
                ticker: sym, currentWeight: currentW, capWeight: perTickerCap,
                drawdownPct: Math.round(drawdown * 10000) / 100, stepWouldHaveFired: currentStep,
            }));
            // Still mark the step as "fired" so we don't keep emitting this INFO
            // every run while price stays below the step. The anchor will rearm
            // naturally on a new high.
            nextLadder[sym] = { ...slot, lastFiredStep: currentStep };
            continue;
        }
        signals.push(makeSignal('TRIPLES_DIP_LADDER', `BUY_${sym}`, sym, 'BUY', sizeDollars, 'HIGH', `Dip ladder: ${sym} ${(drawdown * 100).toFixed(1)}% off anchor ($${slot.anchorHigh.toFixed(2)} → $${price.toFixed(2)}). ` +
            `Step ${currentStep} (prev fired: ${slot.lastFiredStep}). Deploy $${sizeDollars.toFixed(0)}. ` +
            `Current ${sym} weight: ${(currentW * 100).toFixed(1)}%${afwNote}.`, {
            ticker: sym,
            price,
            anchorHigh: slot.anchorHigh,
            drawdownPct: Math.round(drawdown * 10000) / 100,
            stepFired: currentStep,
            prevStep: slot.lastFiredStep,
            currentWeight: currentW,
            afwDollars,
        }));
        nextLadder[sym] = { ...slot, lastFiredStep: currentStep };
        stepsFiredThisRun += 1;
    }
    return { signals, nextLadder };
}
function evalAirbag(vix, spyHistory, valuation, makeSignal) {
    if (spyHistory.length < 20)
        return [];
    const signals = [];
    const spyNow = spyHistory[spyHistory.length - 1];
    const spy20max = Math.max(...spyHistory.slice(-20));
    const spyDD = (spyNow - spy20max) / spy20max;
    let target;
    let label;
    if (vix > 30 && spyDD < -0.10) {
        target = exports.CONFIG.AIRBAG_VIX_HIGH;
        label = `VIX ${vix.toFixed(0)} >30 AND SPY drawdown ${(spyDD * 100).toFixed(1)}%`;
    }
    else if (vix > 20 && spyDD < -0.05) {
        target = exports.CONFIG.AIRBAG_VIX_MED;
        label = `VIX ${vix.toFixed(0)} >20 AND SPY drawdown ${(spyDD * 100).toFixed(1)}%`;
    }
    else {
        target = exports.CONFIG.AIRBAG_NORMAL;
        label = `VIX ${vix.toFixed(0)} normal`;
    }
    for (const ticker of ['SPXU', 'SQQQ']) {
        const currentW = (valuation.weightPcts[ticker] ?? 0) / 100;
        const diff = target - currentW;
        if (Math.abs(diff) > 0.005) {
            const direction = diff > 0 ? 'BUY' : 'SELL';
            const size = Math.abs(diff) * valuation.totalValue;
            // Skip sub-tradeable signals — small/empty accounts (or near-threshold
            // diffs at the 0.5% boundary) would otherwise emit $0–$5 BUYs that
            // signalsToInbox rejects (shares=0) but the daily-plan UI surfaces
            // as ghost tier-1 entries with no inbox item. Mirror the $100 floor
            // used by MAINTENANCE_RANKED_TRIM and PILLAR_FILL.
            if (size < 100)
                continue;
            const priority = target > exports.CONFIG.AIRBAG_NORMAL ? 'HIGH' : 'MEDIUM';
            signals.push(makeSignal('AIRBAG_SCALE', diff > 0 ? `SCALE_UP_${ticker}` : `SCALE_DOWN_${ticker}`, ticker, direction, size, priority, `Airbag ${ticker}: ${(currentW * 100).toFixed(1)}% → ${(target * 100).toFixed(1)}% (${label})`, { vix, spyDrawdown: spyDD, currentWeight: currentW, targetWeight: target }));
        }
    }
    return signals;
}
function evalClmCrf(valuation, makeSignal) {
    const signals = [];
    const combined = ((valuation.weightPcts['CLM'] ?? 0) + (valuation.weightPcts['CRF'] ?? 0)) / 100;
    // TRIM side only — buys are owned by rebalance-plan's Cornerstone pillar.
    // Confirmed 2026-05-12: trim IS allowed (overrides prior never-sell rule).
    if (combined > exports.CONFIG.CLM_CRF_MAX) {
        const trimVal = (combined - exports.CONFIG.CLM_CRF_TARGET) * valuation.totalValue;
        const halfTrim = trimVal / 2;
        // Skip sub-tradeable trims — small accounts barely above the cap, or
        // near-boundary diffs, would otherwise emit $0–$5 SELLs that
        // signalsToInbox rejects (shares=0) but the plan UI surfaces as ghost
        // tier-1 entries with no inbox item. $100 floor mirrors AIRBAG /
        // MAINTENANCE_RANKED_TRIM / PILLAR_FILL.
        if (halfTrim >= 100) {
            signals.push(makeSignal('CLM_CRF_TRIM', 'TRIM_CLM', 'CLM', 'SELL', halfTrim, 'MEDIUM', `CLM+CRF at ${(combined * 100).toFixed(1)}% > ${exports.CONFIG.CLM_CRF_MAX * 100}% hard cap — trim CLM half`, { combinedWeight: combined }));
            signals.push(makeSignal('CLM_CRF_TRIM', 'TRIM_CRF', 'CRF', 'SELL', halfTrim, 'MEDIUM', `CLM+CRF at ${(combined * 100).toFixed(1)}% > ${exports.CONFIG.CLM_CRF_MAX * 100}% hard cap — trim CRF half`, { combinedWeight: combined }));
        }
    }
    // Daily premium check reminder — INFO only.
    signals.push(makeSignal('CLM_CRF_PREMIUM_CHECK', 'CHECK_PREMIUM', 'CLM+CRF', 'INFO', 0, 'INFO', 'Daily: verify CLM/CRF premium/discount at CEFConnect', { url: 'https://www.cefconnect.com/fund/CLM', combinedWeight: combined }));
    return signals;
}
function evalPivot(spyHistory, pivotState, makeSignal) {
    const signals = [];
    if (spyHistory.length === 0) {
        return { signals: [], nextSpyLow: pivotState.spyLowSincePivot };
    }
    const spyNow = spyHistory[spyHistory.length - 1];
    const daysLeft = daysUntil(exports.CONFIG.PIVOT_HARD_DEADLINE);
    let nextSpyLow = pivotState.spyLowSincePivot ?? spyNow;
    if (spyNow < nextSpyLow)
        nextSpyLow = spyNow;
    if (pivotState.pivotExecuted) {
        return { signals, nextSpyLow };
    }
    if (spyNow >= exports.CONFIG.PIVOT_THRESHOLD * nextSpyLow) {
        signals.push(makeSignal('PIVOT_TRIGGER', 'EXECUTE_PIVOT', 'PORTFOLIO', 'REBALANCE', 0, 'CRITICAL', `Pivot trigger: SPY $${spyNow.toFixed(2)} ≥ +5% from low $${nextSpyLow.toFixed(2)}`, {
            spyNow,
            spyLow: nextSpyLow,
            gainFromLow: (spyNow / nextSpyLow) - 1,
            pivotSteps: [
                '1. Sell ULTY → JEPI (60%) + JEPQ (40%)',
                '2. Sell YMAX → JEPI (60%) + JEPQ (40%)',
                '3. Sell UDOW → add to UPRO',
                '4. Confirm no defense mode active first',
            ],
        }));
    }
    if (daysLeft <= exports.CONFIG.PIVOT_RED_DAYS) {
        signals.push(makeSignal('PIVOT_DEADLINE', 'PIVOT_DEADLINE_RED', 'PORTFOLIO', 'ALERT', 0, 'CRITICAL', `HARD DEADLINE: ${daysLeft} days to June 26 pivot deadline — execute NOW to stop NAV bleed`, { daysRemaining: daysLeft, deadline: '2026-06-26' }));
    }
    else if (daysLeft <= exports.CONFIG.PIVOT_AMBER_DAYS) {
        signals.push(makeSignal('PIVOT_DEADLINE', 'PIVOT_DEADLINE_AMBER', 'PORTFOLIO', 'ALERT', 0, 'HIGH', `AMBER: ${daysLeft} days to June 26 pivot deadline`, { daysRemaining: daysLeft, deadline: '2026-06-26' }));
    }
    return { signals, nextSpyLow };
}
function evalMarginKillSwitch(marginDebt, state, makeSignal) {
    const thisMonth = currentYearMonth();
    const prev = state.prevMonth;
    if (!prev || prev.month === thisMonth) {
        return { signals: [], tripped: false, reason: '' };
    }
    const growth = marginDebt - prev.margin;
    if (growth > exports.CONFIG.KILL_SWITCH_DEBT_GROWTH && !state.afwThisMonth.fired) {
        const reason = `Margin debt grew $${growth.toFixed(0)} MoM without an AFW (Available For Withdrawal) ` +
            `deployment this month — margin grew for some other reason, which is concerning`;
        return {
            signals: [makeSignal('MARGIN_KILL_SWITCH', 'PAUSE_ALL_PURCHASES', 'MARGIN', 'ALERT', 0, 'CRITICAL', `${reason} — PAUSE all new purchases until gap closes`, { prevMargin: prev.margin, currentMargin: marginDebt, growth })],
            tripped: true,
            reason,
        };
    }
    return { signals: [], tripped: false, reason: '' };
}
/**
 * LEVERAGE_REDUCTION — ALERT-only. Engine emits a recommendation to update the
 * Triples pillar target; rebalance-plan's drift logic executes the actual SELL
 * on its next run. See memory: triple_c_signal_engine.md.
 */
function evalLeverageReduction(valuation, makeSignal) {
    const signals = [];
    const total = valuation.totalValue;
    const triplesW = ((valuation.weightPcts['UPRO'] ?? 0) + (valuation.weightPcts['TQQQ'] ?? 0)) / 100;
    if (total >= exports.CONFIG.LEVERAGE_EXIT_PORTFOLIO_SIZE && triplesW > 0) {
        signals.push(makeSignal('LEVERAGE_REDUCTION_ALERT', 'UPDATE_TRIPLES_TARGET_TO_0', 'UPRO+TQQQ', 'ALERT', 0, 'HIGH', `Portfolio at $${total.toLocaleString()} ≥ $300k — update Triples pillar target to 0% in Settings. Rebalance-plan will trim on its next run.`, { totalValue: total, triplesWeight: triplesW, recommendedTarget: 0 }));
    }
    else if (total >= 200000 && triplesW > exports.CONFIG.LEVERAGE_200K_TARGET) {
        signals.push(makeSignal('LEVERAGE_REDUCTION_ALERT', 'UPDATE_TRIPLES_TARGET_TO_5PCT', 'UPRO+TQQQ', 'ALERT', 0, 'MEDIUM', `Portfolio at $${total.toLocaleString()} ≥ $200k — update Triples pillar target to ≤5% in Settings (currently ${(triplesW * 100).toFixed(1)}%). Rebalance-plan will trim on its next run.`, { totalValue: total, currentWeight: triplesW, recommendedTarget: exports.CONFIG.LEVERAGE_200K_TARGET }));
    }
    else if (total >= 150000 && triplesW > exports.CONFIG.LEVERAGE_150K_TARGET) {
        signals.push(makeSignal('LEVERAGE_REDUCTION_ALERT', 'UPDATE_TRIPLES_TARGET_TO_7PCT', 'UPRO+TQQQ', 'ALERT', 0, 'MEDIUM', `Portfolio at $${total.toLocaleString()} ≥ $150k — update Triples pillar target to ≤7% in Settings (currently ${(triplesW * 100).toFixed(1)}%). Rebalance-plan will trim on its next run.`, { totalValue: total, currentWeight: triplesW, recommendedTarget: exports.CONFIG.LEVERAGE_150K_TARGET }));
    }
    return signals;
}
function evalFreedomRatio(history, makeSignal) {
    if (history.length < 3)
        return [];
    const recent = history.slice(-3).map((h) => h.ratio);
    let flatMonths = 0;
    for (let i = 1; i < recent.length; i += 1) {
        if (recent[i] - recent[i - 1] < exports.CONFIG.FREEDOM_RATIO_MONTHLY_GAIN) {
            flatMonths += 1;
        }
    }
    if (flatMonths >= 2) {
        return [makeSignal('FREEDOM_RATIO', 'PORTFOLIO_REVIEW', 'PORTFOLIO', 'ALERT', 0, 'HIGH', 'Freedom ratio flat for 2+ consecutive months — portfolio review needed', { history: history.slice(-3), targetGain: exports.CONFIG.FREEDOM_RATIO_MONTHLY_GAIN })];
    }
    return [];
}
// ─── Phase 2 — Maintenance-ranked trim ───────────────────────────────────────
/**
 * MAINTENANCE_RANKED_TRIM
 *
 * When margin utilization exceeds the threshold, sell the position that frees
 * the most equity per dollar sold — i.e. the highest maintenance % the user
 * actually holds. Pair the SELL with a 1/3 rotation into Triple ETFs per the
 * Vol-7 rotation rule.
 *
 * Skipped in defense mode or when the kill-switch is active (those gates take
 * priority). Skipped when the engine has no maintenance data for any position
 * (would degrade to a coin-flip ranking).
 *
 * Skipped for Triples (LEVERAGE_REDUCTION_ALERT owns that), Hedges (AIRBAG owns
 * those), and CLM/CRF (DRIP-protected by separate rule). The candidate set is
 * effectively "income pillar positions ranked by maintenance × marketValue".
 */
function evalMaintenanceRankedTrim(positions, valuation, inDefense, killSwitchActive, thresholds, afwDollars, makeSignal) {
    if (inDefense || killSwitchActive)
        return [];
    if (valuation.totalValue <= 0)
        return [];
    // Prefer runtime thresholds from strategy store; fall back to CONFIG defaults.
    const trimAbove = thresholds ? thresholds.trimAbovePct / 100 : exports.CONFIG.MARGIN_TRIM_THRESHOLD;
    const trimTarget = thresholds ? thresholds.trimTargetPct / 100 : exports.CONFIG.MARGIN_TRIM_TARGET;
    const marginUtilPct = valuation.marginDebt / valuation.totalValue;
    if (marginUtilPct <= trimAbove)
        return [];
    // Equity to free to bring utilization to TARGET. Each dollar sold at
    // maintenance% M frees M/100 of equity (the maintenance requirement
    // against that dollar disappears, returning to AFW).
    //
    // When afwDollars is known we report it in the signal data so the digest
    // can show "AFW will rise from $X to $Y" — but the SIZING math is
    // algebraically identical either way: `(util − target) × totalValue`.
    const requiredEquityFreed = (marginUtilPct - trimTarget) * valuation.totalValue;
    // Eligible candidates: income (and "other") positions only. Triples/hedges/
    // cornerstone owned by other rules. Skip positions without maintenance data
    // (we'd be guessing).
    const candidates = positions
        .filter((p) => p.marketValue > 0)
        .filter((p) => p.pillar !== 'triples' && p.pillar !== 'hedge' && p.pillar !== 'cornerstone')
        .filter((p) => typeof p.maintenancePct === 'number')
        .map((p) => ({
        pos: p,
        maint: p.maintenancePct,
        score: p.maintenancePct * p.marketValue,
    }))
        .sort((a, b) => b.score - a.score);
    if (candidates.length === 0)
        return [];
    const top = candidates[0];
    // dollars to sell ≈ requiredFreed / (maint / 100), capped at half the position
    const rawTrim = requiredEquityFreed / (top.maint / 100);
    const maxTrim = top.pos.marketValue * exports.CONFIG.MARGIN_TRIM_MAX_FRACTION_OF_POSITION;
    const trimDollars = Math.min(rawTrim, maxTrim);
    if (trimDollars < 100)
        return []; // not worth a signal
    const signals = [];
    const priority = marginUtilPct > 0.40 ? 'HIGH' : 'MEDIUM';
    signals.push(makeSignal('MAINTENANCE_RANKED_TRIM', `TRIM_${top.pos.symbol}`, top.pos.symbol, 'SELL', trimDollars, priority, `Margin at ${(marginUtilPct * 100).toFixed(1)}% > ${(trimAbove * 100).toFixed(0)}%. ` +
        `${top.pos.symbol} has highest maintenance (${top.maint}%) among holdings — selling $${Math.round(trimDollars)} ` +
        `frees ~$${Math.round(trimDollars * top.maint / 100)} of equity (target margin ≤${(trimTarget * 100).toFixed(0)}%).`, {
        marginUtilPct,
        trimAboveThresholdPct: trimAbove,
        targetMarginPct: trimTarget,
        candidateSymbol: top.pos.symbol,
        candidateMaintPct: top.maint,
        candidateMaintSource: top.pos.maintenancePctSource ?? 'default',
        requiredEquityFreed,
        cappedAtHalfPosition: rawTrim > maxTrim,
        // AFW (Available For Withdrawal) context — present when Schwab data
        // was fed through. Tells the digest how much headroom this trim frees.
        afwBefore: afwDollars,
        afwAfterEstimate: typeof afwDollars === 'number'
            ? afwDollars + (trimDollars * top.maint / 100)
            : undefined,
    }));
    // Vol-7 1/3 rotation pair — only when 1/3 is large enough to be worth an order.
    const rotationDollars = trimDollars * exports.CONFIG.ROTATION_INTO_TRIPLES_PCT;
    if (rotationDollars >= 100) {
        const uproW = valuation.weightPcts['UPRO'] ?? 0;
        const tqqqW = valuation.weightPcts['TQQQ'] ?? 0;
        const target = uproW <= tqqqW ? 'UPRO' : 'TQQQ';
        signals.push(makeSignal('MAINTENANCE_RANKED_TRIM', `ROTATE_INTO_${target}`, target, 'BUY', rotationDollars, priority, `Vol-7 1/3 rotation: ~$${Math.round(rotationDollars)} of ${top.pos.symbol} proceeds rotates into ${target} ` +
            `(currently ${(uproW + tqqqW > 0 ? (target === 'UPRO' ? uproW : tqqqW) : 0).toFixed(1)}%).`, {
            rotationFromSymbol: top.pos.symbol,
            rotationFraction: exports.CONFIG.ROTATION_INTO_TRIPLES_PCT,
            targetTicker: target,
        }));
    }
    return signals;
}
// ─── Phase 2 — Pillar fill (new-position suggestions) ────────────────────────
/**
 * PILLAR_FILL
 *
 * When the Income pillar is meaningfully below target and the engine isn't
 * gated, propose up to N new income tickers from the AI-curated subset.
 *
 * Scoring prefers candidates whose fund family the user is not already
 * concentrated in. When margin utilization is elevated (>30%), high-maintenance
 * candidates are filtered out so PILLAR_FILL doesn't fight MAINTENANCE_RANKED_TRIM.
 *
 * Triples are owned by AFW_TRIGGER + the rotation pair. Cornerstone buys are
 * owned by the rebalance-plan endpoint. Hedge sizing is owned by AIRBAG_SCALE.
 * So PILLAR_FILL only addresses the Income pillar gap.
 *
 * Skipped when:
 *  - pillarTargets is not provided (caller didn't load strategy config)
 *  - defense mode active, kill switch active
 *  - cash insufficient
 *  - gap is below threshold
 *
 * Size:
 *  - Each run proposes 1/3 of the gap (averages in over time)
 *  - Capped at PILLAR_FILL_MAX_DOLLARS per candidate, MAX_CANDIDATES per pillar
 *  - Bounded by 95% of available cash to leave a buffer
 */
function evalPillarFill(positions, valuation, pillarTargets, marginThresholds, afwDollars, buyingPowerAvail, inDefense, killSwitchActive, recentSells30d, makeSignal) {
    if (!pillarTargets)
        return [];
    if (inDefense || killSwitchActive)
        return [];
    if (buyingPowerAvail < 100)
        return [];
    // Two-part margin gate:
    //  (a) AFW-dollar floor — when we know real headroom, refuse to propose any
    //      new position if AFW is below the floor. Most honest check.
    //  (b) Utilization-ratio ceiling — fallback when AFW data is absent.
    //
    // The AFW floor only matters when margin is actually in play. For an
    // account with zero debt (cash-only, or margin-enabled but unused), the
    // entire AFW number IS the cash on hand — gating on $5K would block every
    // sub-$5K account forever even though there's no leverage cliff to fall
    // off. Skip the gate when marginDebt is zero.
    if (valuation.marginDebt > 0 &&
        typeof afwDollars === 'number' &&
        afwDollars < exports.CONFIG.PILLAR_FILL_MIN_AFW_DOLLARS) {
        return [];
    }
    const newBuyCeiling = marginThresholds
        ? marginThresholds.newBuyCeilingPct / 100
        : exports.CONFIG.PILLAR_FILL_MAX_MARGIN_PCT;
    const utilFirstCheck = valuation.totalValue > 0 ? valuation.marginDebt / valuation.totalValue : 0;
    if (utilFirstCheck > newBuyCeiling)
        return [];
    // Aggregate dollars by pillar and by family.
    const dollarsByPillar = {
        triples: 0, cornerstone: 0, income: 0, hedge: 0, other: 0,
    };
    const dollarsByFamily = {};
    const heldSymbols = new Set();
    for (const p of positions) {
        if (p.marketValue <= 0)
            continue;
        heldSymbols.add(p.symbol);
        if (p.pillar) {
            dollarsByPillar[p.pillar] = (dollarsByPillar[p.pillar] ?? 0) + p.marketValue;
        }
        if (p.family) {
            dollarsByFamily[p.family] = (dollarsByFamily[p.family] ?? 0) + p.marketValue;
        }
    }
    const totalForPct = valuation.totalValue > 0 ? valuation.totalValue : 1;
    const incomePct = (dollarsByPillar['income'] / totalForPct) * 100;
    const targetPct = pillarTargets.incomePct;
    const gapPp = targetPct - incomePct;
    if (gapPp < exports.CONFIG.PILLAR_FILL_GAP_THRESHOLD_PP)
        return [];
    const fullGapDollars = (gapPp / 100) * valuation.totalValue;
    const deployBudget = Math.min(fullGapDollars * exports.CONFIG.PILLAR_FILL_GAP_FRACTION, exports.CONFIG.PILLAR_FILL_MAX_DOLLARS * exports.CONFIG.PILLAR_FILL_MAX_CANDIDATES, buyingPowerAvail * 0.95);
    if (deployBudget < 100)
        return [];
    // Wash-sale defensive skip — only blocks symbols sold at a loss in window.
    const washSaleSkip = new Set(recentSells30d.filter((s) => s.isLoss).map((s) => s.symbol));
    const marginUtilPct = valuation.marginDebt / totalForPct;
    // Score candidates from the AI-curated income subset.
    const scored = (0, fund_metadata_1.listAiCurated)('income')
        .filter((c) => !heldSymbols.has(c.symbol))
        .filter((c) => !washSaleSkip.has(c.symbol))
        .filter((c) => {
        if (marginUtilPct > 0.30 && c.maintenancePct > exports.CONFIG.PILLAR_FILL_HIGH_MARGIN_MAINT_CEILING) {
            return false;
        }
        return true;
    })
        .map((c) => {
        const familyDollars = dollarsByFamily[c.family] ?? 0;
        const familyPct = (familyDollars / totalForPct) * 100;
        const familyPenalty = Math.max(0, familyPct - exports.CONFIG.PILLAR_FILL_FAMILY_PENALTY_PCT);
        // Maintenance gets a mild penalty: prefer lower-maint candidates when ranking
        // is otherwise tied, but don't override the family-diversification preference.
        const maintPenalty = c.maintenancePct / 100;
        const score = -familyPenalty - maintPenalty;
        return { c, familyPct, score };
    })
        .sort((a, b) => b.score - a.score);
    if (scored.length === 0)
        return [];
    // Pick count is budget-aware. Previously a fixed 2-way split would push
    // every small-account budget below the $100 tradability floor (e.g. $107
    // → 2 × $53.50, both unapprovable). Now we cap pickN by how many
    // ≥$100 slices the budget can support, so a $107 budget yields ONE $107
    // suggestion instead of being silently dropped.
    const PER_CANDIDATE_FLOOR = 100;
    const budgetSupports = Math.floor(deployBudget / PER_CANDIDATE_FLOOR);
    const pickN = Math.min(exports.CONFIG.PILLAR_FILL_MAX_CANDIDATES, scored.length, Math.max(1, budgetSupports));
    const perCandidate = deployBudget / pickN;
    const sizePerSignal = Math.min(perCandidate, exports.CONFIG.PILLAR_FILL_MAX_DOLLARS);
    // Final per-candidate floor — guards against the edge case where the
    // budget itself was just barely under $100 (the budgetSupports clamp
    // would give pickN=1 with size <$100). Shares would round to 0 at stage
    // time and the row would be unapprovable.
    if (sizePerSignal < PER_CANDIDATE_FLOOR)
        return [];
    const signals = [];
    const priority = gapPp > 10 ? 'HIGH' : 'MEDIUM';
    for (let i = 0; i < pickN; i += 1) {
        const { c, familyPct } = scored[i];
        signals.push(makeSignal('PILLAR_FILL', `FILL_INCOME_${c.symbol}`, c.symbol, 'BUY', sizePerSignal, priority, `Income pillar at ${incomePct.toFixed(1)}% vs target ${targetPct}% (gap ${gapPp.toFixed(1)}pp). ` +
            `${c.symbol} (${c.family}) fills the gap; you don't already hold it` +
            (familyPct > 0 ? `, and current ${c.family} exposure is ${familyPct.toFixed(1)}%.` : '.'), {
            pillar: 'income',
            actualPct: Math.round(incomePct * 100) / 100,
            targetPct,
            gapPp: Math.round(gapPp * 100) / 100,
            candidateFamily: c.family,
            familyExposurePct: Math.round(familyPct * 100) / 100,
            candidateMaintPct: c.maintenancePct,
            candidateMaintSource: c.maintenancePctSource,
        }));
    }
    return signals;
}
// ─── Main engine ─────────────────────────────────────────────────────────────
function runSignalEngine(inputs) {
    const generatedAt = new Date().toISOString();
    const now = Date.parse(generatedAt);
    const makeSignal = makeSignalFactory(generatedAt);
    const valuation = valuePortfolio(inputs.positions, inputs.cash, inputs.marginDebt, inputs.prices);
    const inDefense = valuation.equityRatio <= exports.CONFIG.DEFENSE_EQUITY_RATIO;
    const spyNow = inputs.spyHistory[inputs.spyHistory.length - 1] ?? 0;
    // Start from the previous state — each rule mutates a copy of the slice it owns.
    const nextState = {
        ...inputs.state,
        defenseMode: { ...inputs.state.defenseMode },
        killSwitch: { ...inputs.state.killSwitch },
        pivot: { ...inputs.state.pivot },
        afwThisMonth: { ...inputs.state.afwThisMonth },
        triplesDipLadder: { ...(inputs.state.triplesDipLadder ?? {}) },
    };
    const all = [];
    // 1. Defense mode — also updates gate flag in nextState.
    all.push(...evalDefenseMode(valuation, makeSignal));
    nextState.defenseMode = {
        active: inDefense,
        since: inDefense
            ? (inputs.state.defenseMode.active ? inputs.state.defenseMode.since : now)
            : null,
        equityRatio: valuation.equityRatio,
    };
    // 2. AFW (Available For Withdrawal) deployment trigger — Vol-7 buy-the-dip
    //    rule that uses available margin headroom. Skipped in defense mode.
    const afwResult = evalAfwTrigger(inputs.spyHistory, valuation, inDefense, inputs.afwDollars, makeSignal);
    all.push(...afwResult.signals);
    if (afwResult.fired) {
        nextState.afwThisMonth = {
            month: currentYearMonth(),
            fired: true,
        };
    }
    // 2b. Triples dip ladder — fires on every fresh 5% drop per-ticker below
    //     a sticky anchor high. Gated by combined triples weight (≤10%), AFW
    //     headroom, defense, killSwitch, and AFW_TRIGGER same-day fire.
    const ladderResult = evalTriplesDipLadder(inputs.prices, valuation, inDefense, nextState.killSwitch.active, inputs.afwDollars, afwResult.fired, inputs.state.triplesDipLadder ?? {}, makeSignal);
    all.push(...ladderResult.signals);
    nextState.triplesDipLadder = ladderResult.nextLadder;
    // 3. Airbag — sole owner of SPXU/SQQQ sizing.
    all.push(...evalAirbag(inputs.vix, inputs.spyHistory, valuation, makeSignal));
    // 4. CLM/CRF trim — buy side cut.
    all.push(...evalClmCrf(valuation, makeSignal));
    // 5. Pivot — both deadline alerts and the +5% recovery trigger.
    const pivot = evalPivot(inputs.spyHistory, inputs.state.pivot, makeSignal);
    all.push(...pivot.signals);
    nextState.pivot = {
        ...nextState.pivot,
        spyLowSincePivot: pivot.nextSpyLow,
    };
    // 6. Margin kill switch — only evaluates at month boundary. Sticky once
    //    tripped (cleared manually via a future admin endpoint).
    const kill = evalMarginKillSwitch(inputs.marginDebt, inputs.state, makeSignal);
    all.push(...kill.signals);
    if (kill.tripped) {
        nextState.killSwitch = {
            active: true,
            since: inputs.state.killSwitch.active ? inputs.state.killSwitch.since : now,
            reason: kill.reason,
        };
    }
    // Note: we do NOT auto-clear killSwitch here — clearing is manual.
    // 7. Leverage reduction — ALERT-only (no SELL).
    all.push(...evalLeverageReduction(valuation, makeSignal));
    // 8. Freedom ratio.
    all.push(...evalFreedomRatio(inputs.state.freedomRatioHistory, makeSignal));
    // 9. (Phase 2) Maintenance-ranked margin-relief trim. Gated by inDefense and
    //    killSwitchActive — both are dominant when active. Thresholds come from
    //    the strategy store when provided; otherwise CONFIG defaults. AFW is
    //    used for digest context (sizing math is algebraically the same).
    all.push(...evalMaintenanceRankedTrim(inputs.positions, valuation, inDefense, nextState.killSwitch.active, inputs.marginThresholds, inputs.afwDollars, makeSignal));
    // 10. (Phase 2) Pillar-fill new-position suggestions. Requires pillarTargets;
    //     gated by inDefense and killSwitchActive. Income pillar only. Hard
    //     AFW-dollar floor when AFW data available — no new buys when headroom
    //     is too low, regardless of utilization ratio.
    const buyingPowerAvail = inputs.buyingPowerAvailable ?? Math.max(0, inputs.cash);
    all.push(...evalPillarFill(inputs.positions, valuation, inputs.pillarTargets, inputs.marginThresholds, inputs.afwDollars, buyingPowerAvail, inDefense, nextState.killSwitch.active, inputs.recentSells30d ?? [], makeSignal));
    // Update prevMonth at month boundary (snapshot current margin for next month's
    // kill-switch comparison).
    const thisMonth = currentYearMonth();
    if (!inputs.state.prevMonth || inputs.state.prevMonth.month !== thisMonth) {
        nextState.prevMonth = { month: thisMonth, margin: inputs.marginDebt };
    }
    nextState.lastRunAt = now;
    // Sort by priority.
    const order = {
        CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4,
    };
    all.sort((a, b) => order[a.priority] - order[b.priority]);
    const actionableTrades = all.filter((s) => s.direction === 'BUY' || s.direction === 'SELL' || s.direction === 'REBALANCE');
    const alerts = all.filter((s) => s.direction === 'ALERT' && s.priority !== 'INFO');
    const info = all.filter((s) => s.direction === 'INFO' || s.priority === 'INFO');
    return {
        generatedAt,
        marketSnapshot: {
            spy: spyNow,
            vix: inputs.vix,
            spyHistory: inputs.spyHistory.slice(-25),
            timestamp: generatedAt,
        },
        valuation,
        signals: all,
        actionableTrades,
        alerts,
        info,
        inDefenseMode: inDefense,
        killSwitchActive: nextState.killSwitch.active,
        nextState,
    };
}
