/**
 * Storage abstraction layer — Netlify Blobs (production).
 * For local dev, tokens are stored in .data/ via the Netlify CLI dev server
 * which emulates Blobs locally. Run: `netlify dev` instead of `npm run dev`.
 */

import { getStore } from '@netlify/blobs';
import type { SchwabTokens } from './schwab/types';

// ─── Token storage ────────────────────────────────────────────────────────────

export async function saveTokens(tokens: SchwabTokens): Promise<void> {
  await getStore('schwab-tokens').setJSON('current-user', tokens);
}

export async function getTokens(): Promise<SchwabTokens | null> {
  return getStore('schwab-tokens').get('current-user', { type: 'json' });
}

export async function deleteTokens(): Promise<void> {
  await getStore('schwab-tokens').delete('current-user');
}

export async function hasTokens(): Promise<boolean> {
  const t = await getTokens();
  return t !== null;
}

// ─── Portfolio cache ──────────────────────────────────────────────────────────

interface CachedPortfolio {
  data: unknown;
  cachedAt: number;
}

export async function cachePortfolio(accountNumber: string, data: unknown): Promise<void> {
  await getStore('portfolio-cache').setJSON(`portfolio-${accountNumber}`, {
    data,
    cachedAt: Date.now(),
  } satisfies CachedPortfolio);
}

export async function getCachedPortfolio(
  accountNumber: string,
  maxAgeMs = 60_000,
): Promise<unknown | null> {
  const cached = await getStore('portfolio-cache').get(
    `portfolio-${accountNumber}`,
    { type: 'json' },
  ) as CachedPortfolio | null;
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > maxAgeMs) return null;
  return cached.data;
}

// ─── AI Analysis history ──────────────────────────────────────────────────────

export interface AnalysisRecord {
  id: string;
  createdAt: number;
  accountHash: string;
  prompt: string;
  analysis: string;
}

export async function saveAnalysis(record: AnalysisRecord): Promise<void> {
  await getStore('ai-analysis').setJSON(`analysis-${record.id}`, record);
}

export async function listAnalyses(accountHash: string): Promise<AnalysisRecord[]> {
  const store = getStore('ai-analysis');
  const { blobs } = await store.list({ prefix: 'analysis-' });
  const records = await Promise.all(
    blobs.map((b) => store.get(b.key, { type: 'json' }) as Promise<AnalysisRecord>)
  );
  return records
    .filter((r): r is AnalysisRecord => r !== null && r.accountHash === accountHash)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
}
