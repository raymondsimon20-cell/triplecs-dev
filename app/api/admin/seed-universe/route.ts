/**
 * Admin endpoint — one-shot "seed the fund universe" tool.
 *
 *   POST /api/admin/seed-universe
 *   body: { accountHash: string; dryRun?: boolean }
 *
 * What it does:
 *   1. Reads every symbol in lib/data/fund-metadata.ts (full 185-name
 *      universe — not just the AI-curated subset).
 *   2. Fetches the target account's current positions and filters out any
 *      symbol you already hold (longQuantity > 0). You only need ONE share,
 *      and existing holdings already satisfy that.
 *   3. Pulls a live quote per remaining symbol so each staged row has a real
 *      price and dollar-cost estimate. Symbols without a quote are skipped.
 *   4. Compares the total BUY cost against your available cash (AFW dollars
 *      when present, raw cash balance otherwise). If there's a shortfall,
 *      generates SELL proposals against your largest existing positions —
 *      enough to cover the gap plus a 5% slippage buffer. Every SELL respects
 *      the keep-one-share rule: max shares = currentShares - 1, and we never
 *      sell a 1-share position.
 *   5. Stages every BUY and SELL into the trade inbox with `source:
 *      'seed-universe'` and `tier: 'approval'`. They appear in the Trade
 *      Inbox panel where you Approve all (or dismiss individually).
 *
 * Why a separate source: distinguishes these from engine-driven signals so
 * the cross-source dedup window in appendInbox doesn't treat a normal "BUY
 * GOF" recommendation as the same as the seed row. Also makes them easy to
 * spot in the inbox UI.
 *
 * Dry-run mode (`dryRun: true`) returns the full proposed plan + estimated
 * cost + estimated SELL proceeds without writing anything. Run this first.
 *
 * Auth-gated (requireAuth) — only the logged-in user can call this.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getQuotes } from '@/lib/schwab/client';
import { fetchAccountState } from '@/lib/portfolio/fetch';
import { appendInbox, type AppendInput } from '@/lib/inbox';
import { listAllSymbols } from '@/lib/data/fund-metadata';

export const dynamic = 'force-dynamic';

/** Slippage cushion on the funding shortfall — sells aim for 5% more than
 *  the BUY total so a few unfavourable fills don't leave the account short. */
const SHORTFALL_BUFFER = 1.05;

/** Per-position trim ceiling on a single seed run — never trim more than
 *  this fraction of a position's market value in one shot, even if the
 *  shortfall would justify going bigger. Keeps the seed from accidentally
 *  flattening any one holding. */
const MAX_TRIM_FRACTION_PER_POSITION = 0.5;

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

interface SeedBuyRow {
  symbol:        string;
  price:         number;
  estimatedCost: number;
}

interface SeedSellRow {
  symbol:           string;
  price:            number;
  currentShares:    number;
  sharesToSell:     number;
  estimatedProceeds: number;
}

interface SeedResponse {
  accountHash:           string;
  dryRun:                boolean;
  universeCount:         number;
  alreadyHeldCount:      number;
  alreadyHeldSymbols:    string[];
  /** Symbols Schwab didn't return a quote for — skipped. */
  noQuoteCount:          number;
  noQuoteSymbols:        string[];
  plannedBuyCount:       number;
  plannedBuys:           SeedBuyRow[];
  estimatedBuyCost:      number;
  /** Cash position before any sells fire — AFW (preferred) or raw cash. */
  availableCashBefore:   number;
  /** Funding shortfall after subtracting available cash from BUY cost. */
  shortfall:             number;
  /** Sell plan generated to cover the shortfall. Empty when cash covers buys. */
  plannedSellCount:      number;
  plannedSells:          SeedSellRow[];
  estimatedSellProceeds: number;
  /** Whether the sells fully cover the shortfall + buffer. */
  fullyFunded:           boolean;
  /** Notes about positions we couldn't tap (e.g. 1-share holdings). */
  unsellableNotes:       string[];
  /** Inbox items actually written. Empty array in dryRun mode. */
  stagedCount:           number;
  stagedIds:             string[];
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  let body: { accountHash?: unknown; dryRun?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const accountHash = typeof body.accountHash === 'string' && body.accountHash.length > 0
    ? body.accountHash
    : null;
  if (!accountHash) {
    return NextResponse.json(
      { error: 'accountHash is required (the Schwab account hash to seed)' },
      { status: 400 },
    );
  }
  const dryRun = body.dryRun === true;

  try {
    // 1. Current positions + cash for the target account.
    const state = await fetchAccountState(accountHash);
    const heldBySymbol = new Map<string, { shares: number; marketValue: number }>();
    for (const p of state.positions) {
      if (p.longQuantity > 0) {
        const existing = heldBySymbol.get(p.instrument.symbol);
        const shares = (existing?.shares ?? 0) + p.longQuantity;
        const mv     = (existing?.marketValue ?? 0) + p.currentValue;
        heldBySymbol.set(p.instrument.symbol, { shares, marketValue: mv });
      }
    }
    const heldSymbols = new Set(heldBySymbol.keys());

    // Available cash — prefer AFW (true buying power including margin
    // headroom) but fall back to raw equity if Schwab didn't return AFW.
    const availableCashBefore = state.afwDollars > 0
      ? state.afwDollars
      : Math.max(0, state.equity - state.marginBalance);

    // 2. Full universe → strip what's already held.
    const universe   = listAllSymbols();
    const candidates = universe.filter((s) => !heldSymbols.has(s));

    // 3. Batch-fetch quotes for both candidates AND held positions (held
    //    quotes are needed to size SELL shares from dollar amounts).
    const tokens = await getTokens();
    if (!tokens) {
      return NextResponse.json({ error: 'Schwab not authenticated' }, { status: 401 });
    }
    const symbolsToPrice = Array.from(new Set([
      ...candidates,
      ...heldBySymbol.keys(),
    ]));
    const BATCH  = 50;
    const prices: Record<string, number> = {};
    for (let i = 0; i < symbolsToPrice.length; i += BATCH) {
      const chunk = symbolsToPrice.slice(i, i + BATCH);
      try {
        const result = await getQuotes(tokens, chunk);
        for (const sym of chunk) {
          const p = result[sym]?.quote?.lastPrice;
          if (typeof p === 'number' && p > 0) prices[sym] = p;
        }
      } catch (err) {
        console.warn('[seed-universe] quote batch failed:', err);
      }
    }

    // 4. BUY plan — one share per quoteable candidate.
    const plannedBuys: SeedBuyRow[] = [];
    const noQuote: string[] = [];
    for (const symbol of candidates) {
      const price = prices[symbol];
      if (typeof price === 'number' && price > 0) {
        plannedBuys.push({ symbol, price, estimatedCost: price });
      } else {
        noQuote.push(symbol);
      }
    }
    const estimatedBuyCost = plannedBuys.reduce((s, r) => s + r.estimatedCost, 0);

    // 5. Shortfall + SELL plan. Only sell if the BUY total exceeds cash;
    //    otherwise the SELL section stays empty.
    const fundingTarget = estimatedBuyCost * SHORTFALL_BUFFER;
    const shortfall     = Math.max(0, fundingTarget - availableCashBefore);

    const plannedSells: SeedSellRow[] = [];
    const unsellable:   string[] = [];
    let estimatedSellProceeds = 0;

    if (shortfall > 0) {
      // Sort holdings by market value descending — trim the heaviest first,
      // which leaves the smallest positions intact and keeps the keep-one-
      // share rule from biting on tiny holdings unnecessarily.
      const heldList = [...heldBySymbol.entries()]
        .map(([symbol, info]) => ({ symbol, ...info, price: prices[symbol] ?? 0 }))
        .sort((a, b) => b.marketValue - a.marketValue);

      let remaining = shortfall;
      for (const h of heldList) {
        if (remaining <= 0) break;
        if (h.price <= 0) {
          unsellable.push(`${h.symbol}: no live quote`);
          continue;
        }
        if (h.shares < 2) {
          unsellable.push(`${h.symbol}: only ${h.shares} share held (keep-one-share rule)`);
          continue;
        }
        const positionTrimCap = h.marketValue * MAX_TRIM_FRACTION_PER_POSITION;
        const dollarsToSell   = Math.min(remaining, positionTrimCap);
        const sharesByDollars = Math.floor(dollarsToSell / h.price);
        // keep-one-share clamp — never sell more than (currentShares - 1).
        const sharesToSell    = Math.min(sharesByDollars, h.shares - 1);
        if (sharesToSell <= 0) continue;
        const proceeds = sharesToSell * h.price;
        plannedSells.push({
          symbol:            h.symbol,
          price:             h.price,
          currentShares:     h.shares,
          sharesToSell,
          estimatedProceeds: proceeds,
        });
        estimatedSellProceeds += proceeds;
        remaining             -= proceeds;
      }
    }

    const fullyFunded =
      shortfall === 0 ||
      availableCashBefore + estimatedSellProceeds >= fundingTarget;

    const baseResponse: SeedResponse = {
      accountHash,
      dryRun,
      universeCount:         universe.length,
      alreadyHeldCount:      heldSymbols.size,
      alreadyHeldSymbols:    [...heldSymbols].sort(),
      noQuoteCount:          noQuote.length,
      noQuoteSymbols:        noQuote.sort(),
      plannedBuyCount:       plannedBuys.length,
      plannedBuys,
      estimatedBuyCost,
      availableCashBefore,
      shortfall,
      plannedSellCount:      plannedSells.length,
      plannedSells,
      estimatedSellProceeds,
      fullyFunded,
      unsellableNotes:       unsellable,
      stagedCount:           0,
      stagedIds:             [],
    };

    if (dryRun) {
      return NextResponse.json(baseResponse);
    }

    // 6. Stage both BUYs and SELLs in one batch so cross-source dedup sees
    //    the whole set together. Ordering doesn't matter for the inbox; the
    //    user will Approve from the inbox panel which submits sequentially.
    const items: AppendInput[] = [
      ...plannedSells.map((r): AppendInput => ({
        source:      'seed-universe',
        symbol:      r.symbol,
        instruction: 'SELL',
        quantity:    r.sharesToSell,
        orderType:   'MARKET',
        price:       r.price,
        rationale:
          `[SEED_UNIVERSE] Trim ${r.sharesToSell} of ${r.currentShares} ` +
          `${r.symbol} to fund one-time universe seed (~$${r.estimatedProceeds.toFixed(0)}).`,
        aiMode:      'seed_universe',
        violations:  [],
        tier:        'approval',
        accountHash,
      })),
      ...plannedBuys.map((r): AppendInput => ({
        source:      'seed-universe',
        symbol:      r.symbol,
        instruction: 'BUY',
        quantity:    1,
        orderType:   'MARKET',
        price:       r.price,
        rationale:
          `[SEED_UNIVERSE] Hold at least one share of every fund in the universe ` +
          `(one-time seed, est ~$${r.estimatedCost.toFixed(0)}).`,
        aiMode:      'seed_universe',
        violations:  [],
        tier:        'approval',
        accountHash,
      })),
    ];

    const staged = items.length > 0 ? await appendInbox(items) : [];
    return NextResponse.json({
      ...baseResponse,
      stagedCount: staged.length,
      stagedIds:   staged.map((it) => it.id),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[seed-universe] failed:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
