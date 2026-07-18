/** Daily digest email: plan summary + alerts + cron health. */
import type { DailyPlan } from './daily-plan';
import { getCronHealth, findStaleJobs } from './cron-health';

export function renderDigestHtml(plan: DailyPlan, staleJobs: { job: string; lastStatus: string }[]): string {
  const row = (s: { title: string; rationale: string }) =>
    `<tr><td style="padding:6px 10px;font-weight:600">${s.title}</td><td style="padding:6px 10px;color:#475569">${s.rationale}</td></tr>`;
  return `
  <div style="font-family:system-ui,sans-serif;max-width:640px">
    <h2>Triple C daily digest — ${plan.date}</h2>
    <h3>Auto-executed (${plan.autoExecuted.length})</h3>
    <table>${plan.autoExecuted.map(row).join('') || '<tr><td>None</td></tr>'}</table>
    <h3>Awaiting approval (${plan.trades.length})</h3>
    <table>${plan.trades.map(row).join('') || '<tr><td>None</td></tr>'}</table>
    <h3>Alerts (${plan.alerts.length})</h3>
    <table>${plan.alerts.map(row).join('') || '<tr><td>None</td></tr>'}</table>
    ${
      staleJobs.length
        ? `<h3 style="color:#dc2626">Cron health issues</h3><ul>${staleJobs
            .map((j) => `<li>${j.job}: ${j.lastStatus}</li>`)
            .join('')}</ul>`
        : ''
    }
  </div>`;
}

export async function sendDigest(plan: DailyPlan): Promise<void> {
  const to = process.env.DIGEST_EMAIL_TO;
  const apiKey = process.env.RESEND_API_KEY;
  const health = await getCronHealth();
  const stale = findStaleJobs(health);
  const html = renderDigestHtml(plan, stale);
  if (!to || !apiKey) {
    console.log('[digest] email not configured; digest:\n', html.slice(0, 500));
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Triple C <digest@triple-c.app>',
      to: [to],
      subject: `Triple C digest ${plan.date} — ${plan.trades.length} pending, ${plan.autoExecuted.length} auto`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Digest email failed: ${res.status}`);
}
