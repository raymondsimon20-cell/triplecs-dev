/**
 * POST /api/notifications/test
 *
 * Fires a single test email through the notifications layer so you can verify
 * the Resend env vars are wired correctly without waiting for the cron or
 * triggering the full engine. Returns the provider's response so you can see
 * exactly why a send failed (missing API key, unverified sender, etc.).
 *
 * Usage:
 *
 *     curl -X POST https://your-site.netlify.app/api/notifications/test \
 *       -H "Cookie: <auth cookie>"
 *
 * Or just hit the endpoint from the browser after logging in. The response
 * shape:
 *
 *     { delivered: true,  providerId: "abc-123" }       — email queued
 *     { delivered: false, reason: "RESEND_API_KEY..." } — env var missing
 *     { delivered: false, reason: "Resend HTTP 403: ..." } — provider rejected
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { sendNotification, notificationsEnabled } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

export async function POST() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const enabled = notificationsEnabled();
  const config = {
    apiKeySet:   Boolean(process.env.RESEND_API_KEY),
    fromSet:     Boolean(process.env.NOTIFY_FROM_EMAIL),
    toSet:       Boolean(process.env.NOTIFY_TO_EMAIL),
    fromPreview: process.env.NOTIFY_FROM_EMAIL ?? '(not set)',
    toPreview:   process.env.NOTIFY_TO_EMAIL ?? '(not set)',
  };

  const now = new Date().toISOString();
  const result = await sendNotification({
    subject: 'Triple C Autopilot — test notification',
    text:
      `This is a test email from the Triple C autopilot.\n\n` +
      `If you're seeing this, the notification pipeline is wired correctly. ` +
      `Real digest emails will fire after each scheduled engine run when there's something actionable.\n\n` +
      `Sent at: ${now}\n` +
      `Mode: ${process.env.NODE_ENV ?? 'unknown'}\n`,
    html:
      `<h2>Triple C Autopilot — test notification</h2>` +
      `<p>If you're seeing this, the notification pipeline is wired correctly. ` +
      `Real digest emails will fire after each scheduled engine run when there's something actionable.</p>` +
      `<p style="color:#666;font-size:12px;">Sent at: ${now}</p>`,
    // Skip the in-process dedup for this endpoint — every test should fire.
  });

  return NextResponse.json({
    enabled,
    config,
    result,
  });
}

// Convenience: support GET too so it can be triggered from a browser address bar.
export async function GET() {
  return POST();
}
