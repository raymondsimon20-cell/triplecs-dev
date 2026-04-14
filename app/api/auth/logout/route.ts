import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/session';
import { deleteTokens } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST() {
  await clearSession();
  await deleteTokens();
  return NextResponse.redirect(new URL('/', process.env.NEXT_PUBLIC_APP_URL!));
}
