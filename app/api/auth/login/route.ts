import { NextResponse } from 'next/server';
import { getSchwabAuthUrl } from '@/lib/schwab/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Generate a random state for CSRF protection
  const state = crypto.randomUUID();

  // Store state in a short-lived cookie so callback can verify it
  const response = NextResponse.redirect(getSchwabAuthUrl(state));
  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  return response;
}
