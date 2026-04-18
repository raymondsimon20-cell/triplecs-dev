import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/schwab/auth';
import { saveTokens } from '@/lib/storage';
import { createSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

// Always redirect to the canonical production URL, never the deploy-preview URL
function appUrl(path: string): URL {
  return new URL(path, process.env.NEXT_PUBLIC_APP_URL!);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // Schwab returned an error
  if (error) {
    return NextResponse.redirect(appUrl(`/?error=${encodeURIComponent(error)}`));
  }

  // Validate required params
  if (!code || !state) {
    return NextResponse.redirect(appUrl('/?error=missing_params'));
  }

  // Verify CSRF state
  const storedState = req.cookies.get('oauth_state')?.value;
  if (storedState !== state) {
    // Clear any stale auth cookies so the user can retry login cleanly.
    const res = NextResponse.redirect(appUrl('/?error=state_mismatch'));
    res.cookies.delete('oauth_state');
    res.cookies.delete('triple_c_session');
    return res;
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    await saveTokens(tokens);

    // Create session cookie and redirect to dashboard
    const sessionToken = await createSession();
    const response = NextResponse.redirect(appUrl('/dashboard'));
    response.cookies.set('triple_c_session', sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });
    response.cookies.delete('oauth_state');

    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('OAuth callback error:', msg);
    return NextResponse.redirect(appUrl(`/?error=${encodeURIComponent(msg)}`));
  }
}
