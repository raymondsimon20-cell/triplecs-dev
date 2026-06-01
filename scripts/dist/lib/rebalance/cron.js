"use strict";
/**
 * Server-side rebalance cron.
 *
 * Loops every linked Schwab account, computes pillar drift against that
 * account's strategy targets (override → global), and stages deterministic
 * rebalance orders to the inbox when drift exceeds 2%. Lives outside the
 * signal engine so the cadence can differ: rebalance is a coarser, weekly-ish
 * check that runs even on days the signal engine sees nothing actionable.
 *
 * Differences from /api/rebalance-plan (the dashboard's Claude-driven path):
 *   - No Claude call. The cron has to be predictable, cheap, and fast.
 *   - Orders staged as tier='approval' so the user reviews before fire. The
 *     dashboard / Claude path can still surface tier='auto' items when the
 *     plan is small enough and the user has flipped auto-config to 'auto'.
 *   - Vol-7 1/3 rule: when an income pillar is trimmed, 1/3 of the freed
 *     dollars rotates into Triples. Cornerstone is never sold.
 *
 * Per-account scoping: each account checks its OWN targets, stages its OWN
 * orders tagged with its accountHash, and skips when an existing pending
 * rebalance batch for that account is already in the inbox.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickTrimTarget = pickTrimTarget;
exports.runDriftRebalanceForAllAccounts = runDriftRebalanceForAllAccounts;
const strategy_store_1 = require("../strategy-store");
const inbox_1 = require("../inbox");
const fund_metadata_1 = require("../data/fund-metadata");
const client_1 = require("../schwab/client");
const storage_1 = require("../storage");
const utils_1 = require("../utils");
const DRIFT_THRESHOLD_PCT = 2;
const MAX_TRADES_PER_ACCOUNT = 4;
// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Fetch every account + classify positions into pillars. */
async function fetchAccountSlices() {
    const tokens = await (0, storage_1.getTokens)();
    if (!tokens)
        throw new Error('Schwab not connected');
    const client = await (0, client_1.createClient)();
    const accountNums = await (0, client_1.getAccountNumbers)(tokens);
    if (accountNums.length === 0)
        throw new Error('No Schwab accounts');
    const wrappers = await Promise.all(accountNums.map(async ({ hashValue }) => ({
        hashValue,
        wrapper: await client.getAccount(hashValue),
    })));
    // Collect every symbol so we can fetch quotes once.
    const allSymbols = new Set();
    for (const { wrapper } of wrappers) {
        for (const p of wrapper.securitiesAccount.positions ?? []) {
            if (p.instrument.assetType === 'OPTION')
                continue;
            if (p.instrument.symbol.includes(' '))
                continue;
            if ((p.longQuantity ?? 0) <= 0)
                continue;
            allSymbols.add(p.instrument.symbol);
        }
    }
    const prices = {};
    if (allSymbols.size > 0) {
        const quotes = await client.getQuotes(Array.from(allSymbols));
        for (const [sym, q] of Object.entries(quotes)) {
            const price = q.quote?.lastPrice ?? q.quote?.mark;
            if (price && Number.isFinite(price))
                prices[sym] = price;
        }
    }
    return wrappers.map(({ hashValue, wrapper }) => {
        const acct = wrapper.securitiesAccount;
        const positions = (acct.positions ?? [])
            .filter((p) => p.instrument.assetType !== 'OPTION'
            && !p.instrument.symbol.includes(' ')
            && (p.longQuantity ?? 0) > 0)
            .map((p) => ({
            symbol: p.instrument.symbol,
            shares: p.longQuantity,
            marketValue: p.marketValue ?? 0,
            pillar: (0, fund_metadata_1.getFundMetadata)(p.instrument.symbol)?.pillar,
        }));
        const totalValue = (acct.currentBalances.longMarketValue ?? 0) +
            Math.abs(acct.currentBalances.shortMarketValue ?? 0);
        return { accountHash: hashValue, positions, totalValue, prices };
    });
}
function summarisePillars(slice) {
    const map = new Map();
    for (const p of slice.positions) {
        const key = p.pillar ?? 'other';
        map.set(key, (map.get(key) ?? 0) + p.marketValue);
    }
    return Array.from(map.entries()).map(([pillar, marketValue]) => ({
        pillar,
        marketValue,
        portfolioPercent: slice.totalValue > 0 ? (marketValue / slice.totalValue) * 100 : 0,
    }));
}
function targetMapFor(strategy) {
    return {
        triples: strategy.triplesPct,
        cornerstone: strategy.cornerstonePct,
        income: strategy.incomePct,
        hedge: strategy.hedgePct,
    };
}
/**
 * Per-pillar trim ordering preference. When a pillar is over-target, this
 * picks which holding to trim — defaults to largest-by-value (caller already
 * sorted that way), but allows a specific ticker to jump the queue if it's
 * present with a meaningful position.
 *
 * Triples preference: SOXL is preferred over UPRO/TQQQ because it's a sector
 * triple that decays during flat/choppy markets (Triple-Cs-Volume-7-Rules.md
 * §2). Pairs with the per-ticker cap in the TRIPLES_DIP_LADDER signal rule —
 * ladder buys SOXL heavy on dips, this trims it heavy on bounces, keeps the
 * position from sitting and bleeding. Falls back to largest-by-value when
 * SOXL isn't held at a trim-worthy size (< $500).
 */
const TRIM_PREFERRED_TICKER_BY_PILLAR = {
    triples: 'SOXL',
};
const TRIM_PREFERENCE_MIN_VALUE = 500;
function pickTrimTarget(pillar, sorted) {
    const preferredSym = TRIM_PREFERRED_TICKER_BY_PILLAR[pillar];
    if (preferredSym) {
        const preferred = sorted.find((p) => p.symbol === preferredSym && p.marketValue >= TRIM_PREFERENCE_MIN_VALUE);
        if (preferred)
            return preferred;
    }
    return sorted[0];
}
/**
 * Build a small set of deterministic rebalance orders for ONE account.
 * Rule of thumb (matches Vol-7):
 *   - Income overweight → trim the biggest income position; 1/3 of proceeds
 *     rotate into Triples (or whichever pillar is most underweight).
 *   - Triples overweight → trim back to target (cap of MAX_TRADES_PER_ACCOUNT).
 *   - Cornerstone NEVER sold; if underweight, propose a BUY of the gap.
 * Returns at most MAX_TRADES_PER_ACCOUNT inputs.
 */
function buildOrders(slice, pillars, targetMap) {
    const drifts = pillars
        .filter((p) => p.pillar !== 'other')
        .map((p) => ({ ...p, drift: p.portfolioPercent - (targetMap[p.pillar] ?? 0) }))
        .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
    const orders = [];
    const remainingBudget = () => MAX_TRADES_PER_ACCOUNT - orders.length;
    // Trim over-weight pillars (skip cornerstone — never sold).
    for (const d of drifts) {
        if (d.drift <= 0)
            continue;
        if (d.pillar === 'cornerstone')
            continue;
        if (remainingBudget() <= 0)
            break;
        const trimDollars = (d.drift / 100) * slice.totalValue;
        const positionsInPillar = slice.positions
            .filter((p) => (p.pillar ?? 'other') === d.pillar)
            .sort((a, b) => b.marketValue - a.marketValue);
        if (positionsInPillar.length === 0)
            continue;
        const target = pickTrimTarget(d.pillar, positionsInPillar);
        const price = slice.prices[target.symbol];
        if (!price || price <= 0)
            continue;
        const shares = Math.floor(Math.min(trimDollars, target.marketValue * 0.5) / price);
        if (shares <= 0)
            continue;
        orders.push({
            source: 'rebalance',
            symbol: target.symbol,
            instruction: 'SELL',
            quantity: shares,
            orderType: 'MARKET',
            price,
            pillar: d.pillar,
            rationale: `Cron drift trim: ${d.pillar} ${d.drift.toFixed(1)}% over target`,
            aiMode: 'rebalance_cron',
            violations: [],
            tier: 'approval',
            accountHash: slice.accountHash,
        });
    }
    // Fill under-weight pillars.
    for (const d of drifts) {
        if (d.drift >= 0)
            continue;
        if (remainingBudget() <= 0)
            break;
        const fillDollars = (-d.drift / 100) * slice.totalValue;
        // Pick an existing holding in the pillar; if none, pick the canonical
        // ticker by pillar so the user can review the symbol.
        const positionsInPillar = slice.positions
            .filter((p) => (p.pillar ?? 'other') === d.pillar)
            .sort((a, b) => b.marketValue - a.marketValue);
        const targetSymbol = positionsInPillar[0]?.symbol
            ?? CANONICAL_BY_PILLAR[d.pillar];
        if (!targetSymbol)
            continue;
        const price = slice.prices[targetSymbol];
        if (!price || price <= 0)
            continue;
        const shares = Math.floor(fillDollars / price);
        if (shares <= 0)
            continue;
        orders.push({
            source: 'rebalance',
            symbol: targetSymbol,
            instruction: 'BUY',
            quantity: shares,
            orderType: 'MARKET',
            price,
            pillar: d.pillar,
            rationale: `Cron drift fill: ${d.pillar} ${(-d.drift).toFixed(1)}% under target`,
            aiMode: 'rebalance_cron',
            violations: [],
            tier: 'approval',
            accountHash: slice.accountHash,
        });
    }
    return orders;
}
/** Canonical ticker per pillar — used when a pillar is underweight AND empty. */
const CANONICAL_BY_PILLAR = {
    triples: 'UPRO',
    cornerstone: 'CLM',
    income: 'JEPI',
    hedge: 'SPXU',
};
// ─── Entry point ─────────────────────────────────────────────────────────────
async function runDriftRebalanceForAllAccounts() {
    const ranAt = new Date().toISOString();
    const slices = await fetchAccountSlices();
    // Pull all currently-pending rebalance items once; bucket by account so each
    // account's check is just a lookup.
    const pendingRebalance = await (0, inbox_1.listInbox)({ status: 'pending', source: 'rebalance' });
    const pendingByAccount = new Map();
    for (const it of pendingRebalance) {
        const k = it.accountHash || '__untagged';
        pendingByAccount.set(k, (pendingByAccount.get(k) ?? 0) + 1);
    }
    const results = [];
    for (const slice of slices) {
        if (slice.positions.length === 0 || slice.totalValue <= 0) {
            results.push({
                accountHash: slice.accountHash,
                drift: 0,
                staged: 0,
                skipped: 'no-positions',
            });
            continue;
        }
        if ((pendingByAccount.get(slice.accountHash) ?? 0) > 0) {
            results.push({
                accountHash: slice.accountHash,
                drift: 0,
                staged: 0,
                skipped: 'existing-batch',
            });
            continue;
        }
        try {
            const strategy = await (0, strategy_store_1.getServerStrategyTargets)(slice.accountHash);
            const pillars = summarisePillars(slice);
            const targets = targetMapFor({ ...utils_1.DEFAULT_TARGETS, ...strategy });
            const maxDrift = Math.max(...pillars
                .filter((p) => p.pillar !== 'other')
                .map((p) => Math.abs(p.portfolioPercent - (targets[p.pillar] ?? 0))), 0);
            if (maxDrift <= DRIFT_THRESHOLD_PCT) {
                results.push({
                    accountHash: slice.accountHash,
                    drift: maxDrift,
                    staged: 0,
                    skipped: 'low-drift',
                });
                continue;
            }
            const orders = buildOrders(slice, pillars, targets);
            if (orders.length === 0) {
                results.push({ accountHash: slice.accountHash, drift: maxDrift, staged: 0 });
                continue;
            }
            const persisted = await (0, inbox_1.appendInbox)(orders);
            results.push({
                accountHash: slice.accountHash,
                drift: maxDrift,
                staged: Array.isArray(persisted) ? persisted.length : 0,
            });
        }
        catch (err) {
            results.push({
                accountHash: slice.accountHash,
                drift: 0,
                staged: 0,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { ranAt, accounts: results };
}
