/**
 * friendly.ts — single source of truth for plain-English language across the app.
 *
 * Three exports:
 *   GLOSSARY     — term → one-line explanation (used by <Term> tooltips)
 *   RULE_LABELS  — engine rule ID → friendly name + one-line description
 *   CONSEQUENCES — engine rule ID → "if you skip this" framing for trade rows
 */

// ─── Glossary ────────────────────────────────────────────────────────────────

export const GLOSSARY: Record<string, string> = {
  AFW: 'Available For Withdrawal — your cash cushion. The dollars you could pull out today after the broker sets aside collateral for what you hold.',
  maintenance: 'How much collateral the broker demands to hold a position. Selling a high-maintenance fund frees more breathing room per dollar than a low-maintenance one.',
  margin: 'Money borrowed from the broker against your holdings. Schwab hard-stops new borrowing at 50% utilization.',
  'premium to NAV': 'How far above the value of its actual holdings a fund trades. CLM/CRF at a 30%+ premium is the signal to sell or box.',
  DRIP: 'Automatic dividend reinvestment. CLM/CRF reinvest at NAV (what holdings are worth), not market price — an instant discount when they trade at a premium.',
  boxing: 'Holding a long and a short position in the same fund at once. Locks the position in place, lowers collateral requirements, and frees equity.',
  DTE: 'Days until the option expires.',
  OTM: 'Out of the money — a strike price below (puts) or above (calls) where the stock trades today.',
  premium: 'The cash you collect for selling an option, or pay to buy one.',
  'cash-secured put': 'Selling a put while holding enough cash to buy the shares if assigned. Income now, shares at a discount if the price falls.',
  expectancy: 'Average result per trade — wins and losses blended together.',
  'equity ratio': 'What you own outright divided by total account value. Falls as borrowing rises; below 40% the app goes on defense.',
  seed: 'A deliberate 1-share starter position marking a fund as part of your approved universe. A bookmark, not an investment — the app suggests scaling seeds up, never selling them.',
  triples: '3× leveraged index ETFs (UPRO, TQQQ, SPXL, UDOW). Move three times as fast as the index, both directions.',
  hedge: 'Positions that profit when the market falls — inverse ETFs and put options. Insurance, minimum 1% at all times.',
  cornerstone: 'CLM and CRF closed-end funds. ~21% yield paid monthly, reinvested at NAV via DRIP.',
  'wash sale': 'IRS rule: sell at a loss and rebuy the same ticker within 30 days, and the tax loss is disallowed.',
};

// ─── Rule labels ─────────────────────────────────────────────────────────────

export interface RuleLabel {
  name: string;
  description: string;
}

export const RULE_LABELS: Record<string, RuleLabel> = {
  AFW_TRIGGER:              { name: 'Dip buying',        description: 'The market dropped — the playbook buys triples in steps on the way down.' },
  TRIPLES_DIP_LADDER:       { name: 'Dip buying',        description: 'Per-ticker dip ladder — buys a fixed slice each 5% a triple falls from its high.' },
  MAINTENANCE_RANKED_TRIM:  { name: 'Margin relief',     description: 'Borrowing got high — sell the fund that frees the most breathing room per dollar.' },
  PILLAR_FILL:              { name: 'Rebalance',         description: 'A pillar drifted below its target — top it back up.' },
  DEFENSE_MODE:             { name: 'Defense mode',      description: 'Equity ratio is low — no new buying until the account recovers.' },
  KILL_SWITCH:              { name: 'Crash brake',       description: 'Borrowing grew too fast — automation pauses new purchases until you reset it.' },
  AIRBAG_SCALE:             { name: 'Auto-hedging',      description: 'Sizes your inverse-ETF hedges up and down with market fear (VIX).' },
  LEVERAGE_REDUCTION_ALERT: { name: 'Trim triples',      description: 'Triples ran above target — take profits back to plan.' },
  CLM_CRF_TRIM:             { name: 'Cornerstone trim',  description: 'CLM/CRF trading rich versus their holdings — trim while the premium is high.' },
  OPTION_SCAN:              { name: 'Options check',     description: 'Daily scan of your puts — close winners, roll expiring ones, add insurance.' },
  SEED_UNIVERSE:            { name: 'Universe seed',     description: '1-share bookmark marking this fund as part of your approved universe.' },
};

/** Friendly name for any engine rule ID (falls back to prettified ID). */
export function ruleName(ruleId: string): string {
  if (RULE_LABELS[ruleId]) return RULE_LABELS[ruleId].name;
  // Prefix match (rule IDs sometimes carry suffixes like FILL_INCOME_XDTE)
  for (const [id, label] of Object.entries(RULE_LABELS)) {
    if (ruleId.startsWith(id)) return label.name;
  }
  return ruleId.replace(/_/g, ' ').toLowerCase();
}

export function ruleDescription(ruleId: string): string | undefined {
  if (RULE_LABELS[ruleId]) return RULE_LABELS[ruleId].description;
  for (const [id, label] of Object.entries(RULE_LABELS)) {
    if (ruleId.startsWith(id)) return label.description;
  }
  return undefined;
}

// ─── Consequence framing ─────────────────────────────────────────────────────

/**
 * "If you skip this" line for a trade suggestion. Deterministic per rule;
 * dollar context filled in where the signal data provides it.
 */
export function consequenceOf(
  ruleId: string,
  direction: 'BUY' | 'SELL' | 'ALERT',
  ctx: { marginUtilPct?: number; marginRatePct?: number; sizeDollars?: number; marginDebt?: number } = {},
): string | undefined {
  const monthlyInterest =
    ctx.marginDebt != null && ctx.marginRatePct != null
      ? (ctx.marginDebt * (ctx.marginRatePct / 100)) / 12
      : undefined;

  if (ruleId.startsWith('MAINTENANCE_RANKED_TRIM') && direction === 'SELL') {
    return monthlyInterest != null
      ? `If you skip this: borrowing stays elevated and interest keeps accruing at roughly $${Math.round(monthlyInterest).toLocaleString()}/mo.`
      : 'If you skip this: borrowing stays elevated and margin interest keeps compounding against you.';
  }
  if (ruleId.startsWith('AFW_TRIGGER') || ruleId.startsWith('TRIPLES_DIP_LADDER')) {
    return 'If you skip this: you miss the dip. The playbook counts on buying these steps down — recoveries are where triples earn their keep.';
  }
  if (ruleId.startsWith('PILLAR_FILL')) {
    return 'If you skip this: the pillar stays under target and the portfolio drifts further from the strategy it was built on.';
  }
  if (ruleId.startsWith('LEVERAGE_REDUCTION_ALERT')) {
    return 'If you skip this: profits stay exposed to a 3× drawdown instead of being rotated into income.';
  }
  if (ruleId.startsWith('CLM_CRF_TRIM')) {
    return 'If you skip this: you hold shares priced well above what the fund actually owns — that premium tends not to last.';
  }
  if (ruleId.startsWith('AIRBAG')) {
    return 'If you skip this: your crash insurance stays mis-sized for current market conditions.';
  }
  return undefined;
}

// ─── Margin zone words ───────────────────────────────────────────────────────

export interface MarginZone {
  word: string;
  color: 'emerald' | 'amber' | 'orange' | 'red';
  advice: string;
}

export function marginZone(utilPct: number, warnPct = 20, limitPct = 30): MarginZone {
  if (utilPct >= 50) return { word: 'Broker limit', color: 'red',    advice: 'Schwab blocks new borrowing here — reduce immediately.' };
  if (utilPct >= limitPct) return { word: 'Reduce now', color: 'orange', advice: 'Above your limit — the app is suggesting sells to bring this down.' };
  if (utilPct >= warnPct)  return { word: 'Caution',    color: 'amber',  advice: 'Getting elevated — watch it, avoid big new buys on margin.' };
  return { word: 'Comfortable', color: 'emerald', advice: 'Borrowing is well inside plan.' };
}

/** Dollars of additional borrowing available before hitting a given zone %. */
export function headroomToZone(totalValue: number, marginDebt: number, zonePct: number): number {
  return Math.max(0, (zonePct / 100) * totalValue - marginDebt);
}
