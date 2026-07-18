/** Cost-basis reconstruction from transaction history (FIFO lots). */
import type { SchwabTransaction, CostBasisLot } from './types';

export function buildLots(transactions: SchwabTransaction[]): Record<string, CostBasisLot[]> {
  const lots: Record<string, CostBasisLot[]> = {};
  const sorted = [...transactions].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
  for (const t of sorted) {
    if (t.type !== 'TRADE') continue;
    for (const item of t.transferItems ?? []) {
      if (item.instrument.assetType !== 'EQUITY' && item.instrument.assetType !== 'COLLECTIVE_INVESTMENT') continue;
      const sym = item.instrument.symbol;
      lots[sym] ??= [];
      if (item.amount > 0) {
        lots[sym].push({
          symbol: sym,
          quantity: item.amount,
          price: item.price ?? (item.cost !== 0 ? Math.abs(item.cost / item.amount) : 0),
          acquiredDate: t.time,
        });
      } else if (item.amount < 0) {
        // FIFO sell
        let remaining = -item.amount;
        while (remaining > 0 && lots[sym].length > 0) {
          const lot = lots[sym][0];
          if (lot.quantity <= remaining) {
            remaining -= lot.quantity;
            lots[sym].shift();
          } else {
            lot.quantity -= remaining;
            remaining = 0;
          }
        }
      }
    }
  }
  return lots;
}

export function averageCost(lots: CostBasisLot[]): number {
  const qty = lots.reduce((s, l) => s + l.quantity, 0);
  if (qty === 0) return 0;
  return lots.reduce((s, l) => s + l.quantity * l.price, 0) / qty;
}
