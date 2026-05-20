import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { createDeviceLinkToken, DEVICE_LINK_TTL_SECONDS } from '@/lib/device-link';

export const dynamic = 'force-dynamic';

/**
 * Mint a one-time device-link URL. Caller must already be authenticated.
 * Returns JSON: { url, expiresInSeconds }. The owner opens `url` on the new
 * device — see lib/device-link.ts for the full flow.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) {
    return NextResponse.json({ error: 'missing_app_url' }, { status: 500 });
  }

  const token = await createDeviceLinkToken();
  const url = `${base.replace(/\/$/, '')}/api/auth/link?token=${encodeURIComponent(token)}`;

  return NextResponse.json({
    url,
    expiresInSeconds: DEVICE_LINK_TTL_SECONDS,
  });
}
