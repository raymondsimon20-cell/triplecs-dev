import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/schwab/auth';
import { saveTokens, getTokens } from '@/lib/storage';
import { createSession, getSession } from '@/lib/session';
import {
  hasValidDeviceLinkCookie,
  DEVICE_LINK_COOKIE,
} from '@/lib/device-link';

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
    return NextResponse.redirect(appUrl('/?error=state_mismatch'));
  }

  // Identity gate. This app is single-user — there's exactly one Schwab
  // token blob (`schwab-tokens/current-user`). Before this gate, anyone
  // who completed the OAuth dance (knowing the deployed redirect URL +
  // forging or stealing the `oauth_state` cookie) could overwrite the
  // stored tokens with their own and silently take over the session.
  //
  // Rule: if tokens already exist, the caller MUST present proof that
  // they're the legitimate owner. Either:
  //   (a) a valid `triple_c_session` cookie — re-auth from a known device, or
  //   (b) a valid `device_link` cookie — a new device authorized by the owner
  //       via /api/auth/link-device (see lib/device-link.ts).
  // A fresh install with no tokens stored is the only case where an
  // unauthenticated OAuth completion succeeds.
  const existingTokens = await getTokens().catch(() => null);
  const existingSession = await getSession();
  const validDeviceLink = await hasValidDeviceLinkCookie();

  if (existingTokens && !existingSession?.authenticated && !validDeviceLink) {
    console.warn(
      '[oauth] callback rejected — tokens exist but caller has no valid session or device-link',
    );
    return NextResponse.redirect(appUrl('/?error=oauth_not_permitted'));
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
    response.cookies.delete(DEVICE_LINK_COOKIE);

    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('OAuth callback error:', msg);
    return NextResponse.redirect(appUrl(`/?error=${encodeURIComponent(msg)}`));
  }
}
