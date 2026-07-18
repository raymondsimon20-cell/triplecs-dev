import { NextResponse } from 'next/server';
import { logout } from '@/lib/schwab/auth';
import { clearSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  await logout();
  clearSession();
  return NextResponse.json({ ok: true });
}
