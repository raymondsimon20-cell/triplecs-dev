/**
 * GET /api/signals/health
 *
 * Returns the engine's heartbeat status — when it last ran, how long it took,
 * what fired, and whether the system considers the cron healthy given the
 * trading-day calendar.
 *
 * Consumed by:
 *   - the dashboard's CronHealth badge
 *   - the daily digest (so the user gets a "cron is stale" warning if needed)
 *   - operator curls when debugging
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getCronHealth } from '@/lib/signals/cron-health';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const health = await getCronHealth();
  // Mirror staleness into the HTTP status so monitors / Uptime checks can
  // detect a failed engine without parsing JSON.
  const status = health.isStale ? 503 : 200;
  return NextResponse.json(health, { status });
}
