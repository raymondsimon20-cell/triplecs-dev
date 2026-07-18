import { NextResponse } from 'next/server';
import { getCronHealth, findStaleJobs } from '@/lib/signals/cron-health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const health = await getCronHealth();
  return NextResponse.json({ health, stale: findStaleJobs(health) });
}
