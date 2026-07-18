/** Claude analysis of the live portfolio against the strategy rules. */
import { NextRequest, NextResponse } from 'next/server';
import { getAccounts } from '@/lib/schwab/client';
import { pillarBreakdown } from '@/lib/classify';
import { analyze } from '@/lib/ai/prompt-cache';
import { buildFeedbackContext } from '@/lib/ai/feedback-context';
import { buildPaceContext } from '@/lib/ai/pace-context';
import { buildRecapContext } from '@/lib/ai/recap-loader';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { question = 'Give a full portfolio health analysis against the strategy rules.' } =
    (await req.json().catch(() => ({}))) as { question?: string };
  try {
    const accounts = await getAccounts();
    const account = accounts[0];
    if (!account) return NextResponse.json({ error: 'No account' }, { status: 400 });

    const portfolio = {
      balances: account.balances,
      pillars: pillarBreakdown(
        account.positions.map((p) => ({
          symbol: p.instrument.symbol,
          marketValue: p.marketValue,
          putCall: p.instrument.putCall,
        })),
        account.balances.cashBalance ?? 0
      ),
      positions: account.positions.map((p) => ({
        symbol: p.instrument.symbol,
        marketValue: p.marketValue,
        qty: p.longQuantity - p.shortQuantity,
      })),
    };

    const extraContext = [await buildPaceContext(), await buildRecapContext(), await buildFeedbackContext()]
      .filter(Boolean)
      .join('\n');

    const text = await analyze(JSON.stringify(portfolio, null, 2), question, extraContext);
    return NextResponse.json({ analysis: text });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
