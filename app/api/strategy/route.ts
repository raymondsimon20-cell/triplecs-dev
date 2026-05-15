/**
 * GET  /api/strategy   Returns the server-side strategy targets (DEFAULT_TARGETS
 *                      if no override has been saved).
 * POST /api/strategy   Persists a new set of strategy targets. SettingsPanel
 *                      calls this after writing to localStorage so the daily
 *                      cron and signal engine can read what the user wants.
 *
 * Body shape (POST): the full StrategyTargets object — see lib/utils.ts.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  getServerStrategyTargets,
  saveServerStrategyTargets,
} from '@/lib/strategy-store';
import { DEFAULT_TARGETS, type StrategyTargets } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const targets = await getServerStrategyTargets();
  return NextResponse.json({ targets });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Partial<StrategyTargets> = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Coerce + clamp. Anything missing falls through to the existing value.
  const current = await getServerStrategyTargets();
  const next: StrategyTargets = {
    ...current,
    ...Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) => k in DEFAULT_TARGETS && typeof v === 'number' && Number.isFinite(v),
      ),
    ),
  };

  await saveServerStrategyTargets(next);
  return NextResponse.json({ ok: true, targets: next });
}
