import { isInternalTransfer, isKnownContributionSource } from '../data/contribution-sources';

export type CashMovementCategory = 'Contribution' | 'Withdrawal' | 'Transfer' | null;

interface CashMovementInput {
  txType: string;
  description: string;
  amount: number;
  hasSecurity?: boolean;
}

const TRADE_SETTLEMENT = /\b(bought|buy|purchase|trade settlement|settlement of trade|securit(?:y|ies)|option)\b/i;
const EXTERNAL_WITHDRAWAL = /\b(withdraw(?:al)?|wire out|ach disbursement|cash disbursement|bill pay|check paid)\b/i;

/** Schwab description variants observed for borrowing charges. */
export function isMarginInterestDescription(description: string): boolean {
  return /margin.*(?:interest|fee)|(?:interest|fee).*margin|interest\s+charge|debit.*interest|interest.*debit/i.test(description);
}

/**
 * Classify cash-movement records without confusing a trade's cash/register leg
 * for money leaving the brokerage account.
 *
 * Schwab can emit a security purchase as both a TRADE and a negative JOURNAL
 * or CASH_DISBURSEMENT. Only explicit external rails (ACH, wire, electronic
 * fund) or an unmistakable withdrawal description count as withdrawals.
 */
export function classifyCashMovement({
  txType: rawType,
  description,
  amount,
  hasSecurity = false,
}: CashMovementInput): CashMovementCategory {
  const txType = rawType.toUpperCase();

  if (amount > 0 && isKnownContributionSource(description)) return 'Contribution';

  if (
    txType === 'ACH_RECEIPT' || txType === 'WIRE_IN' || txType === 'CASH_RECEIPT' ||
    (txType === 'ELECTRONIC_FUND' && amount > 0)
  ) return 'Contribution';

  if (
    txType === 'ACH_DISBURSEMENT' || txType === 'WIRE_OUT' ||
    (txType === 'ELECTRONIC_FUND' && amount < 0)
  ) return 'Withdrawal';

  if (txType === 'JOURNAL' || txType === 'CASH_DISBURSEMENT') {
    if (hasSecurity || isInternalTransfer(description) || TRADE_SETTLEMENT.test(description)) {
      return 'Transfer';
    }
    return amount < 0 && EXTERNAL_WITHDRAWAL.test(description) ? 'Withdrawal' : 'Transfer';
  }

  return null;
}
