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

// Model selection by mode — haiku for quick checks, sonnet for deep analysis
const MODEL_MAP: Record<string, string> = {
  daily_pulse:  'claude-haiku-4-5-20251001',
  what_to_sell: 'claude-haiku-4-5-20251001',
  trade_plan:   'claude-sonnet-4-6',
  rule_audit:   'claude-sonnet-4-6',
  open_question:'claude-sonnet-4-6',
};

const MAX_TOKENS_MAP: Record<string, number> = {
  daily_pulse:   1024,
  what_to_sell:  1024,
  trade_plan:    2048,
  rule_audit:    2048,
  open_question: 2048,
};

const VALID_MODES = new Set(Object.keys(MODEL_MAP));

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

  // Check Anthropic API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured. Add it to your Netlify environment variables.' },
      { status: 503 }
    );
  }

  // Merge strategy config into the snapshot so AI can use it
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

  const userMessage = buildUserMessage(mode, enrichedSnapshot, question);
  const model = MODEL_MAP[mode];
  const maxTokens = MAX_TOKENS_MAP[mode];

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: TRIPLE_C_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Extract text content
    const rawText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('');

    // Parse JSON response from AI
    let analysis: Record<string, unknown>;
    try {
      // Strip any markdown code fences the model might add despite instructions
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      analysis = JSON.parse(cleaned);
    } catch {
      // If parsing fails, return the raw text so the client can display it
      return NextResponse.json({
        mode,
        raw: rawText,
        parse_error: 'AI returned non-JSON response — displaying raw output',
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

    // Surface Anthropic-specific errors clearly
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
