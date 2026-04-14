import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/session';
import { deleteTokens } from '@/lib/storage';

export const dynamic = 'force-dynamic';

async function logout() {
  await clearSession();
  await deleteTokens();
  return NextResponse.redirect(new URL('/', process.env.NEXT_PUBLIC_APP_URL!));
}

export async function GET() {
  return logout();
}

export async function POST() {
  return logout();
}
