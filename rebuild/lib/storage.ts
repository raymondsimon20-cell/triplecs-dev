/**
 * Abstracted storage: local JSON files under `.data/` in dev,
 * Netlify Blobs in production. Used for tokens, snapshots, cache,
 * and persisted engine state.
 */
import { promises as fs } from 'fs';
import path from 'path';

const IS_NETLIFY = !!process.env.NETLIFY || !!process.env.NETLIFY_BLOBS_CONTEXT;
const LOCAL_DIR = path.join(process.cwd(), '.data');

export interface Storage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

function keyToFile(key: string): string {
  return path.join(LOCAL_DIR, key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
}

const localStorageImpl: Storage = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(keyToFile(key), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(keyToFile(key), JSON.stringify(value, null, 2), 'utf8');
  },
  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(keyToFile(key));
    } catch {
      /* already gone */
    }
  },
  async list(prefix = ''): Promise<string[]> {
    try {
      const files = await fs.readdir(LOCAL_DIR);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((k) => k.startsWith(prefix.replace(/[^a-zA-Z0-9._-]/g, '_')));
    } catch {
      return [];
    }
  },
};

function netlifyStorageImpl(): Storage {
  return {
    async get<T>(key: string): Promise<T | null> {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('triple-c');
      const raw = await store.get(key, { type: 'json' });
      return (raw as T) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('triple-c');
      await store.setJSON(key, value as object);
    },
    async delete(key: string): Promise<void> {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('triple-c');
      await store.delete(key);
    },
    async list(prefix = ''): Promise<string[]> {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('triple-c');
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key);
    },
  };
}

export const storage: Storage = IS_NETLIFY ? netlifyStorageImpl() : localStorageImpl;

/** Well-known storage keys */
export const KEYS = {
  tokens: 'schwab-tokens',
  engineState: 'engine-state',
  strategySettings: 'strategy-settings',
  autoConfig: 'auto-config',
  cronHealth: 'cron-health',
  dailyPlan: (date: string) => `daily-plan-${date}`,
  planArchive: (date: string) => `plan-archive-${date}`,
  snapshot: (date: string) => `snapshot-${date}`,
  inbox: 'trade-inbox',
  automationPause: 'automation-pause',
  watchlist: 'watchlist',
  notifications: 'notifications',
  quoteCache: 'quote-cache',
} as const;
