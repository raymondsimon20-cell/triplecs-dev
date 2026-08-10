import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/session';
import { deleteTokens } from '@/lib/storage';
import { appUrl } from '@/lib/app-url';

export const dynamic = 'force-dynamic';

async function logout(req: Request) {
  // Clear state first, and never let a redirect problem prevent it. Logout is
  // the escape hatch from a wedged session — if it 500s, the user has no way
  // out of the app short of manually clearing cookies.
  let cleared = true;
  try {
    await clearSession();
    await deleteTokens();
  } catch (err) {
    cleared = false;
    console.error('[logout] failed to clear session/tokens:', err);
  }

  try {
    return NextResponse.redirect(appUrl(cleared ? '/' : '/?error=logout_partial', req));
  } catch {
    // No canonical URL and no usable request origin. Fall back to a relative
    // redirect via a plain Response, which NextResponse.redirect won't accept
    // but browsers handle fine.
    return new Response(null, { status: 302, headers: { Location: '/' } });
  }
}

export async function GET(req: Request) {
  return logout(req);
}

export async function POST(req: Request) {
  return logout(req);
}
