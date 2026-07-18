import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/schwab/auth';
import { createSession, STATE_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const expected = req.cookies.get(STATE_COOKIE)?.value;

  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  if (!state || !expected || state !== expected) {
    return NextResponse.json({ error: 'CSRF state mismatch' }, { status: 403 });
  }

  await exchangeCode(code);
  await createSession({ authenticated: true });
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.delete(STATE_COOKIE);
  return res;
}
