import type { Pillar } from '@/lib/data/fund-metadata';

export type SignalCategory = 'trade' | 'alert' | 'info';
export type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';

export type RuleId =
  | 'AFW_TRIGGER'
  | 'DEFENSE'
  | 'AIRBAG'
  | 'MAINTENANCE_RANKED_TRIM'
  | 'PILLAR_FILL'
  | 'TRIPLES_DIP_LADDER'
  | 'TRIPLES_TRIM'
  | 'PIVOT_DEADLINE'
  | 'CORNERSTONE_PREMIUM'
  | 'CONCENTRATION'
  | 'MARGIN_TIER'
  | 'HEDGE_FLOOR';

export interface ProposedTrade {
  symbol: string;
  side: 'BUY' | 'SELL';
  notional: number; // dollars
  quantity?: number;
  assetType?: 'EQUITY' | 'OPTION';
  optionKind?: 'cash-secured-put' | 'naked-put' | 'covered-call' | 'long-put' | 'long-call';
  strike?: number;
  contracts?: number;
  pillar: Pillar;
}

export interface TradeSignal {
  id: string;
  rule: RuleId;
  category: SignalCategory;
  severity: SignalSeverity;
  title: string;
  rationale: string;
  trade?: ProposedTrade;
  autoExecutable: boolean;
  createdAt: string;
}

export interface EnginePosition {
  symbol: string;
  marketValue: number;
  quantity: number;
  price: number;
  putCall?: 'PUT' | 'CALL';
  maintenanceRequirement?: number;
}

export interface EngineBalances {
  equity: number; // liquidationValue
  afw: number; // AFW (Available For Withdrawal) — availableFunds
  marginDebit: number; // positive dollars borrowed
  maintenanceRequirement: number;
  cash: number;
}

export interface MarketContext {
  spyPrice: number;
  spyHigh: number; // trailing high (engine state anchor)
  vix: number;
}

export interface DipLadderState {
  /** Per-ticker anchor price (resets on new highs). */
  anchors: Record<string, number>;
  /** Per-ticker dollars deployed by the ladder in the current drawdown cycle. */
  deployed: Record<string, number>;
}

export interface EngineState {
  afwHigh: number; // trailing AFW high-water mark
  spyHigh: number;
  dipLadder: DipLadderState;
  /** Recent margin-debit observations for the pivot kill-switch. */
  marginDebtHistory: { date: string; debit: number }[];
  lastRunAt?: string;
}

export interface EngineInput {
  positions: EnginePosition[];
  balances: EngineBalances;
  market: MarketContext;
  state: EngineState;
  today: string; // YYYY-MM-DD
}

export interface EngineOutput {
  signals: TradeSignal[];
  nextState: EngineState;
}

export function emptyState(): EngineState {
  return {
    afwHigh: 0,
    spyHigh: 0,
    dipLadder: { anchors: {}, deployed: {} },
    marginDebtHistory: [],
  };
}
