'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface Account {
  accountNumber: string;
  type: string;
  totalValue: number;
}

interface Props {
  accounts: Account[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export function AccountSwitcher({ accounts, selectedIndex, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const selected = accounts[selectedIndex];

  if (accounts.length <= 1) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-[#22263a] border border-[#2d3248] rounded-lg px-4 py-2 text-sm hover:border-[#3d4260] transition-colors"
      >
        <span className="text-[#7c82a0]">Account</span>
        <span className="font-mono font-medium">
          ···{selected?.accountNumber?.slice(-4)}
        </span>
        <span className="text-xs text-[#7c82a0] uppercase">{selected?.type}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[#7c82a0]" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-[#22263a] border border-[#2d3248] rounded-lg shadow-xl z-50 overflow-hidden">
          {accounts.map((acct, i) => (
            <button
              key={acct.accountNumber}
              onClick={() => { onSelect(i); setOpen(false); }}
              className={`w-full text-left px-4 py-3 text-sm hover:bg-[#2d3248] flex justify-between items-center transition-colors ${i === selectedIndex ? 'bg-[#2d3248] text-white' : 'text-[#e8eaf0]'}`}
            >
              <span>
                <span className="font-mono">···{acct.accountNumber.slice(-4)}</span>
                <span className="text-xs text-[#7c82a0] ml-2 uppercase">{acct.type}</span>
              </span>
              <span className="text-emerald-400 font-medium text-xs">
                ${acct.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
