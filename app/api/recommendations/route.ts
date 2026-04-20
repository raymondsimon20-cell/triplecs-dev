import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  getRecommendations,
  saveRecommendations,
  updateRecommendationStatus,
  type TrackedRecommendation,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const recs = await getRecommendations();
  return NextResponse.json({ recommendations: recs });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await req.json();
  if (!Array.isArray(body.recommendations)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  await saveRecommendations(body.recommendations as TrackedRecommendation[]);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id, status } = await req.json();
  if (!id || !['executed', 'skipped'].includes(status)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  await updateRecommendationStatus(id, status);
  return NextResponse.json({ ok: true });
}
