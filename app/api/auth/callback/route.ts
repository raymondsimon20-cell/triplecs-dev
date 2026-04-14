import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/schwab/auth';
import { saveTokens } from '@/lib/storage';
import { createSession, setSessionCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // Schwab returned an error
  if (error) {
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(error)}`, req.url)
    );
  }

  // Validate required params
  if (!code || !state) {
    return NextResponse.redirect(new URL('/?error=missing_params', req.url));
  }

  // Verify CSRF state
  const storedState = req.cookies.get('oauth_state')?.value;
  if (storedState !== state) {
    return NextResponse.redirect(new URL('/?error=state_mismatch', req.url));
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    await saveTokens(tokens);

    // Create session cookie
    const sessionToken = await createSession();
    const response = NextResponse.redirect(
      new URL('/dashboard', req.url)
    );
    response.cookies.set('triple_c_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });
    // Clear the state cookie
    response.cookies.delete('oauth_state');

    return response;
  } catch (err) {
    console.error('OAuth callback error:', err);
    return NextResponse.redirect(
      new URL('/?error=token_exchange_failed', req.url)
    );
  }
}
