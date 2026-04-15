'use client';

/**
 * PortfolioExport — one-click export of current portfolio to CSV.
 * Includes positions, allocations, P&L, pillar classification.
 */

import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import type { EnrichedPosition, PillarType } from '@/lib/schwab/types';
import { PILLAR_LABELS } from '@/lib/classify';
import { useToast } from './ToastProvider';

interface Props {
  positions: EnrichedPosition[];
  totalValue: number;
  equity: number;
  marginBalance: number;
  accountNumber: string;
  pillarSummary: { pillar: PillarType; label: string; totalValue: number; portfolioPercent: number; positionCount: number }[];
  dividendsAnnual: number;
}

// ─── CSV generation ──────────────────────────────────────────────────────────

function escapeCSV(val: string | number): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function generateCSV(
  positions: EnrichedPosition[],
  totalValue: number,
  equity: number,
  marginBalance: number,
  accountNumber: string,
  pillarSummary: Props['pillarSummary'],
  dividendsAnnual: number,
): string {
  const lines: string[] = [];
  const now = new Date();

  // Header section
  lines.push('Triple C Portfolio Snapshot');
  lines.push(`Generated,${now.toLocaleDateString()} ${now.toLocaleTimeString()}`);
  lines.push(`Account,${escapeCSV(accountNumber)}`);
  lines.push(`Total Value,${totalValue.toFixed(2)}`);
  lines.push(`Equity,${equity.toFixed(2)}`);
  lines.push(`Margin Balance,${marginBalance.toFixed(2)}`);
  lines.push(`Trailing 12mo Dividends,${dividendsAnnual.toFixed(2)}`);
  lines.push('');

  // Pillar allocation summary
  lines.push('PILLAR ALLOCATION');
  lines.push('Pillar,Value,% of Portfolio,# Positions');
  for (const p of pillarSummary) {
    lines.push(`${escapeCSV(p.label)},${p.totalValue.toFixed(2)},${p.portfolioPercent.toFixed(1)}%,${p.positionCount}`);
  }
  lines.push('');

  // All positions
  lines.push('POSITIONS');
  lines.push('Symbol,Description,Pillar,Qty,Avg Price,Current Value,% Portfolio,Gain/Loss,Gain/Loss %,Today G/L');

  const sorted = [...positions].sort((a, b) => b.marketValue - a.marketValue);
  for (const pos of sorted) {
    const qty = pos.longQuantity > 0 ? pos.longQuantity : pos.shortQuantity > 0 ? -pos.shortQuantity : 0;
    lines.push([
      escapeCSV(pos.instrument.symbol),
      escapeCSV(pos.instrument.description ?? ''),
      escapeCSV(PILLAR_LABELS[pos.pillar] ?? pos.pillar),
      qty,
      pos.averagePrice.toFixed(2),
      pos.marketValue.toFixed(2),
      `${pos.portfolioPercent.toFixed(1)}%`,
      pos.gainLoss.toFixed(2),
      `${pos.gainLossPercent.toFixed(1)}%`,
      (pos.todayGainLoss ?? 0).toFixed(2),
    ].join(','));
  }

  return lines.join('\n');
}

// ─── Download helper ─────────────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PortfolioExport({
  positions,
  totalValue,
  equity,
  marginBalance,
  accountNumber,
  pillarSummary,
  dividendsAnnual,
}: Props) {
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  function handleExportCSV() {
    setExporting(true);
    try {
      const csv = generateCSV(positions, totalValue, equity, marginBalance, accountNumber, pillarSummary, dividendsAnnual);
      const date = new Date().toISOString().split('T')[0];
      downloadBlob(csv, `TripleC_Portfolio_${date}.csv`, 'text/csv;charset=utf-8;');
      toast.show('Portfolio exported to CSV', 'success');
    } catch (err) {
      toast.show('Export failed — check console', 'danger');
      console.error('Export error:', err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <button
      onClick={handleExportCSV}
      disabled={exporting || positions.length === 0}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
        bg-[#22263a] border border-[#2d3248] text-[#7c82a0] hover:text-white hover:border-[#3d4268]
        transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      title="Export portfolio snapshot to CSV"
    >
      {exporting
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <Download className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">Export</span>
    </button>
  );
}
