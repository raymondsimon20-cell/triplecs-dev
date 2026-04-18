/**
 * POST /api/watchlist/seed
 *
 * Bulk-adds the Triple C fund universe to the watchlist.
 * Skips symbols already present. Returns added/skipped counts.
 */

import { NextResponse } from 'next/server';
import { getStore } from '@netlify/blobs';
import { requireAuth } from '@/lib/session';
import type { WatchlistItem } from '../route';

export const dynamic = 'force-dynamic';

// Full Triple C fund universe — 145 symbols across all pillars
const FUND_UNIVERSE: { symbol: string; pillar: string }[] = [
  // ── Triples ───────────────────────────────────────────────────────────────
  { symbol: 'TQQQ',  pillar: 'triples' },
  { symbol: 'UPRO',  pillar: 'triples' },
  { symbol: 'SPXL',  pillar: 'triples' },
  { symbol: 'UDOW',  pillar: 'triples' },
  { symbol: 'TECL',  pillar: 'triples' },
  { symbol: 'SOXL',  pillar: 'triples' },
  { symbol: 'FNGU',  pillar: 'triples' },
  { symbol: 'LABU',  pillar: 'triples' },
  { symbol: 'TNA',   pillar: 'triples' },
  { symbol: 'FAS',   pillar: 'triples' },
  { symbol: 'UMDD',  pillar: 'triples' },
  { symbol: 'URTY',  pillar: 'triples' },
  { symbol: 'CURE',  pillar: 'triples' },
  { symbol: 'HIBL',  pillar: 'triples' },
  // ── Cornerstone ───────────────────────────────────────────────────────────
  { symbol: 'CLM',   pillar: 'cornerstone' },
  { symbol: 'CRF',   pillar: 'cornerstone' },
  // ── Hedge / inverse ───────────────────────────────────────────────────────
  { symbol: 'SPXU',  pillar: 'hedge' },
  { symbol: 'SQQQ',  pillar: 'hedge' },
  { symbol: 'SDOW',  pillar: 'hedge' },
  { symbol: 'SOXS',  pillar: 'hedge' },
  { symbol: 'FNGD',  pillar: 'hedge' },
  { symbol: 'SPXS',  pillar: 'hedge' },
  { symbol: 'FAZ',   pillar: 'hedge' },
  { symbol: 'SRTY',  pillar: 'hedge' },
  { symbol: 'SH',    pillar: 'hedge' },
  { symbol: 'PSQ',   pillar: 'hedge' },
  { symbol: 'DOG',   pillar: 'hedge' },
  { symbol: 'UVXY',  pillar: 'hedge' },
  // ── Income — YieldMax ─────────────────────────────────────────────────────
  { symbol: 'TSLY',  pillar: 'income' },
  { symbol: 'NVDY',  pillar: 'income' },
  { symbol: 'AMZY',  pillar: 'income' },
  { symbol: 'GOOGY', pillar: 'income' },
  { symbol: 'MSFO',  pillar: 'income' },
  { symbol: 'APLY',  pillar: 'income' },
  { symbol: 'OARK',  pillar: 'income' },
  { symbol: 'JPMO',  pillar: 'income' },
  { symbol: 'CONY',  pillar: 'income' },
  { symbol: 'NFLXY', pillar: 'income' },
  { symbol: 'AMDY',  pillar: 'income' },
  { symbol: 'PYPLY', pillar: 'income' },
  { symbol: 'AIYY',  pillar: 'income' },
  { symbol: 'OILY',  pillar: 'income' },
  { symbol: 'CVNY',  pillar: 'income' },
  { symbol: 'MRNY',  pillar: 'income' },
  { symbol: 'SNOY',  pillar: 'income' },
  { symbol: 'BIOY',  pillar: 'income' },
  { symbol: 'DISO',  pillar: 'income' },
  { symbol: 'ULTY',  pillar: 'income' },
  { symbol: 'YMAX',  pillar: 'income' },
  { symbol: 'YMAG',  pillar: 'income' },
  { symbol: 'MSFO2', pillar: 'income' },
  { symbol: 'GDXY',  pillar: 'income' },
  { symbol: 'XOMO',  pillar: 'income' },
  { symbol: 'AMZY2', pillar: 'income' },
  { symbol: 'FBY',   pillar: 'income' },
  { symbol: 'FIAT',  pillar: 'income' },
  { symbol: 'FIVY',  pillar: 'income' },
  { symbol: 'TSMY',  pillar: 'income' },
  { symbol: 'DIPS',  pillar: 'income' },
  { symbol: 'CRSH',  pillar: 'income' },
  { symbol: 'KLIP',  pillar: 'income' },
  { symbol: 'MSTY',  pillar: 'income' },
  { symbol: 'PLTY',  pillar: 'income' },
  // ── Income — Defiance ─────────────────────────────────────────────────────
  { symbol: 'QQQY',  pillar: 'income' },
  { symbol: 'IWMY',  pillar: 'income' },
  { symbol: 'JEPY',  pillar: 'income' },
  { symbol: 'QDTY',  pillar: 'income' },
  { symbol: 'SDTY',  pillar: 'income' },
  { symbol: 'DFNV',  pillar: 'income' },
  { symbol: 'IWMY2', pillar: 'income' },
  // ── Income — Roundhill ────────────────────────────────────────────────────
  { symbol: 'XDTE',  pillar: 'income' },
  { symbol: 'QDTE',  pillar: 'income' },
  { symbol: 'RDTE',  pillar: 'income' },
  { symbol: 'WDTE',  pillar: 'income' },
  { symbol: 'MDTE',  pillar: 'income' },
  { symbol: 'TOPW',  pillar: 'income' },
  { symbol: 'BRKW',  pillar: 'income' },
  // ── Income — RexShares ────────────────────────────────────────────────────
  { symbol: 'FEPI',  pillar: 'income' },
  { symbol: 'AIPI',  pillar: 'income' },
  { symbol: 'REXQ',  pillar: 'income' },
  { symbol: 'REXS',  pillar: 'income' },
  { symbol: 'SPYI2', pillar: 'income' },
  // ── Income — GraniteShares ────────────────────────────────────────────────
  { symbol: 'TSYY',  pillar: 'income' },
  // ── Income — Kurv ─────────────────────────────────────────────────────────
  { symbol: 'KSLV',  pillar: 'income' },
  // ── Income — JPMorgan ─────────────────────────────────────────────────────
  { symbol: 'JEPI',  pillar: 'income' },
  { symbol: 'JEPQ',  pillar: 'income' },
  // ── Income — Neos ─────────────────────────────────────────────────────────
  { symbol: 'SPYI',  pillar: 'income' },
  { symbol: 'QDVO',  pillar: 'income' },
  { symbol: 'JPEI',  pillar: 'income' },
  { symbol: 'IWMI',  pillar: 'income' },
  { symbol: 'QQQI',  pillar: 'income' },
  { symbol: 'BTCI',  pillar: 'income' },
  { symbol: 'NIHI',  pillar: 'income' },
  { symbol: 'IAUI',  pillar: 'income' },
  // ── Income — Global X covered-call ────────────────────────────────────────
  { symbol: 'QYLD',  pillar: 'income' },
  { symbol: 'RYLD',  pillar: 'income' },
  { symbol: 'XYLD',  pillar: 'income' },
  { symbol: 'DJIA',  pillar: 'income' },
  { symbol: 'NVDL',  pillar: 'income' },
  { symbol: 'TSLL',  pillar: 'income' },
  // ── Income — PIMCO CEFs ───────────────────────────────────────────────────
  { symbol: 'PDI',   pillar: 'income' },
  { symbol: 'PDO',   pillar: 'income' },
  { symbol: 'PTY',   pillar: 'income' },
  { symbol: 'PCN',   pillar: 'income' },
  { symbol: 'PFL',   pillar: 'income' },
  { symbol: 'PFN',   pillar: 'income' },
  { symbol: 'PHK',   pillar: 'income' },
  // ── Income — Eaton Vance CEFs ─────────────────────────────────────────────
  { symbol: 'ETV',   pillar: 'income' },
  { symbol: 'ETB',   pillar: 'income' },
  { symbol: 'EOS',   pillar: 'income' },
  { symbol: 'EOI',   pillar: 'income' },
  { symbol: 'EVT',   pillar: 'income' },
  // ── Income — BlackRock CEFs ───────────────────────────────────────────────
  { symbol: 'BST',   pillar: 'income' },
  { symbol: 'BDJ',   pillar: 'income' },
  { symbol: 'ECAT',  pillar: 'income' },
  { symbol: 'BGY',   pillar: 'income' },
  { symbol: 'BCAT',  pillar: 'income' },
  { symbol: 'BUI',   pillar: 'income' },
  // ── Income — Amplify ──────────────────────────────────────────────────────
  { symbol: 'DIVO',  pillar: 'income' },
  { symbol: 'BLOK',  pillar: 'income' },
  { symbol: 'COWS',  pillar: 'income' },
  // ── Income — Oxford Lane / RiverNorth / Liberty / Gabelli / Columbia ──────
  { symbol: 'OXLC',  pillar: 'income' },
  { symbol: 'OXSQ',  pillar: 'income' },
  { symbol: 'RIV',   pillar: 'income' },
  { symbol: 'OPP',   pillar: 'income' },
  { symbol: 'USA',   pillar: 'income' },
  { symbol: 'LICT',  pillar: 'income' },
  { symbol: 'GAB',   pillar: 'income' },
  { symbol: 'GDV',   pillar: 'income' },
  { symbol: 'GGT',   pillar: 'income' },
  { symbol: 'STK',   pillar: 'income' },
  // ── Income — KraneShares / BDC / REIT ────────────────────────────────────
  { symbol: 'KMLM',  pillar: 'income' },
  { symbol: 'TPVG',  pillar: 'income' },
  { symbol: 'O',     pillar: 'income' },
  // ── Income — Vol 7 additions ──────────────────────────────────────────────
  { symbol: 'IQQQ',  pillar: 'income' },
  { symbol: 'SPYT',  pillar: 'income' },
  { symbol: 'XPAY',  pillar: 'income' },
  { symbol: 'MAGY',  pillar: 'income' },
  { symbol: 'FNGA',  pillar: 'income' },
  { symbol: 'FNGB',  pillar: 'income' },
  // ── Income — YieldMax legacy ──────────────────────────────────────────────
  { symbol: 'NFLY',  pillar: 'income' },
  { symbol: 'SQY',   pillar: 'income' },
  { symbol: 'SMCY',  pillar: 'income' },
  { symbol: 'FIAT',  pillar: 'income' },
  { symbol: 'FIVY',  pillar: 'income' },
  // ── Income — Defiance additions ───────────────────────────────────────────
  { symbol: 'DEFI',  pillar: 'income' },
  { symbol: 'BDTE',  pillar: 'income' },
  { symbol: 'IDTE',  pillar: 'income' },
  { symbol: 'QDTU',  pillar: 'income' },
  { symbol: 'YBTC',  pillar: 'income' },
  // ── Income — Roundhill weekly additions ──────────────────────────────────
  { symbol: 'WEEK',  pillar: 'income' },
  // ── Income — Additional CEFs ──────────────────────────────────────────────
  { symbol: 'CHW',   pillar: 'income' },
  { symbol: 'CSQ',   pillar: 'income' },
  { symbol: 'EXG',   pillar: 'income' },
  { symbol: 'GOF',   pillar: 'income' },
  // ── Income — Bond funds ───────────────────────────────────────────────────
  { symbol: 'AGG',   pillar: 'income' },
  { symbol: 'BND',   pillar: 'income' },
  { symbol: 'TLT',   pillar: 'income' },
  { symbol: 'IEF',   pillar: 'income' },
  { symbol: 'SGOV',  pillar: 'income' },
  { symbol: 'USFR',  pillar: 'income' },
  // ── Broad index / growth anchors ──────────────────────────────────────────
  { symbol: 'QQQ',   pillar: 'broad' },
  { symbol: 'QQQM',  pillar: 'broad' },
  { symbol: 'RSP',   pillar: 'broad' },
  { symbol: 'SPY',   pillar: 'broad' },
  { symbol: 'IVV',   pillar: 'broad' },
  { symbol: 'IWM',   pillar: 'broad' },
  { symbol: 'VTI',   pillar: 'broad' },
  { symbol: 'VOO',   pillar: 'broad' },
  { symbol: 'VYM',   pillar: 'broad' },
  { symbol: 'VXUS',  pillar: 'broad' },
  { symbol: 'SPYG',  pillar: 'broad' },
  { symbol: 'SCHD',  pillar: 'broad' },
  { symbol: 'SCHG',  pillar: 'broad' },
  { symbol: 'SCHB',  pillar: 'broad' },
  { symbol: 'ITA',   pillar: 'broad' },
  { symbol: 'VGT',   pillar: 'broad' },
  // ── Individual stocks ─────────────────────────────────────────────────────
  { symbol: 'NVDA',  pillar: 'broad' },
  { symbol: 'AAPL',  pillar: 'broad' },
  { symbol: 'MSFT',  pillar: 'broad' },
  { symbol: 'AMZN',  pillar: 'broad' },
  { symbol: 'GOOGL', pillar: 'broad' },
  { symbol: 'META',  pillar: 'broad' },
  { symbol: 'MCD',   pillar: 'broad' },
  { symbol: 'COST',  pillar: 'broad' },
  { symbol: 'BRK.B', pillar: 'broad' },
  { symbol: 'MSTR',  pillar: 'broad' },
  // ── Gold / precious metals ────────────────────────────────────────────────
  { symbol: 'AAAU',  pillar: 'broad' },
  { symbol: 'GLD',   pillar: 'broad' },
  { symbol: 'IAU',   pillar: 'broad' },
  { symbol: 'KGC',   pillar: 'broad' },
];

export async function POST() {
  try { await requireAuth(); } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const store = getStore('watchlist');
    const existing = await store.get('items', { type: 'json' }) as WatchlistItem[] | null;
    const items: WatchlistItem[] = Array.isArray(existing) ? existing : [];

    const existingSet = new Set(items.map((i) => i.symbol));
    const now = new Date().toISOString();

    let added = 0;
    let skipped = 0;

    for (const { symbol } of FUND_UNIVERSE) {
      if (existingSet.has(symbol)) {
        skipped++;
      } else {
        items.push({ symbol, addedAt: now });
        existingSet.add(symbol);
        added++;
      }
    }

    await store.setJSON('items', items);

    return NextResponse.json({ added, skipped, total: items.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
