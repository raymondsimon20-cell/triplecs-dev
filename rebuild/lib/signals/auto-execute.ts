/**
 * Auto-execution of low-risk signals, with daily trade-count and
 * exposure-shift caps. Every trade STILL passes guardrails independently —
 * autoExecutable flags from the engine are necessary but not sufficient.
 */
import { storage } from '@/lib/storage';
import { validateTrade } from '@/lib/guardrails';
import { buildEquityOrder, placeOrder } from '@/lib/schwab/orders';
import type { TradeSignal, EnginePosition, EngineBalances } from './types';
import { loadAutoConfig, getAutomationPause } from './auto-config';

interface DailyLedger {
  date: string;
  tradesExecuted: number;
  exposureShifted: number;
  executedSignalIds: string[];
}

const ledgerKey = (date: string) => `auto-ledger-${date}`;

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export interface AutoExecuteResult {
  executed: TradeSignal[];
  skipped: { signal: TradeSignal; reason: string }[];
}

export async function autoExecute(
  signals: TradeSignal[],
  positions: EnginePosition[],
  balances: EngineBalances,
  accountHash: string,
  quotes: Record<string, { last: number }>,
  today: string,
  dryRun = false
): Promise<AutoExecuteResult> {
  const result: AutoExecuteResult = { executed: [], skipped: [] };
  const cfg = await loadAutoConfig();
  const pause = await getAutomationPause();

  if (!cfg.enabled) {
    signals.forEach((s) => result.skipped.push({ signal: s, reason: 'automation disabled' }));
    return result;
  }
  if (pause.paused) {
    signals.forEach((s) => result.skipped.push({ signal: s, reason: `automation paused: ${pause.reason ?? ''}` }));
    return result;
  }

  const ledger: DailyLedger = (await storage.get<DailyLedger>(ledgerKey(today))) ?? {
    date: today,
    tradesExecuted: 0,
    exposureShifted: 0,
    executedSignalIds: [],
  };

  for (const sig of signals) {
    if (!sig.autoExecutable || !sig.trade) {
      result.skipped.push({ signal: sig, reason: 'not auto-executable' });
      continue;
    }
    if (SEVERITY_RANK[sig.severity] > SEVERITY_RANK[cfg.maxAutoSeverity]) {
      result.skipped.push({ signal: sig, reason: `severity ${sig.severity} above auto cap` });
      continue;
    }
    if (ledger.executedSignalIds.includes(sig.id)) {
      result.skipped.push({ signal: sig, reason: 'already executed (idempotency)' });
      continue;
    }
    if (ledger.tradesExecuted >= cfg.maxTradesPerDay) {
      result.skipped.push({ signal: sig, reason: 'daily trade-count cap reached' });
      continue;
    }
    if (ledger.exposureShifted + sig.trade.notional > cfg.maxExposureShiftPerDay) {
      result.skipped.push({ signal: sig, reason: 'daily exposure-shift cap reached' });
      continue;
    }

    // INDEPENDENT guardrail validation — mandatory, even for engine signals.
    const guard = validateTrade(sig.trade, positions, balances);
    if (!guard.allowed) {
      const failed = guard.checks.filter((c) => !c.passed).map((c) => c.detail).join(' ');
      result.skipped.push({ signal: sig, reason: `guardrails blocked: ${failed}` });
      continue;
    }

    const price = quotes[sig.trade.symbol]?.last;
    if (!price || price <= 0) {
      result.skipped.push({ signal: sig, reason: 'no quote available' });
      continue;
    }
    const quantity = Math.floor(sig.trade.notional / price);
    if (quantity < 1) {
      result.skipped.push({ signal: sig, reason: 'notional below one share' });
      continue;
    }

    if (!dryRun) {
      const order = buildEquityOrder({
        symbol: sig.trade.symbol,
        instruction: sig.trade.side === 'BUY' ? 'BUY' : 'SELL',
        quantity,
      });
      await placeOrder(accountHash, order);
    }
    ledger.tradesExecuted += 1;
    ledger.exposureShifted += sig.trade.notional;
    ledger.executedSignalIds.push(sig.id);
    result.executed.push(sig);
  }

  await storage.set(ledgerKey(today), ledger);
  return result;
}
