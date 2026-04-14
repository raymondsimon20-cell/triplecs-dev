import { NextResponse } from 'next/server';
import { getSchwabAuthUrl } from '@/lib/schwab/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Generate a random state for CSRF protection
  const state = crypto.randomUUID();
  const authUrl = getSchwabAuthUrl(state);

  // Serve an HTML page that sets the cookie THEN redirects.
  // A direct server-side redirect + Set-Cookie can lose the cookie in some
  // browsers before the redirect is followed — the HTML approach is reliable.
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="refresh" content="0;url=${authUrl}">
    <script>window.location.replace(${JSON.stringify(authUrl)});</script>
  </head>
  <body>Redirecting to Schwab...</body>
</html>`;

  const response = new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  });

  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  return response;
}
