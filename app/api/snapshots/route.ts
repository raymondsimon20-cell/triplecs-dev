import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getSnapshotHistory } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const limit  = parseInt(params.get('limit') ?? '90', 10);
  // ?accountHash=… scopes to a single Schwab account's snapshot history;
  // 'all' / 'global' / empty returns the household-aggregate series.
  const accountHashParam = params.get('accountHash');
  const accountHash      = accountHashParam && accountHashParam !== 'all' && accountHashParam !== 'global'
    ? accountHashParam
    : undefined;
  const snapshots = await getSnapshotHistory(Math.min(limit, 365), accountHash);
  return NextResponse.json({ snapshots, scope: accountHash ?? 'all' });
}
