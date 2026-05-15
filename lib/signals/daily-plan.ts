/**
 * Daily plan — a structured "what autopilot would do today" view.
 *
 * Pure function. Takes the most-recent cached engine result + the current
 * inbox + the auto-execute config, and produces a coherent daily plan grouped
 * by tier:
 *
 *   tier 1 (auto)     — small rebalance trims, CLM/CRF DRIP protection,
 *                       wash-sale-driven substitutions. Eligible for unattended
 *                       execution when auto-config.mode === 'auto'.
 *
 *   tier 2 (approval) — anything opening a new position, anything above the
 *                       per-trade cap, anything that meaningfully changes
 *                       leverage. Always routes through human approval.
 *
 *   tier 3 (alert)    — kill-switch trips, leverage-reduction alerts, defense
 *                       mode, freedom-ratio reviews. Informational only —
 *                       these need user judgment, not a trade.
 *
 * Tier is derived from rule + direction + size, not stored on the signal
 * directly. That keeps the engine pure and lets the tier mapping evolve
 * without changing the engine contract.
 */

import type { EngineResult, TradeSignal } from './engine';
import type { InboxItem } from '../inbox';
import type { AutoConfig } from './auto-config';

export type PlanTier = 'auto' | 'approval' | 'alert';

export interface PlannedAction {
  /** The originating engine signal id (links back to inbox item via the rule+ticker tuple). */
  signalId:    string;
  /** Stable inbox item id when the signal already staged. */
  inboxItemId?: string;
  rule:        string;
  ticker:      string;
  direction:   TradeSignal['direction'];
  sizeDollars: number;
  priority:    TradeSignal['priority'];
  reason:      string;
  tier:        PlanTier;
  /** When true, the user must still approve even if auto-execute is on. */
  requiresApproval: boolean;
  /** Inbox status when known. */
  status?: InboxItem['status'];
  /** Guardrail-attached violations (when the item is staged). */
  blockedByGuardrails: boolean;
}

export interface DailyPlan {
  generatedAt:       string;
  totalValue:        number;
  marginUtilizationPct: number;
  /** AFW (Available For Withdrawal) in dollars — Schwab's margin headroom. */
  afwDollars?:       number;
  inDefenseMode:     boolean;
  killSwitchActive:  boolean;
  autoExecuteMode:   AutoConfig['mode'];
  /** Tier breakdown of every actionable item. */
  actions: {
    auto:     PlannedAction[];
    approval: PlannedAction[];
    alert:    PlannedAction[];
  };
  counts: {
    auto:     number;
    approval: number;
    alert:    number;
    total:    number;
  };
}

/**
 * Tier-1 ("auto") qualifying rules. Conservative whitelist — anything not on
 * this list defaults to tier 2 (requires approval) when a BUY/SELL, or tier 3
 * (alert) when ALERT/INFO. This is intentional: easy to expand the auto list
 * once a rule has been observed in supervised mode for a while.
 *
 * Graduation history:
 *   - CLM_CRF_TRIM, AIRBAG_SCALE: initial set (well-bounded by hard caps)
 *   - AFW_TRIGGER:               promoted after observation; sizes are fixed
 *                                  in CONFIG.AFW_DEPLOY ($500/$1000 splits).
 *   - MAINTENANCE_RANKED_TRIM:   stays tier 2 until observed; can sell up to
 *                                  half of a position which is more material.
 *   - PILLAR_FILL:               stays tier 2; opens NEW positions.
 */
const AUTO_TIER_RULES: ReadonlySet<string> = new Set([
  'CLM_CRF_TRIM',         // pillar trim above a hard cap — well-bounded
  'AIRBAG_SCALE',         // VIX-reactive hedge sizing — bounded by AIRBAG % targets
  'AFW_TRIGGER',          // $500/$500 splits or $1000 single ticker — hard-coded sizes
]);

/**
 * Tier-3 (alert-only) rules — always informational, never tradeable in
 * unattended mode no matter how the action is sized.
 */
const ALERT_ONLY_RULES: ReadonlySet<string> = new Set([
  'DEFENSE_MODE',
  'MARGIN_KILL_SWITCH',
  'LEVERAGE_REDUCTION_ALERT',
  'FREEDOM_RATIO',
  'PIVOT_DEADLINE',
  'CLM_CRF_PREMIUM_CHECK',
]);

/** Per-trade ceiling above which tier-1 candidates get pushed to tier 2. */
const AUTO_TIER_MAX_DOLLARS = 2_000;

/**
 * Pure classifier — exported so `lib/signals/run.ts` can tag inbox items with
 * tier metadata at stage time. Auto-execute reads this back when deciding
 * which items to fire unattended.
 */
export function classifySignalTier(signal: TradeSignal): PlanTier {
  if (ALERT_ONLY_RULES.has(signal.rule)) return 'alert';
  if (signal.direction === 'ALERT' || signal.direction === 'INFO') return 'alert';
  if (signal.direction !== 'BUY' && signal.direction !== 'SELL') return 'approval';

  if (AUTO_TIER_RULES.has(signal.rule) && signal.sizeDollars <= AUTO_TIER_MAX_DOLLARS) {
    return 'auto';
  }
  return 'approval';
}

// Internal alias retained for the rest of this module.
const classifySignal = classifySignalTier;

function findInboxMatch(
  signal: TradeSignal,
  inbox: InboxItem[],
): InboxItem | undefined {
  // Inbox items don't preserve the engine's signal id; we match on
  // (source='signal-engine', ticker, instruction).
  return inbox.find(
    (i) =>
      i.source === 'signal-engine' &&
      i.symbol === signal.ticker &&
      i.instruction === signal.direction,
  );
}

export function buildDailyPlan(
  engineResult: EngineResult,
  inbox: InboxItem[],
  autoConfig: AutoConfig,
): DailyPlan {
  const actions: DailyPlan['actions'] = { auto: [], approval: [], alert: [] };

  for (const signal of engineResult.signals) {
    const tier = classifySignal(signal);
    const inboxMatch = findInboxMatch(signal, inbox);
    const blocked = Boolean(inboxMatch?.blocked);

    // When auto mode is OFF, every actionable item requires approval even
    // tier-1 ones. The tier metadata still gets emitted so the UI can render
    // it; the requiresApproval flag is what gates execution.
    const requiresApproval =
      tier === 'alert' ||
      tier === 'approval' ||
      autoConfig.mode !== 'auto' ||
      blocked;

    const action: PlannedAction = {
      signalId:           signal.id,
      inboxItemId:        inboxMatch?.id,
      rule:               signal.rule,
      ticker:             signal.ticker,
      direction:          signal.direction,
      sizeDollars:        signal.sizeDollars,
      priority:           signal.priority,
      reason:             signal.reason,
      tier,
      requiresApproval,
      status:             inboxMatch?.status,
      blockedByGuardrails: blocked,
    };

    actions[tier].push(action);
  }

  // Pull AFW from the most recent signal that carries it (any rule that fired
  // with AFW data attaches `afwBefore` / `afwDollars` in its data payload).
  // Falls back to undefined for plans built before AFW capture shipped.
  let afwFromSignals: number | undefined;
  for (const s of engineResult.signals) {
    const v = (s.data?.afwBefore ?? s.data?.afwDollars) as number | undefined;
    if (typeof v === 'number') { afwFromSignals = v; break; }
  }

  return {
    generatedAt:          engineResult.generatedAt,
    totalValue:           engineResult.valuation.totalValue,
    marginUtilizationPct:
      engineResult.valuation.totalValue > 0
        ? (engineResult.valuation.marginDebt / engineResult.valuation.totalValue) * 100
        : 0,
    afwDollars:           afwFromSignals,
    inDefenseMode:        engineResult.inDefenseMode,
    killSwitchActive:     engineResult.killSwitchActive,
    autoExecuteMode:      autoConfig.mode,
    actions,
    counts: {
      auto:     actions.auto.length,
      approval: actions.approval.length,
      alert:    actions.alert.length,
      total:    actions.auto.length + actions.approval.length + actions.alert.length,
    },
  };
}
