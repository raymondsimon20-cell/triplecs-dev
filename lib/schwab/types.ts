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
}
