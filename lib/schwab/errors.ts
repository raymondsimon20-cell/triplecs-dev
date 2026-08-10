/**
 * Shared classification for Schwab-related error strings.
 *
 * `schwabFetch` throws 'REFRESH_TOKEN_EXPIRED' when the 7-day refresh token
 * has lapsed, and `createClient` throws 'NOT_AUTHENTICATED' when there are no
 * stored tokens at all. Both mean the same thing to the caller: the user has
 * to re-run the Schwab OAuth flow. Routes that only special-cased
 * NOT_AUTHENTICATED returned a 500 on refresh-token expiry, which the
 * dashboard rendered as a bare "HTTP 500" instead of bouncing to re-auth.
 */

export const AUTH_ERRORS = new Set([
  'NOT_AUTHENTICATED',
  'REFRESH_TOKEN_EXPIRED',
  'UNAUTHENTICATED',
]);

export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_ERRORS.has(msg);
}

/** User-facing copy for an expired/absent Schwab session. */
export function authErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg === 'REFRESH_TOKEN_EXPIRED'
    ? 'Schwab session expired — reconnect your account'
    : 'Not authenticated with Schwab';
}
