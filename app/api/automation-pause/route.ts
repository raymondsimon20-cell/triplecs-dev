/**
 * Kill-switch endpoint for the global "Pause Automation" toggle.
 *
 *   GET   → { paused: boolean }
 *   POST  → body { paused: boolean }; flips the flag
 *
 * Read by AI plan endpoints to short-circuit before calling Claude.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { isAutomationPaused, setAutomationPaused } from '@/lib/guardrails';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ paused: await isAutomationPaused() });
}

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: { paused?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }
  const next = Boolean(body.paused);
  await setAutomationPaused(next);
  return NextResponse.json({ paused: next });
}
