import { NextRequest, NextResponse } from 'next/server';
import {
  verifyDeviceLinkToken,
  DEVICE_LINK_COOKIE,
  DEVICE_LINK_TTL_SECONDS,
} from '@/lib/device-link';

export const dynamic = 'force-dynamic';

function appUrl(path: string): URL {
  return new URL(path, process.env.NEXT_PUBLIC_APP_URL!);
}

/**
 * Accept a device-link token on a new device. Verifies the token, stores it
 * as the `device_link` HttpOnly cookie, then redirects into the normal Schwab
 * OAuth login. The cookie is what the OAuth callback gate looks for as proof
 * that this fresh browser was authorized by an already-logged-in device.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');

  if (!token || !(await verifyDeviceLinkToken(token))) {
    return NextResponse.redirect(appUrl('/?error=invalid_device_link'));
  }

  const response = NextResponse.redirect(appUrl('/api/auth/login'));
  response.cookies.set(DEVICE_LINK_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: DEVICE_LINK_TTL_SECONDS,
    path: '/',
  });
  return response;
}
