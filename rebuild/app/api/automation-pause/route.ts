import { NextRequest, NextResponse } from 'next/server';
import { getAutomationPause, setAutomationPause } from '@/lib/signals/auto-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getAutomationPause());
}

export async function POST(req: NextRequest) {
  const { paused, reason } = (await req.json()) as { paused: boolean; reason?: string };
  await setAutomationPause({ paused, reason, pausedAt: paused ? new Date().toISOString() : undefined });
  return NextResponse.json(await getAutomationPause());
}
