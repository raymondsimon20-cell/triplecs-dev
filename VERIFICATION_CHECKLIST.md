# Verification Checklist — 2026-07-31 implementation pass

Eight commits, ~40 files, none yet run against live data. Everything below passed
typecheck, production build, and synthetic verification only.

Each item states **what I expect**. Report the actual figure; where it diverges,
the divergence is the finding.

---

## 1. Margin thresholds — highest risk change

Moved from a 30% utilisation limit to 45%, with the new-buy ceiling at 48% to stay
under Schwab's hard 50% rejection.

| Check | Expected |
|---|---|
| Tools → Strategy → Margin & risk, utilisation | ~16.3% |
| Decline before a maintenance call | ~62% |
| Decline to the 45% trim limit | ~64% |

**Why it matters:** this permits roughly two-thirds more leverage than the app
allowed this morning. If anything about the displayed thresholds looks wrong,
stop and say so before trading against them.

---

## 2. Bucket taxonomy — 30 tickers moved, 32 CEFs reclassified

| Check | Expected |
|---|---|
| Allocation → bucket rows | four buckets: Growth, CEFs, High Yield, Leveraged |
| CEFs share of portfolio | ~23% (was ~21% before the CEF reclassification) |
| Growth share | ~2–3% — the Growth names are mostly seed bookmarks |
| Any bucket labelled "Hedge" | **should not exist** — retired |
| SPXU / SQQQ / SH / PSQ / DOG | should read **Leveraged**, not Growth |

**Known consequence:** Growth reads ~18pp under its 20% default target, making it
the strongest catch-up magnet in the planner. Run **Set Targets from Current**
before using the contribution calculator, or it will steer most of a deposit into
growth anchors.

---

## 3. DRIP status — genuinely unknown

Tools → Strategy → Cornerstone. The panel infers status from transactions rather
than a setting, so I have no idea what it will say.

| If it shows | Meaning |
|---|---|
| **Reinvesting** on CLM and CRF | the compounding engine is running; the NAV-capture figure is real |
| **Paying cash** | DRIP is off at the broker. The CEF bucket is behaving as an ordinary high-yield holding and its 20% target is sized for something it is not doing |
| **Not enough history** | fewer than two payments on record — no verdict yet |

This is the single most consequential unknown in the pass.

---

## 4. Put insurance

Tools → Strategy → Margin & risk, top panel.

Likely shows **no long index puts held**. That is a finding, not a bug — worth
knowing given the margin ceiling just went up. If puts *are* held, check whether
the "with current puts" headroom actually moves; strikes beyond 20% OTM often
barely shift it.

---

## 5. Contribution labelling

| Check | Expected |
|---|---|
| Cash Flow → Contributions (July) | ~$43,760 + whatever parent deposits the $600/$400 legs belong to |
| Month Close → July Contributions | should rise by roughly $40,344 |
| Month Close → Market & Other | should fall by roughly the same |
| Inflow reconciliation → unswept warning | should stay **silent** (~1.7%, below the 15% threshold) |
| Unrecognised inflows | ~$5.20 (a Direxion credit) |

**If the unswept warning fires**, a payer is still unclassified. The unrecognised
list names it; add the fragment to `lib/data/contribution-sources.ts`.

**Cross-check:** Paycheck2Portfolio reports July contributions of $45,452.54. A
persistent gap against that points at a missing source.

---

## 6. Dividends

| Check | Expected |
|---|---|
| Cadence column | Weekly on YMAX/YMAG/ULTY/TSLY/NVDY/CONY — **not** Monthly |
| Declared ex/pay dates | ~150 of 162 holdings, normal weight; rest grey italic |
| Est. annual income | ~$25,300 |

The YieldMax cadence is the one to eyeball. If those still read Monthly, the
derivation is not running and projections are ~4× low.

---

## 7. Business spread & bridge

| Check | Expected |
|---|---|
| Blended yield | ~24.3% |
| Spread | ~+16.5pp over 7.75% |
| Net per paycheck | ~$922 |
| Distribution-vs-total-return gap | ~22pp, warning **should fire** |
| Bridge, no income entered, $3.5k expenses | month-1 net cash ≈ **−$1,503** |

The gap warning firing is correct behaviour, not an error.

---

## 8. Tools navigation

| Check | Expected |
|---|---|
| Tools sub-tabs | Today · Income · Trades · Strategy · Allocation · History |
| Nesting depth | two levels — no Portfolio → Income third level |
| Dividends page Income Hub panel | still present (FIRE / expenses / margin tabs) |

That last row matters: I wrongly called it a duplicate mid-session and nearly
removed it. Confirm it survived.

---

## Known stale-cache behaviour

First load after deploy will re-run the allocation warm-up counter — the SMA cache
now stores 100/200-day averages and entries without them are treated as stale.
Expect "Loaded N of 163 tickers" to cycle once.
