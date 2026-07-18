/** Loads recent daily-plan recaps as AI context. */
import { listArchivedDates, loadArchivedPlan } from '@/lib/signals/plan-archive';

export async function buildRecapContext(days = 5): Promise<string> {
  const dates = (await listArchivedDates()).slice(0, days);
  if (dates.length === 0) return '';
  const lines: string[] = [];
  for (const date of dates) {
    const archived = await loadArchivedPlan(date);
    if (!archived) continue;
    const p = archived.plan;
    lines.push(
      `- ${date}: ${p.autoExecuted.length} auto-executed, ${p.trades.length} proposed, ${p.alerts.length} alerts` +
        (p.alerts.length ? ` (${p.alerts.map((a) => a.title).join('; ')})` : '')
    );
  }
  return lines.length ? `\n## Recent engine activity\n${lines.join('\n')}` : '';
}
