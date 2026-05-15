/**
 * GET /api/signals/daily-plan/archive          → list archived dates
 * GET /api/signals/daily-plan/archive?date=…   → fetch a specific archived plan
 *
 * Lets the user review what the engine recommended on prior days.
 * Retention is 90 days, set in lib/signals/plan-archive.ts.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  listArchivedPlanDates,
  getArchivedPlan,
} from '@/lib/signals/plan-archive';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url  = new URL(req.url);
  const date = url.searchParams.get('date');

  try {
    if (date) {
      const plan = await getArchivedPlan(date);
      if (!plan) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ plan });
    }
    const dates = await listArchivedPlanDates();
    return NextResponse.json({ dates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[plan-archive] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
