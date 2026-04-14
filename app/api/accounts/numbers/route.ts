import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAuth();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const client = await createClient();
    const accountNumbers = await client.getAccountNumbers();
    return NextResponse.json({ accountNumbers });
  } catch (err) {
    console.error('Account numbers error:', err);
    return NextResponse.json({ error: 'Failed to fetch account numbers' }, { status: 500 });
  }
}
