/**
 * POST /api/option-plan
 *
 * AI-powered options contract selection.
 * Fetches the live chain for a symbol, filters to the relevant window per
 * Vol 5/6 rules, sends the real contracts (with OCC symbols) to Claude,
 * and returns a ready-to-submit OptionOrderRequest.
 *
 * The OCC symbol in the response is ALWAYS taken verbatim from the live chain —
 * never computed from price estimates.
 *
 * Body:
 *   {
 *     symbol:      string,              // e.g. "TQQQ"
 *     mode:        'sell_put' | 'buy_put',
 *     contracts?:  number,              // default 1
 *     vix?:        number,              // current VIX for context
 *     marketTrend?: 'bullish' | 'neutral' | 'bearish',
 *     position?: {                      // current holding, if any
 *       shares:     number,
 *       value:      number,
 *       pillar:     string,
 *     }
 *   }
 *
 * Response:
 *   {
 *     occSymbol:        string,
 *     instruction:      'BUY_TO_OPEN' | 'SELL_TO_OPEN',
 *     contracts:        number,
 *     limitPrice:       number,
 *     rationale:        string,
 *     selectedContract: PutContract,
 *     validationPassed: boolean,
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { getTokens } from '@/lib/storage';
import { getOptionsChain } from '@/lib/schwab/client';
import { cachedSystemPrompt, withContext } from '@/lib/ai/prompt-cache';
import { loadFeedbackBlock, loadPaceBlock } from '@/lib/ai/recap-loader';
import { getAutomationGate } from '@/lib/guardrails';
import { appendInbox } from '@/lib/inbox';

export const dynamic = 'force-dynamic';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PutContract {
  symbol:           string;   // OCC symbol — verbatim from Schwab
  expiration:       string;
  dte:              number;
  strike:           number;
  bid:              number;
  ask:              number;
  mid:              number;
  iv:               number;
  delta:            number;
  openInterest:     number;
  otmPct:           number;
  breakeven:        number;
  closeTarget75:    number;
  annualisedReturn: number;
  inTheMoney:       boolean;
}

interface OptionPlanRequest {
  symbol:       string;
  mode:         'sell_put' | 'buy_put';
  contracts?:   number;
  vix?:         number;
  marketTrend?: 'bullish' | 'neutral' | 'bearish';
  position?: {
    shares: number;
    value:  number;
    pillar: string;
  };
}

interface ClaudeOptionPlan {
  occSymbol:        string;
  instruction:      'BUY_TO_OPEN' | 'SELL_TO_OPEN';
  contracts:        number;
  limitPrice:       number;
  rationale:        string;
  selectedContract: PutContract;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeDte(expirationDate: string): number {
  const exp = new Date(expirationDate + 'T16:00:00');
  const now = new Date();
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / 86_400_000));
}

/** Parse and normalise the raw Schwab chain into our PutContract shape. */
function parseChain(
  raw: Record<string, unknown>,
  underlyingPrice: number,
): PutContract[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  const putMap = (raw.putExpDateMap ?? {}) as Record<string, Record<string, unknown[]>>;
  const contracts: PutContract[] = [];

  for (const [expKey, strikeMap] of Object.entries(putMap)) {
    const expDate = expKey.split(':')[0];
    if (expDate < todayStr) continue;           // skip past expirations
    const dte = safeDte(expDate);
    if (dte <= 0) continue;                     // safety net

    for (const [strikeStr, legs] of Object.entries(strikeMap)) {
      const c = legs[0] as Record<string, unknown>;
      if (!c || c.nonStandard) continue;

      const strike = parseFloat(strikeStr);
      const bid    = (c.bid  as number) ?? 0;
      const ask    = (c.ask  as number) ?? 0;
      const mid    = +((bid + ask) / 2).toFixed(2);
      // Schwab returns volatility already as a percent number (e.g. 59.0 for 59% IV).
      // Don't multiply by 100 — that produced 5900% in the chain UI.
      const iv     = +((c.volatility as number ?? 0)).toFixed(1);
      const delta  = +(c.delta as number ?? 0).toFixed(3);
      const itm    = (c.inTheMoney as boolean) ?? false;
      const otmPct = underlyingPrice > 0
        ? +((underlyingPrice - strike) / underlyingPrice * 100).toFixed(2)
        : 0;
      const breakeven        = +(strike - mid).toFixed(2);
      const closeTarget75    = +(mid * 0.25).toFixed(2);
      const annualisedReturn = strike > 0 && dte > 0
        ? +(mid / strike * (365 / dte) * 100).toFixed(2)
        : 0;

      contracts.push({
        symbol:           (c.symbol as string) ?? '',
        expiration:       expDate,
        dte,
        strike,
        bid,
        ask,
        mid,
        iv,
        delta,
        openInterest:     (c.openInterest  as number) ?? 0,
        otmPct,
        breakeven,
        closeTarget75,
        annualisedReturn,
        inTheMoney: itm,
      });
    }
  }

  return contracts.sort((a, b) => a.dte !== b.dte ? a.dte - b.dte : b.strike - a.strike);
}

/** Filter contracts to the Vol 5/6 sweet window for each mode. */
function filterContracts(contracts: PutContract[], mode: 'sell_put' | 'buy_put'): PutContract[] {
  if (mode === 'sell_put') {
    // Vol 6: 45–150 DTE, 4–28% OTM, delta -0.13 to -0.45 (skip delta check when 0 — missing after-hours data)
    return contracts.filter(
      (c) => c.dte >= 45 && c.dte <= 150 &&
             c.otmPct >= 4 && c.otmPct <= 28 &&
             (c.delta === 0 || (Math.abs(c.delta) >= 0.13 && Math.abs(c.delta) <= 0.45)) &&
             !c.inTheMoney && c.mid > 0,
    );
  } else {
    // Vol 5: ~30 DTE, 5–20% OTM, protective put
    // Wide DTE range (7–90) and OTM range (3–22%) so high-priced ETFs like QQQ
    // with $1 strike spacing always have candidates in the fetched chain.
    return contracts.filter(
      (c) => c.dte >= 7 && c.dte <= 90 &&
             c.otmPct >= 3 && c.otmPct <= 22 &&
             !c.inTheMoney && c.mid > 0,
    );
  }
}

/** Fallback: pick best contract by our own scoring if Claude fails validation. */
function scoreFallback(contracts: PutContract[], mode: 'sell_put' | 'buy_put'): PutContract {
  if (mode === 'sell_put') {
    // Prefer OTM 10%, DTE 60-90, highest annualised return (use otmPct when delta=0)
    return contracts.reduce((best, c) => {
      const deltaC    = c.delta !== 0 ? Math.abs(c.delta) : Math.max(0.05, 0.5 - c.otmPct / 100 * 1.6);
      const deltaB    = best.delta !== 0 ? Math.abs(best.delta) : Math.max(0.05, 0.5 - best.otmPct / 100 * 1.6);
      const deltaDiff = Math.abs(deltaC - 0.25);
      const bestDelta = Math.abs(deltaB - 0.25);
      const dteScore  = c.dte >= 60 && c.dte <= 90 ? 0 : 1;
      const bestDte   = best.dte >= 60 && best.dte <= 90 ? 0 : 1;
      const score     = deltaDiff + dteScore * 0.5 - c.annualisedReturn * 0.01;
      const bestScore = bestDelta + bestDte * 0.5 - best.annualisedReturn * 0.01;
      return score < bestScore ? c : best;
    });
  } else {
    // Vol 5: prefer delta ~-0.20, DTE closest to 30
    return contracts.reduce((best, c) => {
      const dteDiff     = Math.abs(c.dte - 30);
      const bestDteDiff = Math.abs(best.dte - 30);
      return dteDiff < bestDteDiff ? c : best;
    });
  }
}

function extractJSON(text: string): string {
  const xmlMatch   = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (xmlMatch) return xmlMatch[1].trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Automation gate — user pause + signal-engine kill switch + defense mode.
  // Must use stream sentinel format; the client reads the body as a stream
  // and parses after __RESULT__.
  const gate = await getAutomationGate();
  if (gate.paused) {
    const payload = JSON.stringify({
      paused:     true,
      gateSource: gate.source,
      gateReason: gate.reason,
      gateSince:  gate.since,
      error:      `Automation paused (${gate.source}): ${gate.reason}`,
    });
    const body = `__RESULT__${payload}\n__DONE__`;
    return new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache',
      },
    });
  }

  let body: OptionPlanRequest;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { symbol, mode, contracts: requestedContracts = 1, vix, marketTrend, position } = body;

  if (!symbol) return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  if (mode !== 'sell_put' && mode !== 'buy_put')
    return NextResponse.json({ error: 'mode must be sell_put or buy_put' }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });

  const tokens = await getTokens();
  if (!tokens) return NextResponse.json({ error: 'Not authenticated with Schwab' }, { status: 401 });

  // ── 1. Fetch live chain ──────────────────────────────────────────────────────
  let allContracts: PutContract[];
  let underlyingPrice = 0;

  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const raw = await getOptionsChain(tokens, symbol.toUpperCase(), {
      contractType: 'PUT',
      strikeCount:  80,   // QQQ/SPY use $1 spacing near ATM — need 80 to reach 8%+ OTM for sell_put
      fromDate:     todayStr,
    });

    underlyingPrice =
      (raw.underlyingPrice as number) ??
      ((raw.underlying as Record<string, unknown>)?.last as number) ?? 0;

    allContracts = parseChain(raw, underlyingPrice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Chain fetch failed: ${msg}` }, { status: 502 });
  }

  // ── 2. Filter to relevant window ─────────────────────────────────────────────
  const filtered = filterContracts(allContracts, mode);

  if (filtered.length === 0) {
    return NextResponse.json(
      { error: `No suitable ${mode === 'sell_put' ? 'sell-put' : 'buy-put'} contracts found for ${symbol}` },
      { status: 422 },
    );
  }

  // ── 3. Build Claude prompt with real chain data ───────────────────────────────
  const instruction: ClaudeOptionPlan['instruction'] =
    mode === 'sell_put' ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN';

  const modeDesc = mode === 'sell_put'
    ? 'SELL a cash-secured put for premium income (Vol 6 LEAP strategy)'
    : 'BUY a protective put for portfolio insurance (Vol 5 hedging strategy)';

  const criteria = mode === 'sell_put'
    ? 'DTE 45–90 ideal (60–90 best), delta −0.20 to −0.30 ideal (−0.25 is standard entry), OTM 7–15% preferred. Choose best annualised return that meets delta/DTE. Max 3 contracts.'
    : 'DTE closest to 30 (7–90 range), strike ~7–15% OTM, delta closest to −0.20. Buy 1–2 contracts for insurance.';

  const contractsJson = JSON.stringify(
    filtered.slice(0, 20).map((c) => ({
      occSymbol:        c.symbol,
      exp:              c.expiration,
      dte:              c.dte,
      strike:           c.strike,
      otmPct:           c.otmPct,
      delta:            c.delta,
      bid:              c.bid,
      ask:              c.ask,
      mid:              c.mid,
      iv:               c.iv,
      annualisedReturn: c.annualisedReturn,
      breakeven:        c.breakeven,
      closeTarget75:    c.closeTarget75,
    })),
  );

  const userMessage = `
MODE: option_plan

TASK: Select the single best contract to ${modeDesc} on ${symbol}.

SYMBOL: ${symbol}
UNDERLYING_PRICE: $${underlyingPrice.toFixed(2)}
VIX: ${vix ?? 'unknown'}
MARKET_TREND: ${marketTrend ?? 'unknown'}
${position ? `CURRENT_POSITION: ${position.shares} shares, value $${position.value.toFixed(0)}, pillar: ${position.pillar}` : 'CURRENT_POSITION: none held'}
CONTRACTS_REQUESTED: ${requestedContracts}

SELECTION_CRITERIA: ${criteria}

AVAILABLE_CONTRACTS (all future expirations, filtered to sweet window):
${contractsJson}

IMPORTANT:
- The occSymbol in your response MUST match exactly one of the occSymbol values listed above.
- limitPrice must be between bid and ask of the selected contract (use mid price).
- rationale must cite DTE, OTM%, delta, and the specific Vol 5/6 rule being applied.
- DO NOT write any prose, explanation, or analysis outside the <json></json> block.
- Your ENTIRE response must be the JSON object below and nothing else.

Respond with ONLY a JSON object wrapped in <json></json> tags:
<json>
{
  "occSymbol": "<exact occSymbol from list above>",
  "instruction": "${instruction}",
  "contracts": <number>,
  "limitPrice": <mid price of selected contract>,
  "rationale": "<concise: DTE, OTM%, delta, IV, why this contract, Vol rule>",
  "selectedContract": {
    "expiration": "<YYYY-MM-DD>",
    "dte": <number>,
    "strike": <number>,
    "otmPct": <number>,
    "delta": <number>,
    "bid": <number>,
    "ask": <number>,
    "mid": <number>,
    "iv": <number>,
    "annualisedReturn": <number>,
    "breakeven": <number>,
    "closeTarget75": <number>
  }
}
</json>
`.trim();

  // ── 4. Stream Claude → validate → return result ──────────────────────────────
  // Streaming keeps bytes flowing so Netlify's 26s inactivity timeout never fires.
  const encoder = new TextEncoder();
  const occSet  = new Set(filtered.map((c) => c.symbol));

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const client = new Anthropic({ apiKey });
        const [feedbackBlock, paceBlock] = await Promise.all([
          loadFeedbackBlock(),
          loadPaceBlock(),
        ]);
        const stream = await client.messages.stream({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     cachedSystemPrompt(),
          messages:   [{ role: 'user', content: withContext(feedbackBlock, paceBlock, userMessage) }],
        });

        let fullText = '';
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            fullText += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }

        let plan: ClaudeOptionPlan | null = null;
        const extracted = extractJSON(fullText);
        if (extracted.trimStart().startsWith('{')) {
          try { plan = JSON.parse(extracted) as ClaudeOptionPlan; } catch { /* fall through to scoreFallback */ }
        }

        // Validate: occSymbol must exist in the live chain
        let validationPassed = plan != null && occSet.has(plan.occSymbol);
        let selectedContract = plan != null ? (filtered.find((c) => c.symbol === plan!.occSymbol) ?? null) : null;

        if (!validationPassed || !selectedContract) {
          selectedContract = scoreFallback(filtered, mode);
          plan = {
            occSymbol:        selectedContract.symbol,
            instruction,
            contracts:        Math.min(requestedContracts, 3),
            limitPrice:       selectedContract.mid,
            rationale:        `AI selection failed validation — using best scored contract: ${selectedContract.dte} DTE, ${selectedContract.otmPct.toFixed(1)}% OTM, Δ ${selectedContract.delta.toFixed(2)}`,
            selectedContract: plan?.selectedContract ?? selectedContract,
          };
          validationPassed = false;
        }

        const finalPlan = plan!;
        finalPlan.limitPrice = +Math.max(selectedContract.bid, Math.min(selectedContract.ask, finalPlan.limitPrice)).toFixed(2);
        finalPlan.contracts  = Math.max(1, Math.min(3, Math.floor(finalPlan.contracts)));

        // Emit result first so the client always gets it; staging follows with
        // a timeout so a slow blob write can never block the response.
        const result = JSON.stringify({
          occSymbol: finalPlan.occSymbol, instruction: finalPlan.instruction,
          contracts: finalPlan.contracts, limitPrice: finalPlan.limitPrice,
          rationale: finalPlan.rationale, selectedContract,
          validationPassed, symbol: symbol.toUpperCase(), underlyingPrice, mode,
        });
        controller.enqueue(encoder.encode(`\n__RESULT__${result}`));
        controller.enqueue(encoder.encode('\n__DONE__'));

        try {
          await Promise.race([
            appendInbox([{
              source:      'option',
              symbol:      symbol.toUpperCase(),
              instruction: finalPlan.instruction,
              quantity:    finalPlan.contracts,
              orderType:   'LIMIT',
              occSymbol:   finalPlan.occSymbol,
              limitPrice:  finalPlan.limitPrice,
              price:       finalPlan.limitPrice,
              pillar:      position?.pillar,
              rationale:   finalPlan.rationale,
              aiMode:      mode,
              violations:  [],
            }]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('staging timeout')), 5000)),
          ]);
        } catch (err) {
          console.warn('[option-plan] inbox staging failed:', err);
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`\n__RESULT__${JSON.stringify({ error: msg })}`));
        controller.enqueue(encoder.encode('\n__DONE__'));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-cache',
    },
  });
}
