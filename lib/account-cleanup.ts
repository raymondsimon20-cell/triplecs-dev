/**
 * Disconnected-account cleanup.
 *
 * Per-account state (signal-engine state, strategy targets, auto-config,
 * per-account caches, per-account snapshots, nicknames) is keyed by Schwab
 * accountHash. When the user unlinks an account from Schwab the hash
 * disappears from `getAccountNumbers()` but its server-side slots stay
 * forever and bloat storage / confuse later debugging.
 *
 * This module:
 *   • scanStaleAccounts() — returns a per-store list of slots whose hash is
 *     no longer in the user's current Schwab account list.
 *   • purgeStaleAccounts() — deletes them.
 *
 * Nicknames are localStorage-only and out of scope here — the dashboard's
 * AccountSwitcher already hides nicknames whose account isn't in the active
 * list, and a stale nickname in localStorage is harmless.
 */

import { getStore } from '@netlify/blobs';
import { getAccountNumbers } from './schwab/client';
import { getTokens } from './storage';

interface StaleHits {
  /** Blob store name */
  store: string;
  /** Keys keyed-off-hash within the store that look stale */
  keys:  string[];
}

const STORES_AND_PREFIXES: Array<{ store: string; prefix: string }> = [
  // 2026-05 per-account stores. Each maps a prefix to the store; the suffix
  // after the prefix is the accountHash (sometimes followed by additional
  // path segments — we handle that by extracting the *first* hash-shaped
  // token after the prefix).
  { store: 'signal-engine-state',         prefix: 'account:' },
  { store: 'strategy-targets',            prefix: 'account:' },
  { store: 'signal-engine-auto-config',   prefix: 'account:' },
  { store: 'signal-engine-cache',         prefix: 'latest:account:' },
  { store: 'portfolio-snapshots',         prefix: 'account:' },
];

/** Extract the accountHash from a blob key like `account:HASH` or
 *  `account:HASH:day-YYYY-MM-DD`. */
function hashFromKey(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  // Hash terminates at the first ':' (snapshots store has 'account:HASH:day-…').
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

/** Returns the current Schwab account hashes. Throws if Schwab isn't
 *  reachable — caller decides whether to bail safely. */
async function liveAccountHashes(): Promise<Set<string>> {
  const tokens = await getTokens();
  if (!tokens) throw new Error('Schwab not connected');
  const nums = await getAccountNumbers(tokens);
  return new Set(nums.map((n) => n.hashValue));
}

export interface CleanupReport {
  liveAccounts: number;
  stale:        StaleHits[];
}

/**
 * Build a report of per-account slots whose hash isn't in the user's current
 * Schwab account list. Does not delete anything — useful for a dry-run UI
 * before the user confirms purge.
 */
export async function scanStaleAccounts(): Promise<CleanupReport> {
  const live = await liveAccountHashes();
  const stale: StaleHits[] = [];

  for (const { store: storeName, prefix } of STORES_AND_PREFIXES) {
    try {
      const store = getStore(storeName);
      const { blobs } = await store.list({ prefix });
      // De-duplicate by hash so snapshots with many `day-…` entries collapse
      // to one stale-hash bucket per stale account; the actual purge will
      // still walk every key.
      const staleKeys = new Set<string>();
      for (const b of blobs) {
        const hash = hashFromKey(b.key, prefix);
        if (!hash) continue;
        if (!live.has(hash)) staleKeys.add(b.key);
      }
      if (staleKeys.size > 0) {
        stale.push({ store: storeName, keys: Array.from(staleKeys) });
      }
    } catch (err) {
      console.warn(`[account-cleanup] scan ${storeName} failed:`, err);
    }
  }

  return { liveAccounts: live.size, stale };
}

export interface PurgeReport {
  deleted: Array<{ store: string; count: number }>;
}

/**
 * Delete every blob keyed off a stale (no-longer-linked) accountHash. Returns
 * a per-store count of deletions. Best-effort: failures on individual keys
 * are logged but don't abort the rest of the purge.
 */
export async function purgeStaleAccounts(): Promise<PurgeReport> {
  const report = await scanStaleAccounts();
  const deleted: Array<{ store: string; count: number }> = [];

  for (const hit of report.stale) {
    const store = getStore(hit.store);
    let count = 0;
    await Promise.all(hit.keys.map(async (key) => {
      try {
        await store.delete(key);
        count++;
      } catch (err) {
        console.warn(`[account-cleanup] delete ${hit.store}/${key} failed:`, err);
      }
    }));
    deleted.push({ store: hit.store, count });
  }

  return { deleted };
}
