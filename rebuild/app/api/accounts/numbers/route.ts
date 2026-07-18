import { NextResponse } from 'next/server';
import { getAccountNumbers } from '@/lib/schwab/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getAccountNumbers());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
