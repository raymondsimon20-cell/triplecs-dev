/**
 * Canonical absolute-URL builder for redirects.
 *
 * `NEXT_PUBLIC_APP_URL` is the preferred source: OAuth redirects must land on
 * the canonical production host, never a Netlify deploy-preview host, or the
 * Schwab redirect URI won't match and the session cookie won't be shared.
 *
 * The routes here used to do `new URL(path, process.env.NEXT_PUBLIC_APP_URL!)`.
 * When that variable is unset the non-null assertion doesn't save you — `new
 * URL(path, undefined)` throws a TypeError, which surfaces as a 500. That is
 * an especially bad failure mode on /api/auth/logout, since logout is the
 * escape hatch users reach for when the app is already broken.
 *
 * So: prefer the env var, fall back to the request's own origin. The fallback
 * can point at a preview host, which is worse than the canonical URL but far
 * better than a 500 on the one route that unsticks a bad session.
 *
 * Scheme is always forced to https — Schwab OAuth and the Trader API require
 * HTTPS end-to-end, and a redirect that downgrades to http drops the `secure`
 * session cookie.
 */

function normalizeBase(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  url.protocol = 'https:';
  return url.origin;
}

/** Best-effort origin for the incoming request, honoring proxy headers. */
function originFromRequest(req: Request): string | null {
  const forwardedHost = req.headers.get('x-forwarded-host');
  const host = forwardedHost || req.headers.get('host');
  if (host) return normalizeBase(host);

  try {
    return normalizeBase(new URL(req.url).origin);
  } catch {
    return null;
  }
}

/**
 * Build an absolute URL for `path`, preferring the configured canonical host.
 * Pass `req` wherever one is available so the fallback can work.
 */
export function appUrl(path: string, req?: Request): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return new URL(path, normalizeBase(configured));

  if (req) {
    const origin = originFromRequest(req);
    if (origin) {
      console.warn(
        '[app-url] NEXT_PUBLIC_APP_URL is not set — falling back to request origin',
        origin,
      );
      return new URL(path, origin);
    }
  }

  throw new Error('MISSING_APP_URL');
}
