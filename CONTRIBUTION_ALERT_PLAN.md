# Contribution → Allocation Tracking

**Goal:** never miss allocating a contribution.

**Shape:** in-app only · allocation tool pre-filled with the amount ·
every contribution carries an open/closed state until it's dealt with.

---

## 1. The reframe

The first version of this plan was an alert. Alerts are the wrong tool for
"I don't want to miss any," because an alert is a single event in time — if
it's missed, dismissed, or read on a phone at a red light, the contribution is
gone from view and nothing remembers it was never allocated.

Tracking state fixes that. Every contribution is either **allocated** or **not**,
and the not-yet-allocated ones stay visible until they aren't. Missing one
stops being possible, rather than becoming unlikely.

So the deliverable isn't a notification. It's a small ledger with two states
and a button.

---

## 2. What already exists

| Piece | Where | State |
|---|---|---|
| Deposit detection | `lib/schwab/transactions.ts` → `fetchCashFlows()` | Works |
| Daily sync | `netlify/functions/daily-alert.mts` (`0 12 * * *`) | Works — already appends new cash flows each morning |
| `Contribution` category + chip styling | `app/api/transactions/route.ts:147`, `TransactionsView.tsx:35` | **Already there.** Contributions already render in the Transactions tab |
| Per-order metadata persistence | `TradeHistoryEntry` in `app/api/orders/route.ts` | Works — already carries `rationale`, `aiMode`, `accountHash` |
| Allocation math | `TargetAllocationView.tsx`, `plan` useMemo (~line 766) | Works, lives in the component |
| Contribution input on the tool | `TargetAllocationView.tsx:317` `contribution` state | Works |

The Transactions tab already lists contributions. What it doesn't say is
whether you did anything about them. That's the gap.

---

## 3. Design

### 3.1 Status store

Contributions themselves stay derived from cash flows — no duplication. The
*status* is stored separately, keyed by the cash-flow event id:

```ts
// lib/contributions/status.ts
interface ContributionStatus {
  eventId:      string;        // CashFlowEvent.id — the join key
  status:       'open' | 'allocated' | 'ignored';
  allocatedAt?: number;
  /** TradeHistoryEntry ids placed against this contribution. */
  tradeIds?:    string[];
  /** Dollars actually deployed. May be < the contribution (whole-share rounding). */
  allocated$?:  number;
  note?:        string;        // e.g. "allocated manually at Schwab"
}
```

Keyed by event id so a re-sync of cash flows never resets a status, and so an
event that later gets re-fingerprinted doesn't orphan its state. Default is
`open` — a contribution with no status record is unallocated by definition,
which means the feature works retroactively on deposits already in the store.

### 3.2 Where it shows

**Transactions tab** — contributions get a status chip next to the existing
teal `Contribution` category chip:

```
Aug 14   Contribution   ACH deposit           +$2,000.00   [ Needs allocation ]  → Allocate
Aug 01   Contribution   ACH deposit           +$2,000.00   [ Allocated ]
Jul 15   Contribution   Journal from ···123   +$5,000.00   [ Ignored — internal ]
```

**Dashboard** — a single persistent line, only when the count is non-zero:

```
2 contributions awaiting allocation · $4,000 total     [ Allocate → ]
```

That line is the whole feature. It doesn't disappear on refresh, it isn't a
notification you can dismiss, and it reads zero only when the work is done.

### 3.3 The allocate flow

1. Click **Allocate** on a contribution (from either surface).
2. Dashboard switches to the Target Allocation view, `contribution` state
   pre-filled with the amount, and the originating `eventId` held alongside it.
3. You review the computed plan and adjust as normal — nothing about the
   calculator changes.
4. On placing the orders, `contributionId` rides along in the order payload
   and is persisted on each `TradeHistoryEntry`.
5. The contribution flips to `allocated`, with `tradeIds` and `allocated$`
   recorded from what actually placed.

Step 4 is what makes this reliable rather than a guess: the link between
deposit and trades is recorded at the moment of placement, not inferred later.

### 3.4 Escape hatches

Real life won't always route through the tool.

- **Allocated outside the app** → "Mark allocated" with an optional note.
- **Not really a contribution** (internal journal, see §4) → "Ignore", which
  removes it from the count without pretending it was invested.
- **Partial allocation** → see §3.6. Currently the item stays `open` with the
  remainder as its headline figure; under the locked pool design it closes and
  the residual moves to a shared pool.

### 3.5 A hint, not a heuristic

For manual marking, show a read-only hint: *"$1,980 of buys in this account
since this date."* It helps you decide, and costs nothing to compute from
existing trade history.

Deliberately **not** auto-closing on that basis. Buys happen for many reasons —
dividend reinvestment, the weekly drift rebalance, unrelated trades — and a
contribution silently marked allocated because an unrelated rebalance ran is
exactly the failure this feature exists to prevent. Explicit linkage closes
items automatically; inference only ever suggests.

### 3.6 The remainder pool — DESIGN LOCKED, ships with §5b

**Status:** decided, not yet built. Lands with order linkage, which is what
produces partial allocations in the first place. Building it earlier would mean
designing against zero real data.

#### Why

Whole-share rounding leaves a tail on almost every allocation. With the close
threshold at $10, nearly every contribution would stay open indefinitely over
pocket change and the count would never reach zero — the badge-you-ignore
failure this whole feature exists to avoid.

Pooling fixes it by separating two questions that got tangled:

- *"Did I act on this deposit?"* — per contribution, resolves fast, closes
- *"How much undeployed cash is lying around?"* — one number, always current

It also matches reality. Cash is fungible: the $153 left from Aug 1 and the $40
from Aug 14 are the same dollars in the account. Tracking them by which deposit
they came from is bookkeeping that buys nothing.

#### Locked decisions

1. **`allocated` changes meaning** — from "fully deployed" to "dealt with;
   any leftover moved to the pool." A contribution closes as soon as it's
   acted on, regardless of residual.

2. **A residual lives in exactly one place: the pool.** This is the trap to
   avoid. If a contribution row shows "$153 left" *and* the pool includes that
   $153, the banner double-counts and the total is wrong. Once a contribution
   closes, its row shows the original amount and the deployed figure — never a
   live "remaining".

3. **The pool is derived, not stored.**
   ```
   pool = Σ (amount − allocatedDollars) over contributions in state 'allocated'
   ```
   A stored balance would be a second source of truth that can drift from the
   records it summarizes. Derived means the pool is always explainable — you
   can show which deposits it came from — and it survives a cash-flow re-sync.

4. **Allocating from the pool closes nothing.** The pool is a cash balance, not
   a set of obligations. Deploying from it writes the deployment down against
   the contributing records **oldest-first (FIFO)**, raising their
   `allocatedDollars` until the deployed amount is consumed. Their state
   doesn't change — they're already `allocated`.

5. **`RESIDUAL_CLOSE_THRESHOLD` is retired.** With every residual pooling, no
   threshold is needed to decide whether a contribution closes; it always does.
   The constant is replaced by `POOL_DISPLAY_FLOOR` (~$50), below which the
   pool row is hidden — it keeps accumulating, it just doesn't nag over $3.

6. **Banner reports them separately.** Two different things:
   `2 contributions awaiting allocation · $4,000` and, when above the floor,
   `· $253 unallocated remainder`. Summing them into one figure would hide
   that one is fresh money and the other is accumulated change.

#### Work (adds to §5b)

| # | Change | File |
|---|---|---|
| a | `poolBalance()` + `deployFromPool(dollars)` with FIFO write-down | `lib/contributions/status.ts` |
| b | Retire `RESIDUAL_CLOSE_THRESHOLD`; always close on allocate | `lib/contributions/status.ts` |
| c | Pool row in the tracker, with its own Allocate button | `ContributionTracker.tsx` |
| d | Second clause on the banner | `ContributionBanner.tsx` |
| e | FIFO write-down tests, incl. partial consumption and over-deploy | `scripts/test-contribution-status.ts` |

#### Open sub-question

Should the pool be **per account** or **household**? Contributions are scoped
per account, and cash isn't transferable between a Roth and a taxable without
being a withdrawal — which argues per account. Defaulting to per account unless
you say otherwise.

---

## 4. Internal journals still matter

`classifyTransaction()` maps `txType === 'JOURNAL'` to `kind: 'deposit'`. That's
right for TWR, which is per-account — a journal in *is* external from that
account's perspective. It's wrong here: moving money from your Roth to your
taxable creates a `deposit` on one side and a `withdrawal` on the other, and no
new money arrived.

Less dangerous under this design than under the alert design — a bad row is
visible and dismissible rather than an email telling you to go buy something.
But it still pollutes the count, and a count you learn to ignore is a count
that stops working.

**Approach:** pair-match each candidate deposit against a same-date, same-amount
withdrawal on another linked account. On a match, default the status to
`ignored` with the note "internal transfer from ···123" — visible, reversible,
and out of the count. ~15 lines against data already in the cash-flow store.

---

## 5a. Slice one — SHIPPED (`f440d87`, `f72255d`, `f4e9ecf`)

| # | Change | File | Done |
|---|---|---|---|
| 1 | Status store: read/write/list | `lib/contributions/status.ts` | ✅ |
| 2 | Internal-journal pair matching | `lib/contributions/status.ts` | ✅ |
| 3 | API: list + mark + retroactive seed | `app/api/contributions/status/route.ts` | ✅ |
| 4 | Tracker panel in Transactions | `components/ContributionTracker.tsx` | ✅ |
| 5 | Awaiting-allocation banner | `components/ContributionBanner.tsx` | ✅ |
| 6 | Deep link: prefill the calculator | `app/dashboard/page.tsx`, `TargetAllocationView.tsx` | ✅ |
| 9 | Manual mark / ignore / reopen | `components/ContributionTracker.tsx` | ✅ |

That's a working ledger with manual marking, which alone satisfies "don't miss
any." 22 unit tests on the pure logic.

## 5b. Slice two — order linkage + the remainder pool

Not started. These ship together because linkage is what produces the partial
allocations the pool exists to collect.

| # | Change | File | Size |
|---|---|---|---|
| 7 | `contributionId` through order placement → `TradeHistoryEntry` | `app/api/orders/route.ts`, `TargetAllocationView.tsx` | M |
| 8 | Close the contribution on successful placement, recording what filled | `TargetAllocationView.tsx` or the orders route | S |
| 10 | "Buys since this date" hint for manual marking | `ContributionTracker.tsx` | S |
| a–e | The remainder pool — see §3.6 | various | M |

**Notably absent:** extracting the allocation math to `lib/`. That was the
largest item in the original plan and it's no longer needed — nothing computes
a plan server-side. The calculator stays where it is and receives a pre-filled
amount. (Still worth doing for testability one day, but off the critical path.)

**Also not yet automatic:** the retroactive seed is a manual `PUT` call. Left
that way deliberately — it's a bulk write over your history and shouldn't fire
as a side effect of a page load.

## 6. Decisions — settled

1. **Minimum tracked amount** — **$250**. `MIN_TRACKED_AMOUNT`.
2. **Retroactive scope** — seed everything **before the first of the current
   month** as ignored. This month's deposits stay open for review.
3. **Per-account** — yes. Tracker, banner, and API all scope by `accountHash`.
4. **Partial threshold** — **$10** for now (`RESIDUAL_CLOSE_THRESHOLD`), and
   **retired entirely** when the pool lands (§3.6, decision 5).
5. **Pool scoping** — per account, unless changed. See §3.6 open sub-question.

## 7. Risks

- **A count you ignore is worse than no count.** Everything above is in service
  of the number being trustworthy — hence journal matching, retroactive
  seeding, and a minimum amount. If the badge routinely shows items you don't
  intend to act on, the feature has failed even though it "works."
- **Silent auto-close.** Covered in §3.5 — inference suggests, explicit
  linkage closes.
- **Status orphaned from its event.** Keyed on `CashFlowEvent.id`. That id is
  Schwab's `activityId` where available, and a synthetic
  `hash-date-kind-amount-direction` string otherwise. The synthetic form could
  in principle change if a classifier is retuned. Worth storing the amount and
  date on the status record too, so an orphan can be re-matched rather than
  lost.
