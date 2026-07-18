/** JWT session cookies via `jose`. */
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const COOKIE = 'triple-c-session';

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars)');
  return new TextEncoder().encode(s);
}

export interface SessionPayload {
  authenticated: boolean;
  selectedAccount?: string; // account hash
  [key: string]: unknown;
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
  cookies().set(COOKIE, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const jwt = cookies().get(COOKIE)?.value;
  if (!jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, secret());
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  cookies().delete(COOKIE);
}

/** CSRF state cookie for the OAuth flow. */
export const STATE_COOKIE = 'schwab-oauth-state';
