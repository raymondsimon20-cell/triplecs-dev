/**
 * Admin lock-recovery endpoint.
 *
 *   GET    /api/admin/locks            → list every lock blob and its holder
 *   DELETE /api/admin/locks?key=inbox  → force-release a specific lock
 *   DELETE /api/admin/locks?all=1      → force-release every lock
 *
 * The blob-lock pattern in `lib/blob-lock.ts` is best-effort with a 5s TTL —
 * normally stuck locks expire themselves. This endpoint exists for the rare
 * cases where Netlify Blobs propagation lag or a function timeout left the
 * lock stuck longer than the TTL, blocking the dashboard. Manual recovery
 * is faster than redeploying.
 *
 * Auth-gated (requireAuth) so only the logged-in user can clear locks.
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';

const LOCK_STORE = 'blob-locks';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

interface LockRecord {
  acquiredAt: number;
  nonce:      string;
  holder?:    string;
}

export async function GET() {
  try { await requireAuth(); } catch { return unauthorized(); }

  try {
    const store = getStore(LOCK_STORE);
    const { blobs } = await store.list({ prefix: 'lock:' });
    const now = Date.now();
    const locks = await Promise.all(
      blobs.map(async (b) => {
        const record = await store.get(b.key, { type: 'json' }) as LockRecord | null;
        return record
          ? {
              key:        b.key,
              holder:     record.holder,
              ageMs:      now - record.acquiredAt,
              stale:      now - record.acquiredAt > 5000,
              acquiredAt: new Date(record.acquiredAt).toISOString(),
            }
          : { key: b.key, error: 'unreadable' };
      }),
    );
    return NextResponse.json({ locks, count: locks.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try { await requireAuth(); } catch { return unauthorized(); }

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const all = url.searchParams.get('all') === '1';

  try {
    const store = getStore(LOCK_STORE);
    if (all) {
      const { blobs } = await store.list({ prefix: 'lock:' });
      await Promise.all(
        blobs.map((b) => store.delete(b.key).catch((err) => {
          console.warn(`[admin/locks] delete ${b.key} failed:`, err);
        })),
      );
      return NextResponse.json({ deleted: blobs.length, kind: 'all' });
    }
    if (!key) {
      return NextResponse.json({ error: 'Pass ?key=<name> or ?all=1' }, { status: 400 });
    }
    // Accept either the bare lock name ('inbox') or the prefixed key ('lock:inbox').
    const blobKey = key.startsWith('lock:') ? key : `lock:${key}`;
    await store.delete(blobKey);
    return NextResponse.json({ deleted: blobKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
