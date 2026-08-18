"use strict";
/**
 * Schwab Trader API client
 * Wraps all API calls with automatic token refresh, retry with exponential
 * backoff, and error handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAccountNumbers = getAccountNumbers;
exports.getAllAccounts = getAllAccounts;
exports.getAccount = getAccount;
exports.getQuotes = getQuotes;
exports.missingQuoteSymbols = missingQuoteSymbols;
exports.extractDividendDates = extractDividendDates;
exports.getFundamentals = getFundamentals;
exports.getPriceHistory = getPriceHistory;
exports.getOptionsChain = getOptionsChain;
exports.getTransactions = getTransactions;
exports.getUserPreference = getUserPreference;
exports.createClient = createClient;
const auth_1 = require("./auth");
const storage_1 = require("../storage");
const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';
// ─── Retry configuration ─────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const BASE_DELAY = 500; // ms
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ─── Core fetch wrapper ───────────────────────────────────────────────────────
async function schwabFetch(url, tokens, options = {}) {
    // Auto-refresh if the access token is stale
    let activeTokens = tokens;
    if ((0, auth_1.isAccessTokenExpired)(tokens)) {
        if ((0, auth_1.isRefreshTokenExpired)(tokens)) {
            throw new Error('REFRESH_TOKEN_EXPIRED');
        }
        activeTokens = await (0, auth_1.refreshAccessToken)(tokens.refresh_token);
        await (0, storage_1.saveTokens)(activeTokens);
    }
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${activeTokens.access_token}`,
                    ...options.headers,
                },
            });
            // 401 — force one token refresh then retry immediately
            if (response.status === 401 && attempt === 0) {
                try {
                    activeTokens = await (0, auth_1.refreshAccessToken)(activeTokens.refresh_token);
                    await (0, storage_1.saveTokens)(activeTokens);
                    continue; // retry with fresh token
                }
                catch {
                    throw new Error('REFRESH_TOKEN_EXPIRED');
                }
            }
            // Retryable server errors — backoff and retry
            if (RETRYABLE.has(response.status)) {
                const delay = BASE_DELAY * Math.pow(2, attempt);
                console.warn(`[schwab] ${response.status} on ${url} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
                await sleep(delay);
                lastError = new Error(`Schwab API error ${response.status}`);
                continue;
            }
            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Schwab API error ${response.status}: ${body}`);
            }
            // 204 No Content
            if (response.status === 204)
                return undefined;
            return response.json();
        }
        catch (err) {
            // Network errors (fetch itself throws) — retry with backoff
            if (err instanceof TypeError && attempt < MAX_RETRIES - 1) {
                const delay = BASE_DELAY * Math.pow(2, attempt);
                console.warn(`[schwab] Network error on ${url} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
                await sleep(delay);
                lastError = err;
                continue;
            }
            throw err;
        }
    }
    throw lastError ?? new Error(`Schwab API failed after ${MAX_RETRIES} retries`);
}
// ─── Account endpoints ────────────────────────────────────────────────────────
/**
 * Returns the list of linked account numbers + their API hash values.
 * Use hashValue in all subsequent account API calls.
 */
async function getAccountNumbers(tokens) {
    return schwabFetch(`${TRADER_BASE}/accounts/accountNumbers`, tokens);
}
/**
 * Returns all accounts with full positions and balances.
 * Pass `fields=positions` to include position data.
 */
async function getAllAccounts(tokens) {
    return schwabFetch(`${TRADER_BASE}/accounts?fields=positions`, tokens);
}
/**
 * Returns a single account by its hash value with positions and balances.
 */
async function getAccount(tokens, accountHash) {
    return schwabFetch(`${TRADER_BASE}/accounts/${accountHash}?fields=positions`, tokens);
}
// ─── Market Data endpoints ────────────────────────────────────────────────────
/**
 * Fetch real-time quotes for a list of symbols.
 * Returns a map of symbol → quote data.
 *
 * Resilient: if the batch request fails (e.g. one bad symbol causes a 400),
 * falls back to fetching symbols individually so one bad ticker doesn't
 * break the entire dashboard.
 */
async function getQuotes(tokens, symbols) {
    if (symbols.length === 0)
        return {};
    // Filter out obviously invalid symbols (empty, whitespace-only, too long)
    const validSymbols = symbols.filter((s) => s && s.trim().length > 0 && s.trim().length <= 20);
    if (validSymbols.length === 0)
        return {};
    // Build query string manually — URLSearchParams encodes '$' as '%24' which
    // Schwab rejects for index symbols like $VIX.X, $SPX.X, $NDX.X.
    function buildQuoteUrl(syms) {
        const tail = new URLSearchParams({ fields: 'quote,reference', indicative: 'false' }).toString();
        return `${MARKET_BASE}/quotes?symbols=${syms.join(',')}&${tail}`;
    }
    try {
        return await schwabFetch(buildQuoteUrl(validSymbols), tokens);
    }
    catch (err) {
        console.warn('[getQuotes] Batch request failed, falling back to individual symbol fetches:', err);
        const result = {};
        const failed = [];
        for (const sym of validSymbols) {
            try {
                const single = await schwabFetch(buildQuoteUrl([sym]), tokens);
                Object.assign(result, single);
            }
            catch (innerErr) {
                // Previously this swallowed errors with `console.warn`-only — the
                // signal engine then gated trades on `prices[t] && t > 0` and
                // silently skipped staging real BUY/SELLs for any unresolved ticker.
                // Now we collect the failures and surface them on the result via a
                // non-enumerable `__missing` marker so callers that care (the engine
                // pipeline) can decide whether to abort or continue with a warning.
                // The console.error stays so production logs catch it too.
                console.error(`[getQuotes] Failed to resolve symbol: ${sym}`, innerErr);
                failed.push(sym);
            }
        }
        if (failed.length > 0) {
            Object.defineProperty(result, '__missing', {
                value: failed,
                enumerable: false,
            });
        }
        return result;
    }
}
/**
 * Helper to detect when a getQuotes result has missing symbols. Callers that
 * gate trades on price (signal engine, rebalance-plan) should refuse to fire
 * orders for any symbol that landed here rather than silently skipping them.
 */
function missingQuoteSymbols(quotes) {
    const m = quotes.__missing;
    return Array.isArray(m) ? m : [];
}
/** Coerce Schwab's assorted date encodings to YYYY-MM-DD, or null. */
function normaliseDate(v) {
    if (v == null)
        return null;
    if (typeof v === 'number') {
        if (v <= 0)
            return null;
        // Schwab sometimes returns epoch millis, sometimes seconds.
        const ms = v > 1e11 ? v : v * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    if (typeof v !== 'string' || v.trim() === '')
        return null;
    // Already ISO-ish, or a full timestamp — take the date part.
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m)
        return m[1];
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function pick(f, keys) {
    for (const k of keys) {
        if (f[k] != null && f[k] !== '' && f[k] !== 0)
            return f[k];
    }
    return null;
}
/** Normalise a fundamental block into declared dividend dates. */
function extractDividendDates(symbol, f) {
    if (!f) {
        return { symbol, nextExDate: null, nextPayDate: null, lastExDate: null, lastPayDate: null, freq: null, amount: null };
    }
    const freqRaw = pick(f, ['dividendFreq', 'divFreq', 'dividendFrequency']);
    const amtRaw = pick(f, ['dividendAmount', 'divAmount', 'dividendPayAmount']);
    return {
        symbol,
        nextExDate: normaliseDate(pick(f, ['nextDividendDate', 'nextDivDate', 'nextDividendExDate', 'nextDivExDate'])),
        nextPayDate: normaliseDate(pick(f, ['nextDividendPayDate', 'nextDivPayDate'])),
        lastExDate: normaliseDate(pick(f, ['dividendDate', 'divDate', 'dividendExDate'])),
        lastPayDate: normaliseDate(pick(f, ['dividendPayDate', 'divPayDate'])),
        freq: typeof freqRaw === 'number' ? freqRaw : null,
        amount: typeof amtRaw === 'number' ? amtRaw : null,
    };
}
/**
 * Fetch instrument fundamentals — the only Schwab surface that carries
 * *declared* forward dividend dates (the quote endpoint has trailing data only).
 *
 * Schwab's `/instruments` endpoint is documented with a single `symbol`
 * parameter. Comma-separated batches work in practice but are not guaranteed,
 * so this batches optimistically and degrades to per-symbol requests. Coverage
 * is genuinely spotty for closed-end funds and recently launched ETFs — callers
 * should expect nulls and fall back to a derived estimate.
 */
async function getFundamentals(tokens, symbols) {
    const out = {};
    const valid = Array.from(new Set(symbols
        .map((s) => s?.trim().toUpperCase())
        .filter((s) => !!s && s.length > 0 && s.length <= 20 && !s.includes(' '))));
    if (valid.length === 0)
        return out;
    const url = (syms) => `${MARKET_BASE}/instruments?symbol=${syms.join(',')}&projection=fundamental`;
    const absorb = (resp) => {
        for (const inst of resp?.instruments ?? []) {
            const sym = (inst.symbol ?? inst.fundamental?.symbol ?? '').toUpperCase();
            if (!sym)
                continue;
            out[sym] = extractDividendDates(sym, inst.fundamental);
        }
    };
    // Batch in modest chunks — large symbol lists tend to 400 on this endpoint.
    const CHUNK = 25;
    for (let i = 0; i < valid.length; i += CHUNK) {
        const chunk = valid.slice(i, i + CHUNK);
        try {
            absorb(await schwabFetch(url(chunk), tokens));
        }
        catch (err) {
            console.warn(`[getFundamentals] Batch of ${chunk.length} failed, retrying individually:`, err);
            for (const sym of chunk) {
                try {
                    absorb(await schwabFetch(url([sym]), tokens));
                }
                catch (innerErr) {
                    console.error(`[getFundamentals] Failed to resolve fundamentals: ${sym}`, innerErr);
                }
            }
        }
    }
    return out;
}
/**
 * Daily candles for a symbol over a date band (inclusive), straight from
 * Schwab — first-party, authenticated, no third-party rate limits.
 * Index symbols use Schwab notation ($VIX.X, $SPX.X).
 */
async function getPriceHistory(tokens, symbol, fromDate, // YYYY-MM-DD
toDate) {
    const startDate = new Date(`${fromDate}T00:00:00.000Z`).getTime();
    const endDate = new Date(`${toDate}T23:59:59.000Z`).getTime();
    const tail = new URLSearchParams({
        periodType: 'month',
        frequencyType: 'daily',
        frequency: '1',
        startDate: String(startDate),
        endDate: String(endDate),
        needExtendedHoursData: 'false',
    }).toString();
    // Manual symbol interpolation — URLSearchParams encodes '$' which Schwab
    // rejects for index symbols (same constraint as getQuotes).
    const url = `${MARKET_BASE}/pricehistory?symbol=${symbol}&${tail}`;
    const json = await schwabFetch(url, tokens);
    return json.candles ?? [];
}
async function getOptionsChain(tokens, symbol, opts = {}) {
    const params = new URLSearchParams({
        symbol: symbol.toUpperCase(),
        contractType: opts.contractType ?? 'PUT',
        strikeCount: String(opts.strikeCount ?? 15),
        includeUnderlyingQuote: 'true',
        strategy: opts.strategy ?? 'SINGLE',
        ...(opts.fromDate ? { fromDate: opts.fromDate } : {}),
        ...(opts.toDate ? { toDate: opts.toDate } : {}),
        ...(opts.expMonth ? { expMonth: opts.expMonth } : {}),
    });
    return schwabFetch(`${MARKET_BASE}/chains?${params.toString()}`, tokens);
}
// ─── Transactions endpoint ────────────────────────────────────────────────────
/**
 * Schwab transaction types — pass exactly what you want. The original default
 * was `'DIVIDEND_OR_INTEREST'` which was a footgun: every caller that forgot
 * to pass `types` silently got dividend events only and missed trade fills.
 * No default now — callers must declare intent. Most common values:
 *   - `'TRADE'`                — equity/option fills (reconcile, history)
 *   - `'DIVIDEND_OR_INTEREST'` — distributions + margin interest (cashflow)
 *   - `'TRADE,DIVIDEND_OR_INTEREST'` — both
 */
async function getTransactions(tokens, accountHash, startDate, // ISO 8601 datetime e.g. 2025-04-15T00:00:00.000Z (bare YYYY-MM-DD is rejected by Schwab)
endDate, types) {
    const params = new URLSearchParams({ types, startDate, endDate });
    const url = `${TRADER_BASE}/accounts/${accountHash}/transactions?${params}`;
    console.log(`[getTransactions] URL: ${url}`);
    const result = await schwabFetch(url, tokens);
    // Log raw response shape to debug field name mismatches
    if (Array.isArray(result)) {
        console.log(`[getTransactions] Got ${result.length} transactions`);
        if (result.length > 0) {
            const sample = result[0];
            console.log(`[getTransactions] Sample keys: ${Object.keys(sample).join(', ')}`);
            console.log(`[getTransactions] Sample: ${JSON.stringify(sample).slice(0, 500)}`);
        }
    }
    else if (result && typeof result === 'object') {
        // Schwab may wrap transactions in an object
        console.log(`[getTransactions] Non-array response keys: ${Object.keys(result).join(', ')}`);
        console.log(`[getTransactions] Raw: ${JSON.stringify(result).slice(0, 500)}`);
    }
    else {
        console.log(`[getTransactions] Unexpected response type: ${typeof result}`, result);
    }
    return Array.isArray(result) ? result : [];
}
async function getUserPreference(tokens) {
    return schwabFetch(`${TRADER_BASE}/userPreference`, tokens);
}
// ─── Token-aware client factory ───────────────────────────────────────────────
/**
 * Build a client bound to stored tokens, auto-refreshing as needed.
 * Usage: const client = await createClient(); const accts = await client.getAllAccounts();
 */
async function createClient() {
    const tokens = await (0, storage_1.getTokens)();
    if (!tokens)
        throw new Error('NOT_AUTHENTICATED');
    return {
        getAccountNumbers: () => getAccountNumbers(tokens),
        getAllAccounts: () => getAllAccounts(tokens),
        getAccount: (hash) => getAccount(tokens, hash),
        getQuotes: (symbols) => getQuotes(tokens, symbols),
        getTransactions: (hash, start, end, types) => getTransactions(tokens, hash, start, end, types),
        getUserPreference: () => getUserPreference(tokens),
        getAccessToken: () => tokens.access_token,
    };
}
