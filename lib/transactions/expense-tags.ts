import { getStore } from '@netlify/blobs';

export interface ExpenseRule {
  id: string;
  normalizedDescription: string;
  expenseCategory: string;
  createdAt: string;
}

export interface ExpenseOverride {
  transactionId: string;
  expenseCategory: string;
  createdAt: string;
}

export interface ExpenseTagState {
  rules: ExpenseRule[];
  overrides: Record<string, ExpenseOverride>;
}

const STORE = 'transaction-expense-tags';
const KEY = 'state';

export function normalizeExpenseDescription(description: string): string {
  return description
    .toUpperCase()
    .replace(/\b(?:REF|REFERENCE|CONF|CONFIRMATION|TRACE|ID|#)\s*[:#-]?\s*[A-Z0-9-]+\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export async function getExpenseTagState(): Promise<ExpenseTagState> {
  const saved = await getStore(STORE).get(KEY, { type: 'json' }) as ExpenseTagState | null;
  return {
    rules: Array.isArray(saved?.rules) ? saved.rules : [],
    overrides: saved?.overrides && typeof saved.overrides === 'object' ? saved.overrides : {},
  };
}

export async function saveExpenseTagState(state: ExpenseTagState): Promise<void> {
  await getStore(STORE).setJSON(KEY, state);
}

export function findExpenseTag(
  transactionId: string,
  description: string,
  state: ExpenseTagState,
): { expenseCategory: string; source: 'override' | 'rule' } | null {
  const override = state.overrides[transactionId];
  if (override) return { expenseCategory: override.expenseCategory, source: 'override' };
  const normalized = normalizeExpenseDescription(description);
  if (!normalized) return null;
  const rule = state.rules.find((item) => item.normalizedDescription === normalized);
  return rule ? { expenseCategory: rule.expenseCategory, source: 'rule' } : null;
}
