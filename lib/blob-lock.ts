/**
 * Coarse advisory lock over Netlify Blobs.
 *
 * ⚠️  CURRENTLY UNUSED — DO NOT RE-INTRODUCE WITHOUT A CAS-CAPABLE STORE.
 *
 * Shipped in the 2026-05 production hardening pass, ripped out the same
 * week after this self-deadlock pattern surfaced:
 *
 *   1. Caller writes `lock:{key}` with its nonce (setJSON).
 *   2. Caller re-reads to verify (get).
 *   3. Netlify Blobs is eventually consistent — the get can return the
 *      PREVIOUS value, making the caller think it lost the race even
 *      though its setJSON succeeded.
 *   4. The caller falls into the poll loop. Its own freshly-written
 *      record is now in the blob, looks "fresh" (within TTL), and blocks
 *      every subsequent poll iteration until MAX_WAIT_MS expires.
 *   5. appendInbox at the top of /api/signals POST times out, every run
 *      reports `staged: 0`, real trades fail to land in the inbox.
 *
 * The compare-and-swap primitive this design needs simply isn't on the
 * Netlify Blobs API. Until we have one (Redis, DynamoDB, etc.) the lib
 * stays here as documentation of what was tried; callers do plain
 * read-modify-write and accept the microsecond race window — acceptable
 * for a single-user app with one cron/day plus rare manual clicks.
 *
 * The /api/admin/locks endpoint is also retained for emergency manual
 * cleanup if a stuck lock record somehow appears.
 */

import { getStore } from '@netlify/blobs';

const LOCK_STORE = 'blob-locks';
const TTL_MS         = 5_000;
const MAX_WAIT_MS    = 10_000;
const POLL_MS        = 100;

interface LockRecord {
  acquiredAt: number;
  nonce:      string;
  holder?:    string;   // free-form label for debugging
}

function randomNonce(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

export async function withBlobLock<T>(
  key: string,
  fn: () => Promise<T>,
  options?: { holder?: string },
): Promise<T> {
  const store = getStore(LOCK_STORE);
  const lockKey = `lock:${key}`;
  const start = Date.now();

  // Acquisition loop.
  while (true) {
    const current = await store.get(lockKey, { type: 'json' }) as LockRecord | null;
    const now = Date.now();
    const stale = current ? now - current.acquiredAt > TTL_MS : true;

    if (!current || stale) {
      const nonce: string = randomNonce();
      const record: LockRecord = {
        acquiredAt: now,
        nonce,
        holder:     options?.holder,
      };
      await store.setJSON(lockKey, record);

      // Verify we actually hold it — a concurrent writer may have raced
      // and overwritten our nonce in the same ms window.
      const verify = await store.get(lockKey, { type: 'json' }) as LockRecord | null;
      if (verify?.nonce === nonce) {
        try {
          return await fn();
        } finally {
          // Best-effort release. If this fails the TTL will reap the lock.
          await store.delete(lockKey).catch(() => undefined);
        }
      }
    }

    if (Date.now() - start > MAX_WAIT_MS) {
      const wait = Date.now() - start;
      throw new Error(`withBlobLock: timed out waiting for lock '${key}' after ${wait}ms (held by ${current?.holder ?? 'unknown'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
