/**
 * POST /api/ai-analysis
 *
 * Streams the Anthropic response directly to the client so Netlify's
 * inactivity timeout never fires.  The client accumulates all chunks,
 * then extracts and parses the JSON at the end.
 *
 * Body:
 *   {
 *     mode: 'daily_pulse' | 'trade_plan' | 'rule_audit' | 'what_to_sell' | 'open_question',
 *     portfolio: { ...lean snapshot },
 *     question?: string,
 *     config?: { triplesTargetPct, cornerstoneTargetPct, incomeTargetPct,
 *                marginWarnPct, marginMaxPct, fireMonthlyTarget }
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '@/lib/session';
import { TRIPLE_C_SYSTEM_PROMPT, buildUserMessage } from '@/lib/ai/system-prompt';

export const dynamic = 'force-dynamic';

const MODEL_MAP: Record<string, string> = {
  daily_pulse:   'claude-haiku-4-5-20251001',
  what_to_sell:  'claude-haiku-4-5-20251001',
  trade_plan:    'claude-sonnet-4-6',
  rule_audit:    'claude-sonnet-4-6',
  open_question: 'claude-sonnet-4-6',
};

const MAX_TOKENS_MAP: Record<string, number> = {
  daily_pulse:   4096,
  what_to_sell:  4096,
  trade_plan:    6000,
  rule_audit:    6000,
  open_question: 6000,
};

const VALID_MODES = new Set(Object.keys(MODEL_MAP));

/** Pull the first complete JSON object out of arbitrary text. */
function extractJSON(text: string): string {
  const xmlMatch = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (xmlMatch) return xmlMatch[1].trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);

  return text.trim();
}

export async function POST(req: Request) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  try { await requireAuth(); } catch {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: {
    mode: string;
    portfolio: Record<string, unknown>;
    question?: string;
    config?: Record<string, number>;
  };

  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { mode, portfolio, question, config } = body;

  if (!mode || !VALID_MODES.has(mode)) {
    return new Response(
      JSON.stringify({ error: `Invalid mode. Must be one of: ${[...VALID_MODES].join(', ')}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured in Netlify environment variables.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── Build snapshot ────────────────────────────────────────────────────────
  const enrichedSnapshot = {
    ...portfolio,
    strategy_config: config ?? {
      triplesTargetPct:     25,
      cornerstoneTargetPct: 15,
      incomeTargetPct:      60,
      marginWarnPct:        30,
      marginMaxPct:         50,
      fireMonthlyTarget:    10000,
    },
    analysis_mode: mode,
    timestamp: new Date().toISOString(),
  };

  const baseMessage = buildUserMessage(mode, enrichedSnapshot, question);
  const userMessage =
    baseMessage +
    '\n\nIMPORTANT: Wrap your entire JSON response in <json> and </json> tags. ' +
    'No text outside those tags.';

  const model     = MODEL_MAP[mode];
  const maxTokens = MAX_TOKENS_MAP[mode];

  // ── Stream Anthropic → client ─────────────────────────────────────────────
  // Streaming keeps bytes flowing so Netlify's inactivity timer never fires.
  // The client accumulates all chunks then parses the complete JSON.
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const client = new Anthropic({ apiKey });

        const stream = await client.messages.stream({
          model,
          max_tokens: maxTokens,
          system: TRIPLE_C_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        });

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }

        // Signal end of JSON with a sentinel the client can detect
        controller.enqueue(encoder.encode('\n__DONE__'));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(JSON.stringify({ error: msg })));
        controller.enqueue(encoder.encode('\n__DONE__'));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Accel-Buffering': 'no',   // disable proxy buffering (nginx / Netlify edge)
      'Cache-Control': 'no-cache',
    },
  });
}
