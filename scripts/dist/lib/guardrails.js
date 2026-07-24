"use strict";
/**
 * Guardrails — pure validators for AI-proposed trades.
 *
 * The point of one-click approval is speed. The point of guardrails is to
 * make sure speed doesn't become recklessness. Every AI-generated trade
 * runs through `validateProposedTrade()` before it's surfaced to the user;
 * trades that violate hard limits are returned as `blockedTrades` with a
 * human-readable explanation rather than silently dropped.
 *
 * All checks are pure functions over a `GuardrailContext` — data loading
 * happens at the route level, validation happens here.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectMarginDraw = exports.DEFAULT_LIMITS = void 0;
exports.projectAfwImpact = projectAfwImpact;
exports.projectMarginIncrease = projectMarginIncrease;
exports.validateProposedTrade = validateProposedTrade;
exports.validateBatch = validateBatch;
exports.isAutomationPaused = isAutomationPaused;
exports.setAutomationPaused = setAutomationPaused;
exports.getAutomationGate = getAutomationGate;
exports.DEFAULT_LIMITS = {
    maxOrderPctOfPortfolio: 0.05,
    maxConcentrationPct: 25,
    maxPillarOverdriftPp: 8,
    maxMarginUtilizationPct: 50,
    minAfwHeadroomAfterTrade: 10000,
    maxOrdersPerDay: 8,
    washSaleWindowDays: 30,
    drawdownTriggerPct: 10,
    drawdownLookbackDays: 14,
};
// ─── Helpers ─────────────────────────────────────────────────────────────────
function isBuy(instr) {
    return instr === 'BUY' || instr === 'BUY_TO_OPEN' || instr === 'BUY_TO_CLOSE';
}
function isOption(instr) {
    return instr === 'BUY_TO_OPEN' || instr === 'SELL_TO_OPEN'
        || instr === 'BUY_TO_CLOSE' || instr === 'SELL_TO_CLOSE';
}
function tradeNotional(t) {
    return t.shares * t.price;
}
/**
 * Project the trade's reduction of AFW (Available For Withdrawal) headroom.
 *
 * AFW impact is what gets you closer to Schwab's 50% wall — it captures the
 * "money set aside" effect regardless of WHETHER it's set aside as cash
 * collateral or as margin requirement. Used by checkAfwHeadroom.
 *
 * Important: AFW impact and margin-balance increase are DIFFERENT numbers
 * for some trade types. A cash-secured short put reserves $strike×100×N in
 * CASH — that reduces AFW by the full amount, but does NOT increase margin
 * balance (it's cash-secured, not margin-secured). Use `projectMarginIncrease`
 * for the utilization-ratio check.
 *
 * Equity:
 *   - BUY:               max(0, notional − availableCash)   (margin draw above cash)
 *   - SELL:              0 (releases collateral)
 *
 * Options (one contract = 100 shares of underlying):
 *   - BUY_TO_OPEN  long: full debit (premium × 100 × contracts) — cash leaves the account
 *   - BUY_TO_CLOSE:      0 (small debit, conservative)
 *   - SELL_TO_CLOSE:     0 (credit; releases AFW, not a reduction)
 *   - SELL_TO_OPEN put:
 *     - cash-secured:    strike × 100 × contracts (cash collateral reserved)
 *     - naked (Reg-T):   Reg-T short-option formula
 *     - covered:         (calls only) 0 — backed by equity
 *   - SELL_TO_OPEN call:
 *     - covered:         0
 *     - naked (Reg-T):   Reg-T short-option formula
 *
 * Missing option metadata on a SELL_TO_OPEN returns ctx.equity as a worst-case
 * estimate so the guardrail trips loudly rather than silently under-estimating.
 */
function projectAfwImpact(t, ctx) {
    const contracts = t.shares;
    if (t.instruction === 'SELL_TO_CLOSE')
        return 0;
    if (t.instruction === 'BUY_TO_CLOSE')
        return 0;
    if (isOption(t.instruction)) {
        if (t.instruction === 'BUY_TO_OPEN') {
            // Premium leaves cash → reduces AFW dollar-for-dollar.
            return contracts * t.price * 100;
        }
        // SELL_TO_OPEN.
        const opt = t.option;
        if (!opt)
            return Math.max(0, ctx.equity); // defensive — see header
        const strike = opt.strike;
        const U = opt.underlyingPrice ?? strike;
        const otm = opt.kind === 'put'
            ? Math.max(0, U - strike)
            : Math.max(0, strike - U);
        if (opt.style === 'cash-secured')
            return contracts * strike * 100;
        if (opt.style === 'covered')
            return 0;
        const regt = Math.max(0.20 * U - otm, 0.10 * strike);
        return contracts * regt * 100;
    }
    // Equity.
    if (isBuy(t.instruction)) {
        const availableCash = Math.max(0, ctx.equity - ctx.marginBalance);
        return Math.max(0, tradeNotional(t) - availableCash);
    }
    return 0; // equity SELL releases collateral
}
/**
 * Project the trade's increase in margin balance (debt). Used by checkMargin
 * to evaluate the post-trade utilization ratio against the 50% cap.
 *
 * Differs from `projectAfwImpact` for CASH-funded trade types:
 *   - Cash-secured short put: AFW down by strike×100×N, margin balance UNCHANGED → returns 0
 *   - Long option BUY_TO_OPEN: premium paid from cash, margin balance UNCHANGED → returns 0
 *   - Equity BUY fully covered by cash: same → returns 0 (matches AFW impact in this case)
 *
 * Trade types where AFW impact == margin balance increase:
 *   - Equity BUY beyond cash: same number for both
 *   - Naked short option: same Reg-T number for both
 *
 * The pattern: "is this trade cash-funded or margin-funded?" If cash-funded,
 * margin balance doesn't change even though AFW does.
 */
function projectMarginIncrease(t, ctx) {
    const contracts = t.shares;
    if (t.instruction === 'SELL_TO_CLOSE')
        return 0;
    if (t.instruction === 'BUY_TO_CLOSE')
        return 0;
    // Long option BUY_TO_OPEN: cash-funded premium debit. No margin balance bump.
    if (t.instruction === 'BUY_TO_OPEN')
        return 0;
    if (isOption(t.instruction)) {
        // SELL_TO_OPEN.
        const opt = t.option;
        if (!opt)
            return Math.max(0, ctx.equity); // defensive
        const strike = opt.strike;
        const U = opt.underlyingPrice ?? strike;
        const otm = opt.kind === 'put'
            ? Math.max(0, U - strike)
            : Math.max(0, strike - U);
        // Cash-secured shorts reserve CASH, not margin. Schwab reports
        // maintenanceRequirement = $0 for these (the bug the user hit on the
        // close-recs report). They don't bump margin utilization.
        if (opt.style === 'cash-secured')
            return 0;
        if (opt.style === 'covered')
            return 0;
        // Naked — real margin lock.
        const regt = Math.max(0.20 * U - otm, 0.10 * strike);
        return contracts * regt * 100;
    }
    // Equity.
    if (isBuy(t.instruction)) {
        const availableCash = Math.max(0, ctx.equity - ctx.marginBalance);
        return Math.max(0, tradeNotional(t) - availableCash);
    }
    return 0;
}
/**
 * @deprecated Use `projectAfwImpact` (AFW gate) or `projectMarginIncrease`
 * (utilization gate). This alias kept for backwards-compat with callers that
 * weren't using it for a specific gate — both old call sites are internal
 * to this module so the deprecation is informational only.
 */
exports.projectMarginDraw = projectAfwImpact;
function withinDays(timestampISO, days, now = Date.now()) {
    const t = new Date(timestampISO).getTime();
    return now - t <= days * 24 * 60 * 60 * 1000;
}
// ─── Individual checks ───────────────────────────────────────────────────────
/**
 * Always-keep-one-share rule. SELL orders that would close the entire position
 * are blocked outright. The intent: never fully exit a holding via the
 * automated path — leave at least one share behind so the position stays on
 * the book (preserves history, cost basis, dividend trail).
 *
 * Applies to equity SELLs only — option closes (SELL_TO_CLOSE) routinely
 * close to zero contracts and are out of scope. The signal engine's primary
 * staging path (lib/signals/run.ts:signalsToInbox) already caps shares at
 * currentShares - 1; this guardrail is the defense-in-depth catch for any
 * SELL that gets routed through /api/orders without going through
 * signalsToInbox (e.g. on-demand staging from the panel).
 */
function checkFullExit(t, ctx) {
    if (t.instruction !== 'SELL')
        return null;
    const position = ctx.positions.find((p) => p.symbol === t.symbol);
    if (!position || position.shares <= 0)
        return null;
    if (t.shares < position.shares)
        return null;
    return {
        code: 'full_exit_blocked',
        severity: 'block',
        message: `This would sell your entire ${t.symbol} position (all ${position.shares} share${position.shares === 1 ? '' : 's'}). ` +
            `The app never fully exits a holding automatically — it keeps at least 1 share so the position, ` +
            `its cost history, and its dividend record stay on the books. Lower the share count to proceed.`,
    };
}
function checkOrderSize(t, ctx, limits) {
    if (ctx.totalValue <= 0)
        return null;
    const notional = tradeNotional(t);
    const pct = notional / ctx.totalValue;
    if (pct > limits.maxOrderPctOfPortfolio) {
        return {
            code: 'order_size_cap',
            severity: 'block',
            message: `This single order (~$${Math.round(notional).toLocaleString()} of ${t.symbol}) is ` +
                `${(pct * 100).toFixed(1)}% of your whole portfolio — the safety cap for any one trade is ` +
                `${(limits.maxOrderPctOfPortfolio * 100).toFixed(0)}%. Split it into smaller orders if it's intentional.`,
        };
    }
    return null;
}
function checkConcentration(t, ctx, limits) {
    if (!isBuy(t.instruction) || ctx.totalValue <= 0)
        return null;
    const existing = ctx.positions.find((p) => p.symbol === t.symbol)?.marketValue ?? 0;
    const post = existing + tradeNotional(t);
    const pct = (post / ctx.totalValue) * 100;
    if (pct > limits.maxConcentrationPct) {
        return {
            code: 'concentration_cap',
            severity: 'block',
            message: `This buy would make ${t.symbol} ${pct.toFixed(1)}% of your portfolio — over the ` +
                `${limits.maxConcentrationPct}% cap on any single holding. The cap exists so no one position ` +
                `can take the account down with it.`,
        };
    }
    return null;
}
function checkPillarOverdrift(t, ctx, limits) {
    if (!isBuy(t.instruction) || ctx.totalValue <= 0)
        return null;
    const target = ctx.pillars.find((p) => p.pillar === t.pillar);
    if (!target)
        return null;
    const currentDollars = (target.currentPct / 100) * ctx.totalValue;
    const postDollars = currentDollars + tradeNotional(t);
    const postPct = (postDollars / ctx.totalValue) * 100;
    const overdrift = postPct - target.targetPct;
    if (overdrift > limits.maxPillarOverdriftPp) {
        return {
            code: 'pillar_overdrift',
            severity: 'block',
            message: `This buy would push your ${t.pillar} pillar to ${postPct.toFixed(1)}% of the portfolio — ` +
                `${overdrift.toFixed(1)} points past its ${target.targetPct}% target ` +
                `(${limits.maxPillarOverdriftPp} points over is the most the app allows). ` +
                `Raise the pillar's target in Settings if this is deliberate.`,
        };
    }
    return null;
}
function checkMargin(t, ctx, limits) {
    if (ctx.totalValue <= 0)
        return null;
    // Margin BALANCE increase — not AFW impact. Cash-secured shorts and long
    // option opens reduce AFW but don't bump margin debt, so they should NOT
    // trip the utilization cap. See projectMarginIncrease docstring.
    const marginIncrease = projectMarginIncrease(t, ctx);
    if (marginIncrease <= 0)
        return null;
    const projectedMargin = ctx.marginBalance + marginIncrease;
    const projectedTotal = ctx.totalValue + marginIncrease;
    const pct = projectedTotal > 0 ? (projectedMargin / projectedTotal) * 100 : 0;
    if (pct > limits.maxMarginUtilizationPct) {
        return {
            code: 'margin_cap',
            severity: 'block',
            message: `This trade would push your borrowing to ${pct.toFixed(1)}% of the account — past your ` +
                `${limits.maxMarginUtilizationPct}% limit. Free up cash first (or raise the limit in Settings); ` +
                `Schwab hard-stops everything at 50%.`,
        };
    }
    return null;
}
/**
 * Post-trade AFW floor.
 *
 * Projects AFW = (pre-trade AFW − margin draw from this trade). If the result
 * dips below the configured minimum headroom, BLOCK. Catches the case where
 * a single trade — especially a short put — passes the pre-trade AFW check
 * in the signal engine but its own margin requirement leaves you dangerously
 * close to Schwab's 50% wall.
 *
 * Skipped when ctx.afwDollars is undefined (legacy / replay paths). The
 * upstream margin_cap check is the secondary line of defense in that case.
 */
function checkAfwHeadroom(t, ctx, limits) {
    if (typeof ctx.afwDollars !== 'number')
        return null;
    // AFW impact — includes cash-secured collateral and long-option debits
    // that DON'T appear as margin balance increases. See projectAfwImpact.
    const draw = projectAfwImpact(t, ctx);
    if (draw <= 0)
        return null;
    const postAfw = ctx.afwDollars - draw;
    if (postAfw >= limits.minAfwHeadroomAfterTrade)
        return null;
    const drawHuman = `$${Math.round(draw).toLocaleString()}`;
    const preHuman = `$${Math.round(ctx.afwDollars).toLocaleString()}`;
    const postHuman = `$${Math.round(postAfw).toLocaleString()}`;
    const floorHuman = `$${Math.round(limits.minAfwHeadroomAfterTrade).toLocaleString()}`;
    return {
        code: 'afw_headroom',
        severity: 'block',
        message: `This trade would use up ${drawHuman} of your cash cushion (AFW — what you could withdraw today), ` +
            `taking it from ${preHuman} down to ${postHuman}. The app keeps at least ${floorHuman} in reserve ` +
            `so one bad day can't push you into Schwab's 50% borrowing wall.`,
    };
}
function checkDailyCount(_t, ctx, limits) {
    const today = new Date().toISOString().slice(0, 10);
    const todaysCount = ctx.recentTrades.filter((rt) => rt.timestamp.slice(0, 10) === today).length;
    if (todaysCount >= limits.maxOrdersPerDay) {
        return {
            code: 'daily_order_count',
            severity: 'block',
            message: `${todaysCount} orders have already gone out today — the daily limit is ${limits.maxOrdersPerDay}. ` +
                `This is a circuit breaker against runaway automation; it resets at midnight, or you can place ` +
                `the order manually at Schwab if it can't wait.`,
        };
    }
    return null;
}
function checkWashSale(t, ctx, limits) {
    if (!isBuy(t.instruction))
        return null;
    // A simple wash-sale heuristic: any SELL of the same symbol within the
    // window. We don't have realized P&L here, so this is conservative — the
    // user can override if the prior sale was a gain.
    const recentSell = ctx.recentTrades.find((rt) => rt.symbol === t.symbol &&
        (rt.instruction === 'SELL' || rt.instruction === 'SELL_TO_CLOSE') &&
        withinDays(rt.timestamp, limits.washSaleWindowDays));
    if (recentSell) {
        return {
            code: 'wash_sale',
            severity: 'warn',
            message: `${t.symbol} was sold on ${recentSell.timestamp.slice(0, 10)} — wash-sale window (${limits.washSaleWindowDays}d) still open. If that sale was at a loss, this BUY disallows the deduction.`,
        };
    }
    return null;
}
function checkDrawdown(_t, ctx, limits) {
    if (!ctx.snapshots || ctx.snapshots.length < 2)
        return null;
    const sorted = [...ctx.snapshots].sort((a, b) => a.savedAt - b.savedAt);
    const cutoff = Date.now() - limits.drawdownLookbackDays * 24 * 60 * 60 * 1000;
    const window = sorted.filter((s) => s.savedAt >= cutoff);
    if (window.length < 2)
        return null;
    const peak = Math.max(...window.map((s) => s.totalValue));
    const current = window[window.length - 1].totalValue;
    if (peak <= 0)
        return null;
    const drawdownPct = ((peak - current) / peak) * 100;
    if (drawdownPct >= limits.drawdownTriggerPct) {
        return {
            code: 'drawdown_breaker',
            severity: 'warn',
            message: `Portfolio is down ${drawdownPct.toFixed(1)}% from peak in the last ${limits.drawdownLookbackDays}d. Drawdown breaker triggered — confirm before adding aggressive exposure.`,
        };
    }
    return null;
}
// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Validate a single proposed trade against all guardrails. Returns
 * `{ allowed, violations }` — `allowed` is false if any violation has
 * severity 'block'.
 */
function validateProposedTrade(trade, ctx) {
    const limits = { ...exports.DEFAULT_LIMITS, ...(ctx.limits ?? {}) };
    const checks = [
        checkFullExit(trade, ctx),
        checkOrderSize(trade, ctx, limits),
        checkConcentration(trade, ctx, limits),
        checkPillarOverdrift(trade, ctx, limits),
        checkMargin(trade, ctx, limits),
        checkAfwHeadroom(trade, ctx, limits),
        checkDailyCount(trade, ctx, limits),
        checkWashSale(trade, ctx, limits),
        checkDrawdown(trade, ctx, limits),
    ];
    const violations = checks.filter((v) => v !== null);
    const allowed = !violations.some((v) => v.severity === 'block');
    return { allowed, violations };
}
/**
 * Validate a batch of trades. Returns separated allowed + blocked lists,
 * each carrying their violations (allowed trades may still have warnings).
 */
function validateBatch(trades, ctx) {
    const allowed = [];
    const blocked = [];
    for (const t of trades) {
        const { allowed: ok, violations } = validateProposedTrade(t, ctx);
        const enriched = { ...t, violations };
        if (ok)
            allowed.push(enriched);
        else
            blocked.push(enriched);
    }
    return { allowed, blocked };
}
// ─── Kill switch helpers ─────────────────────────────────────────────────────
const PAUSE_KEY = 'pause-flag'; // legacy household pause
const PAUSE_ACCOUNT_PREFIX = 'pause-flag:account:'; // per-account pause
function pauseKeyFor(accountHash) {
    if (!accountHash || accountHash === 'all' || accountHash === 'global')
        return PAUSE_KEY;
    return `${PAUSE_ACCOUNT_PREFIX}${accountHash}`;
}
/**
 * Check whether the user has tripped the "Pause Automation" kill switch.
 * Persisted in the `system-state` blob so it survives across requests.
 *
 * With an `accountHash`, returns true if EITHER the account-specific pause
 * OR the global household pause is active — household pause is the
 * "everything stop" master switch that overrides per-account state.
 * Without an `accountHash`, returns the household pause only (legacy).
 */
async function isAutomationPaused(accountHash) {
    const { getStore } = await Promise.resolve().then(() => __importStar(require('@netlify/blobs')));
    try {
        const store = getStore('system-state');
        if (accountHash && accountHash !== 'all' && accountHash !== 'global') {
            const [own, household] = await Promise.all([
                store.get(pauseKeyFor(accountHash), { type: 'json' }),
                store.get(PAUSE_KEY, { type: 'json' }),
            ]);
            return Boolean(own?.paused) || Boolean(household?.paused);
        }
        const v = await store.get(PAUSE_KEY, { type: 'json' });
        return Boolean(v?.paused);
    }
    catch {
        return false;
    }
}
/**
 * Persist the pause flag. With an `accountHash`, scopes the flag to that
 * account (does NOT touch the household master pause). Without, sets the
 * household master pause that overrides every account.
 */
async function setAutomationPaused(paused, accountHash) {
    const { getStore } = await Promise.resolve().then(() => __importStar(require('@netlify/blobs')));
    await getStore('system-state').setJSON(pauseKeyFor(accountHash), {
        paused,
        updatedAt: Date.now(),
    });
}
/**
 * Combined automation gate. Returns the FIRST gate that's currently active in
 * priority order (user > kill-switch > defense-mode). Other routes use this
 * instead of bare `isAutomationPaused()` so they respect signal-engine flags
 * without needing to know about the engine internals.
 *
 * 2026-05: per-account gates. Callers acting on a specific account should
 * pass that account's hash so they're gated by that account's defense-mode /
 * kill-switch only. Callers without an account context (or working at the
 * household level) omit the arg — the gate then aggregates across all
 * accounts and bails if ANY of them is in defense or kill-switch (the
 * conservative choice — we'd rather pause more than fewer endpoints when a
 * household-level signal trips).
 *
 * Dynamically imports the signal-engine state module to avoid a hard
 * dependency — guardrails is broadly imported, signals/state is narrow.
 */
async function getAutomationGate(accountHash) {
    if (await isAutomationPaused(accountHash)) {
        return {
            paused: true,
            source: 'user',
            reason: accountHash
                ? 'Automation paused (account or household master)'
                : 'Automation paused by user',
            since: null,
        };
    }
    try {
        const { getSignalGates } = await Promise.resolve().then(() => __importStar(require('./signals/state')));
        const gates = await getSignalGates(accountHash);
        if (gates.killSwitch.active) {
            return {
                paused: true,
                source: 'kill-switch',
                reason: gates.killSwitch.reason || 'Margin kill switch tripped',
                since: gates.killSwitch.since,
            };
        }
        if (gates.defenseMode.active) {
            return {
                paused: true,
                source: 'defense-mode',
                reason: `Defense mode active — equity ratio ${(gates.defenseMode.equityRatio * 100).toFixed(1)}%`,
                since: gates.defenseMode.since,
            };
        }
    }
    catch (err) {
        // Signal-engine state blob may not exist yet on a fresh install. Treat as
        // "no gates active" — fall through to normal flow rather than blocking.
        console.warn('[guardrails] could not read signal-engine gates:', err);
    }
    return { paused: false, source: null, reason: '', since: null };
}
