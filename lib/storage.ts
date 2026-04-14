/**
 * Storage abstraction layer.
 *
 * LOCAL DEV:  Stores data in .data/ folder (git-ignored).
 * NETLIFY:    Swap the implementations below for @netlify/blobs.
 *             Just `npm install @netlify/blobs` and uncomment the Netlify
 *             section at the bottom of this file.
 *
 * The API surface is identical either way, so no other file needs to change.
 */

import fs from 'fs';
import path from 'path';
import type { SchwabTokens } from './schwab/types';

// ─── File-based store (local dev + fallback) ──────────────────────────────────

const DATA_DIR = path.join(process.cwd(), '.data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function storeFile(store: string, key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(DATA_DIR, store);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeKey}.json`);
}

function fileSet(store: string, key: string, value: unknown): void {
  ensureDataDir();
  fs.writeFileSync(storeFile(store, key), JSON.stringify(value), 'utf8');
}

function fileGet<T>(store: string, key: string): T | null {
  try {
    const raw = fs.readFileSync(storeFile(store, key), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function fileDel(store: string, key: string): void {
  try { fs.unlinkSync(storeFile(store, key)); } catch { /* ok */ }
}

function fileList(store: string, prefix: string): string[] {
  const dir = path.join(DATA_DIR, store);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}

// ─── Token storage ────────────────────────────────────────────────────────────

const TOKEN_STORE = 'schwab-tokens';
const TOKEN_KEY = 'current-user';

export async function saveTokens(tokens: SchwabTokens): Promise<void> {
  fileSet(TOKEN_STORE, TOKEN_KEY, tokens);
}

export async function getTokens(): Promise<SchwabTokens | null> {
  return fileGet<SchwabTokens>(TOKEN_STORE, TOKEN_KEY);
}

export async function deleteTokens(): Promise<void> {
  fileDel(TOKEN_STORE, TOKEN_KEY);
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
  fileSet('portfolio-cache', `portfolio-${accountNumber}`, {
    data,
    cachedAt: Date.now(),
  } satisfies CachedPortfolio);
}

export async function getCachedPortfolio(
  accountNumber: string,
  maxAgeMs = 60_000,
): Promise<unknown | null> {
  const cached = fileGet<CachedPortfolio>('portfolio-cache', `portfolio-${accountNumber}`);
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
  fileSet('ai-analysis', `analysis-${record.id}`, record);
}

export async function listAnalyses(accountHash: string): Promise<AnalysisRecord[]> {
  const keys = fileList('ai-analysis', 'analysis-');
  const records = keys
    .map((k) => fileGet<AnalysisRecord>('ai-analysis', k))
    .filter((r): r is AnalysisRecord => r !== null && r.accountHash === accountHash);
  return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

/*
 * ─── NETLIFY BLOBS (production swap) ─────────────────────────────────────────
 *
 * When deploying to Netlify:
 *   1. npm install @netlify/blobs
 *   2. Uncomment the block below and delete the file-based implementations above.
 *   3. No other files need changes.
 *
 * import { getStore } from '@netlify/blobs';
 *
 * export async function saveTokens(tokens: SchwabTokens) {
 *   await getStore('schwab-tokens').setJSON('current-user', tokens);
 * }
 * export async function getTokens(): Promise<SchwabTokens | null> {
 *   return getStore('schwab-tokens').get('current-user', { type: 'json' });
 * }
 * ... etc.
 */
