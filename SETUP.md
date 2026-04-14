# Triple C Dashboard — Phase 1 Setup Guide

## Prerequisites
- Node.js 20+
- A Schwab Developer account (free at developer.schwab.com)
- A Netlify account (free tier works)

---

## Step 1 — Register a Schwab App

1. Go to https://developer.schwab.com and sign in.
2. Click **Dashboard → Create App**.
3. Fill in:
   - App Name: `Triple C Dashboard`
   - Callback URL: `http://localhost:3000/api/auth/callback`  (add your Netlify URL here too once deployed)
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

ANTHROPIC_API_KEY=your_anthropic_key  # for Phase 5 AI features

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

## What Phase 1 Delivers

- **Schwab OAuth** — full authorization code flow with CSRF protection and token refresh
- **Multi-account support** — account switcher dropdown
- **Live positions** — fetched from Schwab with real-time quotes
- **Triple C classification** — every position auto-tagged (Triples / Cornerstone / Core-Income / Hedge)
- **Pillar allocation bar** — visual breakdown of portfolio by pillar
- **Margin health meter** — live margin % with 30% target and 50% max markers
- **Rule alerts** — flags concentration cap (20%) and margin limit violations
- **60-second auto-refresh** — polls during market hours
- **Token caching** — 60-second portfolio cache to avoid hammering the API

---

## Phase 2 (next up)

- CLM/CRF NAV premium tracking (requires secondary data source)
- Rights Offering detection and alert
- Per-pillar target % configuration
- Income/dividend tracking
- Historical performance charts

---

## Project Structure

```
app/
  page.tsx                  # Login screen
  dashboard/page.tsx        # Main dashboard (client component)
  api/
    auth/login/route.ts     # Redirect to Schwab OAuth
    auth/callback/route.ts  # Handle OAuth callback, set session
    auth/logout/route.ts    # Clear session + tokens
    accounts/route.ts       # Fetch + enrich all accounts
    accounts/numbers/route.ts  # Account hash list

lib/
  schwab/
    auth.ts     # OAuth helpers (authorize URL, token exchange, refresh)
    client.ts   # API client (accounts, positions, quotes)
    types.ts    # TypeScript interfaces for Schwab API responses
  classify.ts   # Triple C pillar classification + rule engine
  session.ts    # JWT session cookies
  storage.ts    # Token + cache storage (file-based locally, Blobs in prod)

components/
  AccountSwitcher.tsx       # Multi-account dropdown
  PillarAllocationBar.tsx   # Stacked allocation bar + legend
  MarginMeter.tsx           # Margin % gauge with rule markers
  PillarBadge.tsx           # Colored pillar tag
  PositionsTable.tsx        # Sortable/filterable positions table
```
