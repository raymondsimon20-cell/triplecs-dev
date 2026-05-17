/**
 * Kill-switch endpoint for the "Pause Automation" toggle.
 *
 *   GET[?accountHash=…]  → { paused: boolean, scope }
 *   POST[?accountHash=…] body { paused: boolean }; flips the flag.
 *
 * 2026-05 per-account autopilot: per-account pause flags live alongside a
 * household master pause. Per-account flags only affect THAT account. The
 * household pause (unscoped) overrides every account — when it's on, all
 * accounts are paused regardless of their own flag.
 *
 * Read by AI plan endpoints (via getAutomationGate) to short-circuit before
 * calling Claude.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { isAutomationPaused, setAutomationPaused } from '@/lib/guardrails';

export const dynamic = 'force-dynamic';

/** Parse ?accountHash=. Empty / 'all' / 'global' → undefined (household). */
function readScope(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get('accountHash');
  if (!raw || raw === 'all' || raw === 'global') return undefined;
  return raw;
}

export async function GET(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const scope = readScope(req);
  return NextResponse.json({
    paused: await isAutomationPaused(scope),
    scope:  scope ?? 'global',
  });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: { paused?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }
  const scope = readScope(req);
  const next  = Boolean(body.paused);
  await setAutomationPaused(next, scope);
  return NextResponse.json({ paused: next, scope: scope ?? 'global' });
}
