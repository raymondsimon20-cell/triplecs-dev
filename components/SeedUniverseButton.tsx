'use client';

/**
 * SeedUniverseButton — one-shot admin tool that stages 1 share of every fund
 * in the universe (185 names) into the trade inbox, and trims existing
 * positions to fund the buys if cash isn't enough.
 *
 * Flow:
 *   1. User clicks the button → modal opens with a Preview button.
 *   2. Preview calls POST /api/admin/seed-universe with dryRun:true.
 *      Response includes:
 *        - buy plan (symbols + cost)
 *        - sell plan (positions to trim, with the keep-one-share rule
 *          already applied)
 *        - cash / shortfall / fully-funded flag
 *        - unsellable notes
 *      We render that as a scrollable summary so the user sees exactly
 *      what would land in the inbox.
 *   3. User clicks "Stage in inbox" → the same endpoint runs with
 *      dryRun:false, writes the items, and we show a success summary
 *      pointing to the Trade Inbox panel below.
 *
 * Auth + heavy lifting all happen server-side (see
 * app/api/admin/seed-universe/route.ts). This component is just the UX
 * wrapper so the user doesn't need curl + cookies.
 */

import { useCallback, useState } from 'react';
import { Sparkles, X, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface BuyRow {
  symbol:        string;
  price:         number;
  estimatedCost: number;
}

interface SellRow {
  symbol:            string;
  price:             number;
  currentShares:     number;
  sharesToSell:      number;
  estimatedProceeds: number;
}

interface SeedResponse {
  accountHash:           string;
  dryRun:                boolean;
  universeCount:         number;
  alreadyHeldCount:      number;
  alreadyHeldSymbols:    string[];
  noQuoteCount:          number;
  noQuoteSymbols:        string[];
  plannedBuyCount:       number;
  plannedBuys:           BuyRow[];
  estimatedBuyCost:      number;
  availableCashBefore:   number;
  shortfall:             number;
  plannedSellCount:      number;
  plannedSells:          SellRow[];
  estimatedSellProceeds: number;
  fullyFunded:           boolean;
  unsellableNotes:       string[];
  stagedCount:           number;
  stagedIds:             string[];
}

interface Props {
  /** Schwab account hash to seed. Disabled when undefined (e.g. aggregate view). */
  accountHash?: string;
  /** Human-readable label shown in the modal header. */
  accountLabel?: string;
  /** Callback so the parent can refresh the inbox / dashboard after staging. */
  onStaged?: () => void;
}

function fmt$(n: number): string {
  return n.toLocaleString('en-US', {
    style:                'currency',
    currency:             'USD',
    maximumFractionDigits: 0,
  });
}

export function SeedUniverseButton({ accountHash, accountLabel, onStaged }: Props) {
  const [open,    setOpen]    = useState(false);
  const [busy,    setBusy]    = useState<'preview' | 'stage' | null>(null);
  const [preview, setPreview] = useState<SeedResponse | null>(null);
  const [staged,  setStaged]  = useState<SeedResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  const reset = useCallback(() => {
    setPreview(null);
    setStaged(null);
    setError(null);
    setBusy(null);
  }, []);

  const runPreview = useCallback(async () => {
    if (!accountHash) return;
    setBusy('preview');
    setError(null);
    setStaged(null);
    try {
      const r = await fetch('/api/admin/seed-universe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accountHash, dryRun: true }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setError(d.error ?? r.statusText);
        return;
      }
      setPreview(d as SeedResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [accountHash]);

  const runStage = useCallback(async () => {
    if (!accountHash) return;
    if (!confirm(
      `Stage ${preview?.plannedBuyCount ?? 0} BUYs and ${preview?.plannedSellCount ?? 0} SELLs ` +
      'in the trade inbox? They\'ll appear as pending rows tagged "seed-universe" — ' +
      'nothing goes to Schwab until you Approve them.',
    )) return;
    setBusy('stage');
    setError(null);
    try {
      const r = await fetch('/api/admin/seed-universe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accountHash, dryRun: false }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setError(d.error ?? r.statusText);
        return;
      }
      setStaged(d as SeedResponse);
      onStaged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [accountHash, preview, onStaged]);

  const disabled = !accountHash;

  return (
    <>
      <button
        onClick={() => { reset(); setOpen(true); }}
        disabled={disabled}
        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border transition-colors ${
          disabled
            ? 'border-[#2d3248] text-[#4a5070] cursor-not-allowed'
            : 'border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20'
        }`}
        title={
          disabled
            ? 'Pick a single account before seeding the universe'
            : `Stage 1 share of every fund in the universe into ${accountLabel ?? 'this account'}`
        }
      >
        <Sparkles className="w-3.5 h-3.5" />
        Seed universe…
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-[#1a1d27] border border-[#2d3248] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2d3248]">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                <span className="font-bold text-white">Seed Fund Universe</span>
                {accountLabel && (
                  <span className="text-[11px] text-[#7c82a0] px-2 py-0.5 rounded bg-[#22263a]">
                    {accountLabel}
                  </span>
                )}
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-[#7c82a0] hover:text-white transition-colors text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-6 py-5 space-y-4 text-[13px] text-[#cdd2eb]">
              {/* Intro */}
              <p className="text-[12px] text-[#9aa2c0] leading-relaxed">
                One-time tool. Stages a BUY of <strong>one share</strong> for every fund in
                the 185-name universe that isn&apos;t already in this account. If the cash
                isn&apos;t enough, also stages SELLs against your largest positions to
                cover the shortfall (capped at 50% of any single position, keep-one-share
                rule enforced). Nothing goes to Schwab until you Approve from the Trade
                Inbox below.
              </p>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 text-xs p-2.5 rounded border bg-red-500/10 border-red-500/30 text-red-200">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Success — items staged */}
              {staged && (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-xs p-2.5 rounded border bg-emerald-500/10 border-emerald-500/30 text-emerald-200">
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <div className="space-y-1">
                      <div className="font-semibold">
                        Staged {staged.stagedCount} inbox row{staged.stagedCount === 1 ? '' : 's'}.
                      </div>
                      <div>
                        {staged.plannedBuyCount} BUY{staged.plannedBuyCount === 1 ? '' : 's'} ·{' '}
                        {staged.plannedSellCount} SELL{staged.plannedSellCount === 1 ? '' : 's'}.
                        Scroll to the Trade Inbox panel below to review and Approve.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Preview / dry-run plan */}
              {preview && !staged && (
                <div className="space-y-3">
                  {/* KPI strip */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <Kpi label="Universe"       value={String(preview.universeCount)} />
                    <Kpi label="Already held"   value={String(preview.alreadyHeldCount)} />
                    <Kpi label="To BUY"         value={String(preview.plannedBuyCount)} />
                    <Kpi label="Est. BUY cost"  value={fmt$(preview.estimatedBuyCost)} />
                    <Kpi label="Cash available" value={fmt$(preview.availableCashBefore)} />
                    <Kpi label="Shortfall"      value={fmt$(preview.shortfall)} accent={preview.shortfall > 0 ? 'amber' : 'emerald'} />
                    <Kpi label="To SELL"        value={String(preview.plannedSellCount)} />
                    <Kpi label="Est. proceeds"  value={fmt$(preview.estimatedSellProceeds)} />
                  </div>

                  {/* Funding status banner */}
                  <div
                    className={`text-[11px] px-3 py-2 rounded border flex items-start gap-2 ${
                      preview.fullyFunded
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                    }`}
                  >
                    {preview.fullyFunded
                      ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                    <span>
                      {preview.fullyFunded
                        ? 'Plan is fully funded — cash + sell proceeds cover the BUY total plus a 5% slippage buffer.'
                        : 'Plan is NOT fully funded. The 50%-per-position trim cap kept us from raising the full shortfall. Run this once to clear what fits, then re-run after fills.'}
                    </span>
                  </div>

                  {/* Sell plan */}
                  {preview.plannedSells.length > 0 && (
                    <details open className="rounded border border-[#2d3248] bg-[#0f1117]">
                      <summary className="text-[11px] uppercase tracking-wider text-[#7c82a0] font-semibold cursor-pointer px-3 py-2">
                        Sells to fund the buys ({preview.plannedSells.length})
                      </summary>
                      <div className="max-h-48 overflow-y-auto px-3 pb-2">
                        <table className="w-full text-[11px] tabular-nums">
                          <thead className="text-[#7c82a0]">
                            <tr>
                              <th className="text-left font-semibold py-1">Symbol</th>
                              <th className="text-right font-semibold py-1">Shares</th>
                              <th className="text-right font-semibold py-1">Price</th>
                              <th className="text-right font-semibold py-1">Proceeds</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.plannedSells.map((r) => (
                              <tr key={r.symbol} className="border-t border-[#1f2334]">
                                <td className="py-1 font-mono text-white">{r.symbol}</td>
                                <td className="py-1 text-right">{r.sharesToSell} / {r.currentShares}</td>
                                <td className="py-1 text-right">${r.price.toFixed(2)}</td>
                                <td className="py-1 text-right">{fmt$(r.estimatedProceeds)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}

                  {/* Buy plan */}
                  {preview.plannedBuys.length > 0 && (
                    <details className="rounded border border-[#2d3248] bg-[#0f1117]">
                      <summary className="text-[11px] uppercase tracking-wider text-[#7c82a0] font-semibold cursor-pointer px-3 py-2">
                        Buys ({preview.plannedBuys.length})
                      </summary>
                      <div className="max-h-64 overflow-y-auto px-3 pb-2">
                        <table className="w-full text-[11px] tabular-nums">
                          <thead className="text-[#7c82a0]">
                            <tr>
                              <th className="text-left font-semibold py-1">Symbol</th>
                              <th className="text-right font-semibold py-1">Price</th>
                              <th className="text-right font-semibold py-1">Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.plannedBuys.map((r) => (
                              <tr key={r.symbol} className="border-t border-[#1f2334]">
                                <td className="py-1 font-mono text-white">{r.symbol}</td>
                                <td className="py-1 text-right">${r.price.toFixed(2)}</td>
                                <td className="py-1 text-right">{fmt$(r.estimatedCost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}

                  {/* Skipped + notes */}
                  {(preview.noQuoteCount > 0 || preview.unsellableNotes.length > 0) && (
                    <details className="rounded border border-[#2d3248] bg-[#0f1117]">
                      <summary className="text-[11px] uppercase tracking-wider text-[#7c82a0] font-semibold cursor-pointer px-3 py-2">
                        Skipped ({preview.noQuoteCount + preview.unsellableNotes.length})
                      </summary>
                      <div className="text-[11px] text-[#9aa2c0] px-3 pb-3 space-y-1">
                        {preview.noQuoteCount > 0 && (
                          <div>
                            <strong>No live quote ({preview.noQuoteCount}):</strong>{' '}
                            <span className="font-mono">{preview.noQuoteSymbols.join(', ')}</span>
                          </div>
                        )}
                        {preview.unsellableNotes.length > 0 && (
                          <div className="space-y-0.5">
                            <strong>Couldn&apos;t tap for sells:</strong>
                            <ul className="list-disc pl-5">
                              {preview.unsellableNotes.map((n) => <li key={n}>{n}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Empty state — before preview runs */}
              {!preview && !staged && !error && (
                <div className="text-[12px] text-[#7c82a0] border border-dashed border-[#2d3248] rounded px-3 py-4 text-center">
                  Click <strong>Preview</strong> to dry-run the plan. Nothing will be written
                  to your inbox or sent to Schwab until you also click <strong>Stage in
                  inbox</strong>.
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#2d3248]">
              <button
                onClick={() => setOpen(false)}
                className="text-xs text-[#7c82a0] hover:text-white transition-colors"
              >
                Close
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={runPreview}
                  disabled={!accountHash || busy !== null || staged !== null}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-[#3d4468] bg-white/[0.04] text-[#cdd2eb] hover:bg-white/[0.08] transition-colors disabled:opacity-50"
                >
                  {busy === 'preview' ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
                  {preview ? 'Refresh preview' : 'Preview'}
                </button>
                <button
                  onClick={runStage}
                  disabled={!accountHash || !preview || busy !== null || staged !== null}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors disabled:opacity-50"
                  title="Stage every planned BUY and SELL into the Trade Inbox"
                >
                  {busy === 'stage' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  Stage in inbox
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: 'amber' | 'emerald' }) {
  const accentClass =
    accent === 'amber'   ? 'text-amber-300'   :
    accent === 'emerald' ? 'text-emerald-300' :
                           'text-white';
  return (
    <div className="bg-[#0f1117] border border-[#2d3248] rounded px-2.5 py-1.5">
      <div className="text-[#7c82a0] text-[10px] uppercase tracking-wider">{label}</div>
      <div className={`font-semibold tabular-nums ${accentClass}`}>{value}</div>
    </div>
  );
}
