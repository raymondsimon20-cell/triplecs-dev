# Prompt to recreate the Triple C App

Build a Next.js 14 (App Router, TypeScript) trading dashboard called "Triple C" that automates a leveraged-ETF + income-fund portfolio strategy against a live Charles Schwab brokerage account, with Claude as an AI analysis layer. Deploy target: Netlify (Netlify Functions for cron, Netlify Blobs for storage in prod; local JSON files under `.data/` in dev).

## Strategy to encode (source of truth — put this in a rules doc first)

Four portfolio pillars with allocation targets:
- Triples (leveraged index ETFs: UPRO, TQQQ, SPXL, UDOW — major index only, sector triples like SOXL/TECL decay badly): 10% target, 10–30% range
- Cornerstone (CLM, CRF closed-end funds, DRIP-at-NAV is the mechanic): 20% target, 30%+ premium-to-NAV = sell/box signal
- Core/Income (Yieldmax, Defiance, Roundhill, RexShares, NEOS, growth anchors, bonds): 65% target
- Hedges (inverse triple ETFs SQQQ/SPXU/SDOW/SOXS/FNGD, put options): 5% target, minimum 1% always held

Key mechanics: trim triples every ~5% rise above target; buy $100K in triples every 10% down from highs (up to $300K at -30%); when selling income funds in a downturn, redeploy 1/3 into triples; margin tiers healthy <20% / warning 20–30% / critical 30–50% / emergency >50% (Schwab hard-caps margin utilization at 50% — orders above that fail at the broker); single-fund concentration cap 20% hard / 10% personal target / 15% warning; AFW (Available For Withdrawal — Schwab's equity-minus-maintenance-requirement metric) is the primary signal: AFW drops 10% = buy signal, position drifts trigger rebalancing back to target. Full downturn/recovery playbook and fund-family-specific behavior (Defiance sells puts, Roundhill sells calls, Yieldmax/RexShares bounce-then-decay) should be captured too.

## Architecture

**Auth & data layer**
- Schwab OAuth2 authorization-code flow with CSRF state param, token refresh, JWT session cookies (`jose`)
- `lib/schwab/{auth,client,orders,transactions,cost-basis,types}.ts` — typed Schwab API wrapper (accounts, positions, quotes, orders, options chains, transaction history)
- `lib/storage.ts` — abstracted storage (local file in dev, Netlify Blobs in prod) for tokens, snapshots, cache, engine state
- Multi-account support with an account switcher

**Classification & rules engine**
- `lib/classify.ts` — canonical symbol → pillar classification (backed by a `lib/data/fund-metadata.ts` table as source of truth, legacy symbol sets as fallback)
- `lib/signals/engine.ts` — pure, testable rules engine. Each rule is a named constant block in a single `CONFIG` object (thresholds, dollar amounts, percentages — no magic numbers inline) producing typed `TradeSignal`s in categories: actionable trades, alerts, info. Rules to implement: AFW_TRIGGER (SPY drawdown proxy for AFW drawdown), DEFENSE mode (equity ratio threshold), AIRBAG (VIX-scaled position sizing), MAINTENANCE_RANKED_TRIM (margin relief above threshold, rotates 1/3 of proceeds into triples), PILLAR_FILL (proposes new positions to close pillar gaps, capped per-trade and per-run, penalizes over-concentrated fund families), a per-ticker dip-buying ladder (fixed % step, weighted budget split across tickers, anchor resets on new highs, hard ceiling on combined + per-ticker weight), pivot deadline/kill-switch on runaway margin debt growth.
- `lib/guardrails.ts` — a SEPARATE, independent validation layer that every proposed trade (AI-generated or auto-fired) must pass before execution: max order % of portfolio, max concentration after trade, max pillar overdrift, and an AFW-floor check that projects post-trade margin draw (including for options, via cash-secured/naked/covered margin math) and blocks anything that would drop AFW below a configured dollar floor. This must be enforced even for automated/one-click trades — never trust the signal engine alone.
- `lib/signals/{auto-config,auto-execute,daily-plan,daily-digest,plan-archive,run,state,cron-health,option-scan}.ts` — daily plan generation, auto-execution of low-risk signals with daily trade-count and exposure-shift caps, persisted engine state, plan archival/replay, cron health monitoring, digest emails.

**AI layer**
- `lib/ai/system-prompt.ts` — Claude system prompt embedding the full strategy rules
- `lib/ai/{feedback-context,pace-context,recap-loader,prompt-cache}.ts` — context builders + prompt caching for portfolio-aware analysis
- `/api/ai-analysis` route calling Claude with live portfolio + strategy rules for narrative analysis

**API surface** (Next.js route handlers under `app/api/`): auth (login/callback/logout), accounts (+ numbers), quotes, orders, options + options-chain, cornerstone (NAV premium/rights-offering detection via `ro-status`), dividends, watchlist, trade-history, transactions, reconcile-trades, performance + performance-review, signals, rebalance-plan, strategy (settings CRUD), snapshots, backfill, inbox (daily plan approval queue), automation-pause, alerts, notifications, market-conditions, market-correction, recap-stats, recommendations, expenses, stream-credentials (for live quote streaming), admin (seed-universe and lock-recovery utilities).

**UI** (React components, Tailwind, dark/light theme, Framer Motion, Recharts): dashboard shell with 60s auto-refresh during market hours; pillar allocation bar + legend; margin health meter with rule-threshold markers + simulator; FIRE-progress bar; positions table (sortable/filterable); account switcher; Triples tactical panel (trim/rebalance signals); Cornerstone card (NAV premium, DRIP status, rights-offering alerts); dividend income panel, distribution calendar, fund-family concentration monitor; options strategy panel, open put tracker, inline put chain, close-recommendations panel; pending orders, trade history; watchlist; AI analysis panel; daily plan / today panel / trade inbox with one-click approve; settings panel exposing every engine threshold (targets, margin limits, trim thresholds, concentration caps, FIRE target) without a redeploy; CSV export; toast notifications.

**Ops/cron** (Netlify Functions in `netlify/functions/*.mts`): daily signal engine run, daily rebalance, daily alert/digest email — scheduled, idempotent, with cron-health tracking so silent failures get surfaced.

## Build order
1. Rules doc (like `Triple-Cs-Volume-7-Rules.md`) as the spec — write this FIRST, everything else derives from it
2. Schwab OAuth + typed API client + session handling
3. Classification engine + fund metadata table
4. Storage layer (local file, Netlify Blobs interface)
5. Signals engine as pure functions with a single CONFIG block, unit-testable in isolation (see `scripts/test-*.ts` pattern — engine rules, guardrails, tier classifier, AFW close-recs all get their own test script)
6. Guardrails as a fully separate validation pass — never let the engine's own signals be trusted without re-validation
7. Dashboard UI wired to live data
8. AI analysis layer last, once the rules are already enforced deterministically — Claude narrates and recommends, but hard limits are code, not prompt instructions
9. Cron jobs + email digest
10. Settings panel to expose tunables

## Hard constraints to bake in from day one (learned the hard way in this app's history)
- Schwab hard-caps margin utilization at 50% at the broker level — orders above that fail silently or with a cryptic error; validate client-side before submitting
- Schwab OAuth + API requires HTTPS end-to-end, including local dev tunnels — plain HTTP breaks the callback
- AFW must never be expanded as anything but "Available For Withdrawal" in code comments/UI — it's a specific Schwab balances field (`availableFunds`), not a generic term
- Every auto-executable trade needs a hard floor check (e.g., block if projected post-trade AFW < $10K) that runs independently of whatever generated the trade
- Keep tactical/temporary strategy deviations (e.g. weighting a decay-prone sector ETF higher than the base strategy recommends) explicitly labeled as such in both code comments and the rules doc, so they don't get mistaken for permanent strategy later
