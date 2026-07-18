import { NextResponse } from 'next/server';
import { buildAuthorizeUrl } from '@/lib/schwab/auth';
import { STATE_COOKIE } from '@/lib/session';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = crypto.randomBytes(16).toString('hex');
  const url = buildAuthorizeUrl(state);
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return res;
}
