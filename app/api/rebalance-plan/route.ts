/**
 * POST /api/rebalance-plan
 *
 * AI-powered rebalance plan generator.
 * Analyses pillar drift vs strategy targets, applies the Vol 7 1/3 rule,
 * and returns specific buy/sell orders with exact share counts.
 *
 * All share counts are Math.floor(dollars / price) — never fractional.
 * Only recommends symbols from the user's existing positions.
 *
 * Body:
 *   {
 *     totalValue:    number,
 *     equity:        number,
 *     positions:     EnrichedPosition[],
 *     pillarSummary: PillarSummary[],
 *     targets: {
 *       triplesPct:     number,
 *       cornerstonePct: number,
 *       incomePct:      number,
 *       hedgePct:       number,
 *     }
 *   }
 *
 * Response:
 *   {
 *     orders:  RebalanceOrder[],
 *     summary: string,
 *     drifts:  PillarDrift[],
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/session';
import { TRIPLE_C_SYSTEM_PROMPT } from '@/lib/ai/system-prompt';
import type { EnrichedPosition } from '@/lib/schwab/types';

export const dynamic = 'force-dynamic';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PillarSummary {
  pillar: string;
  label: string;
  totalValue: number;
  portfolioPercent: number;
  positionCount: number;
}

interface Targets {
  triplesPct:     number;
  cornerstonePct: number;
  incomePct:      number;
  hedgePct:       number;
}

export interface RebalanceOrder {
  symbol:         string;
  instruction:    'BUY' | 'SELL';
  shares:         number;        // whole number — Math.floor(dollars/price)
  currentPrice:   number;
  estimatedValue: number;        // shares × currentPrice
  pillar:         string;
  rationale:      string;
}

interface PillarDrift {
  pillar:       string;
  label:        string;
  currentPct:   number;
  targetPct:    number;
  driftPct:     number;          // positive = over target
  driftDollars: number;
  action:       'buy' | 'sell' | 'hold';
}

interface RebalancePlanRequest {
  totalValue:    number;
  equity:        number;
  positions:     EnrichedPosition[];
  pillarSummary: PillarSummary[];
  targets:       Targets;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJSON(text: string): string {
  const xmlMatch = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (xmlMatch) return xmlMatch[1].trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

function positionPrice(pos: EnrichedPosition): number {
  if (pos.longQuantity > 0) return pos.marketValue / pos.longQuantity;
  return pos.quote?.lastPrice ?? pos.averagePrice ?? 1;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    return await handlePost(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Unexpected error: ${msg}` }, { status: 500 });
  }
}

async function handlePost(req: Request) {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });

  let body: RebalancePlanRequest;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { totalValue, equity, positions, pillarSummary, targets } = body;

  if (!totalValue || !positions?.length || !pillarSummary?.length || !targets)
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });

  // ── 1. Calculate pillar drifts ─────────────────────────────────────────────

  const targetMap: Record<string, number> = {
    triples:     targets.triplesPct,
    cornerstone: targets.cornerstonePct,
    income:      targets.incomePct,
    hedge:       targets.hedgePct,
  };

  const drifts: PillarDrift[] = pillarSummary
    .filter((ps) => ps.pillar !== 'other')
    .map((ps) => {
      const target      = targetMap[ps.pillar] ?? 0;
      const driftPct    = ps.portfolioPercent - target;
      const driftDollars = (driftPct / 100) * totalValue;
      return {
        pillar:       ps.pillar,
        label:        ps.label,
        currentPct:   ps.portfolioPercent,
        targetPct:    target,
        driftPct,
        driftDollars,
        action: Math.abs(driftPct) < 1 ? 'hold'
               : driftPct > 0 ? 'sell' : 'buy',
      };
    });

  // Add missing pillars (e.g. hedge at 0% when target is 5%)
  for (const [pillar, target] of Object.entries(targetMap)) {
    if (!drifts.find((d) => d.pillar === pillar) && target > 0) {
      drifts.push({
        pillar,
        label:        pillar,
        currentPct:   0,
        targetPct:    target,
        driftPct:     -target,
        driftDollars: -(target / 100) * totalValue,
        action:       'buy',
      });
    }
  }

  // ── 2. Build position data for Claude ─────────────────────────────────────

  // Exclude options, bonds, and cash — include EQUITY, ETF, MUTUAL_FUND, and anything else tradeable
  const NON_EQUITY = new Set(['OPTION', 'FIXED_INCOME', 'CASH_EQUIVALENT', 'CURRENCY', 'FUTURE']);
  const equityPositions = positions.filter(
    (p) => !NON_EQUITY.has(p.instrument.assetType)
        && Number(p.longQuantity) > 0
        && p.pillar !== 'other',
  );

  const positionRows = equityPositions
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((p) => {
      const price = positionPrice(p);
      return `${p.instrument.symbol} | ${p.pillar} | ${p.longQuantity} shares | $${price.toFixed(2)}/sh | $${p.marketValue.toFixed(0)} value`;
    })
    .join('\n');

  const driftRows = drifts
    .map((d) => {
      const sign = d.driftPct > 0 ? '+' : '';
      return `${d.pillar}: ${d.currentPct.toFixed(1)}% (target ${d.targetPct}%) → drift ${sign}${d.driftPct.toFixed(1)}% / ${sign}$${d.driftDollars.toFixed(0)}  [${d.action.toUpperCase()}]`;
    })
    .join('\n');

  // ── 3. Prompt Claude ──────────────────────────────────────────────────────

  const prompt = `
MODE: rebalance_plan

PORTFOLIO OVERVIEW:
- Total value: $${totalValue.toFixed(0)}
- Equity: $${equity.toFixed(0)}
- Margin used: $${Math.max(0, totalValue - equity).toFixed(0)}

PILLAR DRIFT ANALYSIS:
${driftRows}

CURRENT EQUITY POSITIONS (sell/buy candidates):
symbol | pillar | shares | price | value
${positionRows || 'No equity positions found.'}

STRATEGY RULES (must follow exactly):
1. 1/3 RULE: When trimming income, route exactly 1/3 of the trimmed dollars into Triples (TQQQ or UPRO preferred). The remaining 2/3 stays as freed capital / cash.
2. NEVER sell Cornerstone (CLM or CRF). These are long-term DRIP positions — do not touch.
3. For SELL orders: only sell symbols the user already holds (listed above).
4. For BUY orders: prefer symbols already held. For new positions, you may suggest any symbol from the Triple C universe (YieldMax, Defiance, Roundhill, RexShares, Neos, PIMCO/CEF income, ProShares/Direxion triples, hedge inverses, broad index ETFs, or individual growth anchors). Prioritise Vol 7 favourites: TQQQ, UPRO, YMAG, XDTE, FEPI, SPYI, JEPI, JEPQ, QQQY, CLM, CRF.
5. Shares MUST be whole numbers: use Math.floor(dollarAmount / pricePerShare).
6. Minimum 1 share per order. Skip orders where Math.floor gives 0.
7. Only include orders for pillars with |drift| > 1% AND driftDollars > $500.
8. Keep individual orders manageable — split large sells across top 2-3 positions if needed.

TASK: Generate the minimum set of orders to move each pillar to within 1% of target.
Apply the 1/3 rule automatically for income trims.

Respond with ONLY a JSON object wrapped in <json></json> tags:
<json>
{
  "orders": [
    {
      "symbol": "FEPI",
      "instruction": "SELL",
      "shares": 45,
      "currentPrice": 50.00,
      "estimatedValue": 2250.00,
      "pillar": "income",
      "rationale": "Income at 71.5% vs 65% target — trimming largest income position"
    }
  ],
  "summary": "One sentence describing the overall rebalance plan and 1/3 rule application"
}
</json>
`.trim();

  // ── 4. Pre-build validation maps (needed after Claude responds) ───────────

  const positionPriceMap = new Map(
    equityPositions.map((p) => [p.instrument.symbol, positionPrice(p)])
  );
  const positionShareMap = new Map(
    equityPositions.map((p) => [p.instrument.symbol, p.longQuantity])
  );
  // All known symbols from the Triple C universe — any can be suggested as a new buy
  const APPROVED_BUY_NEW = new Set([
    // Triples (long)
    'TQQQ','UPRO','SPXL','UDOW','TECL','SOXL','FNGU','LABU','TNA','FAS','UMDD','URTY','CURE','HIBL',
    // Hedges / inverse
    'SPXU','SQQQ','SDOW','FAZ','SRTY','SPXS','SH','PSQ','DOG','UVXY','SOXS','FNGD',
    // Cornerstone
    'CLM','CRF',
    // YieldMax
    'TSLY','NVDY','AMZY','GOOGY','MSFO','APLY','OARK','JPMO','CONY','NFLXY','AMDY','PYPLY',
    'AIYY','OILY','CVNY','MRNY','SNOY','BIOY','DISO','ULTY','YMAX','YMAG','MSFO2','GDXY',
    'XOMO','AMZY2','FBY','FIAT','FIVY','TSMY','DIPS','CRSH','KLIP','MSTY','PLTY',
    // Defiance
    'QQQY','IWMY','JEPY','QDTY','SDTY','DFNV','IWMY2',
    // Roundhill
    'XDTE','QDTE','RDTE','WDTE','MDTE','TOPW','BRKW',
    // RexShares
    'FEPI','AIPI','REXQ','REXS','SPYI2',
    // GraniteShares
    'TSYY',
    // Kurv
    'KSLV',
    // JPMorgan
    'JEPI','JEPQ',
    // Neos
    'SPYI','QDVO','JPEI','IWMI','QQQI','BTCI','NIHI','IAUI',
    // Global X
    'QYLD','RYLD','XYLD','DJIA','NVDL','TSLL',
    // PIMCO
    'PDI','PDO','PTY','PCN','PFL','PFN','PHK',
    // Eaton Vance
    'ETV','ETB','EOS','EOI','EVT',
    // BlackRock
    'BST','BDJ','ECAT','BGY','BCAT','BUI',
    // Amplify
    'DIVO','BLOK','COWS',
    // Oxford Lane / RiverNorth / Liberty / Gabelli / Columbia
    'OXLC','OXSQ','RIV','OPP','USA','LICT','GAB','GDV','GGT','STK',
    // Invesco
    'QQQ','QQQM','RSP',
    // KraneShares
    'KMLM',
    // BDC
    'TPVG',
    // Schwab / Vanguard / iShares / broad index
    'SCHD','SCHG','SCHB','VTI','VOO','VYM','VXUS','SPY','IVV','IWM',
    // Growth anchors / individual
    'NVDA','AAPL','MSFT','AMZN','GOOGL','META','SPYG','MCD','COST','MSTR',
    // Gold
    'AAAU','GLD','IAU',
    // Defense
    'ITA',
    // Vol 7 additional income
    'IQQQ','SPYT','XPAY','MAGY','FNGA','FNGB',
  ]);

  // ── 5. Stream Claude → client, validate, return result ────────────────────
  // Streaming keeps bytes flowing so Netlify's inactivity timer never fires.
  // The client reads until __DONE__ then extracts the JSON after __RESULT__.

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const client = new Anthropic({ apiKey });
        const stream = await client.messages.stream({
          model:      'claude-sonnet-4-6',
          max_tokens: 2048,
          system:     TRIPLE_C_SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: prompt }],
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

        // Parse Claude's JSON response
        let claudeOrders: RebalanceOrder[];
        let summary: string;
        try {
          const parsed = JSON.parse(extractJSON(fullText)) as { orders: RebalanceOrder[]; summary: string };
          claudeOrders = parsed.orders ?? [];
          summary      = parsed.summary ?? '';
        } catch {
          throw new Error('AI response was not valid JSON — try again');
        }

        // Validate and sanitise orders
        const validatedOrders: RebalanceOrder[] = claudeOrders
          .filter((o) => {
            if (!o.symbol || !o.instruction || !o.shares) return false;
            if (!['BUY', 'SELL'].includes(o.instruction)) return false;
            if (o.instruction === 'SELL' && !positionShareMap.has(o.symbol)) return false;
            if (o.instruction === 'SELL' && ['CLM', 'CRF'].includes(o.symbol)) return false;
            if (o.instruction === 'BUY' && !positionPriceMap.has(o.symbol) && !APPROVED_BUY_NEW.has(o.symbol)) return false;
            return true;
          })
          .map((o) => {
            const price     = positionPriceMap.get(o.symbol) ?? o.currentPrice ?? 1;
            const shares    = Math.max(1, Math.floor(o.shares));
            const maxShares = o.instruction === 'SELL'
              ? Math.floor(positionShareMap.get(o.symbol) ?? shares)
              : shares;
            const finalShares = Math.min(shares, maxShares);
            return {
              ...o,
              shares:         finalShares,
              currentPrice:   +price.toFixed(2),
              estimatedValue: +(finalShares * price).toFixed(2),
            };
          })
          .filter((o) => o.shares >= 1);

        const result = JSON.stringify({ orders: validatedOrders, summary, drifts });
        controller.enqueue(encoder.encode(`\n__RESULT__${result}`));
        controller.enqueue(encoder.encode('\n__DONE__'));
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
