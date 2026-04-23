/**
 * Synthetic snapshot backfill.
 *
 * Walks back from current portfolio state day-by-day, rewinding any trades
 * that happened *after* the target date, then prices the remaining symbols
 * at that date's EOD close. Snapshots produced this way are flagged
 * `synthetic: true` so the UI can dim them and `savePortfolioSnapshot`
 * never overwrites a real snapshot.
 *
 * Honest caveats (documented at the route level too):
 *  - Cash balance is not reconstructed; treated as constant from current state
 *  - Margin balance is null on synthetic days
 *  - Option positions are best-effort; corporate actions/assignments may break the rewind
 *  - Trades older than Schwab's transaction window aren't visible
 */

import { getStore } from '@netlify/blobs';
import { getAccountNumbers } from './schwab/client';
import { getTokens, savePortfolioSnapshot } from './storage';
import { fetchAccountState } from './portfolio/fetch';
import { getCloses } from './prices/historical';
import { classifySymbol } from './classify';
import type { TradeHistoryEntry } from '../app/api/orders/route';
import type { PortfolioSnapshot } from './storage';

interface PositionMap {
  [symbol: string]: { shares: number; pillar: string };
}

function shiftQuantity(map: PositionMap, symbol: string, instruction: TradeHistoryEntry['instruction'], qty: number) {
  const cur = map[symbol] ?? { shares: 0, pillar: classifySymbol(symbol) };
  const isBuy = instruction === 'BUY' || instruction === 'BUY_TO_OPEN' || instruction === 'BUY_TO_CLOSE';
  cur.shares += isBuy ? qty : -qty;
  map[symbol] = cur;
}

async function loadTradeHistory(): Promise<TradeHistoryEntry[]> {
  const store = getStore('trade-history');
  const log = await store.get('log', { type: 'json' }) as TradeHistoryEntry[] | null;
  return Array.isArray(log) ? log : [];
}

/**
 * Reconstruct the last `days` daily snapshots and persist them as synthetic.
 * Returns the count of new snapshots written.
 */
export async function backfillSnapshots(days: number): Promise<{ written: number; skipped: number; daysAttempted: number }> {
  const tokens = await getTokens();
  if (!tokens) throw new Error('NOT_AUTHENTICATED');

  // Build current position map across all accounts
  const accounts = await getAccountNumbers(tokens);
  const states   = await Promise.all(accounts.map(({ hashValue }) => fetchAccountState(hashValue)));
  const currentPositions: PositionMap = {};
  for (const s of states) {
    for (const p of s.positions) {
      const sym = p.instrument.symbol;
      // Skip option contracts — symbols contain spaces (e.g. "AAPL  240315C00150000")
      if (sym.includes(' ')) continue;
      const cur = currentPositions[sym] ?? { shares: 0, pillar: p.pillar };
      cur.shares += p.longQuantity;
      currentPositions[sym] = cur;
    }
  }

  // Trades sorted DESCENDING (newest first) — we rewind from the present
  const trades = (await loadTradeHistory())
    .filter((t) => t.status === 'placed')
    .filter((t) => !t.symbol.includes(' '))    // skip options for backfill
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const today = new Date();
  let written = 0;
  let skipped = 0;

  // Walk back day by day. We mutate `positionsAtT` as we encounter trades
  // that happened on dates we've already passed.
  const positionsAtT: PositionMap = JSON.parse(JSON.stringify(currentPositions));
  let tradeIdx = 0;

  for (let d = 1; d <= days; d++) {
    const target = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
    const dateStr = target.toISOString().slice(0, 10);

    // Skip weekends — markets closed, no meaningful close to capture.
    const dow = target.getUTCDay();
    if (dow === 0 || dow === 6) { skipped++; continue; }

    // Rewind any trades whose timestamp is strictly after this target date.
    // Since `trades` is sorted DESC, walk forward and consume.
    while (tradeIdx < trades.length && trades[tradeIdx].timestamp.slice(0, 10) > dateStr) {
      const t = trades[tradeIdx];
      // Reverse the trade: if it was a BUY after this date, we had FEWER shares before; subtract.
      // If it was a SELL after this date, we had MORE shares before; add.
      const isBuy = t.instruction === 'BUY' || t.instruction === 'BUY_TO_OPEN' || t.instruction === 'BUY_TO_CLOSE';
      shiftQuantity(positionsAtT, t.symbol, isBuy ? 'SELL' : 'BUY', t.quantity);
      tradeIdx++;
    }

    // Filter to symbols with non-zero shares at this date
    const symbols = Object.entries(positionsAtT)
      .filter(([, v]) => v.shares > 0)
      .map(([sym]) => sym);

    if (symbols.length === 0) { skipped++; continue; }

    // Fetch closes for these symbols + SPY in one call
    const allSymbols = Array.from(new Set([...symbols, 'SPY']));
    let closes: Record<string, number>;
    try {
      closes = await getCloses(allSymbols, dateStr);
    } catch (err) {
      console.warn(`[backfill] price fetch failed for ${dateStr}:`, err);
      skipped++;
      continue;
    }

    const spyClose = closes['SPY'];

    // Build position list with values
    const positions = symbols
      .map((sym) => {
        const close = closes[sym.toUpperCase()];
        if (close == null) return null;
        const shares = positionsAtT[sym].shares;
        const pillar = positionsAtT[sym].pillar ?? classifySymbol(sym);
        return {
          symbol: sym,
          pillar,
          marketValue: shares * close,
          shares,
          unrealizedGL: 0,        // not reconstructible without per-trade cost basis
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (positions.length === 0) { skipped++; continue; }

    const totalValue = positions.reduce((s, p) => s + p.marketValue, 0);

    // Pillar summary aggregated from positions
    const pillarMap = new Map<string, number>();
    for (const p of positions) {
      pillarMap.set(p.pillar, (pillarMap.get(p.pillar) ?? 0) + p.marketValue);
    }
    const pillarSummary = Array.from(pillarMap.entries()).map(([pillar, value]) => ({
      pillar,
      totalValue: value,
      portfolioPercent: totalValue > 0 ? (value / totalValue) * 100 : 0,
    }));

    const snapshot: PortfolioSnapshot = {
      // savedAt = end-of-day UTC for the target date so date-keying lines up
      savedAt: new Date(`${dateStr}T20:00:00.000Z`).getTime(),
      totalValue,
      equity: totalValue,                  // synthetic: cash + margin not reconstructed
      marginBalance: 0,
      marginUtilizationPct: 0,
      pillarSummary,
      positions,
      synthetic: true,
      ...(spyClose ? { spyClose } : {}),
    };

    await savePortfolioSnapshot(snapshot);
    written++;
  }

  return { written, skipped, daysAttempted: days };
}
