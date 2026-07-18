/** User feedback on past AI analyses, fed back as context. */
import { storage } from '@/lib/storage';

export interface FeedbackEntry {
  date: string;
  analysisId: string;
  rating: 'up' | 'down';
  note?: string;
}

const KEY = 'ai-feedback';

export async function recordFeedback(entry: FeedbackEntry): Promise<void> {
  const all = (await storage.get<FeedbackEntry[]>(KEY)) ?? [];
  all.push(entry);
  await storage.set(KEY, all.slice(-100));
}

export async function buildFeedbackContext(): Promise<string> {
  const all = (await storage.get<FeedbackEntry[]>(KEY)) ?? [];
  const noted = all.filter((f) => f.note).slice(-10);
  if (noted.length === 0) return '';
  return `\n## Owner feedback on past analyses (adjust accordingly)\n${noted
    .map((f) => `- [${f.rating === 'up' ? '+' : '-'}] ${f.date}: ${f.note}`)
    .join('\n')}`;
}
