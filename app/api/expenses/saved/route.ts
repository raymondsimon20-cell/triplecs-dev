import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getUserExpenses, saveUserExpenses } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const expenses = await getUserExpenses();
  return NextResponse.json({ expenses });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await req.json();
  if (!Array.isArray(body.expenses)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  await saveUserExpenses(body.expenses);
  return NextResponse.json({ ok: true });
}
