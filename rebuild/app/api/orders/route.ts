import { NextRequest, NextResponse } from 'next/server';
import { getAccount } from '@/lib/schwab/client';
import { buildEquityOrder, placeOrder, getOrders, precheckMarginCap } from '@/lib/schwab/orders';
import { validateTrade } from '@/lib/guardrails';
import { toEngineInputs } from '@/lib/signals/run';
import type { ProposedTrade } from '@/lib/signals/types';
import { classify } from '@/lib/classify';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const accountHash = req.nextUrl.searchParams.get('account');
  if (!accountHash) return NextResponse.json({ error: 'account required' }, { status: 400 });
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  try {
    return NextResponse.json(await getOrders(accountHash, from, to));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * Place an order. EVERY order — manual, AI-suggested, or one-click from the
 * inbox — passes guardrails + the Schwab 50% margin-cap precheck here.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    accountHash: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    limitPrice?: number;
    price: number; // reference price for notional calc
  };
  try {
    const account = await getAccount(body.accountHash);
    const { positions, balances } = toEngineInputs(account, {}, 0, 0, '');
    const notional = body.quantity * body.price;

    const trade: ProposedTrade = {
      symbol: body.symbol,
      side: body.side,
      notional,
      quantity: body.quantity,
      pillar: classify(body.symbol),
    };
    const guard = validateTrade(trade, positions, balances);
    if (!guard.allowed) {
      return NextResponse.json({ error: 'Blocked by guardrails', checks: guard.checks }, { status: 422 });
    }
    if (body.side === 'BUY') {
      const cap = precheckMarginCap(account, notional);
      if (!cap.ok) return NextResponse.json({ error: cap.reason }, { status: 422 });
    }

    await placeOrder(
      body.accountHash,
      buildEquityOrder({
        symbol: body.symbol,
        instruction: body.side,
        quantity: body.quantity,
        limitPrice: body.limitPrice,
      })
    );
    return NextResponse.json({ ok: true, checks: guard.checks });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
