/**
 * Portfolio health score — one 0–100 number synthesizing margin, pillar
 * drift, concentration, and the hedge floor, plus the top reason it isn't
 * 100. Pure and deterministic so it can be unit-tested and shown anywhere.
 */

export interface HealthInputs {
  marginUtilPct: number;          // 0–100
  marginWarnPct?: number;         // default 20
  marginLimitPct?: number;        // default 30
  /** Per-pillar drift from target in percentage points (absolute). */
  pillarDriftPp: { triples: number; cornerstone: number; income: number; hedge: number };
  /** Largest single position as % of portfolio (seeds excluded upstream). */
  maxConcentrationPct: number;
  /** Hedge pillar as % of portfolio. */
  hedgePct: number;
  killSwitchActive?: boolean;
  inDefenseMode?: boolean;
}

export interface HealthResult {
  score: number; // 0–100
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  /** The single biggest deduction, in plain English. */
  topIssue: string | null;
  deductions: { reason: string; points: number }[];
}

export function healthScore(h: HealthInputs): HealthResult {
  const warn  = h.marginWarnPct ?? 20;
  const limit = h.marginLimitPct ?? 30;
  const deductions: { reason: string; points: number }[] = [];

  // Margin: 0 pts inside comfort, scaling to −40 at the Schwab 50% cap.
  if (h.marginUtilPct >= 50) {
    deductions.push({ reason: `Borrowing is at the broker's 50% hard cap`, points: 40 });
  } else if (h.marginUtilPct >= limit) {
    const t = (h.marginUtilPct - limit) / (50 - limit);
    deductions.push({ reason: `Borrowing is ${h.marginUtilPct.toFixed(0)}% — above your ${limit}% limit`, points: Math.round(20 + t * 20) });
  } else if (h.marginUtilPct >= warn) {
    const t = (h.marginUtilPct - warn) / (limit - warn);
    deductions.push({ reason: `Borrowing is ${h.marginUtilPct.toFixed(0)}% — in the caution zone`, points: Math.round(5 + t * 15) });
  }

  // Pillar drift: −1.5 pts per pp of drift beyond 3pp, capped at 25.
  const totalDrift = Object.values(h.pillarDriftPp).reduce((s, d) => s + Math.max(0, Math.abs(d) - 3), 0);
  if (totalDrift > 0) {
    const worst = (Object.entries(h.pillarDriftPp) as [string, number][])
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    deductions.push({
      reason: `${worst[0].charAt(0).toUpperCase() + worst[0].slice(1)} is ${Math.abs(worst[1]).toFixed(0)}pp ${worst[1] > 0 ? 'over' : 'under'} its target`,
      points: Math.min(25, Math.round(totalDrift * 1.5)),
    });
  }

  // Concentration: over 15% warn, −1 pt per 0.5pp past 15, capped at 20.
  if (h.maxConcentrationPct > 15) {
    deductions.push({
      reason: `One position is ${h.maxConcentrationPct.toFixed(0)}% of the portfolio (cap 20%)`,
      points: Math.min(20, Math.round((h.maxConcentrationPct - 15) * 2)),
    });
  }

  // Hedge floor: below 1% costs 10 points.
  if (h.hedgePct < 1) {
    deductions.push({ reason: 'Hedges are below the 1% minimum — no crash insurance', points: 10 });
  }

  if (h.killSwitchActive) deductions.push({ reason: 'The crash brake is on — borrowing grew too fast', points: 15 });
  if (h.inDefenseMode)    deductions.push({ reason: 'Defense mode — equity ratio is low', points: 15 });

  const total = deductions.reduce((s, d) => s + d.points, 0);
  const score = Math.max(0, 100 - total);
  const sorted = [...deductions].sort((a, b) => b.points - a.points);

  return {
    score,
    grade: score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 55 ? 'fair' : 'poor',
    topIssue: sorted[0]?.reason ?? null,
    deductions: sorted,
  };
}
