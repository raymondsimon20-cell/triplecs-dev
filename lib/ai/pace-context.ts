/**
 * Pace context — converts current TWR/CAGR vs the 40% target into a compact
 * prompt block that gets injected into rebalance/option/ai-analysis Claude
 * calls.
 *
 * Goal: ~150-250 tokens. Tells Claude where the portfolio sits vs the 40%
 * north star so it can size more aggressively when behind, defensive when
 * ahead — the closing piece of the AI feedback loop (Phase 4).
 *
 * Sits OUTSIDE the cached system prompt so it refreshes per-request without
 * invalidating the cache. Prepended after the feedback block, before the
 * task-specific instructions.
 */

import type { TwrResult, Vs40Progress } from '../performance';

function fmtPct(n: number, dp = 1): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(dp)}%`;
}

function fmtPp(n: number, dp = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}pp`;
}

export interface PaceContext {
  twr: TwrResult;
  progress: Vs40Progress;
  daysSinceStart: number;
}

/**
 * Render the pace block. Returns null when we don't have enough history
 * (caller treats null as "skip the block, run the prompt without it").
 */
export function buildPaceBlock(ctx: PaceContext | null): string | null {
  if (!ctx) return null;

  const { twr, progress, daysSinceStart } = ctx;
  const { actualCAGR, gapPp, paceLabel, requiredForwardCAGR } = progress;

  const twrLine =
    `${fmtPct(twr.twrPct, 1)} cumulative · ` +
    `${fmtPct(actualCAGR, 1)} annualized · ` +
    `${daysSinceStart.toFixed(0)}d window`;

  const gapLine = `Gap vs 40% target: ${fmtPp(gapPp, 1)} (${paceLabel.toUpperCase()})`;

  const requiredLine = requiredForwardCAGR != null
    ? `Required forward CAGR to hit 40% by year mark: ${fmtPct(requiredForwardCAGR, 1)}`
    : `Year mark already passed — measure rolling 365d going forward.`;

  const guidance = paceGuidance(paceLabel, requiredForwardCAGR, twr.daysCovered);

  return [
    `═══ PACE VS 40% TARGET (Phase 4) ═══`,
    `WHERE YOU STAND:`,
    `  ${twrLine}`,
    `  ${gapLine}`,
    `  ${requiredLine}`,
    ``,
    `HOW TO USE THIS CONTEXT:`,
    guidance,
    `═══════════════════════════════════════════════════════`,
  ].join('\n');
}

function paceGuidance(
  paceLabel: 'ahead' | 'on-pace' | 'behind',
  requiredForwardCAGR: number | null,
  daysCovered: number,
): string {
  // Small windows → CAGR is noisy; soften the lever
  if (daysCovered < 21) {
    return [
      `  - Window is short (<21d). Treat the gap as directional, not precise.`,
      `  - Stay near baseline pillar targets; do not size aggressively off a small sample.`,
    ].join('\n');
  }

  if (paceLabel === 'behind') {
    const required = requiredForwardCAGR != null && requiredForwardCAGR > 0
      ? `${fmtPct(requiredForwardCAGR, 0)} forward CAGR is needed`
      : `the year-mark catch-up is steep`;
    return [
      `  - You're BEHIND pace. ${required}.`,
      `  - Size proposals more aggressively within rules: lean toward UPRO/TQQQ on Triples,`,
      `    higher-delta puts (0.30-0.40) when IV permits, full pillar refills (not partial).`,
      `  - Do NOT relax concentration caps, margin thresholds, or CLM/CRF DRIP floor — those`,
      `    are guardrails that protect the engine; aggression goes inside them, not past them.`,
    ].join('\n');
  }

  if (paceLabel === 'ahead') {
    return [
      `  - You're AHEAD of pace. Bank the lead.`,
      `  - Bias proposals defensive: lower-delta puts (0.20-0.25), trim Triples toward target`,
      `    rather than over, prefer fortress income (JEPI/SCHD/GOF) over high-maint chasers.`,
      `  - Don't be afraid to recommend HOLD / no-action when nothing screams.`,
    ].join('\n');
  }

  return [
    `  - You're ON PACE. Hold baseline pillar targets and standard sizing.`,
    `  - Don't reach for yield or stretch concentration — the plan is working.`,
  ].join('\n');
}
