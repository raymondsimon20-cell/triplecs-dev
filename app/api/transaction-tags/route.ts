import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  getExpenseTagState,
  normalizeExpenseDescription,
  saveExpenseTagState,
} from '@/lib/transactions/expense-tags';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await getExpenseTagState());
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const expenseCategory = typeof body?.expenseCategory === 'string'
    ? body.expenseCategory.trim().slice(0, 60)
    : '';
  const applyToFuture = body?.applyToFuture === true;
  if (!transactionId || !description || !expenseCategory) {
    return NextResponse.json(
      { error: 'transactionId, description, and expenseCategory are required' },
      { status: 400 },
    );
  }

  const state = await getExpenseTagState();
  const now = new Date().toISOString();
  state.overrides[transactionId] = { transactionId, expenseCategory, createdAt: now };

  if (applyToFuture) {
    const normalizedDescription = normalizeExpenseDescription(description);
    if (!normalizedDescription) {
      return NextResponse.json({ error: 'Description cannot create a matching rule' }, { status: 400 });
    }
    const existing = state.rules.find((rule) => rule.normalizedDescription === normalizedDescription);
    if (existing) {
      existing.expenseCategory = expenseCategory;
    } else {
      state.rules.push({
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        normalizedDescription,
        expenseCategory,
        createdAt: now,
      });
    }
  }

  await saveExpenseTagState(state);
  return NextResponse.json({ ok: true });
}
