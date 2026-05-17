/**
 * GET    /api/strategy[?accountHash=...] — returns effective strategy targets.
 *                                          With accountHash, returns the
 *                                          per-account override resolved
 *                                          override → global → defaults.
 *                                          Without, returns the global blob.
 * POST   /api/strategy[?accountHash=...] — persists strategy targets. With
 *                                          accountHash, writes a per-account
 *                                          override (UI-only — the engine's
 *                                          per-account loop reads this on next
 *                                          run). Without, writes the global.
 * DELETE /api/strategy?accountHash=...    — clears the per-account override
 *                                          so the next read falls back to
 *                                          global. Global cannot be deleted
 *                                          through this endpoint.
 *
 * Body shape (POST): partial StrategyTargets — see lib/utils.ts. Any field
 * absent from the body falls through to the existing value at the same scope
 * (or to the global default if the scope is fresh).
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  getServerStrategyTargets,
  saveServerStrategyTargets,
  clearServerStrategyOverride,
  hasServerStrategyOverride,
} from '@/lib/strategy-store';
import { DEFAULT_TARGETS, type StrategyTargets } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Parse and validate accountHash from query. Empty / 'all' / 'global' all
 *  collapse to undefined (global scope). */
function readScope(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get('accountHash');
  if (!raw || raw === 'all' || raw === 'global') return undefined;
  return raw;
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const scope   = readScope(req);
  const targets = await getServerStrategyTargets(scope);
  const hasOverride = scope ? await hasServerStrategyOverride(scope) : false;
  return NextResponse.json({
    targets,
    scope: scope ?? 'global',
    hasOverride,
  });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Partial<StrategyTargets> = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const scope = readScope(req);

  // Coerce + clamp. Anything missing falls through to the existing value at
  // the same scope (override) or to global (which itself falls back to
  // DEFAULT_TARGETS when fresh).
  const current = await getServerStrategyTargets(scope);
  const merged: StrategyTargets = {
    ...current,
    ...Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) => k in DEFAULT_TARGETS && typeof v === 'number' && Number.isFinite(v),
      ),
    ),
  };

  // Schwab caps margin utilization at 50% (Reg T initial margin requirement).
  // Configuring margin thresholds above 50% is meaningless — orders fail at
  // the broker regardless. Clamp to keep the user's settings honest.
  const SCHWAB_MARGIN_HARD_CAP = 50;
  const clampPct = (v: number) => Math.max(0, Math.min(v, SCHWAB_MARGIN_HARD_CAP));
  const next: StrategyTargets = {
    ...merged,
    marginLimitPct:         clampPct(merged.marginLimitPct),
    marginWarnPct:          clampPct(merged.marginWarnPct),
    marginTrimTargetPct:    clampPct(merged.marginTrimTargetPct),
    marginNewBuyCeilingPct: clampPct(merged.marginNewBuyCeilingPct),
  };

  await saveServerStrategyTargets(next, scope);
  return NextResponse.json({
    ok:      true,
    scope:   scope ?? 'global',
    targets: next,
    notes: next.marginLimitPct !== merged.marginLimitPct ||
           next.marginNewBuyCeilingPct !== merged.marginNewBuyCeilingPct
      ? [`Margin thresholds clamped to Schwab's 50% hard cap.`]
      : undefined,
  });
}

export async function DELETE(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const scope = readScope(req);
  if (!scope) {
    return NextResponse.json(
      { error: 'DELETE requires ?accountHash=<hash>. The global default cannot be cleared, only overwritten.' },
      { status: 400 },
    );
  }
  await clearServerStrategyOverride(scope);
  const fallback = await getServerStrategyTargets(); // global, post-delete
  return NextResponse.json({ ok: true, scope, fellBackTo: 'global', targets: fallback });
}
