'use client';

/**
 * AccountSwitcher — header dropdown for choosing which Schwab account drives
 * the dashboard.
 *
 * 2026-05 redesign:
 *   • Always renders, even with a single account (so the user can see which
 *     account they're looking at and edit its nickname).
 *   • Per-account nicknames persisted to localStorage, keyed by accountHash.
 *     Inline pencil → rename. Empty name falls back to ···{last4}.
 *   • "All accounts" virtual option at index -1 in the dropdown. When picked
 *     it surfaces a roll-up across every linked account (the dashboard turns
 *     the index into a synthetic aggregated AccountData).
 *
 * API:
 *   selectedIndex: -1 means "All accounts", 0..N-1 picks a single account.
 *   onSelect: receives -1 for All, or the array index of the picked account.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, Pencil, Check, X, Layers } from 'lucide-react';

interface Account {
  accountNumber: string;
  accountHash: string;
  type: string;
  totalValue: number;
}

interface Props {
  accounts: Account[];
  selectedIndex: number; // -1 = All accounts
  onSelect: (index: number) => void;
}

// ─── Nickname storage ─────────────────────────────────────────────────────────

const NICKNAME_KEY = 'triplec_account_nicknames';

function loadNicknames(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(NICKNAME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveNicknames(map: Record<string, string>) {
  try {
    localStorage.setItem(NICKNAME_KEY, JSON.stringify(map));
    // Notify other components (e.g. dashboard) in case they want to listen.
    window.dispatchEvent(new CustomEvent('triplec:nicknames-changed'));
  } catch {
    /* ignore */
  }
}

/** Read a nickname directly (used by other components). */
export function getAccountNickname(accountHash: string): string | undefined {
  const map = loadNicknames();
  const v = map[accountHash];
  return v && v.trim() ? v.trim() : undefined;
}

/** Hook form for components that need to re-render when nicknames change. */
export function useAccountNicknames(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(() => loadNicknames());
  useEffect(() => {
    const handler = () => setMap(loadNicknames());
    window.addEventListener('triplec:nicknames-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('triplec:nicknames-changed', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  return map;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function defaultLabel(acct: Account): string {
  return `···${acct.accountNumber.slice(-4)}`;
}

function displayName(acct: Account, nicknames: Record<string, string>): string {
  const nick = nicknames[acct.accountHash];
  return nick && nick.trim() ? nick.trim() : defaultLabel(acct);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AccountSwitcher({ accounts, selectedIndex, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [editingHash, setEditingHash] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const nicknames = useAccountNicknames();
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setEditingHash(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Aggregate total across all accounts (for "All accounts" entry).
  const aggregateValue = accounts.reduce((s, a) => s + (a.totalValue || 0), 0);
  const isAll = selectedIndex === -1;
  const selected = !isAll ? accounts[selectedIndex] : null;

  const startEdit = (acct: Account) => {
    setEditingHash(acct.accountHash);
    setDraftName(nicknames[acct.accountHash] ?? '');
  };

  const commitEdit = useCallback(() => {
    if (!editingHash) return;
    const map = loadNicknames();
    const trimmed = draftName.trim();
    if (trimmed) {
      map[editingHash] = trimmed;
    } else {
      delete map[editingHash];
    }
    saveNicknames(map);
    setEditingHash(null);
  }, [editingHash, draftName]);

  const cancelEdit = () => {
    setEditingHash(null);
    setDraftName('');
  };

  // ── Trigger button (header chip) ────────────────────────────────────────────
  const triggerLabel = isAll
    ? 'All accounts'
    : selected ? displayName(selected, nicknames) : 'Account';
  const triggerSub = isAll
    ? `${accounts.length} accounts`
    : selected?.type;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-[#22263a] border border-[#2d3248] rounded-lg px-4 py-2 text-sm hover:border-[#3d4260] transition-colors"
      >
        {isAll
          ? <Layers className="w-3.5 h-3.5 text-blue-400" />
          : <span className="text-[#7c82a0]">Account</span>}
        <span className="font-medium">{triggerLabel}</span>
        {triggerSub && (
          <span className="text-xs text-[#7c82a0] uppercase">{triggerSub}</span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-[#7c82a0]" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-[#22263a] border border-[#2d3248] rounded-lg shadow-xl z-50 overflow-hidden">
          {/* All accounts roll-up — only useful when there's > 1 account */}
          {accounts.length > 1 && (
            <button
              onClick={() => { onSelect(-1); setOpen(false); setEditingHash(null); }}
              className={`w-full text-left px-4 py-3 text-sm flex justify-between items-center transition-colors border-b border-[#2d3248] ${
                isAll ? 'bg-[#2d3248] text-white' : 'text-[#e8eaf0] hover:bg-[#2d3248]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-blue-400" />
                <span className="font-medium">All accounts</span>
                <span className="text-xs text-[#7c82a0]">({accounts.length})</span>
              </span>
              <span className="text-emerald-400 font-medium text-xs">
                ${aggregateValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
            </button>
          )}

          {accounts.map((acct, i) => {
            const isActive  = !isAll && i === selectedIndex;
            const isEditing = editingHash === acct.accountHash;
            const displayed = displayName(acct, nicknames);
            const showingNickname = displayed !== defaultLabel(acct);

            return (
              <div
                key={acct.accountHash || acct.accountNumber}
                className={`group px-4 py-3 text-sm transition-colors ${
                  isActive ? 'bg-[#2d3248] text-white' : 'text-[#e8eaf0] hover:bg-[#2d3248]'
                }`}
              >
                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')  commitEdit();
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      placeholder={defaultLabel(acct)}
                      className="flex-1 bg-[#12151f] border border-[#3d4260] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                      maxLength={32}
                    />
                    <button
                      onClick={commitEdit}
                      className="text-emerald-400 hover:text-emerald-300"
                      title="Save nickname"
                      aria-label="Save nickname"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-[#7c82a0] hover:text-white"
                      title="Cancel"
                      aria-label="Cancel rename"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => { onSelect(i); setOpen(false); }}
                      className="flex-1 text-left flex items-center gap-2 min-w-0"
                    >
                      <span className="flex flex-col min-w-0">
                        <span className="font-medium truncate">{displayed}</span>
                        <span className="text-[10px] text-[#7c82a0] flex items-center gap-1.5">
                          {showingNickname && (
                            <span className="font-mono">···{acct.accountNumber.slice(-4)}</span>
                          )}
                          <span className="uppercase">{acct.type}</span>
                        </span>
                      </span>
                    </button>
                    <span className="text-emerald-400 font-medium text-xs flex-shrink-0">
                      ${acct.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); startEdit(acct); }}
                      className="text-[#7c82a0] opacity-0 group-hover:opacity-100 hover:text-white transition-opacity flex-shrink-0"
                      title="Rename account"
                      aria-label="Rename account"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
