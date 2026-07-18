/**
 * Session gate for the entire API surface. Everything except the OAuth
 * endpoints requires a valid JWT session cookie. This runs at the edge,
 * before any route handler — no route is reachable unauthenticated.
 */
import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const PUBLIC_PREFIXES = ['/api/auth/login', '/api/auth/callback'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  const jwt = req.cookies.get('triple-c-session')?.value;
  if (!jwt) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET unset');
    await jwtVerify(jwt, new TextEncoder().encode(secret));
    return NextResponse.next();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export const config = { matcher: '/api/:path*' };
