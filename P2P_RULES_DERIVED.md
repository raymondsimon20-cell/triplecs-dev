# P2P Rules — Derived from the Training Academy

Source: p2ptrain-cpswo7uz.manus.space, Modules 1–5 plus the live Target Allocation tool.
Captured 2026-07-31. Paraphrased into implementable rules — not a transcript.

Status column: **HAVE** = encoded in Triple C App · **PARTIAL** = exists but differs
· **MISSING** = not in the app · **CONFLICT** = contradicts current behavior.

**Updated 2026-07-31** after the implementation pass. Items built during that pass
carry a pointer to the module that implements them.

---

## A. Capital Flow

| # | Rule | Status |
|---|---|---|
| A1 | 100% of W-2 income direct-deposits into the brokerage account | HAVE — `lib/portfolio/bridge.ts`, MarginBridgePanel |
| A2 | Incoming cash pays down margin first, then is invested | HAVE — modelled in `projectBridge` |
| A3 | Margin is the "bridge" covering living expenses until dividends catch up | HAVE — bridge direction + months-to-clear |
| A4 | Target ≈ $600 positive cash flow per paycheck after interest cost | HAVE — BusinessSpreadPanel, net/paycheck |
| A5 | Bills are paid from margin/debit against the account, not from held-back salary | HAVE — implicit in the bridge cycle |
| A6 | Start by floating one small bill before scaling to core expenses | MISSING — onboarding concept, not modelled |

## B. Margin Safety

| # | Rule | Status |
|---|---|---|
| B1 | **Maintain ≥ 50% equity at all times.** Margin balance never exceeds 50% of portfolio value | HAVE (Schwab hard-caps at 50%) |
| B2 | Know the maintenance requirement per position: SPY/SPYG ≈ 30%, major stocks 30–50%, high-volatility funds up to 100% | HAVE (`maintenancePct` in fund-metadata) |
| B3 | Never use margin for speculation or depreciating assets | N/A (policy, not computable) |
| B4 | Monitor equity % daily | HAVE (MarginRiskPanel) |
| B5 | Margin rate target ≤ 8.4%; renegotiate every 6 months | PARTIAL — rate stored (7.75%), no renegotiation reminder |
| B6 | $2,000 minimum to qualify for margin | N/A |
| B7 | Positive spread test: blended yield must exceed margin rate | HAVE — BusinessSpreadPanel, shown beside total return |

**Note on B1 vs. the app's AFW guardrail:** the app currently blocks trades whose projected
post-trade AFW dips below $10K. That is a dollar floor; B1 is a ratio. They are not the same
constraint and can disagree — worth deciding which governs.

## C. Bucket Structure

The training modules describe **three** buckets. The live allocation tool uses **four**.

| Tool bucket | Purpose | Triple C App equivalent |
|---|---|---|
| Growth (Anchors) | Capital appreciation; stabilizes margin equity; low maintenance % | `growth` (added 2026-07) |
| CEFs (Engines) | DRIP at NAV compounding | `cornerstone` |
| High Yield (Workhorses) | Covered-call/put income that pays the bills | `income` |
| Leveraged | 3x amplification | `triples` |

| # | Rule | Status |
|---|---|---|
| C1 | Every bucket funded from day one — no sequencing | PARTIAL — planner splits by gap, no sequencing rule |
| C2 | Growth bucket exists to stabilize margin equity, chosen partly for *low maintenance %* | HAVE — Growth pillar added, 35% maintenance default |
| C3 | Bucket targets sum to 100% | HAVE |
| C4 | Per-fund targets within a bucket; unset funds split the remainder evenly | SKIPPED — duplicates score-driven allocation; see T2 note |
| C5 | App had a `hedge` pillar the source has no equivalent for | RESOLVED — retired, inverse/vol folded into Leveraged |

## D. CEFs / DRIP

| # | Rule | Status |
|---|---|---|
| D1 | Enable DRIP **at NAV** specifically on CLM and CRF | HAVE — `lib/portfolio/drip.ts`, inferred from transactions |
| D2 | NAV discount of 13–20% is the expected compounding edge | PARTIAL (`/api/cornerstone` has premium/discount) |
| D3 | Judge CEFs on **Total Return** (price + all distributions), never price alone | PARTIAL (Positions has Total Return) |
| D4 | Rights offering (N2A) play: sell into the filing announcement, buy back after dilution | MISSING — not built |
| D5 | Vol-7 overlay: NAV premium > 30% is a box/sell trigger | HAVE (hard override in scoring) |

**Live data point:** the source tool currently shows CLM at +17.1% and CRF at +16.2% premium and
rates both Neutral — i.e. the 30% trigger is the app's Vol-7 rule, not the tool's.

## E. Options & Defense

| # | Rule | Status |
|---|---|---|
| E1 | Buy monthly puts on SPY or QQQ, 10–20% OTM, ~30 DTE, rolled each expiration | HAVE — PutInsurancePanel checks OTM band + DTE |
| E2 | Treat put premium as a recurring operating expense, not a discretionary trade | PARTIAL — framed as standing cover, not expensed |
| E3 | Puts exist to protect *margin equity*, not to profit | HAVE — drawdown headroom is the headline metric |
| E4 | Increase protection under stress conditions | PARTIAL — MarketConditions sizes the hedge sleeve; not linked to the put panel |
| E5 | Covered calls only on growth positions you'd be happy to sell higher | MISSING — not built |
| E6 | Cash-secured puts at your genuine target buy price | HAVE (OpenPutTracker, put chain) |

## F. Crash Playbook

| # | Rule | Status |
|---|---|---|
| F1 | Sell 100%-maintenance positions first — frees the most equity per dollar | PARTIAL (maintenance scored, not sequenced) |
| F2 | Redeploy ~1/3 into 3x leveraged (TQQQ/UPRO) to amplify recovery | PARTIAL (TRIPLES_DIP_LADDER) |
| F3 | Put insurance is deeply ITM at this point — that's the cash to deploy | MISSING |
| F4 | Buy into fear rather than de-risking | PARTIAL (dip ladder) |

## G. Milestones

| Phase | Threshold | Meaning |
|---|---|---|
| 1 | $2,000 | Margin qualified; float one small bill |
| 2 | $20,000 | Float core expenses (rent/mortgage) |
| 3 | $100,000 | "Charlie Munger Rule" — hardest milestone; compounding accelerates |
| 4 | $3,000–4,400+/mo | Dividends cover all expenses; bridge no longer needed |

Status: HAVE — `lib/portfolio/milestones.ts`, MilestonesPanel on Tools → Today. Paced by observed contributions rather than an assumed savings rate.

## H. Stated Targets (source claims)

- Conservative blended yield: **20–30%**; source claims actual blends reach 47–54%
- Margin rate: **~8.4%**
- Implied spread: **17–22pp**
- Source-cited returns: 39–52% annually
- Expense benchmark used: $8,333/mo ($100K/yr, family of six)

---

# Allocation Tool — Behavioral Delta

What the source tool does that Triple C App's Target Allocation does not:

| # | Behavior | Status |
|---|---|---|
| T1 | Four buckets including **Growth** | HAVE |
| T2 | Two-level targets: bucket %, then per-fund % *within* bucket | SKIPPED — see note below |
| T3 | Unset funds split their bucket's remainder evenly | SKIPPED — follows from T2 |
| T4 | **"Set Targets from Current"** — snapshot present allocation as the starting point | HAVE |
| T5 | Selectable SMA period: 50 / 100 / 200 | HAVE — `lib/portfolio/sma.ts` |
| T6 | **User-editable scoring weights**, normalised, persisted locally | HAVE |
| T7 | **Catch-Up weight as a slider** | HAVE — one of the six weights |
| T8 | **"Apply to Rebalance" toggle** | HAVE — even split across top 8 when off |
| T9 | Focus Mode | HAVE (already existed) |
| T10 | Signal filter chips | HAVE |
| T11 | "% Bucket" vs "% Portfolio" display toggle | HAVE |
| T12 | Per-bucket blended yield + projected target yield | HAVE |
| T13 | Custom filters + EVALUATE | MISSING — not built |
| T14 | Progressive load counter | HAVE (already existed) |
| T15 | Yield defined as *last distribution annualized*, forward-looking | HAVE — cadence-derived |

**Why T2/T3 were skipped:** per-fund targets duplicate the scoring engine. Within-bucket
allocation is already decided by score — that is what the apply-scores toggle controls.
A second, manual mechanism competing with it would be ambiguous when the two disagree,
and setting targets by hand across 160+ holdings is not realistic. Raising the Catch-Up
weight is the existing lever for more control over within-bucket allocation.

Shared columns: Ticker · Bucket · Score · Signal · vs 50-SMA · 12MO · 24MO · Yield · NAV Disc · Margin.
Column set already matches; the difference is configurability, not display.

---

# Two Things Worth Deciding Before Encoding Anything

**1. Distribution yield is not total return.** The source frames 20–30% blended yield as the
engine. Your own Dividends page currently reports 24.69% forward yield against **+1.82% total
return** and **−3.10% total gain**. Both figures are correct and not in conflict: high-distribution
funds can pay 50%+ while the NAV bleeds, so the distribution is partly return of capital. Rule D3
(judge on total return) is the source's own guard against this, and it points the opposite
direction from scoring on yield. The current 40pp yield cap in scoring is the only thing presently
keeping decay traps off the top of the list.

**2. Several rules are unfalsifiable as stated.** "Never speculate," "stay disciplined," and the
39–52% return claim can't be encoded or checked. Worth separating the mechanical rules (B1, C3,
D5, E1) from the dispositional ones so the engine only enforces what it can actually measure.

Also relevant: per your own notes, the signal engine has been off since July 2026 because it lost
money, and the weekly Wednesday stage-for-approval rebalance is the only automation running. Any
rule adopted here should specify whether it advises or acts.
