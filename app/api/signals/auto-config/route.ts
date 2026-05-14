/**
 * /api/signals/auto-config — configures the Signal Engine auto-execute mode.
 *
 *   GET   → returns the current config (mode, caps, circuit-breaker state).
 *   PATCH → updates one or more fields. Validates the enum + numeric ranges.
 *
 * Body for PATCH (all fields optional, only included ones are updated):
 *   {
 *     mode?: 'manual' | 'dry-run' | 'auto',
 *     dailyCaps?: {
 *       maxTrades?:               number,
 *       maxDollarsPerTrade?:      number,
 *       maxNetExposureShiftPct?:  number,
 *     },
 *     circuitBreaker?: {
 *       dailyLossPct?:    number,
 *       /// admin: force-clear a tripped breaker
 *       clearPause?:      boolean,
 *     }
 *   }
 *
 * Note on clearing the breaker: when the engine trips the breaker, it sets
 * `pausedUntilDate` to today's ISO date. The breaker auto-clears at the start
 * of the next day (loadAutoConfig handles the date-rollover check). If you
 * need to force-clear it mid-day (e.g. you've manually addressed the drawdown
 * and want auto-execute to resume), PATCH with `clearPause: true`.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import {
  loadAutoConfig,
  saveAutoConfig,
  type AutoConfig,
  type AutoMode,
} from '@/lib/signals/auto-config';

export const dynamic = 'force-dynamic';

const VALID_MODES: AutoMode[] = ['manual', 'dry-run', 'auto'];

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  try { await requireAuth(); } catch { return unauthorized(); }
  const config = await loadAutoConfig();
  return NextResponse.json({ config });
}

interface PatchBody {
  mode?:           string;
  dailyCaps?: Partial<{
    maxTrades:              number;
    maxDollarsPerTrade:     number;
    maxNetExposureShiftPct: number;
  }>;
  circuitBreaker?: Partial<{
    dailyLossPct: number;
    clearPause:   boolean;
  }>;
}

export async function PATCH(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const current = await loadAutoConfig();
  const next: AutoConfig = JSON.parse(JSON.stringify(current));

  // Mode
  if (body.mode !== undefined) {
    if (!VALID_MODES.includes(body.mode as AutoMode)) {
      return NextResponse.json(
        { error: 'Invalid mode', valid: VALID_MODES },
        { status: 400 },
      );
    }
    next.mode = body.mode as AutoMode;
  }

  // Daily caps
  if (body.dailyCaps) {
    const c = body.dailyCaps;
    if (c.maxTrades !== undefined) {
      if (!Number.isFinite(c.maxTrades) || c.maxTrades < 0 || c.maxTrades > 50) {
        return NextResponse.json({ error: 'maxTrades must be 0-50' }, { status: 400 });
      }
      next.dailyCaps.maxTrades = Math.floor(c.maxTrades);
    }
    if (c.maxDollarsPerTrade !== undefined) {
      if (!Number.isFinite(c.maxDollarsPerTrade) || c.maxDollarsPerTrade < 0) {
        return NextResponse.json({ error: 'maxDollarsPerTrade must be ≥ 0' }, { status: 400 });
      }
      next.dailyCaps.maxDollarsPerTrade = c.maxDollarsPerTrade;
    }
    if (c.maxNetExposureShiftPct !== undefined) {
      if (!Number.isFinite(c.maxNetExposureShiftPct) ||
          c.maxNetExposureShiftPct < 0 ||
          c.maxNetExposureShiftPct > 100) {
        return NextResponse.json({ error: 'maxNetExposureShiftPct must be 0-100' }, { status: 400 });
      }
      next.dailyCaps.maxNetExposureShiftPct = c.maxNetExposureShiftPct;
    }
  }

  // Circuit breaker
  if (body.circuitBreaker) {
    const b = body.circuitBreaker;
    if (b.dailyLossPct !== undefined) {
      if (!Number.isFinite(b.dailyLossPct) || b.dailyLossPct > 0 || b.dailyLossPct < -50) {
        return NextResponse.json(
          { error: 'dailyLossPct must be a negative number between -50 and 0' },
          { status: 400 },
        );
      }
      next.circuitBreaker.dailyLossPct = b.dailyLossPct;
    }
    if (b.clearPause === true) {
      next.circuitBreaker.pausedUntilDate = null;
      next.circuitBreaker.pausedReason    = '';
    }
  }

  await saveAutoConfig(next);
  return NextResponse.json({ ok: true, config: next });
}
