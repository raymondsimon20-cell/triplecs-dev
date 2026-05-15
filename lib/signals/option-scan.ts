/**
 * Daily put autopilot scan.
 *
 * Runs after the signal engine in every cron pass. Examines existing put
 * positions and stages four kinds of proposals to the inbox:
 *
 *   1. CLOSE  — short put at >=75% profit. Vol-6 close target. Captures
 *               the remaining 25% of premium that's at risk vs the time
 *               you'd hold to expiration. Almost always the right move
 *               at this profit level.
 *
 *   2. ROLL   — short put with DTE < 21 AND profit% between 25% and 75%.
 *               Buy-to-close the current short, then propose a new
 *               SELL_TO_OPEN at ~60-90 DTE with the same notional. Vol-6
 *               roll mechanic.
 *
 *   3. PROTECT — when triples > 30% of portfolio AND no protective long put
 *                exists on SPY/QQQ, propose a new BUY_TO_OPEN protective put
 *                (Vol-5: ~30 DTE, 10% OTM). Capped at one open hedge.
 *
 *   4. INCOME  — when AFW headroom is comfortable AND no short put exists
 *                on any user-held TIER-1 income ticker, propose a new
 *                SELL_TO_OPEN (Vol-6: 60-90 DTE, delta ~-0.25). Capped at
 *                MAX_INCOME_PROPOSALS per scan to avoid flooding the inbox.
 *
 * All proposals stage with tier: 'approval'. Options never auto-execute,
 * period — the user reviews each before it touches Schwab.
 *
 * No persistence: positions are read fresh from Schwab each run; the scanner
 * just reads the live state and produces proposals.
 */

import { getOptionsChain } from '../schwab/client';
import type { SchwabTokens } from '../schwab/types';
import { pickBestContract, type OptionMode } from '../options/select-contract';
import type { AppendInput } from '../inbox';
import type { EnginePosition } from './engine';

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  /** Vol-6 close trigger: short put at this profit % or higher → propose close. */
  CLOSE_PROFIT_PCT_THRESHOLD: 75,
  /** Vol-6 roll trigger: DTE below this AND profit between MIN/MAX. */
  ROLL_DTE_THRESHOLD:         21,
  ROLL_MIN_PROFIT_PCT:        25,
  ROLL_MAX_PROFIT_PCT:        74,
  /** Protective put proposal trigger: Triples > this fraction of portfolio. */
  PROTECT_TRIPLES_THRESHOLD:  0.30,
  /** Maximum income put proposals per scan (limits inbox flood). */
  MAX_INCOME_PROPOSALS:       2,
  /** Minimum AFW headroom for proposing a new income put. */
  INCOME_MIN_AFW_DOLLARS:     10_000,
  /** Tier-1 income underlyings the strategy actively sells puts on. */
  TIER_1_INCOME_TICKERS: ['TQQQ', 'UPRO', 'QQQY', 'XDTE', 'FEPI', 'JEPI'],
  /** Symbols allowed for protective puts. */
  PROTECT_TICKERS: ['SPY', 'QQQ'],
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Parse OCC option symbol: "TQQQ  240920P00065000" → underlying/exp/type/strike.
// Schwab also returns symbols without the space padding in some shapes.
function parseOcc(symbol: string): {
  underlying: string;
  expiration: string;
  type:       'P' | 'C';
  strike:     number;
} | null {
  const m = symbol.replace(/\s+/g, ' ').match(
    /^(\w+)\s+(\d{6})([CP])(\d{8})$/,
  );
  if (!m) return null;
  const [, underlying, yymmdd, type, strikeStr] = m;
  const year   = 2000 + parseInt(yymmdd.slice(0, 2), 10);
  const month  = yymmdd.slice(2, 4);
  const day    = yymmdd.slice(4, 6);
  const strike = parseInt(strikeStr, 10) / 1000;
  return {
    underlying,
    expiration: `${year}-${month}-${day}`,
    type:       type as 'P' | 'C',
    strike,
  };
}

function dteFromIso(iso: string): number {
  const target = new Date(iso + 'T16:00:00Z').getTime();
  return Math.ceil((target - Date.now()) / (1000 * 60 * 60 * 24));
}

// Position-shape used by the scanner. Mirrors what Schwab returns for options
// after fetch — the scanner accepts any positions list (so cron + test cases work).
export interface OptionScanPosition {
  symbol:        string;     // OCC symbol
  shortQuantity: number;     // contracts short (1 = sold one put)
  longQuantity:  number;     // contracts long (1 = bought one put)
  averagePrice:  number;     // premium per share (×100 = per contract)
  marketValue:   number;     // current cost-to-close (positive abs value)
}

// ─── Phase A: scan existing puts for close/roll ──────────────────────────────

interface PutManagementProposal {
  kind:           'close' | 'roll';
  occSymbol:      string;
  underlying:     string;
  contracts:      number;
  /** For CLOSE: the limit price to buy back at. For ROLL: the close-leg price. */
  closeLimitPrice: number;
  /** For ROLL only: the new leg to open (with shape from pickBestContract). */
  newLeg?: {
    occSymbol:    string;
    contracts:    number;
    limitPrice:   number;
    rationale:    string;
  };
  /** Plain-English rationale for the inbox. */
  rationale:      string;
  /** Profit % at the time of the scan. */
  profitPct:      number;
  /** DTE at the time of the scan. */
  dte:            number;
}

export function scanShortPutsForClose(
  positions: OptionScanPosition[],
): PutManagementProposal[] {
  const out: PutManagementProposal[] = [];

  for (const p of positions) {
    if (p.shortQuantity <= 0) continue;             // skip non-short
    if (!p.symbol || p.symbol.length < 10) continue; // skip equities

    const parsed = parseOcc(p.symbol);
    if (!parsed || parsed.type !== 'P')  continue;

    const dte = dteFromIso(parsed.expiration);
    if (dte < 0)                          continue;

    const contracts = p.shortQuantity;
    const premiumReceived = p.averagePrice * contracts * 100;
    const currentCost     = Math.abs(p.marketValue);
    const profitDollars   = premiumReceived - currentCost;
    const profitPct       = premiumReceived > 0
      ? (profitDollars / premiumReceived) * 100
      : 0;

    // Close at gain target (Vol-6 75% rule).
    if (profitPct >= CONFIG.CLOSE_PROFIT_PCT_THRESHOLD) {
      const closeLimitPrice = +(currentCost / contracts / 100).toFixed(2);
      out.push({
        kind:           'close',
        occSymbol:      p.symbol,
        underlying:     parsed.underlying,
        contracts,
        closeLimitPrice,
        profitPct,
        dte,
        rationale:
          `Vol-6 close: ${profitPct.toFixed(0)}% profit captured on ${parsed.underlying} $${parsed.strike}P ` +
          `(${dte}d remaining). BUY_TO_CLOSE ${contracts} @ ~$${closeLimitPrice.toFixed(2)}.`,
      });
    }
  }

  return out;
}

/**
 * Detect roll candidates (DTE < 21 AND profit between 25%-75%). Caller still
 * needs to fetch the chain for the new leg; this function just identifies
 * which short puts NEED rolling. The chain fetch happens in the orchestrator.
 */
export function detectShortPutRolls(
  positions: OptionScanPosition[],
): Array<{
  occSymbol:      string;
  underlying:     string;
  contracts:      number;
  closeLimitPrice: number;
  profitPct:      number;
  dte:            number;
}> {
  const out: Array<{
    occSymbol: string; underlying: string; contracts: number;
    closeLimitPrice: number; profitPct: number; dte: number;
  }> = [];

  for (const p of positions) {
    if (p.shortQuantity <= 0) continue;
    if (!p.symbol || p.symbol.length < 10) continue;
    const parsed = parseOcc(p.symbol);
    if (!parsed || parsed.type !== 'P') continue;

    const dte = dteFromIso(parsed.expiration);
    if (dte < 0 || dte >= CONFIG.ROLL_DTE_THRESHOLD) continue;

    const contracts = p.shortQuantity;
    const premiumReceived = p.averagePrice * contracts * 100;
    const currentCost     = Math.abs(p.marketValue);
    const profitPct       = premiumReceived > 0
      ? ((premiumReceived - currentCost) / premiumReceived) * 100
      : 0;
    if (profitPct < CONFIG.ROLL_MIN_PROFIT_PCT) continue;
    if (profitPct > CONFIG.ROLL_MAX_PROFIT_PCT) continue;  // covered by close

    out.push({
      occSymbol:      p.symbol,
      underlying:     parsed.underlying,
      contracts,
      closeLimitPrice: +(currentCost / contracts / 100).toFixed(2),
      profitPct,
      dte,
    });
  }

  return out;
}

// ─── Phase B: detect gaps to propose new puts ────────────────────────────────

export interface NewProtectiveProposal {
  underlying: 'SPY' | 'QQQ';
  reason:     string;
}

export function detectProtectiveGap(
  positions:        OptionScanPosition[],
  equityPositions:  EnginePosition[],
  totalValue:       number,
): NewProtectiveProposal[] {
  if (totalValue <= 0) return [];

  // Triples weight (UPRO + TQQQ) — same formula AIRBAG uses.
  const triplesDollars = equityPositions
    .filter((p) => p.symbol === 'UPRO' || p.symbol === 'TQQQ')
    .reduce((s, p) => s + (p.marketValue || 0), 0);
  const triplesPct = triplesDollars / totalValue;
  if (triplesPct < CONFIG.PROTECT_TRIPLES_THRESHOLD) return [];

  // Check whether ANY long put on SPY or QQQ already exists.
  const existingProtect = new Set<string>();
  for (const p of positions) {
    if (p.longQuantity <= 0) continue;
    const parsed = parseOcc(p.symbol);
    if (!parsed || parsed.type !== 'P') continue;
    if (parsed.underlying === 'SPY' || parsed.underlying === 'QQQ') {
      existingProtect.add(parsed.underlying);
    }
  }

  const proposals: NewProtectiveProposal[] = [];
  for (const underlying of CONFIG.PROTECT_TICKERS) {
    if (existingProtect.has(underlying)) continue;
    proposals.push({
      underlying,
      reason:
        `Triples at ${(triplesPct * 100).toFixed(1)}% > ${CONFIG.PROTECT_TRIPLES_THRESHOLD * 100}% with no ${underlying} protective put. ` +
        `Vol-5 hedge: propose ~30 DTE, ~10% OTM long put.`,
    });
    // Only propose one underlying per scan — pick SPY first (most liquid).
    break;
  }
  return proposals;
}

export interface NewIncomeProposal {
  underlying: string;
  reason:     string;
}

export function detectIncomeGaps(
  positions:        OptionScanPosition[],
  equityPositions:  EnginePosition[],
  afwDollars:       number | undefined,
): NewIncomeProposal[] {
  if (typeof afwDollars !== 'number') return [];
  if (afwDollars < CONFIG.INCOME_MIN_AFW_DOLLARS) return [];

  // Already-active short puts by underlying.
  const activeShortByUnderlying = new Set<string>();
  for (const p of positions) {
    if (p.shortQuantity <= 0) continue;
    const parsed = parseOcc(p.symbol);
    if (!parsed || parsed.type !== 'P') continue;
    activeShortByUnderlying.add(parsed.underlying);
  }

  // Equity holdings present in portfolio (to size and confirm willingness to own).
  const heldEquitySymbols = new Set(
    equityPositions.filter((p) => p.marketValue > 0).map((p) => p.symbol),
  );

  const proposals: NewIncomeProposal[] = [];
  for (const ticker of CONFIG.TIER_1_INCOME_TICKERS) {
    if (proposals.length >= CONFIG.MAX_INCOME_PROPOSALS) break;
    if (activeShortByUnderlying.has(ticker)) continue;
    if (!heldEquitySymbols.has(ticker))      continue;  // only propose on names you actually hold
    proposals.push({
      underlying: ticker,
      reason:
        `Tier-1 income candidate ${ticker}: no active short put, AFW headroom $${Math.round(afwDollars)}. ` +
        `Vol-6 sell-put: 60-90 DTE, delta ~-0.25, OTM ~10%.`,
    });
  }
  return proposals;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface OptionScanResult {
  closeProposals:    AppendInput[];
  rollProposals:     AppendInput[];
  protectProposals:  AppendInput[];
  incomeProposals:   AppendInput[];
  skipped:           Array<{ underlying: string; reason: string }>;
}

/**
 * Run the full daily scan. Fetches option chains for any underlyings that
 * need new-leg pricing (rolls, protect/income proposals). All staged items
 * are tier 'approval' — options never auto-execute.
 *
 * Fetch failures on individual underlyings are non-fatal — the corresponding
 * proposal is skipped with a recorded reason rather than poisoning the whole run.
 */
export async function runOptionScan(
  tokens:          SchwabTokens,
  optionPositions: OptionScanPosition[],
  equityPositions: EnginePosition[],
  prices:          Record<string, number>,
  totalValue:      number,
  afwDollars:      number | undefined,
): Promise<OptionScanResult> {
  const result: OptionScanResult = {
    closeProposals:   [],
    rollProposals:    [],
    protectProposals: [],
    incomeProposals:  [],
    skipped:          [],
  };

  // Phase A.1 — close at gain
  const closes = scanShortPutsForClose(optionPositions);
  for (const c of closes) {
    result.closeProposals.push({
      source:      'option',
      symbol:      c.underlying,
      occSymbol:   c.occSymbol,
      instruction: 'BUY_TO_CLOSE',
      quantity:    c.contracts,
      orderType:   'LIMIT',
      limitPrice:  c.closeLimitPrice,
      price:       c.closeLimitPrice,
      rationale:   c.rationale,
      aiMode:      'put_close',
      violations:  [],
      tier:        'approval',
    });
  }

  // Phase A.2 — roll (close + new SELL_TO_OPEN)
  const rolls = detectShortPutRolls(optionPositions);

  for (const r of rolls) {
    // First leg: close the existing short.
    result.rollProposals.push({
      source:      'option',
      symbol:      r.underlying,
      occSymbol:   r.occSymbol,
      instruction: 'BUY_TO_CLOSE',
      quantity:    r.contracts,
      orderType:   'LIMIT',
      limitPrice:  r.closeLimitPrice,
      price:       r.closeLimitPrice,
      rationale:
        `Roll leg 1 (close): ${r.profitPct.toFixed(0)}% profit on ${r.underlying} short put with ${r.dte}d left. ` +
        `BUY_TO_CLOSE ${r.contracts} @ ~$${r.closeLimitPrice.toFixed(2)}.`,
      aiMode:      'put_roll',
      violations:  [],
      tier:        'approval',
    });
    // Second leg: pick the new short.
    try {
      const chain   = await getOptionsChain(tokens, r.underlying, { strikeCount: 40 });
      const px      = prices[r.underlying];
      if (!px || px <= 0) throw new Error(`no underlying price for ${r.underlying}`);
      const picked  = pickBestContract(chain as Record<string, unknown>, px, 'sell_put');
      if (!picked) throw new Error(`no candidate in Vol-6 window for ${r.underlying}`);
      result.rollProposals.push({
        source:      'option',
        symbol:      r.underlying,
        occSymbol:   picked.symbol,
        instruction: 'SELL_TO_OPEN',
        quantity:    r.contracts,   // match notional
        orderType:   'LIMIT',
        limitPrice:  picked.mid,
        price:       picked.mid,
        rationale:
          `Roll leg 2 (open): ${r.underlying} ${picked.expiration} $${picked.strike}P @ mid $${picked.mid}. ` +
          `${picked.dte}d, delta ${picked.delta.toFixed(2)}, ${picked.otmPct.toFixed(1)}% OTM, ` +
          `annualised ${picked.annualisedReturn.toFixed(1)}%.`,
        aiMode:      'put_roll',
        violations:  [],
        tier:        'approval',
      });
    } catch (err) {
      result.skipped.push({
        underlying: r.underlying,
        reason:     `Roll leg 2 skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Phase B.1 — protective put proposals
  const protectGaps = detectProtectiveGap(optionPositions, equityPositions, totalValue);
  for (const g of protectGaps) {
    try {
      const chain  = await getOptionsChain(tokens, g.underlying, { strikeCount: 40 });
      const px     = prices[g.underlying];
      if (!px || px <= 0) throw new Error(`no underlying price for ${g.underlying}`);
      const picked = pickBestContract(chain as Record<string, unknown>, px, 'buy_put');
      if (!picked) throw new Error(`no candidate in Vol-5 window for ${g.underlying}`);
      result.protectProposals.push({
        source:      'option',
        symbol:      g.underlying,
        occSymbol:   picked.symbol,
        instruction: 'BUY_TO_OPEN',
        quantity:    1,
        orderType:   'LIMIT',
        limitPrice:  picked.mid,
        price:       picked.mid,
        rationale:
          `${g.reason} Picked ${g.underlying} ${picked.expiration} $${picked.strike}P @ mid $${picked.mid} ` +
          `(${picked.dte}d, ${picked.otmPct.toFixed(1)}% OTM).`,
        aiMode:      'put_propose_long',
        violations:  [],
        tier:        'approval',
      });
    } catch (err) {
      result.skipped.push({
        underlying: g.underlying,
        reason:     `Protective proposal skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Phase B.2 — income put proposals
  const incomeGaps = detectIncomeGaps(optionPositions, equityPositions, afwDollars);
  for (const g of incomeGaps) {
    try {
      const chain  = await getOptionsChain(tokens, g.underlying, { strikeCount: 40 });
      const px     = prices[g.underlying];
      if (!px || px <= 0) throw new Error(`no underlying price for ${g.underlying}`);
      const picked = pickBestContract(chain as Record<string, unknown>, px, 'sell_put');
      if (!picked) throw new Error(`no candidate in Vol-6 window for ${g.underlying}`);
      result.incomeProposals.push({
        source:      'option',
        symbol:      g.underlying,
        occSymbol:   picked.symbol,
        instruction: 'SELL_TO_OPEN',
        quantity:    1,
        orderType:   'LIMIT',
        limitPrice:  picked.mid,
        price:       picked.mid,
        rationale:
          `${g.reason} Picked ${g.underlying} ${picked.expiration} $${picked.strike}P @ mid $${picked.mid} ` +
          `(${picked.dte}d, delta ${picked.delta.toFixed(2)}, annualised ${picked.annualisedReturn.toFixed(1)}%).`,
        aiMode:      'put_propose_short',
        violations:  [],
        tier:        'approval',
      });
    } catch (err) {
      result.skipped.push({
        underlying: g.underlying,
        reason:     `Income proposal skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}
