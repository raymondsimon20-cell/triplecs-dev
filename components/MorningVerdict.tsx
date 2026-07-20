'use client';

/**
 * MorningVerdict — the one-sentence answer to "do I need to do anything
 * today?", shown at the top of the dashboard. Deterministic; no AI call.
 * Pulls plan counts + kill-switch/defense state from the daily-plan endpoint
 * itself so parents only supply account-level numbers.
 */

import { useEffect, useState } from 'react';
import { healthScore, type HealthInputs } from '@/lib/health-score';
import { marginZone } from '@/lib/friendly';

export interface MorningVerdictProps {
  dayGainLoss: number;
  marginUtilPct: number;
  marginWarnPct?: number;
  marginLimitPct?: number;
  health: Omit<HealthInputs, 'killSwitchActive' | 'inDefenseMode'>;
}

interface PlanCounts {
  approval: number;
  alert: number;
  killSwitchActive: boolean;
  inDefenseMode: boolean;
}

export function MorningVerdict(p: MorningVerdictProps) {
  const [plan, setPlan] = useState<PlanCounts>({ approval: 0, alert: 0, killSwitchActive: false, inDefenseMode: false });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/signals/daily-plan')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.counts) return;
        setPlan({
          approval:         d.counts.approval ?? 0,
          alert:            d.counts.alert ?? 0,
          killSwitchActive: !!d.killSwitchActive,
          inDefenseMode:    !!d.inDefenseMode,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const zone   = marginZone(p.marginUtilPct, p.marginWarnPct, p.marginLimitPct);
  const health = healthScore({ ...p.health, killSwitchActive: plan.killSwitchActive, inDefenseMode: plan.inDefenseMode });

  const dayPart =
    p.dayGainLoss === 0
      ? 'Portfolio flat today.'
      : `Portfolio ${p.dayGainLoss > 0 ? 'up' : 'down'} $${Math.abs(Math.round(p.dayGainLoss)).toLocaleString()} today.`;
  const marginPart = `Borrowing ${zone.word.toLowerCase()} at ${p.marginUtilPct.toFixed(0)}%.`;
  const actionPart =
    plan.approval > 0
      ? `${plan.approval} trade${plan.approval === 1 ? '' : 's'} waiting for your OK.`
      : plan.alert > 0
        ? `${plan.alert} alert${plan.alert === 1 ? '' : 's'} worth a look — no trades needed.`
        : 'Nothing needs your attention.';

  const scoreColor =
    health.score >= 90 ? 'text-emerald-400' :
    health.score >= 75 ? 'text-emerald-300' :
    health.score >= 55 ? 'text-amber-400'   : 'text-red-400';

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[#2d3248] bg-[#1a1d27] px-5 py-4">
      <div>
        <p className="text-sm text-white leading-relaxed">
          {dayPart} {marginPart} <span className="font-semibold">{actionPart}</span>
        </p>
        {health.topIssue && health.score < 90 && (
          <p className="text-xs text-[#7c82a0] mt-1">Biggest drag on your score: {health.topIssue}.</p>
        )}
      </div>
      <div className="text-center shrink-0" title={health.deductions.map((d) => `−${d.points}: ${d.reason}`).join('\n') || 'No deductions'}>
        <div className={`text-2xl font-semibold tabular-nums ${scoreColor}`}>{health.score}</div>
        <div className="text-[10px] text-[#4a5070] capitalize">{health.grade} health</div>
      </div>
    </div>
  );
}
