/**
 * Schwab Trader API client
 * Wraps all API calls with automatic token refresh, retry with exponential
 * backoff, and error handling.
 */

import { refreshAccessToken, isAccessTokenExpired, isRefreshTokenExpired } from './auth';
import { getTokens, saveTokens } from '../storage';
import type {
  SchwabAccountNumberHash,
  SchwabAccountWrapper,
  SchwabQuotesResponse,
  SchwabTokens,
} from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

// ─── Retry configuration ─────────────────────────────────────────────────────

const MAX_RETRIES  = 3;
const BASE_DELAY   = 500;   // ms
const RETRYABLE    = new Set([408, 429, 500, 502, 503, 504]);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function schwabFetch<T>(
  url: string,
  tokens: SchwabTokens,
  options: RequestInit = {}
): Promise<T> {
  // Auto-refresh if the access token is stale
  let activeTokens = tokens;
  if (isAccessTokenExpired(tokens)) {
    if (isRefreshTokenExpired(tokens)) {
      throw new Error('REFRESH_TOKEN_EXPIRED');
    }
    activeTokens = await refreshAccessToken(tokens.refresh_token);
    await saveTokens(activeTokens);
  }

  let lastError: Error | null = null;

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
          activeTokens = await refreshAccessToken(activeTokens.refresh_token);
          await saveTokens(activeTokens);
          continue; // retry with fresh token
        } catch {
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
      if (response.status === 204) return undefined as T;

      return response.json() as Promise<T>;
    } catch (err) {
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
export async function getAccountNumbers(tokens: SchwabTokens): Promise<SchwabAccountNumberHash[]> {
  return schwabFetch<SchwabAccountNumberHash[]>(
    `${TRADER_BASE}/accounts/accountNumbers`,
    tokens
  );
}

/**
 * Returns all accounts with full positions and balances.
 * Pass `fields=positions` to include position data.
 */
export async function getAllAccounts(tokens: SchwabTokens): Promise<SchwabAccountWrapper[]> {
  return schwabFetch<SchwabAccountWrapper[]>(
    `${TRADER_BASE}/accounts?fields=positions`,
    tokens
  );
}

/**
 * Returns a single account by its hash value with positions and balances.
 */
export async function getAccount(
  tokens: SchwabTokens,
  accountHash: string
): Promise<SchwabAccountWrapper> {
  return schwabFetch<SchwabAccountWrapper>(
    `${TRADER_BASE}/accounts/${accountHash}?fields=positions`,
    tokens
  );
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
export async function getQuotes(
  tokens: SchwabTokens,
  symbols: string[]
): Promise<SchwabQuotesResponse> {
  if (symbols.length === 0) return {};

  // Filter out obviously invalid symbols (empty, whitespace-only, too long)
  const validSymbols = symbols.filter(
    (s) => s && s.trim().length > 0 && s.trim().length <= 20
  );
  if (validSymbols.length === 0) return {};

  // Build query string manually — URLSearchParams encodes '$' as '%24' which
  // Schwab rejects for index symbols like $VIX.X, $SPX.X, $NDX.X.
  function buildQuoteUrl(syms: string[]): string {
    const tail = new URLSearchParams({ fields: 'quote,reference', indicative: 'false' }).toString();
    return `${MARKET_BASE}/quotes?symbols=${syms.join(',')}&${tail}`;
  }

  try {
    return await schwabFetch<SchwabQuotesResponse>(buildQuoteUrl(validSymbols), tokens);
  } catch (err) {
    console.warn('[getQuotes] Batch request failed, falling back to individual symbol fetches:', err);
    const result: SchwabQuotesResponse = {};

    for (const sym of validSymbols) {
      try {
        const single = await schwabFetch<SchwabQuotesResponse>(buildQuoteUrl([sym]), tokens);
        Object.assign(result, single);
      } catch {
        console.warn(`[getQuotes] Skipping unresolvable symbol: ${sym}`);
      }
    }
    return result;
  }
}

// ─── Options chain endpoint ───────────────────────────────────────────────────

export interface OptionsChainParams {
  contractType?: 'CALL' | 'PUT' | 'ALL';
  strikeCount?: number;       // number of strikes above/below ATM
  strategy?: 'SINGLE' | 'ANALYTICAL';
  fromDate?: string;          // YYYY-MM-DD
  toDate?: string;
  expMonth?: string;          // ALL, JAN…DEC
}

export async function getOptionsChain(
  tokens: SchwabTokens,
  symbol: string,
  opts: OptionsChainParams = {}
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    symbol:                     symbol.toUpperCase(),
    contractType:               opts.contractType ?? 'PUT',
    strikeCount:                String(opts.strikeCount ?? 15),
    includeUnderlyingQuote:     'true',
    strategy:                   opts.strategy ?? 'SINGLE',
    ...(opts.fromDate ? { fromDate: opts.fromDate } : {}),
    ...(opts.toDate   ? { toDate:   opts.toDate   } : {}),
    ...(opts.expMonth ? { expMonth: opts.expMonth } : {}),
  });
  return schwabFetch<Record<string, unknown>>(
    `${MARKET_BASE}/chains?${params.toString()}`,
    tokens
  );
}

// ─── Transactions endpoint ────────────────────────────────────────────────────

export async function getTransactions(
  tokens: SchwabTokens,
  accountHash: string,
  startDate: string, // ISO 8601 datetime e.g. 2025-04-15T00:00:00.000Z (bare YYYY-MM-DD is rejected by Schwab)
  endDate: string,
  types = 'DIVIDEND_OR_INTEREST',
): Promise<import('./types').SchwabTransaction[]> {
  const params = new URLSearchParams({ types, startDate, endDate });
  const url = `${TRADER_BASE}/accounts/${accountHash}/transactions?${params}`;
  console.log(`[getTransactions] URL: ${url}`);
  const result = await schwabFetch<unknown>(url, tokens);

  // Log raw response shape to debug field name mismatches
  if (Array.isArray(result)) {
    console.log(`[getTransactions] Got ${result.length} transactions`);
    if (result.length > 0) {
      const sample = result[0];
      console.log(`[getTransactions] Sample keys: ${Object.keys(sample).join(', ')}`);
      console.log(`[getTransactions] Sample: ${JSON.stringify(sample).slice(0, 500)}`);
    }
  } else if (result && typeof result === 'object') {
    // Schwab may wrap transactions in an object
    console.log(`[getTransactions] Non-array response keys: ${Object.keys(result as Record<string, unknown>).join(', ')}`);
    console.log(`[getTransactions] Raw: ${JSON.stringify(result).slice(0, 500)}`);
  } else {
    console.log(`[getTransactions] Unexpected response type: ${typeof result}`, result);
  }

  return Array.isArray(result) ? (result as import('./types').SchwabTransaction[]) : [];
}

// ─── User Preference / Streamer Info ─────────────────────────────────────────

export interface StreamerInfo {
  streamerSocketUrl:          string;
  schwabClientCustomerId:     string;
  schwabClientCorrelId:       string;
  schwabClientChannel:        string;
  schwabClientFunctionId:     string;
}

export interface UserPreference {
  streamerInfo: StreamerInfo[];
}

export async function getUserPreference(tokens: SchwabTokens): Promise<UserPreference> {
  return schwabFetch<UserPreference>(`${TRADER_BASE}/userPreference`, tokens);
}

// ─── Token-aware client factory ───────────────────────────────────────────────

/**
 * Build a client bound to stored tokens, auto-refreshing as needed.
 * Usage: const client = await createClient(); const accts = await client.getAllAccounts();
 */
export async function createClient() {
  const tokens = await getTokens();
  if (!tokens) throw new Error('NOT_AUTHENTICATED');

  return {
    getAccountNumbers: () => getAccountNumbers(tokens),
    getAllAccounts: () => getAllAccounts(tokens),
    getAccount: (hash: string) => getAccount(tokens, hash),
    getQuotes: (symbols: string[]) => getQuotes(tokens, symbols),
    getTransactions: (hash: string, start: string, end: string, types?: string) =>
      getTransactions(tokens, hash, start, end, types),
    getUserPreference: () => getUserPreference(tokens),
    getAccessToken: () => tokens.access_token,
  };
}
