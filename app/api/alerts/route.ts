import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getAlerts, markAlertsRead } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const alerts = await getAlerts();
  return NextResponse.json({ alerts });
}

export async function POST() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  await markAlertsRead();
  return NextResponse.json({ ok: true });
}
