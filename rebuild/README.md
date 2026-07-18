# Triple C (rebuild)

Fresh rebuild from `RECREATE_PROMPT.md`, following the prescribed build order: rules doc → Schwab OAuth/client → classification → storage → signals engine → guardrails → UI → AI layer → cron → settings.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env` and fill in Schwab credentials, `SESSION_SECRET`, `ANTHROPIC_API_KEY`. **The redirect URI must be HTTPS end-to-end** (use an https tunnel locally — plain HTTP breaks Schwab's callback).
3. `npm run dev`, then visit `/api/auth/login` to connect Schwab.

## Verify

- `npm run typecheck`
- `npm test` — runs `scripts/test-classify.ts`, `test-engine.ts`, `test-guardrails.ts`

## Architecture notes

- `docs/RULES.md` is the strategy source of truth; every engine constant traces to it.
- `lib/signals/engine.ts` is pure (no I/O); all tunables live in the single `CONFIG` object. **Tactical deviation (temporary):** SOXL weighted 2× in the dip ladder — see `docs/RULES.md` §13.
- `lib/guardrails.ts` is an independent validation pass. Every trade path (auto-execute, inbox one-click approve, manual `/api/orders`) re-validates through it, including the $10K post-trade AFW (Available For Withdrawal) floor with options margin math, plus the Schwab 50% broker margin-cap precheck.
- Storage: `.data/` JSON locally, Netlify Blobs in prod (`lib/storage.ts`).
- Cron: `netlify/functions/*.mts` (signals run, snapshot/rebalance, digest) with cron-health tracking surfaced at `/api/admin/cron-health`.
