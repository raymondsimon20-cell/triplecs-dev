/**
 * Schwab Trader API client
 * Wraps all API calls with automatic token refresh and error handling.
 */

import { refreshAccessToken, isAccessTokenExpired } from './auth';
import { getTokens, saveTokens } from '../storage';
import type {
  SchwabAccountNumberHash,
  SchwabAccountWrapper,
  SchwabQuotesResponse,
  SchwabTokens,
} from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function schwabFetch<T>(
  url: string,
  tokens: SchwabTokens,
  options: RequestInit = {}
): Promise<T> {
  // Auto-refresh if the access token is stale
  let activeTokens = tokens;
  if (isAccessTokenExpired(tokens)) {
    activeTokens = await refreshAccessToken(tokens.refresh_token);
    await saveTokens(activeTokens);
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${activeTokens.access_token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Schwab API error ${response.status}: ${body}`);
  }

  // 204 No Content
  if (response.status === 204) return undefined as T;

  return response.json() as Promise<T>;
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
 */
export async function getQuotes(
  tokens: SchwabTokens,
  symbols: string[]
): Promise<SchwabQuotesResponse> {
  if (symbols.length === 0) return {};

  const params = new URLSearchParams({
    symbols: symbols.join(','),
    fields: 'quote,reference',
    indicative: 'false',
  });

  return schwabFetch<SchwabQuotesResponse>(
    `${MARKET_BASE}/quotes?${params.toString()}`,
    tokens
  );
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
  const result = await schwabFetch<import('./types').SchwabTransaction[]>(
    `${TRADER_BASE}/accounts/${accountHash}/transactions?${params}`,
    tokens,
  );
  return Array.isArray(result) ? result : [];
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
    getTransactions: (hash: string, start: string, end: string) =>
      getTransactions(tokens, hash, start, end),
  };
}
