/**
 * Feedback context — converts a recap into a compact prompt block that gets
 * injected into rebalance/option/ai-analysis Claude calls.
 *
 * Goal: ~600-900 tokens, dense, machine-readable. Claude gets:
 *   1. Regime context (so it can interpret hit rate against market backdrop)
 *   2. Per-mode track record (hit rate + expectancy + sample size)
 *   3. Top winners + losers (concrete examples it can pattern-match against)
 *   4. What the user has been dismissing (taste signal)
 *
 * The block sits OUTSIDE the cached system prompt so it can refresh per-request
 * without invalidating the cache.
 */

import type { FullRecap, RecOutcome } from '../recap';

const TOP_K = 4;          // top N winners + losers to surface
const RATIONALE_MAX = 90; // truncate rationales to keep block compact

function truncate(s: string | undefined, n = RATIONALE_MAX): string {
  if (!s) return '—';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function fmtPct(n: number, dp = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

function fmtUSD(n: number): string {
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function regimeLabel(spyReturnPct: number | null, drawdownPct: number): string {
  if (spyReturnPct == null) return 'unknown tape';
  if (spyReturnPct >= 5)  return 'strong rally';
  if (spyReturnPct >= 1)  return 'mild uptrend';
  if (spyReturnPct >= -1) return 'flat';
  if (spyReturnPct >= -5) return 'mild pullback';
  if (drawdownPct >= 10)  return 'sharp selloff';
  return 'downtrend';
}

/**
 * Render the full feedback block. Pass the result as part of the user message,
 * AFTER the cached system prompt and BEFORE the task-specific instructions.
 *
 * If the recap is empty (no outcomes in window), returns a short notice instead
 * of pretending we have data.
 */
export function buildFeedbackBlock(recap: FullRecap): string {
  if (recap.outcomes.length === 0) {
    return [
      `═══ AI FEEDBACK CONTEXT (last ${recap.windowDays}d) ═══`,
      `No prior recommendations in window. This is your first measurable rec — be deliberate.`,
      `═══════════════════════════════════════════════════════`,
    ].join('\n');
  }

  const sortedByPnl = [...recap.outcomes].sort((a, b) => b.pnlPct - a.pnlPct);
  const winners = sortedByPnl.slice(0, TOP_K).filter((o) => o.pnlPct > 0);
  const losers  = sortedByPnl.slice(-TOP_K).reverse().filter((o) => o.pnlPct < 0);

  const dismissed = recap.outcomes.filter((o) => o.source === 'dismissed');
  const dismissedHurt = dismissed.filter((o) => o.win === true);   // user said no, AI was right

  const modeRows = recap.byMode.map((m) => {
    const hit = m.wins + m.losses > 0 ? `${m.hitRatePct.toFixed(0)}%` : '—';
    return `  ${m.aiMode.padEnd(20)} n=${String(m.count).padStart(3)}  hit=${hit.padStart(4)}  exp=${fmtPct(m.expectancyPct, 1).padStart(7)}  P&L=${fmtUSD(m.totalPnlDollars).padStart(10)}`;
  }).join('\n');

  const winnerRows = winners.length === 0
    ? '  (none in window)'
    : winners.map((o) => fmtOutcomeRow(o)).join('\n');
  const loserRows = losers.length === 0
    ? '  (none in window)'
    : losers.map((o) => fmtOutcomeRow(o)).join('\n');

  const dismissedNote = dismissed.length === 0
    ? `User has not dismissed any recs in window.`
    : `User dismissed ${dismissed.length} rec${dismissed.length === 1 ? '' : 's'}; ${dismissedHurt.length} of those would have been winners (user's taste signal: avoid these patterns).`;

  const regimeBits = [
    `${recap.regime.windowDays}d window (${recap.regime.startDate} → ${recap.regime.endDate})`,
    recap.regime.spyReturnPct != null ? `SPY ${fmtPct(recap.regime.spyReturnPct, 1)}` : 'SPY unknown',
    `drawdown ${fmtPct(-recap.regime.drawdownPct, 1)}`,
    `regime: ${regimeLabel(recap.regime.spyReturnPct, recap.regime.drawdownPct)}`,
  ].join(' · ');

  return [
    `═══ AI FEEDBACK CONTEXT (last ${recap.windowDays}d) ═══`,
    ``,
    `MARKET REGIME:`,
    `  ${regimeBits}`,
    ``,
    `OVERALL TRACK RECORD:`,
    `  ${recap.totals.executedCount} executed · ${recap.totals.dismissedCount} dismissed · ` +
      `hit ${recap.totals.overallHitRatePct.toFixed(0)}% · ` +
      `expectancy ${fmtPct(recap.totals.overallExpectancyPct, 2)} · ` +
      `P&L ${fmtUSD(recap.totals.totalPnlDollars)}`,
    ``,
    `BY MODE (n=count, hit=win rate decided, exp=avg P&L incl flat):`,
    modeRows,
    ``,
    `TOP WINNERS:`,
    winnerRows,
    ``,
    `TOP LOSERS:`,
    loserRows,
    ``,
    `DISMISSED RECS:`,
    `  ${dismissedNote}`,
    ``,
    `HOW TO USE THIS CONTEXT:`,
    `  - If a mode's expectancy is negative, propose more conservatively (or skip) until it inverts.`,
    `  - If hit rate looks bad in a strong tape, the issue is selection, not luck.`,
    `  - If hit rate looks bad in a sharp selloff, distinguish bad calls from market beta.`,
    `  - If user keeps dismissing certain patterns, stop proposing them (pattern-match the rationales above).`,
    `  - DO NOT become paralyzed by a small bad sample. n<5 is noise, not signal.`,
    `═══════════════════════════════════════════════════════`,
  ].join('\n');
}

function fmtOutcomeRow(o: RecOutcome): string {
  const tag = o.source === 'dismissed' ? '[DISM]' : '[EXEC]';
  return `  ${tag} ${o.instruction.padEnd(13)} ${o.symbol.padEnd(6)} ${fmtPct(o.pnlPct, 1).padStart(7)}  ${fmtUSD(o.pnlDollars).padStart(9)}  ${o.daysHeld.toFixed(0)}d  "${truncate(o.rationale)}"`;
}
