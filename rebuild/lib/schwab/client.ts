/** Typed Schwab API wrapper: accounts, positions, quotes, options chains. */
import { getAccessToken } from './auth';
import type {
  SchwabAccount,
  SchwabAccountNumberHash,
  SchwabBalances,
  SchwabPosition,
  SchwabQuote,
  OptionChain,
} from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

async function schwabFetch<T>(url: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Schwab API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Account numbers + their hash values (all API calls use the hash). */
export async function getAccountNumbers(): Promise<SchwabAccountNumberHash[]> {
  return schwabFetch<SchwabAccountNumberHash[]>(`${TRADER_BASE}/accounts/accountNumbers`);
}

interface RawAccount {
  securitiesAccount: {
    accountNumber: string;
    type: string;
    positions?: SchwabPosition[];
    currentBalances: {
      liquidationValue: number;
      availableFunds: number; // AFW (Available For Withdrawal)
      marginBalance?: number;
      maintenanceRequirement?: number;
      buyingPower?: number;
      cashBalance?: number;
    };
  };
}

function normalizeAccount(raw: RawAccount, hashValue: string): SchwabAccount {
  const sa = raw.securitiesAccount;
  const balances: SchwabBalances = {
    liquidationValue: sa.currentBalances.liquidationValue,
    availableFunds: sa.currentBalances.availableFunds,
    marginBalance: sa.currentBalances.marginBalance ?? 0,
    maintenanceRequirement: sa.currentBalances.maintenanceRequirement ?? 0,
    buyingPower: sa.currentBalances.buyingPower,
    cashBalance: sa.currentBalances.cashBalance,
  };
  return {
    accountNumber: sa.accountNumber,
    hashValue,
    type: sa.type,
    positions: sa.positions ?? [],
    balances,
  };
}

/** All accounts with positions (multi-account support). */
export async function getAccounts(): Promise<SchwabAccount[]> {
  const hashes = await getAccountNumbers();
  const raw = await schwabFetch<RawAccount[]>(`${TRADER_BASE}/accounts?fields=positions`);
  return raw.map((r) => {
    const h = hashes.find((x) => x.accountNumber === r.securitiesAccount.accountNumber);
    return normalizeAccount(r, h?.hashValue ?? '');
  });
}

export async function getAccount(accountHash: string): Promise<SchwabAccount> {
  const raw = await schwabFetch<RawAccount>(
    `${TRADER_BASE}/accounts/${accountHash}?fields=positions`
  );
  return normalizeAccount(raw, accountHash);
}

/** Batched quotes. */
export async function getQuotes(symbols: string[]): Promise<Record<string, SchwabQuote>> {
  if (symbols.length === 0) return {};
  const raw = await schwabFetch<
    Record<string, { quote: { lastPrice: number; bidPrice: number; askPrice: number; netChange: number; netPercentChange: number; '52WeekHigh'?: number; '52WeekLow'?: number; totalVolume?: number } }>
  >(`${MARKET_BASE}/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
  const out: Record<string, SchwabQuote> = {};
  for (const [symbol, data] of Object.entries(raw)) {
    const q = data.quote;
    if (!q) continue;
    out[symbol] = {
      symbol,
      last: q.lastPrice,
      bid: q.bidPrice,
      ask: q.askPrice,
      netChange: q.netChange,
      netPercentChange: q.netPercentChange,
      high52Week: q['52WeekHigh'],
      low52Week: q['52WeekLow'],
      volume: q.totalVolume,
    };
  }
  return out;
}

/** Option chain (puts + calls) for a symbol. */
export async function getOptionChain(
  symbol: string,
  opts: { contractType?: 'PUT' | 'CALL' | 'ALL'; daysToExpiration?: number } = {}
): Promise<OptionChain> {
  const params = new URLSearchParams({
    symbol,
    contractType: opts.contractType ?? 'ALL',
    strategy: 'SINGLE',
  });
  return schwabFetch<OptionChain>(`${MARKET_BASE}/chains?${params}`);
}
