// ─── Schwab OAuth ─────────────────────────────────────────────────────────────

export interface SchwabTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;        // seconds
  scope: string;
  issued_at: number;         // unix ms — we add this on receipt
}

export interface SessionPayload {
  sessionId: string;
  accountIds: string[];      // hashed account numbers
  expiresAt: number;         // unix ms
}

// ─── Schwab Account / Position Types ─────────────────────────────────────────

export interface SchwabAccountNumberHash {
  accountNumber: string;     // masked account number for display
  hashValue: string;         // hash used in API calls
}

export interface SchwabPosition {
  shortQuantity: number;
  averagePrice: number;
  currentDayProfitLoss: number;
  currentDayProfitLossPercentage: number;
  longQuantity: number;
  settledLongQuantity: number;
  settledShortQuantity: number;
  instrument: {
    assetType: 'EQUITY' | 'OPTION' | 'FIXED_INCOME' | 'MUTUAL_FUND' | 'CASH_EQUIVALENT';
    cusip?: string;
    symbol: string;
    description?: string;
    netChange?: number;
  };
  marketValue: number;
  maintenanceRequirement: number;
  averageLongPrice: number;
  taxLotAverageLongPrice: number;
  longOpenProfitLoss: number;
  previousSessionLongQuantity: number;
  currentDayCost: number;
}

export interface SchwabBalance {
  accruedInterest: number;
  cashBalance: number;
  cashReceipts: number;
  longOptionMarketValue: number;
  liquidationValue: number;
  longMarketValue: number;
  moneyMarketFund: number;
  savings: number;
  shortMarketValue: number;
  pendingDeposits: number;
  availableFunds: number;
  availableFundsNonMarginableTrade: number;
  buyingPower: number;
  buyingPowerNonMarginableTrade: number;
  dayTradingBuyingPower: number;
  equity: number;
  equityPercentage: number;
  longMarginValue: number;
  maintenanceCall: number;
  maintenanceRequirement: number;
  margin: number;
  /** Margin balance: negative = margin debt (borrowed), positive = credit. Use Math.abs() for display. */
  marginBalance: number;
  regTCall: number;
  shortBalance: number;
  shortMarginValue: number;
  shortOptionMarketValue: number;
  sma: number;
  mutualFundValue: number;
  bondValue: number;
}

export interface SchwabAccount {
  type: 'MARGIN' | 'CASH' | 'IRA';
  accountNumber: string;
  roundTrips: number;
  isDayTrader: boolean;
  isClosingOnlyRestricted: boolean;
  pfcbFlag: boolean;
  positions: SchwabPosition[];
  initialBalances: SchwabBalance;
  currentBalances: SchwabBalance;
  projectedBalances: SchwabBalance;
}

export interface SchwabAccountWrapper {
  securitiesAccount: SchwabAccount;
}

// ─── Market Data ─────────────────────────────────────────────────────────────

export interface SchwabQuote {
  symbol: string;
  description: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  lastPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  netChange: number;
  netPercentChange: number;
  totalVolume: number;
  tradeTime: number;
  quoteTime: number;
  mark: number;
  exchange: string;
  exchangeName: string;
  volatility: number;
  peRatio: number;
  divAmount: number;
  divYield: number;
  divDate: string;
  securityStatus: string;
  regularMarketLastPrice: number;
  regularMarketNetChange: number;
}

export type SchwabQuotesResponse = Record<string, { quote: SchwabQuote; reference?: unknown }>;

// ─── App-level enriched types ─────────────────────────────────────────────────

export type PillarType = 'triples' | 'cornerstone' | 'income' | 'hedge' | 'other';

export interface EnrichedPosition extends SchwabPosition {
  pillar: PillarType;
  quote?: SchwabQuote;
  currentValue: number;
  gainLoss: number;
  gainLossPercent: number;
  portfolioPercent: number;
  todayGainLoss: number;
  /**
   * Fund family — issuer / concentration bucket. 'Other' for unknowns,
   * 'Individual' for single stocks, 'Gold' for physical-gold ETFs.
   * Sourced from `lib/data/fund-metadata.ts`.
   */
  family?: string;
  /**
   * Schwab-style maintenance requirement % — the proportion of position value
   * that must be backed by equity. Used by the rule engine to rank sells by
   * the equity freed per dollar sold ("maintenance hierarchy").
   *
   * Explicit values come from the Vol-7 maintenance table; pillar-default
   * fallbacks are used otherwise. Inspect `maintenancePctSource` to tell them
   * apart when accuracy matters (e.g. when sizing autopilot trades).
   */
  maintenancePct?: number;
  maintenancePctSource?: 'explicit' | 'default';
}

// ─── Schwab Order Types ──────────────────────────────────────────────────────

export type SchwabOrderStatus =
  | 'AWAITING_PARENT_ORDER'
  | 'AWAITING_CONDITION'
  | 'AWAITING_STOP_CONDITION'
  | 'AWAITING_MANUAL_REVIEW'
  | 'ACCEPTED'
  | 'AWAITING_UR_OUT'
  | 'PENDING_ACTIVATION'
  | 'QUEUED'
  | 'WORKING'
  | 'REJECTED'
  | 'PENDING_CANCEL'
  | 'CANCELED'
  | 'PENDING_REPLACE'
  | 'REPLACED'
  | 'FILLED'
  | 'EXPIRED';

/** Statuses that represent a cancellable (still-open) order */
export const CANCELLABLE_STATUSES: Set<SchwabOrderStatus> = new Set([
  'AWAITING_PARENT_ORDER', 'AWAITING_CONDITION', 'AWAITING_STOP_CONDITION',
  'AWAITING_MANUAL_REVIEW', 'ACCEPTED', 'AWAITING_UR_OUT',
  'PENDING_ACTIVATION', 'QUEUED', 'WORKING',
]);

export interface SchwabOrderLeg {
  orderLegType: string;
  legId: number;
  instrument: {
    assetType: string;
    cusip?: string;
    symbol: string;
    description?: string;
  };
  instruction: 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
  positionEffect?: string;
  quantity: number;
  quantityType?: string;
}

export interface SchwabOrder {
  session: string;
  duration: string;
  orderType: string;
  complexOrderStrategyType?: string;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  requestedDestination?: string;
  destinationLinkName?: string;
  price?: number;
  stopPrice?: number;
  orderLegCollection: SchwabOrderLeg[];
  orderStrategyType: string;
  orderId: number;
  cancelable: boolean;
  editable: boolean;
  status: SchwabOrderStatus;
  enteredTime: string;
  closeTime?: string;
  tag?: string;
  accountNumber?: number;
  statusDescription?: string;
}

export interface SchwabTransaction {
  activityId: number;
  time: string;
  type: string;
  description: string;
  netAmount: number;
  transferItems: {
    instrument: { symbol?: string; description?: string; assetType: string };
    amount: number;
    cost: number;
    price?: number;
  }[];
  // ── Alternative field names Schwab may use ──
  activityType?: string;
  transactionType?: string;
  transactionDescription?: string;
  transactionDate?: string;
  tradeDate?: string;
  settlementDate?: string;
  amount?: number;
  totalAmount?: number;
  symbol?: string;
  transactionItems?: {
    instrument?: { symbol?: string; description?: string; assetType?: string };
    asset?: { symbol?: string; cusip?: string };
    amount?: number;
    cost?: number;
    price?: number;
  }[];
}
