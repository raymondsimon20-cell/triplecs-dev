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

export interface DigestInput {
  plan:        DailyPlan;
  autoExecute?: AutoExecuteResult;
  /** Absolute URL to the dashboard, e.g. https://triplecs.netlify.app/dashboard. */
  dashboardUrl?: string;
  /** Optional cron health snapshot — surfaced as a warning when stale. */
  cronHealth?: CronHealth;
}

export interface FormattedDigest {
  subject: string;
  text:    string;
  html:    string;
  /** Stable per-day key to dedupe repeated cron retries. */
  idempotencyKey: string;
}

/**
 * Should we send an email for this digest? Returns false when nothing
 * actionable happened. Conservative: when in doubt, send.
 */
export function shouldSend(input: DigestInput): boolean {
  const { plan, autoExecute, cronHealth } = input;
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

function buildSubject(plan: DailyPlan, autoExecute?: AutoExecuteResult, cronHealth?: CronHealth): string {
  if (cronHealth?.isStale)               return 'Autopilot: engine is stale';
  if (plan.killSwitchActive)             return 'Autopilot: kill switch tripped';
  if (plan.inDefenseMode)                return 'Autopilot: defense mode active';
  if (plan.counts.approval > 0) {
    return `Autopilot: ${plan.counts.approval} item${plan.counts.approval === 1 ? '' : 's'} need${plan.counts.approval === 1 ? 's' : ''} approval`;
  }
  if (autoExecute && autoExecute.executed > 0) {
    return `Autopilot: ${autoExecute.executed} trade${autoExecute.executed === 1 ? '' : 's'} executed`;
  }
  if (autoExecute && autoExecute.breakerTripped) {
    return 'Autopilot: circuit breaker tripped';
  }
  return 'Autopilot: daily summary';
}

function actionLine(prefix: string, ticker: string, dir: string, size: number, rule: string): string {
  if (size > 0) {
    return `${prefix} ${dir} ${ticker} ${fmt$(size)} — ${rule}`;
  }
  return `${prefix} ${dir} ${ticker} — ${rule}`;
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
  const { plan, autoExecute, dashboardUrl, cronHealth } = input;
  const subject = buildSubject(plan, autoExecute, cronHealth);

  // ─── Plain text body ────────────────────────────────────────────────────────
  const lines: string[] = [];
  const afwSuffix = typeof plan.afwDollars === 'number'
    ? ` · AFW ${fmt$(plan.afwDollars)}`
    : '';
  lines.push(`Portfolio: ${fmt$(plan.totalValue)} · Margin ${plan.marginUtilizationPct.toFixed(1)}%${afwSuffix}`);
  lines.push(`Mode: ${plan.autoExecuteMode}`);
  if (cronHealth?.isStale)   lines.push(`⚠ Engine health: ${cronHealth.reason}`);
  if (plan.inDefenseMode)    lines.push('⚠ Defense mode is active — new buys suppressed.');
  if (plan.killSwitchActive) lines.push('⚠ Margin kill switch is tripped — all new purchases paused.');
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
    lines.push(`TIER 1 — Auto-eligible (${plan.actions.auto.length}):`);
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
    lines.push(`TIER 2 — Needs approval (${plan.actions.approval.length}):`);
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
    lines.push(`TIER 3 — Alerts (${plan.actions.alert.length}):`);
    const groups = groupByAccount(plan.actions.alert);
    const multi  = groups.length > 1;
    for (const g of groups) {
      if (multi) lines.push(`  [${shortHash(g.hash)}]`);
      for (const a of g.items) {
        lines.push(`  • ${a.rule}: ${a.reason}`);
      }
    }
    lines.push('');
  }

  if (plan.counts.total === 0 && !autoExecute?.executed) {
    lines.push('Engine ran clean — no actions today.');
    lines.push('');
  }

  if (dashboardUrl) {
    lines.push(`Dashboard: ${dashboardUrl}#daily-plan`);
  }

  const text = lines.join('\n');

  // ─── HTML body ──────────────────────────────────────────────────────────────
  const html = renderHtml(plan, autoExecute, dashboardUrl);

  // ─── Idempotency: one digest per date ───────────────────────────────────────
  const date = new Date(plan.generatedAt).toISOString().slice(0, 10);
  const idempotencyKey = `daily-digest-${date}`;

  return { subject, text, html, idempotencyKey };
}

function renderHtml(plan: DailyPlan, autoExecute: AutoExecuteResult | undefined, dashboardUrl?: string): string {
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

  const tier1 = section('#10b981', 'Tier 1 — Auto-eligible', plan.actions.auto.map(actionRowHtml));
  const tier2 = section('#f59e0b', 'Tier 2 — Needs approval', plan.actions.approval.map(actionRowHtml));
  const tier3 = section('#06b6d4', 'Tier 3 — Alerts',         plan.actions.alert.map(actionRowHtml));

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
  ${tier1}
  ${tier2}
  ${tier3}
  ${plan.counts.total === 0 && !autoExecute?.executed
    ? '<p style="color: #888; font-style: italic;">Engine ran clean — no actions today.</p>'
    : ''}
  ${dashboardLink}
</body>
</html>
  `.trim();
}
