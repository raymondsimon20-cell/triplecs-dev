/**
 * Lightweight session management using signed HTTP-only cookies.
 * No database needed — the session just signals "user is authenticated".
 * Actual tokens live in Netlify Blobs.
 */

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const SESSION_COOKIE = 'triple_c_session';
const ALG = 'HS256';

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is not set');
  return new TextEncoder().encode(secret);
}

export interface SessionData {
  authenticated: boolean;
}

export async function createSession(): Promise<string> {
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getSecret());
  return token;
}

export async function setSessionCookie(token: string): Promise<void> {
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  });
}

export async function getSession(): Promise<SessionData | null> {
  const cookieStore = cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecret());
    return { authenticated: payload.authenticated as boolean };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  cookies().delete(SESSION_COOKIE);
}

export async function requireAuth(): Promise<void> {
  const session = await getSession();
  if (!session?.authenticated) {
    throw new Error('UNAUTHENTICATED');
  }
}
