/**
 * POST /api/performance-review
 *
 * Asks Claude to review the user's 90-day track record + portfolio context
 * and propose strategy target adjustments. Does NOT auto-apply — the panel
 * surfaces the proposal as a diff with an explicit "Apply to Settings" action.
 *
 *   GET  → returns raw 90d recap (no Claude call) — used by the panel header
 *   POST → triggers Claude in performance_review mode → returns proposed
 *          target adjustments + rationale + supporting data
 *
 * Body for POST:
 *   {
 *     currentTargets: StrategyTargets,
 *   }
 *
 * Response for POST:
 *   {
 *     recap:         FullRecap,
 *     proposed:      Partial<StrategyTargets>,
 *     rationale:     string,
 *     keyFindings:   string[],
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { isAutomationPaused } from '@/lib/guardrails';
import { cachedSystemPrompt } from '@/lib/ai/prompt-cache';
import { loadRecap } from '@/lib/ai/recap-loader';
import { buildFeedbackBlock } from '@/lib/ai/feedback-context';
import type { StrategyTargets } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface ReviewRequest {
  currentTargets: StrategyTargets;
}

interface ClaudeReviewResponse {
  proposed:    Partial<StrategyTargets>;
  rationale:   string;
  keyFindings: string[];
}

function extractJSON(text: string): string {
  const xml = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (xml) return xml[1].trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

// ─── GET — recap only (no Claude) ────────────────────────────────────────────

export async function GET() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const recap90 = await loadRecap(90);
  const recap30 = await loadRecap(30);
  return NextResponse.json({ recap90, recap30 });
}

// ─── POST — full Claude review ───────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (await isAutomationPaused()) {
    return NextResponse.json({ paused: true, error: 'Automation paused' }, { status: 200 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });

  let body: ReviewRequest;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { currentTargets } = body;
  if (!currentTargets) return NextResponse.json({ error: 'currentTargets required' }, { status: 400 });

  const recap = await loadRecap(90);
  if (!recap) return NextResponse.json({ error: 'Recap unavailable' }, { status: 503 });

  // Only count decided outcomes (win !== null). Flat outcomes (|pnl| < 1%)
  // carry no signal, so they shouldn't satisfy the gate.
  const decidedCount = recap.outcomes.filter((o) => o.win !== null).length;
  if (decidedCount < 3) {
    return NextResponse.json({
      recap,
      proposed: {},
      rationale: `Not enough decided recommendations in the 90-day window to propose target changes (${decidedCount} decided, need ≥3). Keep accumulating data — at least 5–10 outcomes are needed for a meaningful review.`,
      keyFindings: [],
    });
  }

  const feedback = buildFeedbackBlock(recap);
  const targetsBlock = JSON.stringify(currentTargets);

  const userMessage = `
MODE: performance_review

${feedback}

CURRENT STRATEGY TARGETS (the user's allocation rules — these are what you may propose to change):
${targetsBlock}

TASK:
You are reviewing your own 90-day track record. Based on the feedback context above:
1. Identify 3-5 key findings (what's working, what's not, what regime did this happen in)
2. Propose specific target adjustments that would improve the next 90 days
3. ONLY propose changes you can defend with the data above — no unsupported guesses
4. Pillar percentages must sum to ≤100. If you adjust one pillar, adjust at least one other to keep the math clean
5. Be conservative with marginLimitPct changes — that's leverage policy, not a tactical lever
6. If the data doesn't support changes (e.g., not enough decided recs, regime was extreme), return an empty {proposed: {}} and say so in the rationale

Respond with ONLY a JSON object wrapped in <json></json> tags:
<json>
{
  "keyFindings": [
    "<one finding per item, concrete and grounded in the numbers above>"
  ],
  "proposed": {
    "triplesPct": 12,
    "incomePct": 63
  },
  "rationale": "<2-3 sentences explaining the why, citing the specific stats from the feedback block>"
}
</json>
`.trim();

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1500,
      system:     cachedSystemPrompt('performance_review'),
      messages:   [{ role: 'user', content: userMessage }],
    });

    const fullText = response.content
      .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    let parsed: ClaudeReviewResponse;
    try {
      parsed = JSON.parse(extractJSON(fullText)) as ClaudeReviewResponse;
    } catch {
      return NextResponse.json({ error: 'AI response was not valid JSON', raw: fullText }, { status: 502 });
    }

    // Sanitize: only allow known keys
    const allowedKeys: Array<keyof StrategyTargets> = [
      'triplesPct', 'cornerstonePct', 'incomePct', 'hedgePct',
      'marginLimitPct', 'marginWarnPct', 'familyCapPct', 'fireNumber', 'marginRatePct',
    ];
    const cleanProposed: Partial<StrategyTargets> = {};
    for (const k of allowedKeys) {
      const v = parsed.proposed?.[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        cleanProposed[k] = v;
      }
    }

    return NextResponse.json({
      recap,
      proposed:    cleanProposed,
      rationale:   parsed.rationale ?? '',
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.slice(0, 8) : [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
