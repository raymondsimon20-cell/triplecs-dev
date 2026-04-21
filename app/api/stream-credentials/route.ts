/**
 * GET /api/stream-credentials
 * Returns Schwab WebSocket streamer credentials so the browser can open a
 * direct WebSocket connection to Schwab's streaming API.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { createClient } from '@/lib/schwab/client';
import { getTokens } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const client = await createClient();
    const [pref, tokens] = await Promise.all([
      client.getUserPreference(),
      getTokens(),
    ]);

    const info = pref?.streamerInfo?.[0];
    if (!info) {
      return NextResponse.json({ error: 'Streamer info unavailable' }, { status: 503 });
    }

    return NextResponse.json({
      streamerSocketUrl:      info.streamerSocketUrl,
      schwabClientCustomerId: info.schwabClientCustomerId,
      schwabClientCorrelId:   info.schwabClientCorrelId,
      schwabClientChannel:    info.schwabClientChannel,
      schwabClientFunctionId: info.schwabClientFunctionId,
      accessToken:            tokens?.access_token ?? '',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
