'use client';

import { useMemo } from 'react';
import {
  Sun, Moon, Sunrise, TrendingUp, TrendingDown, AlertTriangle, Gauge,
  Scale, ClipboardList, DollarSign, Sparkles, ArrowRight, CheckCircle2,
  Zap, Shield, BookOpen, Calendar,
} from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import type { RuleAlert } from '@/lib/classify';
import type { StrategyTargets } from '@/lib/utils';
import { fmt$, fmtPct, gainLossColor } from '@/lib/utils';

interface PillarSummaryRow {
  pillar: PillarType;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
  dayGainLoss: number;
}

interface DailyFlowProps {
  totalValue: number;
  equity: number;
  marginBalance: number;
  dayGainLoss: number;
  unrealizedGainLoss: number;
  availableForWithdrawal: number;
  positions: EnrichedPosition[];
  pillarSummary: PillarSummaryRow[];
  marginAlerts: RuleAlert[];
  dividendsTotal: number;
  monthlyIncome: number;
  fireTarget: number;
  strategyTargets: StrategyTargets;
  pendingOrderCount: number;
  onJumpTo: (sectionId: string) => void;
}

type FocusTone = 'danger' | 'warn' | 'info' | 'success';

interface FocusCard {
  id: string;
  tone: FocusTone;
  icon: React.ReactNode;
  title: string;
  detail: string;
  cta: string;
  jumpTo: string;
}

const TONE_STYLES: Record<FocusTone, { bg: string; border: string; accent: string; btn: string }> = {
  danger: {
    bg: 'bg-red-500/5',
    border: 'border-red-500/30',
    accent: 'text-red-400',
    btn: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border-red-500/30',
  },
  warn: {
    bg: 'bg-orange-500/5',
    border: 'border-orange-500/30',
    accent: 'text-orange-400',
    btn: 'bg-orange-500/15 hover:bg-orange-500/25 text-orange-300 border-orange-500/30',
  },
  info: {
    bg: 'bg-blue-500/5',
    border: 'border-blue-500/30',
    accent: 'text-blue-400',
    btn: 'bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border-blue-500/30',
  },
  success: {
    bg: 'bg-emerald-500/5',
    border: 'border-emerald-500/30',
    accent: 'text-emerald-400',
    btn: 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border-emerald-500/30',
  },
};

function greetingFor(hour: number): { label: string; icon: React.ReactNode } {
  if (hour < 12)  return { label: 'Good morning',   icon: <Sunrise className="w-5 h-5 text-amber-300" /> };
  if (hour < 17)  return { label: 'Good afternoon', icon: <Sun className="w-5 h-5 text-yellow-300" /> };
  return              { label: 'Good evening',      icon: <Moon className="w-5 h-5 text-indigo-300" /> };
}

const STRATEGY_TIPS = [
  { icon: Zap,      text: 'Triples thrive on drawdowns. Size entries to at least a 10% correction.' },
  { icon: Shield,   text: 'Cornerstone fuels the compounder — DRIP discounts are a durable edge.' },
  { icon: Scale,    text: 'Margin is a tool, not a destination. Above 20% is the warning lane.' },
  { icon: DollarSign, text: 'Single-family cap is 20%. Cover it with diversified income streams.' },
  { icon: BookOpen, text: 'Your Income pillar is the income engine. Let dividends do the work.' },
];

export function DailyFlow({
  totalValue,
  equity,
  marginBalance,
  dayGainLoss,
  unrealizedGainLoss,
  availableForWithdrawal,
  positions,
  pillarSummary,
  marginAlerts,
  dividendsTotal,
  monthlyIncome,
  fireTarget,
  strategyTargets,
  pendingOrderCount,
  onJumpTo,
}: DailyFlowProps) {
  const now = new Date();
  const hour = now.getHours();
  const greeting = greetingFor(hour);
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const marginAbs = Math.abs(marginBalance);
  const marginDenom = equity + marginAbs;
  const marginPct = marginDenom > 0 ? (marginAbs / marginDenom) * 100 : 0;

  const dayPctOfPortfolio = totalValue > 0 ? (dayGainLoss / totalValue) * 100 : 0;
  const firePct = fireTarget > 0 ? Math.min((monthlyIncome / fireTarget) * 100, 100) : 0;

  // Today's dividends (positions don't have per-day dividend data, so show weekly estimate)
  const weeklyIncome = (monthlyIncome / 30) * 7;

  // Pillar drift detection (portfolioPercent vs targets)
  const pillarDrift = useMemo(() => {
    const targetsByPillar: Record<string, number> = {
      triples: strategyTargets.triplesPct,
      cornerstone: strategyTargets.cornerstonePct,
      income: strategyTargets.incomePct,
      hedge: strategyTargets.hedgePct,
    };
    let worst: { label: string; delta: number; pillar: string } | null = null;
    for (const p of pillarSummary) {
      const target = targetsByPillar[p.pillar];
      if (typeof target !== 'number') continue;
      const delta = p.portfolioPercent - target;
      if (!worst || Math.abs(delta) > Math.abs(worst.delta)) {
        worst = { label: p.label, delta, pillar: p.pillar };
      }
    }
    return worst;
  }, [pillarSummary, strategyTargets]);

  // ── Build Focus cards based on state ──────────────────────────────────────
  const focusCards = useMemo<FocusCard[]>(() => {
    const cards: FocusCard[] = [];

    // 1. Rule violations (highest priority)
    const danger = marginAlerts.filter((a) => a.level === 'danger');
    if (danger.length > 0) {
      cards.push({
        id: 'alerts',
        tone: 'danger',
        icon: <AlertTriangle className="w-4 h-4" />,
        title: `${danger.length} rule violation${danger.length > 1 ? 's' : ''}`,
        detail: danger[0].detail,
        cta: 'Review margin & risk',
        jumpTo: 'margin',
      });
    }

    // 2. Margin
    if (marginPct >= strategyTargets.marginLimitPct) {
      cards.push({
        id: 'margin-critical',
        tone: 'danger',
        icon: <Gauge className="w-4 h-4" />,
        title: `Margin ${marginPct.toFixed(1)}% — over limit`,
        detail: `Above the ${strategyTargets.marginLimitPct}% ceiling. Deleverage before adding risk.`,
        cta: 'Open margin panel',
        jumpTo: 'margin',
      });
    } else if (marginPct >= strategyTargets.marginWarnPct) {
      cards.push({
        id: 'margin-warn',
        tone: 'warn',
        icon: <Gauge className="w-4 h-4" />,
        title: `Margin ${marginPct.toFixed(1)}% — warning zone`,
        detail: `Above the ${strategyTargets.marginWarnPct}% warning line. Watch cost of borrow.`,
        cta: 'Open margin panel',
        jumpTo: 'margin',
      });
    }

    // 3. Pending orders
    if (pendingOrderCount > 0) {
      cards.push({
        id: 'orders',
        tone: 'info',
        icon: <ClipboardList className="w-4 h-4" />,
        title: `${pendingOrderCount} pending order${pendingOrderCount > 1 ? 's' : ''}`,
        detail: 'Working at Schwab. Review, adjust, or cancel before the next session.',
        cta: 'See pending orders',
        jumpTo: 'orders',
      });
    }

    // 4. Pillar drift
    if (pillarDrift && Math.abs(pillarDrift.delta) >= 3) {
      const over = pillarDrift.delta > 0;
      cards.push({
        id: 'drift',
        tone: 'warn',
        icon: <Scale className="w-4 h-4" />,
        title: `${pillarDrift.label} ${over ? 'over' : 'under'} target`,
        detail: `${fmtPct(pillarDrift.delta)} from plan. Use the simplified workflow to bring it home.`,
        cta: 'Start rebalance',
        jumpTo: 'workflow',
      });
    }

    // 5. Big red day
    if (dayPctOfPortfolio <= -2) {
      cards.push({
        id: 'drawdown',
        tone: 'info',
        icon: <TrendingDown className="w-4 h-4" />,
        title: `Portfolio ${fmtPct(dayPctOfPortfolio)} today`,
        detail: 'Pullbacks are opportunity windows. Check the Triples tactical engine.',
        cta: 'Check triples',
        jumpTo: 'triples',
      });
    }

    // 6. FIRE progress milestone
    if (firePct >= 100) {
      cards.push({
        id: 'fire',
        tone: 'success',
        icon: <Sparkles className="w-4 h-4" />,
        title: 'FIRE target reached',
        detail: `Monthly income ${fmt$(monthlyIncome)} covers the ${fmt$(fireTarget)} goal. Stay the course.`,
        cta: 'See income detail',
        jumpTo: 'income',
      });
    } else if (firePct >= 75) {
      cards.push({
        id: 'fire-near',
        tone: 'success',
        icon: <Sparkles className="w-4 h-4" />,
        title: `${firePct.toFixed(0)}% to FIRE`,
        detail: `${fmt$(monthlyIncome)}/mo tracking against ${fmt$(fireTarget)}/mo target.`,
        cta: 'See income detail',
        jumpTo: 'income',
      });
    }

    // 7. Default: all clear
    if (cards.length === 0) {
      cards.push({
        id: 'clear',
        tone: 'success',
        icon: <CheckCircle2 className="w-4 h-4" />,
        title: 'All systems healthy',
        detail: 'Margin within plan, allocation on target, no pending workflow. Patience compounds.',
        cta: 'Read a strategy tip',
        jumpTo: 'strategy',
      });
    }

    return cards.slice(0, 4);
  }, [marginAlerts, marginPct, strategyTargets, pendingOrderCount, pillarDrift, dayPctOfPortfolio, firePct, monthlyIncome, fireTarget]);

  // Rotating tip — pick one deterministically from today's date
  const tip = useMemo(() => {
    const dayIdx = Math.floor(now.getTime() / (1000 * 60 * 60 * 24));
    return STRATEGY_TIPS[dayIdx % STRATEGY_TIPS.length];
  }, [now]);
  const TipIcon = tip.icon;

  const dayUp = dayGainLoss > 0;
  const dayColor = gainLossColor(dayGainLoss);

  return (
    <div className="space-y-5 animate-[fadeIn_0.4s_ease-out]">

      {/* ─── Hero: greeting + portfolio one-liner ────────────────────────── */}
      <div className="relative bg-gradient-to-br from-[#1a1d27] via-[#1a1d27] to-[#161926] border border-[#2d3248] rounded-2xl p-6 sm:p-7 overflow-hidden">
        <div className="absolute -top-16 -right-16 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -left-10 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[#7c82a0] text-xs uppercase tracking-wider mb-2">
              {greeting.icon}
              <span>{greeting.label} · {dateLabel}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white leading-tight">
              Your portfolio is{' '}
              <span className={dayColor}>
                {dayUp ? 'up' : dayGainLoss < 0 ? 'down' : 'flat'}
              </span>{' '}
              today
            </h1>
            <p className="text-sm text-[#7c82a0] mt-1.5">
              {fmt$(totalValue)} across {positions.length} positions ·{' '}
              <span className={dayColor}>
                {dayUp && '+'}{fmt$(dayGainLoss)} ({fmtPct(dayPctOfPortfolio)})
              </span>
            </p>
          </div>

          {/* FIRE pill */}
          <div className="min-w-[180px]">
            <div className="flex items-center justify-between text-[11px] text-[#7c82a0] mb-1.5">
              <span className="uppercase tracking-wider">FIRE progress</span>
              <span className={`tabular-nums font-semibold ${firePct >= 100 ? 'text-emerald-400' : 'text-white'}`}>{firePct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 bg-[#2d3248] rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-700 ${firePct >= 100 ? 'bg-emerald-400' : 'bg-gradient-to-r from-blue-500 to-indigo-400'}`}
                style={{ width: `${firePct}%` }}
              />
            </div>
            <div className="text-[11px] text-[#4a5070] mt-1 tabular-nums">
              {fmt$(monthlyIncome)}/mo · goal {fmt$(fireTarget)}/mo
            </div>
          </div>
        </div>
      </div>

      {/* ─── Today's focus ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-xs uppercase tracking-wider font-semibold text-[#7c82a0]">
            Today&apos;s focus
          </h2>
          <span className="text-[11px] text-[#4a5070]">
            {focusCards.length} item{focusCards.length > 1 ? 's' : ''}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {focusCards.map((card) => {
            const style = TONE_STYLES[card.tone];
            return (
              <div
                key={card.id}
                className={`${style.bg} border ${style.border} rounded-xl p-4 flex flex-col gap-3 transition-all hover:border-opacity-60`}
              >
                <div className="flex items-start gap-3">
                  <div className={`${style.accent} flex-shrink-0 mt-0.5`}>{card.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white leading-snug">{card.title}</div>
                    <p className="text-xs text-[#7c82a0] mt-1 leading-relaxed">{card.detail}</p>
                  </div>
                </div>
                <button
                  onClick={() => onJumpTo(card.jumpTo)}
                  className={`${style.btn} self-start border px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors`}
                >
                  {card.cta}
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ─── Pulse strip ──────────────────────────────────────────────── */}
      <section>
        <h2 className="text-xs uppercase tracking-wider font-semibold text-[#7c82a0] mb-3 px-1">
          Portfolio pulse
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <PulseStat
            label="Value"
            value={fmt$(totalValue)}
            hint={`${positions.length} positions`}
          />
          <PulseStat
            label="Day"
            value={`${dayUp ? '+' : ''}${fmt$(dayGainLoss)}`}
            hint={fmtPct(dayPctOfPortfolio)}
            valueClass={dayColor}
          />
          <PulseStat
            label="Margin"
            value={`${marginPct.toFixed(1)}%`}
            hint={fmt$(marginAbs) + ' borrowed'}
            valueClass={
              marginPct >= strategyTargets.marginLimitPct ? 'text-red-400'
              : marginPct >= strategyTargets.marginWarnPct ? 'text-orange-400'
              : 'text-emerald-400'
            }
          />
          <PulseStat
            label="Cash"
            value={fmt$(availableForWithdrawal)}
            hint="Available"
            valueClass="text-blue-400"
          />
        </div>
      </section>

      {/* ─── Income + quick actions ───────────────────────────────────── */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Income snapshot */}
        <div className="bg-[#1a1d27] border border-[#2d3248] border-l-2 border-l-emerald-500/50 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Income stream</h3>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-1">
            <IncomeCell label="This week" value={fmt$(weeklyIncome)} />
            <IncomeCell label="This month" value={fmt$(monthlyIncome)} />
            <IncomeCell label="Annualized" value={fmt$(monthlyIncome * 12)} valueClass="text-emerald-400" />
          </div>
          <button
            onClick={() => onJumpTo('income')}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-[#7c82a0] hover:text-white border border-[#2d3248] hover:border-[#3d4268] rounded-lg py-2 transition-colors"
          >
            Full income detail
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        {/* Quick actions */}
        <div className="bg-[#1a1d27] border border-[#2d3248] border-l-2 border-l-blue-500/50 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-semibold text-white">Quick actions</h3>
          </div>
          <div className="grid grid-cols-1 gap-2 pt-1">
            <QuickAction
              icon={<Scale className="w-3.5 h-3.5" />}
              label="Rebalance my portfolio"
              onClick={() => onJumpTo('workflow')}
            />
            <QuickAction
              icon={<TrendingUp className="w-3.5 h-3.5" />}
              label="Check market conditions"
              onClick={() => onJumpTo('market')}
            />
            <QuickAction
              icon={<Calendar className="w-3.5 h-3.5" />}
              label="Upcoming distributions"
              onClick={() => onJumpTo('calendar')}
            />
          </div>
        </div>
      </section>

      {/* ─── Tip of the day ───────────────────────────────────────────── */}
      <section className="bg-gradient-to-r from-[#1a1d27] to-[#161926] border border-[#2d3248] rounded-xl p-4 flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
          <TipIcon className="w-4 h-4 text-blue-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-[#7c82a0] font-semibold mb-0.5">
            Strategy reminder
          </div>
          <p className="text-sm text-white leading-relaxed">{tip.text}</p>
        </div>
      </section>

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
      `}</style>
    </div>
  );
}

function PulseStat({
  label, value, hint, valueClass = 'text-white',
}: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl px-4 py-3">
      <div className="text-[11px] text-[#7c82a0] uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold tabular-nums mt-0.5 ${valueClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-[#4a5070] mt-0.5 tabular-nums truncate">{hint}</div>}
    </div>
  );
}

function IncomeCell({
  label, value, valueClass = 'text-white',
}: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <div className="text-[11px] text-[#7c82a0] uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}

function QuickAction({
  icon, label, onClick,
}: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between gap-2 bg-[#0f1117] hover:bg-white/[0.03] border border-[#2d3248] hover:border-[#3d4268] rounded-lg px-3 py-2.5 text-left transition-colors group"
    >
      <span className="flex items-center gap-2 text-sm text-white">
        <span className="text-[#7c82a0] group-hover:text-blue-400 transition-colors">{icon}</span>
        {label}
      </span>
      <ArrowRight className="w-3.5 h-3.5 text-[#4a5070] group-hover:text-white transition-colors" />
    </button>
  );
}
