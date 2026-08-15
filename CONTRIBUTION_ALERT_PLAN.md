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
- **Partial allocation** → whole-share rounding leaves a remainder. If
  `allocated$` is materially below the contribution, keep it `open` with the
  residual shown: `$2,000 · $1,847 deployed · $153 left`. Below a small
  threshold (~$100, or one share of the cheapest target), close it — chasing
  the last $12 isn't worth a permanent open item.

### 3.5 A hint, not a heuristic

For manual marking, show a read-only hint: *"$1,980 of buys in this account
since this date."* It helps you decide, and costs nothing to compute from
existing trade history.

Deliberately **not** auto-closing on that basis. Buys happen for many reasons —
dividend reinvestment, the weekly drift rebalance, unrelated trades — and a
contribution silently marked allocated because an unrelated rebalance ran is
exactly the failure this feature exists to prevent. Explicit linkage closes
items automatically; inference only ever suggests.

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

## 5. Work breakdown

| # | Change | File | Size |
|---|---|---|---|
| 1 | Status store: read/write/list | new `lib/contributions/status.ts` | S |
| 2 | Internal-journal pair matching | new helper, or `lib/schwab/transactions.ts` | S |
| 3 | API: list contributions + status, mark allocated/ignored | new `app/api/contributions/status/route.ts` | S |
| 4 | Status chip + Allocate button in Transactions | `components/TransactionsView.tsx` | M |
| 5 | Awaiting-allocation line on the dashboard | `components/DashboardOverview.tsx` | S |
| 6 | Deep link: prefill amount + carry `eventId` | `app/dashboard/page.tsx`, `TargetAllocationView.tsx` | M |
| 7 | `contributionId` through order placement → `TradeHistoryEntry` | `app/api/orders/route.ts`, `TargetAllocationView.tsx` | M |
| 8 | Flip status on successful placement | `TargetAllocationView.tsx` or the orders route | S |
| 9 | Manual mark / ignore / note | `TransactionsView.tsx` | S |
| 10 | "Buys since this date" hint | `TransactionsView.tsx` | S |

**Notably absent:** extracting the allocation math to `lib/`. That was the
largest item in the previous plan and it's no longer needed — nothing computes
a plan server-side any more. The calculator stays exactly where it is and just
receives a pre-filled amount. (Still worth doing one day for testability, but
it's no longer on this feature's critical path.)

Suggested order: **1 → 3 → 4 → 5** gives a working ledger with manual marking,
which alone satisfies "don't miss any." Then **6 → 7 → 8** removes the manual
step for the normal path.

## 6. Decisions still open

1. **Minimum tracked amount.** A $12 residual ACH probably shouldn't open an
   item. Suggest $250, configurable, with smaller ones logged but auto-ignored.
2. **Retroactive scope.** On first run, does every historical deposit in the
   store open as unallocated? Suggest seeding everything before today as
   `ignored` so you start at zero rather than facing months of backlog.
3. **Per-account.** A deposit into the Roth should presumably allocate against
   the Roth's targets. Confirm the deep link scopes the account switcher too.
4. **Partial threshold.** What residual is small enough to auto-close (§3.4).

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
