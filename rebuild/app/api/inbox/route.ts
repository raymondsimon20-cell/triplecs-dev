/** Trade inbox: daily-plan approval queue with one-click approve. */
import { NextRequest, NextResponse } from 'next/server';
import { loadDailyPlan, setApproval } from '@/lib/signals/daily-plan';
import { getAccount, getQuotes } from '@/lib/schwab/client';
import { validateTrade } from '@/lib/guardrails';
import { buildEquityOrder, placeOrder, precheckMarginCap } from '@/lib/schwab/orders';
import { toEngineInputs } from '@/lib/signals/run';

export const dynamic = 'force-dynamic';

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  return NextResponse.json(await loadDailyPlan(today));
}

/** Approve or reject a plan trade; approval executes (guardrail-gated). */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    signalId: string;
    decision: 'approved' | 'rejected';
    accountHash: string;
  };
  const today = new Date().toISOString().slice(0, 10);
  const plan = await setApproval(today, body.signalId, body.decision);
  if (!plan) return NextResponse.json({ error: 'No plan for today' }, { status: 404 });
  if (body.decision === 'rejected') return NextResponse.json({ ok: true, executed: false });

  const sig = plan.trades.find((s) => s.id === body.signalId);
  if (!sig?.trade) return NextResponse.json({ error: 'Signal has no trade' }, { status: 400 });

  try {
    const account = await getAccount(body.accountHash);
    const { positions, balances } = toEngineInputs(account, {}, 0, 0, today);

    // One-click approve is still guardrail-gated — no exceptions.
    const guard = validateTrade(sig.trade, positions, balances);
    if (!guard.allowed) {
      return NextResponse.json({ error: 'Blocked by guardrails', checks: guard.checks }, { status: 422 });
    }
    if (sig.trade.side === 'BUY') {
      const cap = precheckMarginCap(account, sig.trade.notional);
      if (!cap.ok) return NextResponse.json({ error: cap.reason }, { status: 422 });
    }

    const quotes = await getQuotes([sig.trade.symbol]);
    const price = quotes[sig.trade.symbol]?.last;
    if (!price) return NextResponse.json({ error: 'No quote' }, { status: 500 });
    const quantity = Math.floor(sig.trade.notional / price);
    if (quantity < 1) return NextResponse.json({ error: 'Notional below one share' }, { status: 400 });

    await placeOrder(
      body.accountHash,
      buildEquityOrder({
        symbol: sig.trade.symbol,
        instruction: sig.trade.side === 'BUY' ? 'BUY' : 'SELL',
        quantity,
      })
    );
    return NextResponse.json({ ok: true, executed: true, quantity });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
