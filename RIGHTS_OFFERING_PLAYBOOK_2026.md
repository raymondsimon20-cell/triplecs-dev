# Rights Offering Playbook — CLM & CRF, 2026

**Status as of 2026-08-15:** both N-2s filed 2026-08-14. Registration only —
record and expiration dates are still `[●]`. Nothing to act on yet; the clock
starts at the announcement press release.

This is an operational playbook built from rules already documented in this
repo (`P2P_RULES_DERIVED.md` D1–D5, Vol-7 overlay, `roStrategyGuidance()` in
`CornerStoneCard.tsx`). It is not investment advice — where the source rules
disagree with each other, that's called out rather than resolved.

---

## 1. The offerings

Terms are **identical** for both funds.

| | CLM | CRF |
|---|---|---|
| Accession | 0001398344-26-014671 | 0001398344-26-014668 |
| Filed | 2026-08-14 | 2026-08-14 |
| Ratio | 1-for-3 | 1-for-3 |
| Subscription price | **104% of NAV** at expiration | **104% of NAV** at expiration |
| Rights | Non-transferable, expire worthless | Non-transferable, expire worthless |
| Over-subscription | Yes, up to 100% additional shares | Yes, up to 100% additional shares |
| Shares out (Jul 31, 2026) | 312,142,253 | 170,263,672 |
| Basic subscription ≈ | ~104.0M shares (+33%) | ~56.8M shares (+33%) |
| With full over-allotment ≈ | ~208.1M (+67%) | ~113.5M (+67%) |
| Est. year-1 offering expense | ~$677,000 | ~$426,000 |
| Record / expiration | **TBD** | **TBD** |

**Change from 2025:** last year priced at the *greater of* 112% of NAV or 80%
of market. This year is a flat **104% of NAV** with no market floor — a lower
subscription price relative to NAV.

---

## 2. The tension to resolve before anything else

Two rules in this repo point opposite directions.

**D4 (`P2P_RULES_DERIVED.md`, status: MISSING — not built):**
> "Rights offering (N2A) play: sell into the filing announcement, buy back
> after dilution."

**The subscription itself:** buying at 104% of NAV is buying below market
whenever the premium exceeds 4%, which for these funds it essentially always
does.

These are incompatible in their pure forms. You cannot both sell into the
announcement and subscribe with a full position. The deciding variable is the
**premium at each stage**, which is exactly what the existing
`roStrategyGuidance()` keys on:

| Premium at announcement | Encoded rule |
|---|---|
| ≥ 30% | Sell down to ~3 shares, wait for completion, buy back |
| 20–30% | Box the position until the RO completes |
| < 20% | Monitor — box or sell if premium rises through 20–30% |

So the app's own logic says: **at a high premium, D4 wins — exit or box. At a
moderate premium, hold and consider subscribing.** The last premiums recorded
in this repo were CLM +17.1% and CRF +16.2%, which sit *below* the box
trigger — but that figure is from `P2P_RULES_DERIVED.md` and is stale. Refresh
it from `/api/cornerstone` before deciding anything.

**First action: get today's premium for both funds.** Everything below branches
on it.

---

## 3. Stage-by-stage

### Stage 0 — now (registration filed, no dates)

- [ ] Record both funds in the RO tracker as `announced`, decision `pending`.
- [ ] Add accession numbers to the notes field (CLM `…-014671`, CRF `…-014668`).
- [ ] Pull current premium for CLM and CRF. Write it down — you need the
      *pre-announcement* premium as a baseline to judge the move later.
- [ ] Do **not** set a deadline yet. There isn't one. The banner will read
      "deadline not recorded", which is correct.
- [ ] Note current share counts of each holding, and which are seed positions
      (sub-$500 1-share bookmarks — those are scale-up candidates only and are
      never sold or ranked, so they don't participate in a D4 exit).

Nothing else. A registration statement is not an offering, and the SEC has not
declared it effective.

### Stage 1 — announcement press release (dates land)

This is the trigger event. Historically the announcement is what moves price.

- [ ] Enter the **record date** and **expiration date** in the tracker. The
      countdown starts here and the banner escalates: info > 10 days, warn
      ≤ 10, critical ≤ 3.
- [ ] Recheck premium for both funds and compare to your Stage-0 baseline.
- [ ] **Branch on premium** using the table in §2.
- [ ] If exiting or boxing: you must be positioned **before the record date**,
      not before expiration. Rights are issued on the record date.

Cash-side checks before any buy or box:

- [ ] Projected post-trade AFW stays above the $10K floor (the guardrail
      blocks it otherwise).
- [ ] Margin utilization stays under 50% — Schwab rejects orders above it at
      the broker, so a plan that assumes 55% simply fails.
- [ ] Boxing lowers collateral requirements and frees equity (Vol-5 method) —
      relevant if the alternative is selling a position you want to keep.

### Stage 2 — subscription period open

- [ ] If subscribing: the money must be available. Work out the exact figure —
      `floor(shares held ÷ 3) × estimated subscription price`. Price isn't
      known until expiration, so size against 104% of *current* NAV plus a
      buffer for NAV drift.
- [ ] Fund it from the contribution tracker / remainder pool rather than
      drawing margin, if the balance covers it. This is what that ledger is for.
- [ ] Decide on over-subscription. Up to 100% additional shares are available,
      and history shows these get heavily requested — 2022 saw over-subscription
      shares make up half of CLM's issuance.
- [ ] **Do not buy at market during the subscription window** at an elevated
      premium — that's the encoded rule, and it's the mirror of D4.
- [ ] Record the decision in the tracker (`subscribed` / `declined`). The
      banner does not clear until you do — deliberately.

### Stage 3 — subscription closed, shares being issued

- [ ] Hold. The encoded rule is explicit: wait for completion before adding.
- [ ] Watch for the premium compression the prospectus itself warns about,
      "especially if Stockholders exercising the Rights attempt to sell
      sizeable numbers of shares immediately after such issuance."
- [ ] Note that shares issue within 15 days after the monthly distribution
      record date, and **new shares don't receive that distribution**. If you
      subscribed, expect one distribution to be smaller than a naive
      share-count calculation implies.

### Stage 4 — complete

- [ ] This is the D4 re-entry point: "buy back after dilution." The encoded
      rule reads "buy-back opportunity at or near NAV. Resume normal DRIP and
      accumulation."
- [ ] Compare the post-offering premium against your Stage-0 baseline. If it
      compressed, the D4 leg paid; if it didn't, it didn't — record which, so
      the next offering has evidence behind it rather than theory.
- [ ] Confirm DRIP is still on and still reinvesting **at NAV** for both funds
      (D1). That's the standing compounding edge and is easy to lose after a
      corporate action.
- [ ] Set the tracker to `complete`.

---

## 4. Things that are true regardless of which branch you take

- **Rights expire worthless and cannot be sold.** Non-transferable, not
  listed, no market. Doing nothing is a real decision with a real cost, which
  is precisely why the tracker banner has no dismiss button.
- **All holders pay the offering costs**, participating or not — ~$677K on CLM,
  ~$426K on CRF.
- **The Board expects it to be anti-dilutive to NAV, dilutive to voting**,
  because 104% of NAV is above book. That is the opposite of the usual rights
  offering. But it is conditioned on shares issued not being "materially less
  than a full exercise of the Basic Subscription" — see §5.
- **Proceeds partly fund the distribution policy.** The filing says so
  explicitly, and that distributions "may constitute a return of… capital."
  Relevant to how you read the yield.
- **Conflicts are disclosed.** Two directors who approved the offering are
  affiliated with the adviser, whose fee scales with assets.

---

## 5. Open question worth settling first

CLM's 2025 offering issued **26.2M shares**. CLM has 312.1M shares outstanding
today. Even allowing that a large part of the growth since came from monthly
DRIP issuance at NAV rather than the offering, 26.2M looks well short of a full
1-for-3 basic subscription on the pre-offering base. CRF's 32.9M looks
proportionally much closer to full, despite CRF being the smaller fund.

If CLM's 2025 offering really was substantially under-subscribed, that is the
exact condition the Board flags as the one where the anti-dilution result does
**not** hold — and it would mean CLM and CRF should be judged separately here
rather than as a pair.

**To settle it:** pull pre-offering share counts from the 2025 annual report
(filed ~March 2026) and compute actual subscription take-up per fund.

---

## 6. What's not built

`D4` is still marked *MISSING — not built* in `P2P_RULES_DERIVED.md`. The
tracker now records stages, dates, and your decision, and the banner won't let
the deadline pass silently — but nothing automates the D4 sell/rebuy, and
nothing computes the subscription cost for you.

Candidates, in order of usefulness:

1. **Subscription cost calculator** — `floor(shares ÷ 3) × 1.04 × NAV`, per
   account, checked against AFW and the 50% margin cap. Turns "can I afford
   this?" into a number.
2. **Premium-at-stage capture** — record the premium automatically at each
   stage transition, so the next offering can be judged on this one's evidence.
3. **D4 staging** — stage the sell/box at announcement and the rebuy at
   completion into the inbox for approval, same path as the drift rebalance.

---

*Not investment advice. This operationalizes rules already documented in this
repo; the branch decisions are yours.*
