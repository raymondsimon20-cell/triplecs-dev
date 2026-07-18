/** Typed subset of the Schwab Trader & Market Data APIs used by Triple C. */

export interface SchwabTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  token_type: string;
  scope?: string;
}

export interface SchwabAccountNumberHash {
  accountNumber: string;
  hashValue: string;
}

export interface SchwabPosition {
  instrument: {
    symbol: string;
    assetType: 'EQUITY' | 'OPTION' | 'COLLECTIVE_INVESTMENT' | 'FIXED_INCOME' | string;
    putCall?: 'PUT' | 'CALL';
    underlyingSymbol?: string;
    description?: string;
  };
  longQuantity: number;
  shortQuantity: number;
  marketValue: number;
  averagePrice: number;
  currentDayProfitLoss?: number;
  maintenanceRequirement?: number;
}

export interface SchwabBalances {
  liquidationValue: number; // total account equity
  /**
   * AFW (Available For Withdrawal) — Schwab's equity-minus-maintenance-requirement
   * metric. This exact field is the strategy's primary signal. Do NOT rename or
   * re-expand the acronym.
   */
  availableFunds: number;
  marginBalance: number; // margin debit (negative = borrowed)
  maintenanceRequirement: number;
  buyingPower?: number;
  cashBalance?: number;
}

export interface SchwabAccount {
  accountNumber: string;
  hashValue: string;
  type: 'MARGIN' | 'CASH' | string;
  positions: SchwabPosition[];
  balances: SchwabBalances;
}

export interface SchwabQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  netChange: number;
  netPercentChange: number;
  high52Week?: number;
  low52Week?: number;
  volume?: number;
  nav?: number; // for CEFs, when available
}

export type OrderInstruction = 'BUY' | 'SELL' | 'SELL_SHORT' | 'BUY_TO_COVER' | 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type OrderDuration = 'DAY' | 'GOOD_TILL_CANCEL';

export interface OrderLeg {
  instruction: OrderInstruction;
  quantity: number;
  instrument: { symbol: string; assetType: 'EQUITY' | 'OPTION' };
}

export interface SchwabOrder {
  orderId?: number;
  orderType: OrderType;
  session: 'NORMAL' | 'AM' | 'PM' | 'SEAMLESS';
  duration: OrderDuration;
  orderStrategyType: 'SINGLE';
  price?: number;
  orderLegCollection: OrderLeg[];
  status?: string;
  enteredTime?: string;
  filledQuantity?: number;
}

export interface OptionContract {
  symbol: string;
  putCall: 'PUT' | 'CALL';
  strikePrice: number;
  expirationDate: string;
  daysToExpiration: number;
  bid: number;
  ask: number;
  last: number;
  delta?: number;
  openInterest?: number;
  inTheMoney: boolean;
}

export interface OptionChain {
  symbol: string;
  underlyingPrice: number;
  putExpDateMap: Record<string, Record<string, OptionContract[]>>;
  callExpDateMap: Record<string, Record<string, OptionContract[]>>;
}

export interface SchwabTransaction {
  activityId: number;
  time: string;
  type: string; // TRADE, DIVIDEND_OR_INTEREST, etc.
  netAmount: number;
  description?: string;
  transferItems?: {
    instrument: { symbol: string; assetType: string };
    amount: number;
    cost: number;
    price?: number;
    feeType?: string;
  }[];
}

export interface CostBasisLot {
  symbol: string;
  quantity: number;
  price: number;
  acquiredDate: string;
}
