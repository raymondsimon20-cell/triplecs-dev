import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getAlerts, markAlertsRead } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // ?accountHash=… scopes to a single account; untagged household-level
  // alerts (cron health, RO filings, premium watch) always pass through.
  const accountHashParam = new URL(req.url).searchParams.get('accountHash');
  const accountHash      = accountHashParam && accountHashParam !== 'all' && accountHashParam !== 'global'
    ? accountHashParam
    : undefined;
  const alerts = await getAlerts(accountHash);
  return NextResponse.json({ alerts, scope: accountHash ?? 'all' });
}

export async function POST() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  await markAlertsRead();
  return NextResponse.json({ ok: true });
}
