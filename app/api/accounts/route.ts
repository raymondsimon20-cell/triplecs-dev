import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient, getAccountNumbers } from '@/lib/schwab/client';
import { getCachedPortfolio, cachePortfolio, getTokens, savePortfolioSnapshot } from '@/lib/storage';
import { enrichPositions, summarizeByPillar, checkMarginRules, getTaxHarvestCandidates } from '@/lib/classify';
import { buildSnapshot } from '@/lib/portfolio/fetch';
import type { SchwabAccountWrapper } from '@/lib/schwab/types';

export const dynamic = 'force-dynamic';

// ─── Per-account lock to prevent concurrent fetches for the same account ──────
const _inflightFetches = new Map<string, Promise<unknown>>();

function withAccountLock<T>(accountNumber: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflightFetches.get(accountNumber);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => {
    _inflightFetches.delete(accountNumber);
  });
  _inflightFetches.set(accountNumber, promise);
  return promise;
}

export async function GET(req: Request) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHash = searchParams.get('hash');

  try {
    const client  = await createClient();
    const tokens  = await getTokens();

    // Build a map of accountNumber → hashValue so we can attach it to results
    const accountNumMap: Record<string, string> = {};
    if (tokens) {
      const nums = await getAccountNumbers(tokens);
      for (const { accountNumber, hashValue } of nums) {
        accountNumMap[accountNumber] = hashValue;
      }
    }

    // Get all accounts or a specific one
    let accounts: SchwabAccountWrapper[];
    if (accountHash) {
      const single = await client.getAccount(accountHash);
      accounts = [single];
    } else {
      accounts = await client.getAllAccounts();
    }

    // Guard: Schwab should return an array
    if (!Array.isArray(accounts)) {
      console.error('Unexpected Schwab accounts response:', accounts);
      return NextResponse.json({ error: `Unexpected Schwab response: ${JSON.stringify(accounts)}` }, { status: 500 });
    }

    // Enrich each account with classification, quotes, and rule checks
    // withAccountLock prevents duplicate concurrent fetches for the same account
    const enriched = await Promise.all(
      accounts.map(({ securitiesAccount: acct }) =>
        withAccountLock(acct.accountNumber, async () => {
        // Check cache first
        const cached = await getCachedPortfolio(acct.accountNumber);
        if (cached) return cached;

        // Schwab omits `positions` when account has none — default to []
        const positions = acct.positions ?? [];

        // Collect all symbols for quote fetch
        const symbols = positions
          .map((p) => p.instrument.symbol)
          .filter((s) => !s.includes(' ')); // skip options for now

        const quotes = symbols.length > 0
          ? await client.getQuotes(symbols)
          : {};

        // Use gross market value (longs + shorts) so pillar % are based on
        // total position exposure, not net equity. liquidationValue is net of
        // margin debt and causes pillars to sum to >100% in margin accounts.
        const totalValue =
          (acct.currentBalances.longMarketValue ?? 0) +
          Math.abs(acct.currentBalances.shortMarketValue ?? 0);

        const enrichedPositions = enrichPositions(
          positions,
          quotes,
          totalValue,
        );

        const pillarSummary = summarizeByPillar(enrichedPositions, totalValue);

        const marginAlerts = checkMarginRules(
          acct.currentBalances.equity,
          acct.currentBalances.marginBalance ?? 0,
          enrichedPositions,
        );

        // Day gain/loss: sum quote-computed todayGainLoss across positions
        const dayGainLoss = enrichedPositions.reduce(
          (sum, p) => sum + (p.todayGainLoss ?? 0), 0
        );

        // Unrealized gain/loss across all positions
        const unrealizedGainLoss = enrichedPositions.reduce(
          (sum, p) => sum + p.gainLoss, 0
        );

        // Available for withdrawal = cash + money market (dividends land here)
        const availableForWithdrawal =
          (acct.currentBalances.cashBalance ?? 0) +
          (acct.currentBalances.moneyMarketFund ?? 0);

        const taxHarvestCandidates = getTaxHarvestCandidates(enrichedPositions);

        const result = {
          accountNumber: acct.accountNumber,
          accountHash:   accountNumMap[acct.accountNumber] ?? '',
          type: acct.type,
          totalValue,
          equity: acct.currentBalances.equity,
          marginBalance: acct.currentBalances.marginBalance ?? 0,
          buyingPower: acct.currentBalances.buyingPower,
          dayGainLoss,
          unrealizedGainLoss,
          availableForWithdrawal,
          positions: enrichedPositions,
          pillarSummary,
          marginAlerts,
          taxHarvestCandidates,
          balances: acct.currentBalances,
        };

        // Cache for 60 seconds
        await cachePortfolio(acct.accountNumber, result);

        // Persist snapshot for AI history and proactive alerts (fire-and-forget)
        const marginBal = Math.abs(acct.currentBalances.marginBalance ?? 0);
        savePortfolioSnapshot(buildSnapshot([{
          accountNumber: acct.accountNumber,
          totalValue,
          equity: acct.currentBalances.equity,
          marginBalance: marginBal,
          marginUtilizationPct: totalValue > 0 ? (marginBal / totalValue) * 100 : 0,
          // AFW = Available For Withdrawal. Captured in snapshots so backtest
          // / replay paths can eventually gate on true historical headroom.
          afwDollars: acct.currentBalances.availableFunds ?? 0,
          pillarSummary,
          positions: enrichedPositions,
        }])).catch((e) => console.warn('[snapshot] save failed:', e));

        return result;
      }))
    );

    return NextResponse.json({ accounts: enriched });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });
    }
    console.error('Accounts API error:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
