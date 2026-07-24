'use client';

/**
 * ConnectionsView — brokerage connections (P2P-style redesign, page 8).
 * Shows Schwab link status per account plus device linking.
 */

import React from 'react';
import { Landmark, CheckCircle, Plus } from 'lucide-react';
import { LinkDeviceButton } from '@/components/LinkDeviceButton';

function ago(d: Date | null): string {
  if (!d) return '—';
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

interface Props {
  accounts:    { accountNumber: string; accountHash: string; type: string }[];
  nicknames:   Record<string, string>;
  lastUpdated: Date | null;
  onRefresh:   () => void;
}

export function ConnectionsView({ accounts, nicknames, lastUpdated, onRefresh }: Props) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-white">Brokerage Connections</h1>
        <p className="text-xs text-[#7c82a0] mt-0.5">Connect and sync your brokerage accounts</p>
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">Sync Status</div>
          <div className="text-xs text-[#7c82a0] mt-0.5">Last synced: {ago(lastUpdated)}</div>
        </div>
        <button
          onClick={onRefresh}
          className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 bg-blue-600/10 hover:bg-blue-600/20 px-3 py-1.5 rounded-lg transition-colors"
        >
          Sync now
        </button>
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600/15 border border-blue-500/25 flex items-center justify-center">
              <Landmark className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">Schwab</div>
              <div className="text-xs text-[#7c82a0]">
                {accounts.length} account{accounts.length === 1 ? '' : 's'} linked
              </div>
            </div>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full">
            <CheckCircle className="w-3.5 h-3.5" /> Active
          </span>
        </div>
        <div className="mt-3 pt-3 border-t border-[#1f2334] space-y-2">
          {accounts.map((a) => (
            <div key={a.accountHash} className="flex items-center justify-between text-xs">
              <span className="text-[#9aa2c0]">
                {nicknames[a.accountHash] || `···${a.accountNumber.slice(-3)}`}
                <span className="text-[#4a5070] ml-2">{a.type}</span>
              </span>
              <span className="text-[#4a5070]">Last synced: {ago(lastUpdated)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-[#12151f] border border-dashed border-[#2d3248] rounded-lg p-4 flex items-center gap-3 text-[#4a5070]">
        <Plus className="w-4 h-4" />
        <div className="text-xs">
          <div className="font-medium text-[#7c82a0]">Add Connection</div>
          <div>Schwab is currently the only supported broker.</div>
        </div>
      </div>

      <div className="bg-[#12151f] border border-[#1f2334] rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-2">Devices</div>
        <p className="text-xs text-[#7c82a0] mb-3">Link another device to this session.</p>
        <LinkDeviceButton />
      </div>
    </div>
  );
}
