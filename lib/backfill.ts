/**
 * Synthetic snapshot backfill.
 *
 * Walks back from current portfolio state day-by-day, rewinding any trades
 * that happened *after* the target date, then prices the remaining symbols
 * at that date's EOD close. Snapshots produced this way are flagged
 * `synthetic: true` so the UI can dim them and `savePortfolioSnapshot`
 * never overwrites a real snapshot.
 *
 * 2026-05 — per-account backfill. We now track positions PER ACCOUNT so the
 * per-account performance panels have history before any live capture
 * accumulates. Trades that pre-date per-account tagging fall back to the
 * primary (first) account — best-effort, documented.
 *
 * Honest caveats (documented at the route level too):
 *  - Cash balance is not reconstructed; treated as constant from current state
 *  - Margin balance is null on synthetic days
 *  - Option positions are best-effort; corporate actions/assignments may break the rewind
 *  - Trades older than Schwab's transaction window aren't visible
 *  - Untagged historical trades (pre-2026-05) are attributed to the primary
 *    account, which can skew per-account history if you actually transacted
 *    in a different account at the time
 */

import { getStore } from '@netlify/blobs';
import { getAccountNumbers } from './schwab/client';
import { getTokens, savePortfolioSnapshot, savePerAccountSnapshot } from './storage';
import { fetchAccountState } from './portfolio/fetch';
import { getCloses } from './prices/historical';
import { classifySymbol } from './classify';
import type { TradeHistoryEntry } from '../app/api/orders/route';
import type { PortfolioSnapshot } from './storage';

interface PositionEntry { shares: number; pillar: string; }
type PositionMap = Record<string, PositionEntry>;

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

function buildSnapshotFromPositions(
  positionsAtT: PositionMap,
  closes: Record<string, number>,
  dateStr: string,
  spyClose?: number,
): PortfolioSnapshot | null {
  const symbols = Object.entries(positionsAtT)
    .filter(([, v]) => v.shares > 0)
    .map(([sym]) => sym);

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

  if (positions.length === 0) return null;

  const totalValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const pillarMap = new Map<string, number>();
  for (const p of positions) {
    pillarMap.set(p.pillar, (pillarMap.get(p.pillar) ?? 0) + p.marketValue);
  }
  const pillarSummary = Array.from(pillarMap.entries()).map(([pillar, value]) => ({
    pillar,
    totalValue: value,
    portfolioPercent: totalValue > 0 ? (value / totalValue) * 100 : 0,
  }));

  return {
    // savedAt = end-of-day UTC for the target date so date-keying lines up
    savedAt: new Date(`${dateStr}T20:00:00.000Z`).getTime(),
    totalValue,
    // Cash + borrowing can't be reconstructed from the trade log. NULL is
    // honest; the old `equity = totalValue, margin = 0` fabrication made
    // history overstate equity by the full margin debt and show a fake 0%
    // borrowing line, then cliff to reality when live snapshots began.
    equity: null,
    marginBalance: null,
    marginUtilizationPct: null,
    pillarSummary,
    positions,
    synthetic: true,
    ...(spyClose ? { spyClose } : {}),
  };
}

/**
 * Reconstruct the last `days` daily snapshots and persist them as synthetic.
 * Writes BOTH the household snapshot (legacy) AND a per-account snapshot for
 * every linked account. Returns the count of new snapshots written.
 */
export async function backfillSnapshots(days: number): Promise<{ written: number; skipped: number; daysAttempted: number }> {
  const tokens = await getTokens();
  if (!tokens) throw new Error('NOT_AUTHENTICATED');

  // Per-account position state at "now".
  const accounts = await getAccountNumbers(tokens);
  if (accounts.length === 0) throw new Error('No Schwab accounts');
  const primaryHash = accounts[0].hashValue;

  const states = await Promise.all(accounts.map(async ({ hashValue }) => ({
    hash:  hashValue,
    state: await fetchAccountState(hashValue),
  })));

  // currentPositions: union across all accounts (household)
  // perAccount[hash]: only that account's symbols
  const currentPositions: PositionMap = {};
  const perAccount: Record<string, PositionMap> = {};
  for (const { hash, state } of states) {
    const acctMap: PositionMap = {};
    for (const p of state.positions) {
      const sym = p.instrument.symbol;
      if (sym.includes(' ')) continue;     // skip option contracts
      // Household roll-up
      const householdCur = currentPositions[sym] ?? { shares: 0, pillar: p.pillar };
      householdCur.shares += p.longQuantity;
      currentPositions[sym] = householdCur;
      // Per-account slice
      const acctCur = acctMap[sym] ?? { shares: 0, pillar: p.pillar };
      acctCur.shares += p.longQuantity;
      acctMap[sym] = acctCur;
    }
    perAccount[hash] = acctMap;
  }

  // Trades sorted DESCENDING (newest first) — we rewind from the present.
  // Each trade is attributed to its accountHash; untagged legacy trades go
  // to the primary account (best-effort, documented caveat).
  const trades = (await loadTradeHistory())
    .filter((t) => t.status === 'placed')
    .filter((t) => !t.symbol.includes(' '))    // skip options for backfill
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const today = new Date();
  let written = 0;
  let skipped = 0;

  // Working state we mutate as we walk back.
  const householdPositionsAtT: PositionMap = JSON.parse(JSON.stringify(currentPositions));
  const perAccountAtT: Record<string, PositionMap> = JSON.parse(JSON.stringify(perAccount));
  let tradeIdx = 0;

  for (let d = 1; d <= days; d++) {
    const target = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
    const dateStr = target.toISOString().slice(0, 10);

    const dow = target.getUTCDay();
    if (dow === 0 || dow === 6) { skipped++; continue; }

    // Rewind trades after this target date.
    while (tradeIdx < trades.length && trades[tradeIdx].timestamp.slice(0, 10) > dateStr) {
      const t = trades[tradeIdx];
      const isBuy = t.instruction === 'BUY' || t.instruction === 'BUY_TO_OPEN' || t.instruction === 'BUY_TO_CLOSE';
      // Household level
      shiftQuantity(householdPositionsAtT, t.symbol, isBuy ? 'SELL' : 'BUY', t.quantity);
      // Account level — attribute to the trade's accountHash (or primary fallback).
      const tradeHash = t.accountHash || primaryHash;
      if (!perAccountAtT[tradeHash]) perAccountAtT[tradeHash] = {};
      shiftQuantity(perAccountAtT[tradeHash], t.symbol, isBuy ? 'SELL' : 'BUY', t.quantity);
      tradeIdx++;
    }

    // Symbols to price: union of household + every per-account map.
    const allSymbols = new Set<string>();
    for (const [, e] of Object.entries(householdPositionsAtT)) {
      // include only symbols that exist; pricing the household set covers
      // everything we'll need for the per-account passes too.
      void e; // silence unused-var lint
    }
    for (const sym of Object.keys(householdPositionsAtT)) {
      if ((householdPositionsAtT[sym]?.shares ?? 0) > 0) allSymbols.add(sym);
    }
    for (const acctMap of Object.values(perAccountAtT)) {
      for (const sym of Object.keys(acctMap)) {
        if ((acctMap[sym]?.shares ?? 0) > 0) allSymbols.add(sym);
      }
    }
    if (allSymbols.size === 0) { skipped++; continue; }
    allSymbols.add('SPY');

    let closes: Record<string, number>;
    try {
      closes = await getCloses(Array.from(allSymbols), dateStr);
    } catch (err) {
      console.warn(`[backfill] price fetch failed for ${dateStr}:`, err);
      skipped++;
      continue;
    }
    const spyClose = closes['SPY'];

    // Household snapshot (legacy).
    const householdSnap = buildSnapshotFromPositions(householdPositionsAtT, closes, dateStr, spyClose);
    if (householdSnap) {
      await savePortfolioSnapshot(householdSnap);
      written++;
    }

    // Per-account snapshots — synthetic days into account:{hash}:day-… keys.
    for (const [hash, acctMap] of Object.entries(perAccountAtT)) {
      const snap = buildSnapshotFromPositions(acctMap, closes, dateStr, spyClose);
      if (!snap) continue;
      await savePerAccountSnapshot(hash, snap);
    }
  }

  return { written, skipped, daysAttempted: days };
}
