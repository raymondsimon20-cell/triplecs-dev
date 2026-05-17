/**
 * /api/signals/state — manual state mutations for sticky engine flags.
 *
 *   GET   → returns the current signal-engine state blob (gates, pivot,
 *           freedom-ratio history, prev-month margin). Read-only.
 *   PATCH → mutates the state blob. Body: { action: <one-of> }.
 *
 * Supported actions:
 *   - 'clear-kill-switch'   — clears the margin kill-switch flag. The signal
 *                             engine trips it on a month-over-month margin
 *                             jump without an AFW; user acknowledges by
 *                             clearing here once they've addressed it.
 *   - 'mark-pivot-executed' — marks the Vol 7 pivot as executed (suppresses
 *                             further PIVOT_TRIGGER and PIVOT_DEADLINE signals).
 *   - 'reset-pivot'         — undoes 'mark-pivot-executed' (used if the pivot
 *                             trade plan changes and the engine should resume
 *                             watching for the +5% recovery trigger).
 *
 * Both gates are STICKY by design — the engine won't auto-clear them. The
 * user has to take an action (here) to clear them after they've acted on the
 * underlying condition. That's intentional: you don't want defense mode to
 * silently un-trip the moment equity ratio nudges back over 40%.
 *
 * Note: 'defense-mode' is NOT manually clearable — it auto-clears when
 * equityRatio rises back above the threshold on the next engine run. If you
 * need to force-clear it for testing, edit the blob directly.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { loadSignalState, saveSignalState, type SignalEngineState } from '@/lib/signals/state';

export const dynamic = 'force-dynamic';

const VALID_ACTIONS = ['clear-kill-switch', 'mark-pivot-executed', 'reset-pivot'] as const;
type Action = (typeof VALID_ACTIONS)[number];

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/** Read `?accountHash=` and normalise. Empty/`all`/`global` → undefined. */
function readScope(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get('accountHash');
  if (!raw || raw === 'all' || raw === 'global') return undefined;
  return raw;
}

// ─── GET — read-only view of the state blob ──────────────────────────────────
// With ?accountHash=… returns that account's slot; without, returns the legacy
// global state (same as pre-2026-05 behaviour).

export async function GET(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }
  const scope = readScope(req);
  const state = await loadSignalState(scope);
  return NextResponse.json({ state, scope: scope ?? 'global' });
}

// ─── PATCH — apply one of the supported mutations ────────────────────────────
// Mutations apply at the scope passed via ?accountHash=… (or the legacy global
// slot when omitted).

export async function PATCH(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action;
  if (!action || !VALID_ACTIONS.includes(action as Action)) {
    return NextResponse.json(
      { error: 'Invalid action', valid: VALID_ACTIONS },
      { status: 400 },
    );
  }

  const scope = readScope(req);
  const state = await loadSignalState(scope);
  const next: SignalEngineState = applyAction(state, action as Action);
  await saveSignalState(next, scope);

  return NextResponse.json({ ok: true, action, scope: scope ?? 'global', state: next });
}

function applyAction(state: SignalEngineState, action: Action): SignalEngineState {
  switch (action) {
    case 'clear-kill-switch':
      return {
        ...state,
        killSwitch: { active: false, since: null, reason: '' },
      };
    case 'mark-pivot-executed':
      return {
        ...state,
        pivot: { ...state.pivot, pivotExecuted: true },
      };
    case 'reset-pivot':
      return {
        ...state,
        pivot: { spyLowSincePivot: null, pivotExecuted: false },
      };
  }
}
