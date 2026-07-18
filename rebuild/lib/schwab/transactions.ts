/** Transaction history (trades, dividends/interest). */
import { getAccessToken } from './auth';
import type { SchwabTransaction } from './types';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

export async function getTransactions(
  accountHash: string,
  fromDate: string,
  toDate: string,
  types?: string
): Promise<SchwabTransaction[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    startDate: `${fromDate}T00:00:00.000Z`,
    endDate: `${toDate}T23:59:59.000Z`,
  });
  if (types) params.set('types', types);
  const res = await fetch(
    `${TRADER_BASE}/accounts/${accountHash}/transactions?${params}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`getTransactions failed ${res.status}`);
  return (await res.json()) as SchwabTransaction[];
}

/** Dividend/interest income over a window, grouped by symbol. */
export async function getDividendIncome(
  accountHash: string,
  fromDate: string,
  toDate: string
): Promise<{ total: number; bySymbol: Record<string, number> }> {
  const txns = await getTransactions(accountHash, fromDate, toDate, 'DIVIDEND_OR_INTEREST');
  const bySymbol: Record<string, number> = {};
  let total = 0;
  for (const t of txns) {
    total += t.netAmount;
    const sym = t.transferItems?.[0]?.instrument.symbol ?? 'OTHER';
    bySymbol[sym] = (bySymbol[sym] ?? 0) + t.netAmount;
  }
  return { total, bySymbol };
}
