/**
 * POST /api/ai-analysis
 *
 * Accepts a portfolio snapshot + analysis mode, calls the Anthropic Claude API
 * with the Triple C system prompt, and returns structured JSON analysis.
 *
 * Body:
 *   {
 *     mode: 'daily_pulse' | 'trade_plan' | 'rule_audit' | 'what_to_sell' | 'open_question',
 *     portfolio: { ...account data, positions, pillarSummary, marginBalance, ... },
 *     question?: string,   // only for open_question mode
 *     config?: {           // optional strategy config overrides
 *       triplesTargetPct: number,
 *       cornerstoneTargetPct: number,
 *       incomeTargetPct: number,
 *       marginWarnPct: number,
 *       marginMaxPct: number,
 *       fireMonthlyTarget: number,
 *     }
 *   }
 *
 * Uses claude-haiku-4-5 for daily_pulse / what_to_sell (fast, cheap).
 * Uses claude-sonnet-4-6 for trade_plan / rule_audit / open_question (thorough).
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '@/lib/session';
import { TRIPLE_C_SYSTEM_PROMPT, buildUserMessage } from '@/lib/ai/system-prompt';

export const dynamic = 'force-dynamic';

// Model selection by mode
const MODEL_MAP: Record<string, string> = {
  daily_pulse:   'claude-haiku-4-5-20251001',
  what_to_sell:  'claude-haiku-4-5-20251001',
  trade_plan:    'claude-sonnet-4-6',
  rule_audit:    'claude-sonnet-4-6',
  open_question: 'claude-sonnet-4-6',
};

// Higher token limits — large portfolios + full JSON can exceed 1024 easily
const MAX_TOKENS_MAP: Record<string, number> = {
  daily_pulse:   2048,
  what_to_sell:  2048,
  trade_plan:    4096,
  rule_audit:    4096,
  open_question: 4096,
};

const VALID_MODES = new Set(Object.keys(MODEL_MAP));

/**
 * Extract JSON from model output using multiple strategies:
 *  1. Content between <json>…</json> tags (preferred — what we ask for)
 *  2. Content between ```json … ``` fences
 *  3. First { … } block found anywhere in the text
 *  4. Raw text as-is
 */
function extractJSON(text: string): string {
  // Strategy 1: XML tag wrapper
  const xmlMatch = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (xmlMatch) return xmlMatch[1].trim();

  // Strategy 2: markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  // Strategy 3: first { to last } (handles leading/trailing text)
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);

  // Strategy 4: return as-is and let JSON.parse fail gracefully
  return text.trim();
}

export async function POST(req: Request) {
  // Auth check
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse body
  let body: {
    mode: string;
    portfolio: Record<string, unknown>;
    question?: string;
    config?: Record<string, number>;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { mode, portfolio, question, config } = body;

  if (!mode || !VALID_MODES.has(mode)) {
    return NextResponse.json(
      { error: `Invalid mode. Must be one of: ${[...VALID_MODES].join(', ')}` },
      { status: 400 }
    );
  }

  if (!portfolio || typeof portfolio !== 'object') {
    return NextResponse.json({ error: 'Missing portfolio snapshot' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured. Add it to your Netlify environment variables.' },
      { status: 503 }
    );
  }

  // Merge strategy config into the snapshot
  const enrichedSnapshot = {
    ...portfolio,
    strategy_config: config ?? {
      triplesTargetPct: 25,
      cornerstoneTargetPct: 15,
      incomeTargetPct: 60,
      marginWarnPct: 30,
      marginMaxPct: 50,
      fireMonthlyTarget: 10000,
    },
    analysis_mode: mode,
    timestamp: new Date().toISOString(),
  };

  // Append a hard JSON-only instruction to the user message.
  // Using <json> tags gives the model a clear container to write into,
  // and our extractor pulls from those tags first.
  const baseMessage = buildUserMessage(mode, enrichedSnapshot, question);
  const userMessage =
    baseMessage +
    '\n\nIMPORTANT: Wrap your entire JSON response in <json> and </json> tags. ' +
    'Do not include any text outside those tags. Example: <json>{ ... }</json>';

  const model     = MODEL_MAP[mode];
  const maxTokens = MAX_TOKENS_MAP[mode];

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: TRIPLE_C_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Collect full text response
    const rawText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');

    // Check for truncation — if stop_reason is max_tokens the JSON is incomplete
    if (message.stop_reason === 'max_tokens') {
      console.warn('AI response truncated at max_tokens — increase MAX_TOKENS_MAP for mode:', mode);
    }

    // Extract and parse JSON
    const candidate = extractJSON(rawText);
    let analysis: Record<string, unknown>;

    try {
      analysis = JSON.parse(candidate);
    } catch (parseErr) {
      // Return raw so the UI can show it and we can debug from Netlify logs
      console.error('JSON parse failed for mode:', mode);
      console.error('stop_reason:', message.stop_reason);
      console.error('raw response (first 2000 chars):', rawText.slice(0, 2000));
      return NextResponse.json({
        mode,
        raw: rawText,
        candidate_extracted: candidate.slice(0, 500),
        parse_error: 'AI returned non-JSON response — displaying raw output',
        stop_reason: message.stop_reason,
        model,
        usage: message.usage,
      });
    }

    return NextResponse.json({
      ...analysis,
      model,
      usage: message.usage,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('AI Analysis API error:', msg);

    if (msg.includes('401') || msg.includes('authentication')) {
      return NextResponse.json(
        { error: 'Invalid ANTHROPIC_API_KEY — check your Netlify environment variables.' },
        { status: 401 }
      );
    }
    if (msg.includes('429') || msg.includes('rate')) {
      return NextResponse.json(
        { error: 'Anthropic rate limit hit — wait a moment and try again.' },
        { status: 429 }
      );
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
