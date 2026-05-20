/**
 * Device-link tokens — short-lived signed proofs that an already-authenticated
 * device has authorized a second browser to complete Schwab OAuth.
 *
 * Why this exists: the OAuth callback gate (app/api/auth/callback/route.ts)
 * rejects any completion where Netlify Blobs already holds tokens but the
 * caller has no `triple_c_session` cookie. That guard stops a stranger who
 * stumbles onto the redirect URL from overwriting the owner's tokens — but it
 * also blocks the owner from linking their own phone. A device-link cookie is
 * the legitimate escape hatch:
 *
 *   1. Owner (already logged in on desktop) calls GET /api/auth/link-device
 *      and receives a one-time URL with a signed token.
 *   2. Owner opens that URL on the second device. /api/auth/link verifies the
 *      token and sets `device_link` as a 1-hour HttpOnly cookie, then
 *      redirects to /api/auth/login to start the normal Schwab OAuth flow.
 *   3. The callback gate accepts a valid `device_link` cookie in lieu of a
 *      session cookie, then deletes it after success.
 *
 * Tokens are signed with SESSION_SECRET (same as session JWTs) so no new
 * secret has to be plumbed through environment configuration.
 */

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

export const DEVICE_LINK_COOKIE = 'device_link';
export const DEVICE_LINK_TTL_SECONDS = 60 * 60;
const ALG = 'HS256';

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is not set');
  return new TextEncoder().encode(secret);
}

export async function createDeviceLinkToken(): Promise<string> {
  return new SignJWT({ kind: 'device-link' })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${DEVICE_LINK_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyDeviceLinkToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload.kind === 'device-link';
  } catch {
    return false;
  }
}

/** Check the current request's `device_link` cookie. */
export async function hasValidDeviceLinkCookie(): Promise<boolean> {
  const token = cookies().get(DEVICE_LINK_COOKIE)?.value;
  if (!token) return false;
  return verifyDeviceLinkToken(token);
}
