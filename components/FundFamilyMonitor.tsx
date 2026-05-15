'use client';

/**
 * Fund Family Concentration Monitor
 *
 * Tracks concentration by fund family (YieldMax, Defiance, Roundhill, etc.)
 * and flags families approaching or exceeding the recommended cap.
 *
 * Rules from Triple C Vol 7 strategy:
 *   - No single fund family > 40% of total portfolio (hard cap)
 *   - Warn at 30% concentration
 *   - Cornerstone (CLM/CRF) is its own pillar — no family cap applies
 */

import { useState, useMemo } from 'react';
import { Layers, ChevronDown, ChevronUp, AlertTriangle, CheckCircle } from 'lucide-react';
import type { EnrichedPosition } from '@/lib/schwab/types';

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
}

// ─── Fund family mapping ──────────────────────────────────────────────────────

const FUND_FAMILIES: Record<string, string> = {
  // YieldMax
  TSLY: 'YieldMax', NVDY: 'YieldMax', AMZY: 'YieldMax', GOOGY: 'YieldMax',
  MSFO: 'YieldMax', CONY: 'YieldMax', JPMO: 'YieldMax', NFLXY: 'YieldMax',
  AMDY: 'YieldMax', PYPLY: 'YieldMax', AIYY: 'YieldMax', OILY: 'YieldMax',
  CVNY: 'YieldMax', MRNY: 'YieldMax', SNOY: 'YieldMax', BIOY: 'YieldMax',
  DISO: 'YieldMax', ULTY: 'YieldMax', YMAX: 'YieldMax', YMAG: 'YieldMax',
  GDXY: 'YieldMax', XOMO: 'YieldMax',
  FBY: 'YieldMax', FIAT: 'YieldMax', FIVY: 'YieldMax', TSMY: 'YieldMax',
  APLY: 'YieldMax', OARK: 'YieldMax', DIPS: 'YieldMax', CRSH: 'YieldMax',
  KLIP: 'YieldMax', MSTY: 'YieldMax', PLTY: 'YieldMax',

  // Defiance ETFs
  QQQY: 'Defiance', IWMY: 'Defiance', JEPY: 'Defiance',
  QDTY: 'Defiance', SDTY: 'Defiance', DFNV: 'Defiance',

  // Roundhill Investments
  XDTE: 'Roundhill', QDTE: 'Roundhill', RDTE: 'Roundhill', WDTE: 'Roundhill',
  MDTE: 'Roundhill', TOPW: 'Roundhill', BRKW: 'Roundhill',

  // RexShares
  FEPI: 'RexShares', REXS: 'RexShares', REXQ: 'RexShares', AIPI: 'RexShares',

  // GraniteShares
  TSYY: 'GraniteShares',

  // Kurv
  KSLV: 'Kurv',

  // JPMorgan
  JEPI: 'JPMorgan', JEPQ: 'JPMorgan',

  // Global X
  QYLD: 'Global X', RYLD: 'Global X', XYLD: 'Global X', DJIA: 'Global X',
  NVDL: 'Global X', TSLL: 'Global X',

  // Neos Investments
  SPYI: 'Neos', QDVO: 'Neos', JPEI: 'Neos', IWMI: 'Neos',
  QQQI: 'Neos', BTCI: 'Neos', NIHI: 'Neos', IAUI: 'Neos',

  // PIMCO
  PDI: 'PIMCO', PDO: 'PIMCO', PTY: 'PIMCO', PCN: 'PIMCO',
  PFL: 'PIMCO', PFN: 'PIMCO', PHK: 'PIMCO',

  // Eaton Vance
  ETV: 'Eaton Vance', ETB: 'Eaton Vance', EOS: 'Eaton Vance',
  EOI: 'Eaton Vance', EVT: 'Eaton Vance',

  // BlackRock
  BST: 'BlackRock', BDJ: 'BlackRock', ECAT: 'BlackRock', BGY: 'BlackRock',
  BCAT: 'BlackRock', BUI: 'BlackRock',

  // Amplify
  DIVO: 'Amplify', BLOK: 'Amplify', COWS: 'Amplify',

  // ProShares / 3× ETFs
  UPRO: 'ProShares', TQQQ: 'ProShares', UDOW: 'ProShares',
  UMDD: 'ProShares', URTY: 'ProShares', SQQQ: 'ProShares', SPXS: 'ProShares',

  // Direxion
  SPXL: 'Direxion', TECL: 'Direxion', LABU: 'Direxion', TPVG: 'Direxion',
  HIBL: 'Direxion', CURE: 'Direxion',

  // Cornerstone (own pillar — no concentration cap applies)
  CLM: 'Cornerstone', CRF: 'Cornerstone',

  // Oxford Lane
  OXLC: 'Oxford Lane', OXSQ: 'Oxford Lane',

  // KraneShares
  KMLM: 'KraneShares',

  // RiverNorth
  RIV: 'RiverNorth', OPP: 'RiverNorth',

  // Liberty All-Star
  USA: 'Liberty', LICT: 'Liberty',

  // Columbia
  STK: 'Columbia',

  // Gabelli
  GAB: 'Gabelli', GDV: 'Gabelli', GGT: 'Gabelli',

  // Invesco
  QQQ: 'Invesco', QQQM: 'Invesco', RSP: 'Invesco',

  // Schwab / Vanguard / iShares — broad index, typically no cap needed
  SCHD: 'Schwab', SCHG: 'Schwab', SCHB: 'Schwab',
  VTI: 'Vanguard', VOO: 'Vanguard', VYM: 'Vanguard', VXUS: 'Vanguard',
  SPY: 'iShares', IVV: 'iShares', IWM: 'iShares', ITA: 'iShares',

  // Growth anchors — treated as individual, not families
  NVDA: 'Individual', AAPL: 'Individual', MSFT: 'Individual',
  AMZN: 'Individual', GOOGL: 'Individual', META: 'Individual',
  SPYG: 'Individual',
  MCD: 'Individual', COST: 'Individual', 'BRK.B': 'Individual',
  MSTR: 'Individual', KGC: 'Individual', 'O': 'Individual',

  // Physical-gold anchors
  AAAU: 'Gold', GLD: 'Gold', IAU: 'Gold',
};

// Families exempt from cap warnings (index funds, individual stocks, etc.)
const EXEMPT_FAMILIES = new Set(['Cornerstone', 'Individual', 'Schwab', 'Vanguard', 'iShares', 'Gold']);

const WARN_PCT  = 30;
const MAX_PCT   = 40;

interface FamilyData {
  name:       string;
  totalValue: number;
  pct:        number;
  tickers:    { symbol: string; value: number }[];
  status:     'ok' | 'warn' | 'over';
  exempt:     boolean;
}

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function FundFamilyMonitor({ positions, totalValue }: Props) {
  const [open,      setOpen]      = useState(false);
  const [showAll,   setShowAll]   = useState(false);

  const families = useMemo((): FamilyData[] => {
    if (totalValue <= 0) return [];

    const map: Record<string, { totalValue: number; tickers: { symbol: string; value: number }[] }> = {};

    for (const pos of positions) {
      const symbol = pos.instrument?.symbol?.toUpperCase() ?? '';
      if (!symbol || pos.marketValue <= 0) continue;

      const family = FUND_FAMILIES[symbol] ?? 'Other';
      if (!map[family]) map[family] = { totalValue: 0, tickers: [] };
      map[family].totalValue += pos.marketValue;
      map[family].tickers.push({ symbol, value: pos.marketValue });
    }

    return Object.entries(map)
      .map(([name, data]) => {
        const pct    = (data.totalValue / totalValue) * 100;
        const exempt = EXEMPT_FAMILIES.has(name);
        const status: FamilyData['status'] =
          exempt           ? 'ok'   :
          pct >= MAX_PCT   ? 'over' :
          pct >= WARN_PCT  ? 'warn' : 'ok';

        return {
          name,
          totalValue: data.totalValue,
          pct,
          tickers: data.tickers.sort((a, b) => b.value - a.value),
          status,
          exempt,
        };
      })
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [positions, totalValue]);

  const overCount  = families.filter((f) => f.status === 'over').length;
  const warnCount  = families.filter((f) => f.status === 'warn').length;
  const shown      = showAll ? families : families.filter((f) => !f.exempt || f.pct >= WARN_PCT).slice(0, 12);

  return (
    <div className="bg-[#1a1d27] border border-[#2d3248] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#20243a] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Layers className="w-5 h-5 text-amber-400" />
          <span className="font-semibold text-white text-sm">Fund Family Concentration</span>
          {(overCount > 0 || warnCount > 0) ? (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              overCount > 0 ? 'bg-red-500/20 text-red-300' : 'bg-orange-500/20 text-orange-300'
            }`}>
              {overCount > 0 ? `${overCount} over cap` : `${warnCount} near cap`}
            </span>
          ) : (
            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">All clear</span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-[#7c82a0]" /> : <ChevronDown className="w-4 h-4 text-[#7c82a0]" />}
      </button>

      {open && (
        <div className="border-t border-[#2d3248] px-5 py-4 space-y-3">
          <div className="flex items-center justify-between text-xs text-[#4a5070]">
            <span>Warn at {WARN_PCT}% · Cap at {MAX_PCT}% per family (Cornerstone & index funds exempt)</span>
          </div>

          {shown.map((f) => (
            <div key={f.name} className={`bg-[#0f1117] border rounded-lg p-3 space-y-2 ${
              f.status === 'over' ? 'border-red-500/25' :
              f.status === 'warn' ? 'border-orange-500/25' : 'border-[#2d3248]'
            }`}>
              <div className="flex items-center gap-2">
                {f.status === 'over'  ? <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" /> :
                 f.status === 'warn'  ? <AlertTriangle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" /> :
                                        <CheckCircle   className="w-3.5 h-3.5 text-emerald-400/50 flex-shrink-0" />}

                <span className="text-sm font-semibold text-white">{f.name}</span>
                <span className="text-xs text-[#7c82a0] ml-auto">{fmt$(f.totalValue)}</span>
                <span className={`text-xs font-bold w-12 text-right ${
                  f.status === 'over' ? 'text-red-400' :
                  f.status === 'warn' ? 'text-orange-400' : 'text-emerald-400'
                }`}>{f.pct.toFixed(1)}%</span>
              </div>

              {/* Bar */}
              <div className="relative h-1.5 bg-[#2d3248] rounded-full overflow-visible">
                <div
                  className={`h-full rounded-full transition-all ${
                    f.status === 'over' ? 'bg-red-500' :
                    f.status === 'warn' ? 'bg-orange-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(f.pct, 100)}%` }}
                />
                {/* Warn line */}
                <div className="absolute top-0 h-full w-0.5 bg-orange-400/50" style={{ left: `${WARN_PCT}%` }} />
                {/* Cap line */}
                <div className="absolute top-0 h-full w-0.5 bg-red-400/50" style={{ left: `${MAX_PCT}%` }} />
              </div>

              {/* Tickers */}
              <div className="flex flex-wrap gap-1.5">
                {f.tickers.slice(0, 6).map((t) => (
                  <span key={t.symbol} className="text-[10px] font-mono bg-[#2d3248] text-[#7c82a0] px-1.5 py-0.5 rounded">
                    {t.symbol} <span className="text-[#4a5070]">{((t.value / totalValue) * 100).toFixed(1)}%</span>
                  </span>
                ))}
                {f.tickers.length > 6 && (
                  <span className="text-[10px] text-[#4a5070]">+{f.tickers.length - 6} more</span>
                )}
              </div>
            </div>
          ))}

          {families.length > shown.length && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full text-xs text-[#4a5070] hover:text-white transition-colors py-2"
            >
              {showAll ? 'Show fewer' : `Show all ${families.length} families`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
