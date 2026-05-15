/**
 * Notifications — provider-agnostic email/alert delivery.
 *
 * Wraps an external email API behind a small interface so the call sites
 * (`runSignalsAndStage`, auto-execute reports, etc.) don't care which provider
 * is used. Resend is the first backend because its HTTP API is dead simple
 * and the free tier covers ~100 emails/day.
 *
 * To enable email delivery, set these env vars on Netlify:
 *
 *   RESEND_API_KEY      = re_xxxxxxxx (from resend.com dashboard)
 *   NOTIFY_FROM_EMAIL   = e.g. "Triple C <autopilot@yourdomain.com>"  (must be a verified Resend sender)
 *   NOTIFY_TO_EMAIL     = raymondsimon20@gmail.com
 *
 * When RESEND_API_KEY is unset the module no-ops (logs a debug line) so local
 * dev and unconfigured deploys don't fail. Callers should always assume the
 * notification might silently not deliver — never gate user-visible behavior
 * on `sendNotification` succeeding.
 */

export interface NotificationPayload {
  /** Short subject line. Keep under 70 chars for mobile email clients. */
  subject: string;
  /** Plain-text body. Used as fallback for clients that block HTML. */
  text:    string;
  /** Rich HTML body. Optional — if omitted, `text` is used. */
  html?:   string;
  /**
   * Stable identifier used to dedupe. If the same idempotencyKey has been
   * sent in the last 24h, the send is skipped. Optional but recommended for
   * cron-driven notifications so a re-run doesn't double-fire.
   */
  idempotencyKey?: string;
}

export interface NotificationResult {
  /** True when the provider acknowledged the send (HTTP 2xx). */
  delivered: boolean;
  /** When false: explanation (provider error, missing config, deduped, etc.). */
  reason?:   string;
  /** Provider message id when available. */
  providerId?: string;
}

// ─── Internal dedup ──────────────────────────────────────────────────────────
//
// We keep a per-process in-memory cache so retries inside the same Netlify
// function invocation don't duplicate. For cross-invocation dedup, callers
// should pick an idempotencyKey that's stable across invocations (e.g. a
// daily plan date) — the Resend API itself doesn't dedupe so the only
// process-level dedup we get for free is "two sends in the same cold start".

const sentKeys = new Map<string, number>();
const SENT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

function recentlySent(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of sentKeys) {
    if (now - t > SENT_KEY_TTL_MS) sentKeys.delete(k);
  }
  return sentKeys.has(key);
}

function markSent(key: string): void {
  sentKeys.set(key, Date.now());
}

// ─── Provider: Resend ────────────────────────────────────────────────────────

async function sendViaResend(payload: NotificationPayload): Promise<NotificationResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.NOTIFY_FROM_EMAIL;
  const to     = process.env.NOTIFY_TO_EMAIL;

  if (!apiKey) {
    return { delivered: false, reason: 'RESEND_API_KEY not set' };
  }
  if (!from) {
    return { delivered: false, reason: 'NOTIFY_FROM_EMAIL not set' };
  }
  if (!to) {
    return { delivered: false, reason: 'NOTIFY_TO_EMAIL not set' };
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to:      [to],
        subject: payload.subject,
        html:    payload.html ?? `<pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(payload.text)}</pre>`,
        text:    payload.text,
      }),
    });

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return {
        delivered: false,
        reason:    `Resend HTTP ${r.status}: ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await r.json().catch(() => ({}))) as { id?: string };
    return { delivered: true, providerId: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { delivered: false, reason: `Resend fetch failed: ${msg}` };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a notification. No-ops gracefully when the provider isn't configured.
 * Idempotent per process when `idempotencyKey` is provided.
 *
 * Callers should NOT block on this — failure to notify must never break the
 * cron's primary work (signal engine, auto-execute). Wrap call sites in
 * try/catch and log warnings.
 */
export async function sendNotification(payload: NotificationPayload): Promise<NotificationResult> {
  if (payload.idempotencyKey && recentlySent(payload.idempotencyKey)) {
    return { delivered: false, reason: 'deduped by idempotencyKey (sent recently)' };
  }

  const result = await sendViaResend(payload);

  if (result.delivered && payload.idempotencyKey) {
    markSent(payload.idempotencyKey);
  }

  return result;
}

/** Returns true when at least one delivery channel is configured. */
export function notificationsEnabled(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY &&
    process.env.NOTIFY_FROM_EMAIL &&
    process.env.NOTIFY_TO_EMAIL,
  );
}
