/**
 * Daily digest formatter — turns a DailyPlan + AutoExecuteResult into a clean
 * email summary. Pure function; the caller decides whether/when to actually
 * send.
 *
 * Format rule: prose first, table second. The email should be scannable on
 * mobile in under 10 seconds — the user shouldn't have to open the dashboard
 * to know whether they need to act.
 *
 * Subject-line strategy:
 *   - "Autopilot: <N> needs approval"            when tier-2 items are pending
 *   - "Autopilot: <N> auto-executed today"       when tier-1 fired and nothing pending
 *   - "Autopilot: defense mode active"           when gates are tripped
 *   - "Autopilot: all clear"                     suppressed entirely (no email sent)
 *
 * Sending policy: caller checks `shouldSend()` and only fires when it returns
 * true. Clean days produce no email — autopilot should be quiet by default so
 * the user pays attention when an email actually lands.
 */

import type { DailyPlan } from './daily-plan';
import type { AutoExecuteResult } from './auto-execute';
import type { CronHealth } from './cron-health';
import type { StoredAlert } from '../storage';
import type { RebalanceCronResult } from '../rebalance/cron';

export interface DigestInput {
  plan:        DailyPlan;
  autoExecute?: AutoExecuteResult;
  /** Absolute URL to the dashboard, e.g. https://triplecs.netlify.app/dashboard. */
  dashboardUrl?: string;
  /** Optional cron health snapshot — surfaced as a warning when stale. */
  cronHealth?: CronHealth;
  /**
   * Optional alerts written by the morning daily-alert cron earlier today.
   * Filtered to "unread, today only" by the caller so the digest reflects
   * only fresh alerts from this calendar day.
   */
  morningAlerts?: StoredAlert[];
  /**
   * Optional drift-rebalance result from the daily-rebalance cron. Renders
   * a brief per-account summary at the bottom so the user can see which
   * accounts drifted enough to stage rebalance orders.
   */
  rebalance?: RebalanceCronResult;
}

export interface FormattedDigest {
  subject: string;
  text:    string;
  html:    string;
  /** Stable per-day key to dedupe repeated cron retries. */
  idempotencyKey: string;
}

/**
 * Should we send an email for this digest? Historically this gated the
 * after-close signal-engine cron's email — the engine was "quiet by default"
 * and only emailed on actionable days.
 *
 * As of 2026-05 the consolidating cron (daily-rebalance) calls buildDigest
 * directly and ALWAYS sends weekday emails, so this function is no longer on
 * that critical path. It's still exported because the manual /api/recap-stats
 * route and a few ad-hoc tools call it to decide whether to nudge the user.
 */
export function shouldSend(input: DigestInput): boolean {
  const { plan, autoExecute, cronHealth, morningAlerts, rebalance } = input;
  // Always send when defense or kill switch is active — the user needs to know.
  if (plan.inDefenseMode || plan.killSwitchActive) return true;
  // Always send when the engine is stale or errored — most important signal.
  if (cronHealth?.isStale) return true;
  // Send when anything needs approval.
  if (plan.counts.approval > 0) return true;
  // Send when auto-execute actually placed orders.
  if (autoExecute && autoExecute.executed > 0) return true;
  // Send when auto-execute was tripped by circuit breaker.
  if (autoExecute && autoExecute.breakerTripped) return true;
  // Send when the morning alert cron flagged anything at danger/warn level.
  if (morningAlerts && morningAlerts.some((a) => a.level !== 'ok')) return true;
  // Send when the drift-rebalance cron staged orders.
  if (rebalance && rebalance.accounts.some((a) => a.staged > 0)) return true;
  // Otherwise: clean day, no email.
  return false;
}

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  return n.toLocaleString('en-US', {
    style:                'currency',
    currency:             'USD',
    maximumFractionDigits: 0,
  });
}

function buildSubject(
  plan: DailyPlan,
  autoExecute?: AutoExecuteResult,
  cronHealth?: CronHealth,
  morningAlerts?: StoredAlert[],
  rebalance?: RebalanceCronResult,
): string {
  if (cronHealth?.isStale)               return 'Autopilot: engine is stale';
  if (plan.killSwitchActive)             return 'Autopilot: kill switch tripped';
  if (plan.inDefenseMode)                return 'Autopilot: defense mode active';
  if (morningAlerts && morningAlerts.some((a) => a.level === 'danger')) {
    const n = morningAlerts.filter((a) => a.level === 'danger').length;
    return `Autopilot: ${n} morning alert${n === 1 ? '' : 's'}`;
  }
  if (plan.counts.approval > 0) {
    return `Autopilot: ${plan.counts.approval} item${plan.counts.approval === 1 ? '' : 's'} need${plan.counts.approval === 1 ? 's' : ''} approval`;
  }
  if (autoExecute && autoExecute.executed > 0) {
    return `Autopilot: ${autoExecute.executed} trade${autoExecute.executed === 1 ? '' : 's'} executed`;
  }
  if (autoExecute && autoExecute.breakerTripped) {
    return 'Autopilot: circuit breaker tripped';
  }
  const rebalanceStaged = rebalance?.accounts.reduce((s, a) => s + a.staged, 0) ?? 0;
  if (rebalanceStaged > 0) {
    return `Autopilot: drift rebalance staged ${rebalanceStaged} order${rebalanceStaged === 1 ? '' : 's'}`;
  }
  return 'Autopilot: daily summary';
}

function actionLine(prefix: string, ticker: string, dir: string, size: number, rule: string): string {
  const verb  = dir === 'BUY' ? 'Buy' : dir === 'SELL' ? 'Sell' : dir;
  const label = friendlyRuleName(rule);
  if (size > 0) {
    return `${prefix} ${verb} ${fmt$(size)} of ${ticker} (${label})`;
  }
  return `${prefix} ${verb} ${ticker} (${label})`;
}

/** Friendly rule name — mirrors lib/friendly.ts RULE_LABELS (kept dependency-free
 *  so the digest builder stays importable from Netlify functions). */
function friendlyRuleName(ruleId: string): string {
  const map: Record<string, string> = {
    AFW_TRIGGER:              'dip buying',
    TRIPLES_DIP_LADDER:       'dip buying',
    MAINTENANCE_RANKED_TRIM:  'margin relief',
    PILLAR_FILL:              'rebalance',
    DEFENSE_MODE:             'defense mode',
    KILL_SWITCH:              'crash brake',
    AIRBAG_SCALE:             'auto-hedging',
    LEVERAGE_REDUCTION_ALERT: 'trim triples',
    CLM_CRF_TRIM:             'cornerstone trim',
  };
  for (const [id, label] of Object.entries(map)) {
    if (ruleId.startsWith(id)) return label;
  }
  return ruleId.replace(/_/g, ' ').toLowerCase();
}

/**
 * Group plan actions by account so the digest can render
 *   Tier 1 — Roth: …
 *           Taxable: …
 * instead of one flat list. Untagged actions (legacy / no accountHash) fall
 * into the "—" bucket and are rendered last.
 */
function groupByAccount<T extends { accountHash?: string }>(items: T[]): Array<{ hash: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const key = it.accountHash || '—';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  return Array.from(map.entries())
    // Put untagged ("—") last; everything else sorts by hash for stable output.
    .sort(([a], [b]) => (a === '—' ? 1 : b === '—' ? -1 : a.localeCompare(b)))
    .map(([hash, items]) => ({ hash, items }));
}

/** Short, scannable identifier for an account hash in the digest. */
function shortHash(hash: string): string {
  if (hash === '—' || !hash) return 'unassigned';
  return `${hash.slice(0, 6)}…`;
}

export function buildDigest(input: DigestInput): FormattedDigest {
  const { plan, autoExecute, dashboardUrl, cronHealth, morningAlerts, rebalance } = input;
  const subject = buildSubject(plan, autoExecute, cronHealth, morningAlerts, rebalance);

  // ─── Plain text body ────────────────────────────────────────────────────────
  const lines: string[] = [];
  const afwSuffix = typeof plan.afwDollars === 'number'
    ? ` · AFW ${fmt$(plan.afwDollars)}`
    : '';
  lines.push(`Portfolio: ${fmt$(plan.totalValue)} · Borrowing ${plan.marginUtilizationPct.toFixed(1)}%${afwSuffix}`);
  lines.push(`Automation: ${plan.autoExecuteMode === 'auto' ? 'on — low-risk trades run themselves' : plan.autoExecuteMode === 'dry-run' ? 'dry run — nothing actually trades' : 'manual — everything waits for your approval'}`);
  if (cronHealth?.isStale)   lines.push(`⚠ Heads up: the engine hasn't run on schedule. ${cronHealth.reason}`);
  if (plan.inDefenseMode)    lines.push('⚠ Defense mode is on — your equity ratio is low, so no new buying until the account recovers.');
  if (plan.killSwitchActive) lines.push('⚠ The crash brake is on — borrowing grew too fast, so all new purchases are paused until you reset it.');
  lines.push('');

  if (autoExecute) {
    if (autoExecute.executed > 0) {
      lines.push(`Auto-executed today: ${autoExecute.executed}`);
    }
    if (autoExecute.breakerTripped) {
      lines.push(`Circuit breaker: ${autoExecute.breakerReason}`);
    }
    // Per-account breakdown — surfaces "Roth: 2 placed, Taxable: paused
    // (breaker)" so the digest reflects which accounts actually fired.
    if (autoExecute.byAccount && autoExecute.byAccount.length > 1) {
      lines.push('Per-account:');
      for (const a of autoExecute.byAccount) {
        const head = `  [${shortHash(a.accountHash)}] mode=${a.mode}`;
        const exec = a.executed > 0 ? ` placed=${a.executed}` : '';
        const brk  = a.breakerTripped ? ` breaker=${a.breakerReason || 'tripped'}` : '';
        const rej  = a.rejectedCount > 0 ? ` rejected=${a.rejectedCount}` : '';
        lines.push(`${head}${exec}${rej}${brk}`);
      }
    }
    if (autoExecute.rejected.length > 0) {
      lines.push(`Rejected by gates/caps: ${autoExecute.rejected.length}`);
      for (const r of autoExecute.rejected.slice(0, 5)) {
        lines.push(`  • ${r.instruction} ${r.symbol} — ${r.reason}`);
      }
      if (autoExecute.rejected.length > 5) {
        lines.push(`  …and ${autoExecute.rejected.length - 5} more`);
      }
    }
    lines.push('');
  }

  // ── Tier 1 / Tier 2 / Tier 3 — grouped by account ─────────────────────
  // When multiple accounts have items, the digest shows a sub-header per
  // account so the reader can tell at a glance which account each trade is
  // for. With one account (single-account user, or all items unbucketed)
  // the header is omitted to keep the digest compact.
  if (plan.actions.auto.length > 0) {
    lines.push(`RUNS AUTOMATICALLY (${plan.actions.auto.length}):`);
    const groups = groupByAccount(plan.actions.auto);
    const multi  = groups.length > 1;
    for (const g of groups) {
      if (multi) lines.push(`  [${shortHash(g.hash)}]`);
      for (const a of g.items) {
        lines.push(`  ${actionLine('•', a.ticker, a.direction, a.sizeDollars, a.rule)}`);
      }
    }
    lines.push('');
  }

  if (plan.actions.approval.length > 0) {
    lines.push(`WAITING FOR YOU (${plan.actions.approval.length}):`);
    const groups = groupByAccount(plan.actions.approval);
    const multi  = groups.length > 1;
    for (const g of groups) {
      if (multi) lines.push(`  [${shortHash(g.hash)}]`);
      for (const a of g.items) {
        lines.push(`  ${actionLine('•', a.ticker, a.direction, a.sizeDollars, a.rule)}`);
        lines.push(`    ${a.reason}`);
      }
    }
    lines.push('');
  }

  if (plan.actions.alert.length > 0) {
    // Alerts don't always carry an accountHash (some are household-level
    // gates like DEFENSE_MODE). Group anyway so per-account alerts surface
    // clearly when present.
    lines.push(`WORTH KNOWING — no trade needed (${plan.actions.alert.length}):`);
    const groups = groupByAccount(plan.actions.alert);
    const multi  = groups.length > 1;
    for (const g of groups) {
      if (multi) lines.push(`  [${shortHash(g.hash)}]`);
      for (const a of g.items) {
        lines.push(`  • ${friendlyRuleName(a.rule)}: ${a.reason}`);
      }
    }
    lines.push('');
  }

  // ── Morning alert digest (from daily-alert cron earlier today) ───────────
  if (morningAlerts && morningAlerts.length > 0) {
    const danger = morningAlerts.filter((a) => a.level === 'danger');
    const warn   = morningAlerts.filter((a) => a.level === 'warn');
    const ok     = morningAlerts.filter((a) => a.level === 'ok');
    lines.push(
      `MORNING CHECK — ${danger.length} danger / ${warn.length} warn / ${ok.length} ok:`,
    );
    for (const a of [...danger, ...warn]) {
      const tag = a.level === 'danger' ? '⛔' : '⚠';
      lines.push(`  ${tag} ${a.rule}: ${a.detail}`);
    }
    if (danger.length === 0 && warn.length === 0) {
      lines.push('  • All clear at open.');
    }
    lines.push('');
  }

  // ── Drift rebalance summary (from daily-rebalance cron just now) ─────────
  if (rebalance && rebalance.accounts.length > 0) {
    const staged = rebalance.accounts.reduce((s, a) => s + a.staged, 0);
    const drifted = rebalance.accounts.filter((a) => a.drift > 2);
    lines.push(
      `DRIFT REBALANCE — ${rebalance.accounts.length} account(s), ` +
        `${drifted.length} drifted, ${staged} order(s) staged:`,
    );
    for (const a of rebalance.accounts) {
      const tag = a.skipped
        ? `skipped (${a.skipped})`
        : a.error
        ? `error: ${a.error}`
        : `staged ${a.staged}`;
      lines.push(`  [${shortHash(a.accountHash)}] drift=${a.drift.toFixed(1)}% — ${tag}`);
    }
    lines.push('');
  }

  if (
    plan.counts.total === 0 &&
    !autoExecute?.executed &&
    !(morningAlerts && morningAlerts.some((a) => a.level !== 'ok')) &&
    !(rebalance && rebalance.accounts.some((a) => a.staged > 0))
  ) {
    lines.push('Engine ran clean — no actions today.');
    lines.push('');
  }

  if (dashboardUrl) {
    lines.push(`Dashboard: ${dashboardUrl}#daily-plan`);
  }

  const text = lines.join('\n');

  // ─── HTML body ──────────────────────────────────────────────────────────────
  const html = renderHtml(plan, autoExecute, dashboardUrl, morningAlerts, rebalance);

  // ─── Idempotency: one digest per date ───────────────────────────────────────
  const date = new Date(plan.generatedAt).toISOString().slice(0, 10);
  const idempotencyKey = `daily-digest-${date}`;

  return { subject, text, html, idempotencyKey };
}

function renderHtml(
  plan: DailyPlan,
  autoExecute: AutoExecuteResult | undefined,
  dashboardUrl?: string,
  morningAlerts?: StoredAlert[],
  rebalance?: RebalanceCronResult,
): string {
  const section = (color: string, title: string, rows: string[]): string => {
    if (rows.length === 0) return '';
    return `
      <h3 style="margin: 16px 0 6px; color: ${color}; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;">
        ${title}
      </h3>
      <ul style="margin: 0 0 12px; padding-left: 18px; list-style: none;">
        ${rows.map((r) => `<li style="margin: 4px 0;">${r}</li>`).join('')}
      </ul>
    `;
  };

  const actionRowHtml = (a: DailyPlan['actions']['auto'][number]): string => {
    const sizeStr = a.sizeDollars > 0 ? `<strong>${fmt$(a.sizeDollars)}</strong> ` : '';
    return `
      <span style="font-family: monospace; font-weight: 600;">${a.direction} ${a.ticker}</span>
      ${sizeStr}
      <span style="color: #666;">[${a.rule}]</span><br>
      <span style="color: #555; font-size: 13px;">${a.reason}</span>
    `;
  };

  const tier1 = section('#10b981', 'Runs automatically',            plan.actions.auto.map(actionRowHtml));
  const tier2 = section('#f59e0b', 'Waiting for you',               plan.actions.approval.map(actionRowHtml));
  const tier3 = section('#06b6d4', 'Worth knowing — no trade needed', plan.actions.alert.map(actionRowHtml));

  // Morning alert rows
  const morningRows = (morningAlerts ?? [])
    .filter((a) => a.level !== 'ok')
    .map((a) => {
      const color = a.level === 'danger' ? '#dc2626' : '#f59e0b';
      return `<span style="color: ${color}; font-weight: 600;">${a.level.toUpperCase()}</span> <strong>${a.rule}</strong><br><span style="color: #555; font-size: 13px;">${a.detail}</span>`;
    });
  const morningSection =
    morningAlerts && morningAlerts.length > 0
      ? section('#8b5cf6', 'Morning check', morningRows.length > 0 ? morningRows : ['<em style="color: #888;">All clear at open.</em>'])
      : '';

  // Drift rebalance rows
  const rebalanceRows = (rebalance?.accounts ?? []).map((a) => {
    const driftColor = a.drift > 5 ? '#dc2626' : a.drift > 2 ? '#f59e0b' : '#10b981';
    const status = a.skipped
      ? `<span style="color: #888;">skipped (${a.skipped})</span>`
      : a.error
      ? `<span style="color: #dc2626;">error: ${a.error}</span>`
      : a.staged > 0
      ? `<strong>${a.staged}</strong> order${a.staged === 1 ? '' : 's'} staged`
      : `<span style="color: #888;">no action</span>`;
    return `<code style="font-family: monospace;">${a.accountHash.slice(0, 8)}…</code> drift <span style="color: ${driftColor}; font-weight: 600;">${a.drift.toFixed(1)}%</span> — ${status}`;
  });
  const rebalanceSection =
    rebalance && rebalance.accounts.length > 0
      ? section('#0ea5e9', 'Drift rebalance', rebalanceRows)
      : '';

  const gateWarning =
    plan.killSwitchActive ? '<p style="color: #dc2626; font-weight: bold;">⚠ Margin kill switch tripped — all new purchases paused.</p>' :
    plan.inDefenseMode    ? '<p style="color: #dc2626; font-weight: bold;">⚠ Defense mode active — equity ratio ≤ 40%.</p>' :
                            '';

  let autoSummary = '';
  if (autoExecute) {
    const bits: string[] = [];
    if (autoExecute.executed > 0) bits.push(`<strong>${autoExecute.executed}</strong> auto-executed`);
    if (autoExecute.breakerTripped) bits.push(`<strong style="color: #dc2626;">circuit breaker tripped</strong> — ${autoExecute.breakerReason}`);
    if (autoExecute.rejected.length > 0) bits.push(`<strong>${autoExecute.rejected.length}</strong> rejected by gates/caps`);
    if (bits.length > 0) {
      autoSummary = `<p style="color: #555;">${bits.join(' · ')}</p>`;
    }
  }

  const dashboardLink = dashboardUrl
    ? `<p style="margin-top: 20px;"><a href="${dashboardUrl}#daily-plan" style="background: #10b981; color: white; padding: 8px 16px; text-decoration: none; border-radius: 6px; display: inline-block;">Open dashboard</a></p>`
    : '';

  return `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #222;">
  <h2 style="margin: 0 0 4px;">Daily autopilot summary</h2>
  <p style="color: #666; margin: 0 0 16px; font-size: 14px;">
    Portfolio <strong>${fmt$(plan.totalValue)}</strong>
    · Margin <strong>${plan.marginUtilizationPct.toFixed(1)}%</strong>
    ${typeof plan.afwDollars === 'number' ? `· AFW <strong>${fmt$(plan.afwDollars)}</strong>` : ''}
    · Mode <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 3px;">${plan.autoExecuteMode}</code>
  </p>
  ${gateWarning}
  ${autoSummary}
  ${morningSection}
  ${tier1}
  ${tier2}
  ${tier3}
  ${rebalanceSection}
  ${plan.counts.total === 0
    && !autoExecute?.executed
    && !(morningAlerts && morningAlerts.some((a) => a.level !== 'ok'))
    && !(rebalance && rebalance.accounts.some((a) => a.staged > 0))
    ? '<p style="color: #888; font-style: italic;">Engine ran clean — no actions today.</p>'
    : ''}
  ${dashboardLink}
</body>
</html>
  `.trim();
}
