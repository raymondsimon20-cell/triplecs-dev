import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getCachedPortfolio, cachePortfolio } from '@/lib/storage';
import { enrichPositions, summarizeByPillar, checkMarginRules } from '@/lib/classify';
import type { SchwabAccountWrapper } from '@/lib/schwab/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountHash = searchParams.get('hash');

  try {
    const client = await createClient();

    // Get all accounts or a specific one
    let accounts: SchwabAccountWrapper[];
    if (accountHash) {
      const single = await client.getAccount(accountHash);
      accounts = [single];
    } else {
      accounts = await client.getAllAccounts();
    }

    // Enrich each account with classification, quotes, and rule checks
    const enriched = await Promise.all(
      accounts.map(async ({ securitiesAccount: acct }) => {
        // Check cache first
        const cached = await getCachedPortfolio(acct.accountNumber);
        if (cached) return cached;

        // Collect all symbols for quote fetch
        const symbols = acct.positions
          .map((p) => p.instrument.symbol)
          .filter((s) => !s.includes(' ')); // skip options for now

        const quotes = symbols.length > 0
          ? await client.getQuotes(symbols)
          : {};

        const totalValue = acct.currentBalances.liquidationValue;

        const enrichedPositions = enrichPositions(
          acct.positions,
          quotes,
          totalValue,
        );

        const pillarSummary = summarizeByPillar(enrichedPositions, totalValue);

        const marginAlerts = checkMarginRules(
          acct.currentBalances.equity,
          acct.currentBalances.marginBalance ?? 0,
          enrichedPositions,
        );

        const result = {
          accountNumber: acct.accountNumber,
          type: acct.type,
          totalValue,
          equity: acct.currentBalances.equity,
          marginBalance: acct.currentBalances.marginBalance ?? 0,
          buyingPower: acct.currentBalances.buyingPower,
          dayGainLoss: enrichedPositions.reduce(
            (sum, p) => sum + (p.currentDayProfitLoss ?? 0), 0
          ),
          positions: enrichedPositions,
          pillarSummary,
          marginAlerts,
          balances: acct.currentBalances,
        };

        // Cache for 60 seconds
        await cachePortfolio(acct.accountNumber, result);
        return result;
      })
    );

    return NextResponse.json({ accounts: enriched });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'NOT_AUTHENTICATED') {
      return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('Accounts API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
