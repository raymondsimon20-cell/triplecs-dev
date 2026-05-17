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
  // system-state per-account pause flags.
  { store: 'system-state',                prefix: 'pause-flag:account:' },
];

/**
 * Stores whose legacy `current` (unscoped) blob can be deleted once every
 * live account has its own per-account slot. Keeps the read-fallback chain
 * tidy and frees storage. Snapshots and trade-history have their own legacy
 * keys we intentionally keep ('latest', 'log') because the household view
 * still reads them.
 */
const LEGACY_GLOBAL_KEYS: Array<{ store: string; key: string }> = [
  { store: 'signal-engine-state',       key: 'current' },
  { store: 'signal-engine-auto-config', key: 'current' },
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
  /**
   * Legacy unscoped blobs whose per-account replacement exists for every
   * live account. Safe to delete — purge will remove them.
   */
  legacyShakeable: Array<{ store: string; key: string }>;
}

/**
 * Build a report of per-account slots whose hash isn't in the user's current
 * Schwab account list. Does not delete anything — useful for a dry-run UI
 * before the user confirms purge.
 */
export async function scanStaleAccounts(): Promise<CleanupReport> {
  const live = await liveAccountHashes();
  const stale: StaleHits[] = [];
  // Track which live accounts have a per-account slot in each store; used to
  // decide whether the legacy unscoped blob is safe to delete.
  const liveHashesByStore = new Map<string, Set<string>>();

  for (const { store: storeName, prefix } of STORES_AND_PREFIXES) {
    try {
      const store = getStore(storeName);
      const { blobs } = await store.list({ prefix });
      const staleKeys = new Set<string>();
      const livePresent = new Set<string>();
      for (const b of blobs) {
        const hash = hashFromKey(b.key, prefix);
        if (!hash) continue;
        if (live.has(hash)) livePresent.add(hash);
        else staleKeys.add(b.key);
      }
      liveHashesByStore.set(storeName, livePresent);
      if (staleKeys.size > 0) {
        stale.push({ store: storeName, keys: Array.from(staleKeys) });
      }
    } catch (err) {
      console.warn(`[account-cleanup] scan ${storeName} failed:`, err);
    }
  }

  // Legacy blob shake-out: a `current` key is safe to delete when every live
  // account already has its own per-account slot AND there are live accounts
  // at all (we never delete a legacy blob if the user disconnected
  // everything — that would lose history).
  const legacyShakeable: Array<{ store: string; key: string }> = [];
  if (live.size > 0) {
    for (const { store: storeName, key } of LEGACY_GLOBAL_KEYS) {
      const present = liveHashesByStore.get(storeName) ?? new Set();
      const allCovered = Array.from(live).every((h) => present.has(h));
      if (!allCovered) continue;
      // Also confirm the legacy blob actually exists — no point reporting
      // a deletion that's a no-op.
      try {
        const exists = await getStore(storeName).get(key, { type: 'json' });
        if (exists != null) legacyShakeable.push({ store: storeName, key });
      } catch {
        /* swallow */
      }
    }
  }

  return { liveAccounts: live.size, stale, legacyShakeable };
}

export interface PurgeReport {
  deleted:       Array<{ store: string; count: number }>;
  legacyDeleted: Array<{ store: string; key: string }>;
}

/**
 * Delete every blob keyed off a stale (no-longer-linked) accountHash. Also
 * deletes any legacy unscoped blob whose per-account replacement now covers
 * every live account. Returns a per-store count of deletions. Best-effort:
 * failures on individual keys are logged but don't abort the rest of the
 * purge.
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

  // Legacy shake-out: drop any unscoped blob now covered by per-account slots.
  const legacyDeleted: Array<{ store: string; key: string }> = [];
  for (const entry of report.legacyShakeable) {
    try {
      await getStore(entry.store).delete(entry.key);
      legacyDeleted.push(entry);
    } catch (err) {
      console.warn(`[account-cleanup] legacy delete ${entry.store}/${entry.key} failed:`, err);
    }
  }

  return { deleted, legacyDeleted };
}
