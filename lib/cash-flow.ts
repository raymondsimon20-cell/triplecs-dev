export interface CashFlowTransactionLike {
  date: string;
  category: string;
  amount: number;
}

export interface CashFlowSummary {
  income: number;
  distributionIncome: number;
  optionIncome: number;
  stockSaleProceeds: number;
  marginCost: number;
  contributions: number;
  withdrawals: number;
  deployed: number;
  expenses: number;
  netOperating: number;
  daily: Map<string, number>;
}

/** Local calendar date, avoiding UTC rollover in evening US time zones. */
export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Exactly `count` local calendar dates, oldest first and including today. */
export function cashFlowDateKeys(count: number, now = new Date()): string[] {
  const safeCount = Math.max(1, Math.floor(count));
  const out: string[] = [];
  for (let daysAgo = safeCount - 1; daysAgo >= 0; daysAgo -= 1) {
    out.push(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)));
  }
  return out;
}

/**
 * Cash operating model:
 * - distributions, credit interest, and positive option cash are income;
 * - stock-sale proceeds are disclosed separately, not called income;
 * - purchases are capital deployment, not withdrawals or operating expenses.
 */
export function summarizeCashFlow(rows: CashFlowTransactionLike[]): CashFlowSummary {
  let distributionIncome = 0;
  let optionIncome = 0;
  let stockSaleProceeds = 0;
  let marginCost = 0;
  let contributions = 0;
  let withdrawals = 0;
  let deployed = 0;
  const daily = new Map<string, number>();

  for (const row of rows) {
    const amount = Math.abs(row.amount);
    if (row.category === 'Dividend' || row.category === 'Interest') {
      distributionIncome += amount;
      daily.set(row.date, (daily.get(row.date) ?? 0) + amount);
    } else if (row.category === 'Option Trade') {
      if (row.amount > 0) {
        optionIncome += amount;
        daily.set(row.date, (daily.get(row.date) ?? 0) + amount);
      } else if (row.amount < 0) {
        deployed += amount;
      }
    } else if (row.category === 'Stock Sale' && row.amount > 0) {
      stockSaleProceeds += amount;
    } else if (row.category === 'Margin Interest') {
      marginCost += amount;
      daily.set(row.date, (daily.get(row.date) ?? 0) - amount);
    } else if (row.category === 'Withdrawal') {
      withdrawals += amount;
      daily.set(row.date, (daily.get(row.date) ?? 0) - amount);
    } else if (row.category === 'Contribution') {
      contributions += amount;
    } else if (row.category === 'Stock Purchase' && row.amount < 0) {
      deployed += amount;
    }
  }

  const income = distributionIncome + optionIncome;
  const expenses = withdrawals + marginCost;
  return {
    income,
    distributionIncome,
    optionIncome,
    stockSaleProceeds,
    marginCost,
    contributions,
    withdrawals,
    deployed,
    expenses,
    netOperating: income - expenses,
    daily,
  };
}
