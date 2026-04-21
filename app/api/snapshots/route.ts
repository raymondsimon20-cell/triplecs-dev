import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getSnapshotHistory } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '90', 10);
  const snapshots = await getSnapshotHistory(Math.min(limit, 365));
  return NextResponse.json({ snapshots });
}
