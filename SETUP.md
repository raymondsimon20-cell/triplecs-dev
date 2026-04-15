# Triple C Dashboard — Setup Guide

## Prerequisites
- Node.js 20+
- A Schwab Developer account (free at developer.schwab.com)
- An Anthropic API key (for AI analysis features)
- A Netlify account (free tier works)

---

## Step 1 — Register a Schwab App

1. Go to https://developer.schwab.com and sign in.
2. Click **Dashboard → Create App**.
3. Fill in:
   - App Name: `Triple C Dashboard`
   - Callback URL: `http://localhost:3000/api/auth/callback` (add your Netlify URL here too once deployed)
   - Product: **Accounts and Trading - Individual**
4. After approval (usually instant), copy your **App Key** (= Client ID) and **App Secret**.

---

## Step 2 — Configure Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
SCHWAB_CLIENT_ID=your_app_key_here
SCHWAB_CLIENT_SECRET=your_app_secret_here
SCHWAB_REDIRECT_URI=http://localhost:3000/api/auth/callback

# Generate a random secret: openssl rand -base64 32
SESSION_SECRET=your_random_32byte_secret

ANTHROPIC_API_KEY=your_anthropic_key

NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## Step 3 — Install & Run Locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 — you'll see the Triple C login page.

Click **Connect Schwab Account** to start the OAuth flow.
After authorizing, you'll land on the live portfolio dashboard.

> **Note:** Local token/cache data is stored in `.data/` (git-ignored).

---

## Step 4 — Deploy to Netlify

### Option A: Netlify CLI (recommended)

```bash
npm install -g netlify-cli
netlify init         # link to your Netlify site
netlify env:set SCHWAB_CLIENT_ID your_key
netlify env:set SCHWAB_CLIENT_SECRET your_secret
netlify env:set SCHWAB_REDIRECT_URI https://your-site.netlify.app/api/auth/callback
netlify env:set SESSION_SECRET your_secret
netlify env:set ANTHROPIC_API_KEY your_key
netlify env:set NEXT_PUBLIC_APP_URL https://your-site.netlify.app
netlify deploy --build --prod
```

### Option B: GitHub → Netlify CI

1. Push to GitHub.
2. In Netlify, **New site from Git** → connect your repo.
3. Add env vars in **Site settings → Environment variables**.

### Upgrading storage to Netlify Blobs (production)

Once deployed, swap the local file storage for Netlify Blobs:

```bash
npm install @netlify/blobs
```

Then in `lib/storage.ts`, follow the comment at the bottom of the file to switch to the Netlify Blobs implementation.

---

## What the Dashboard Delivers

### Core Portfolio View
- **Schwab OAuth** — full authorization code flow with CSRF protection and token refresh
- **Multi-account support** — account switcher dropdown
- **Live positions** — fetched from Schwab with real-time quotes
- **Triple C classification** — every position auto-tagged (Triples / Cornerstone / Core-Income / Hedge)
- **Pillar allocation bar** — visual breakdown of portfolio by pillar vs. your targets
- **Margin health meter** — live margin % with configurable target and max markers
- **Rule alerts** — flags concentration cap and margin limit violations
- **60-second auto-refresh** — polls during market hours
- **FIRE progress bar** — tracks monthly income vs. your FIRE target
- **Dark/light theme toggle**

### Triples (Leveraged ETFs)
- **Triples Tactical Panel** — allocation status, trim signals, and rebalance guidance for UPRO/TQQQ/SPXL
- **Rebalance Calculator** — computes exact buy/sell amounts to hit target allocations

### Cornerstone (CLM/CRF)
- **Cornerstone Card** — live NAV premium/discount tracking, DRIP status, rights offering alerts
- **RO Status API** — detects and surfaces active rights offerings

### Income & Dividends
- **Dividend Income Panel** — tracks distributions by symbol, fund family, and frequency
- **Distribution Calendar** — upcoming ex-dividend and pay dates
- **Fund Family Monitor** — concentration caps per family (Yieldmax, Defiance, Roundhill, RexShares, etc.)

### Options & Puts
- **Options Strategy Panel** — view and manage put-selling strategy
- **Open Put Tracker** — tracks open put positions with P&L and expiration
- **Put Chain Inline** — inline options chain for strike selection

### Risk & Margin
- **Margin Risk Panel** — detailed margin breakdown with buffer analysis
- **Margin Simulator** — model margin impact of hypothetical trades

### Orders & History
- **Pending Orders Panel** — live view of open/working orders from Schwab
- **Trade History Panel** — completed trade log with filtering

### Watchlist
- **Watchlist Panel** — monitor symbols outside your current positions

### AI Analysis
- **AI Analysis Panel** — Claude-powered portfolio analysis using the Triple C's rules: allocation targets, trim thresholds, margin limits, fund family caps, and income optimization

### Settings & Export
- **Settings Panel** — customize allocation targets (Triples %, Cornerstone %, Income %), margin limits, trim thresholds, single-fund concentration caps, and FIRE income target
- **Portfolio Export** — export current positions and analysis to CSV

---

## Project Structure

```
app/
  page.tsx                        # Login screen
  dashboard/page.tsx              # Main dashboard (client component)
  api/
    auth/login/route.ts           # Redirect to Schwab OAuth
    auth/callback/route.ts        # Handle OAuth callback, set session
    auth/logout/route.ts          # Clear session + tokens
    accounts/route.ts             # Fetch + enrich all accounts
    accounts/numbers/route.ts     # Account hash list
    ai-analysis/route.ts          # Claude AI portfolio analysis
    cornerstone/route.ts          # CLM/CRF NAV + premium data
    dividends/route.ts            # Dividend tracking
    market-correction/route.ts    # Market correction signals
    options-chain/route.ts        # Schwab options chain data
    orders/route.ts               # Open/pending orders
    ro-status/route.ts            # Rights offering detection
    trade-history/route.ts        # Completed trade log
    watchlist/route.ts            # Watchlist management

lib/
  schwab/
    auth.ts       # OAuth helpers (authorize URL, token exchange, refresh)
    client.ts     # API client (accounts, positions, quotes)
    orders.ts     # Orders API helpers
    types.ts      # TypeScript interfaces for Schwab API responses
  ai/
    system-prompt.ts  # Claude system prompt with Triple C's rules
  classify.ts     # Triple C pillar classification + rule engine
  session.ts      # JWT session cookies
  storage.ts      # Token + cache storage (file-based locally, Blobs in prod)
  utils.ts        # Formatting utilities

components/
  AccountSwitcher.tsx         # Multi-account dropdown
  AIAnalysisPanel.tsx         # Claude-powered AI analysis
  CollapsiblePanel.tsx        # Reusable collapsible section wrapper
  CornerStoneCard.tsx         # CLM/CRF NAV premium + RO tracking
  DistributionCalendar.tsx    # Dividend pay/ex-date calendar
  DividendIncomePanel.tsx     # Income tracking by symbol + family
  FundFamilyMonitor.tsx       # Concentration cap monitor per fund family
  MarginMeter.tsx             # Margin % gauge with rule markers
  MarginRiskPanel.tsx         # Detailed margin breakdown
  MarginSimulator.tsx         # Hypothetical trade margin modeler
  OpenPutTracker.tsx          # Open put positions tracker
  OptionsStrategyPanel.tsx    # Put-selling strategy overview
  PendingOrdersPanel.tsx      # Live open/working orders
  PillarAllocationBar.tsx     # Stacked pillar allocation bar + legend
  PillarBadge.tsx             # Colored pillar tag
  PortfolioExport.tsx         # CSV export
  PositionsTable.tsx          # Sortable/filterable positions table
  PutChainInline.tsx          # Inline options chain
  RebalanceCalculator.tsx     # Buy/sell amounts to hit targets
  SettingsPanel.tsx           # Strategy configuration
  Skeleton.tsx                # Loading skeletons
  ThemeToggle.tsx             # Dark/light mode toggle
  ToastProvider.tsx           # Alert toast notifications
  TradeHistoryPanel.tsx       # Completed trade history
  TriplesTacticalPanel.tsx    # Leveraged ETF trim + rebalance signals
  WatchlistPanel.tsx          # Symbol watchlist
```
