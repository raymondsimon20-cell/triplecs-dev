'use client';

/**
 * LinkDeviceButton — one-tap "Link new device" affordance for the dashboard
 * header. Calls GET /api/auth/link-device to mint a short-lived signed URL,
 * then displays it in a modal with a copy button so the user can open it on
 * their phone (or a second browser) to complete Schwab OAuth there.
 *
 * The minted URL is single-purpose and expires in 10 minutes — see
 * lib/device-link.ts and the callback gate in app/api/auth/callback/route.ts
 * for the full flow.
 */

import { useState, useCallback } from 'react';
import { Smartphone, Copy, Check, X, RefreshCw } from 'lucide-react';

interface LinkResponse {
  url: string;
  expiresInSeconds: number;
}

export function LinkDeviceButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mint = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch('/api/auth/link-device', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as LinkResponse;
      setUrl(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const openModal = useCallback(() => {
    setOpen(true);
    setUrl(null);
    void mint();
  }, [mint]);

  const closeModal = useCallback(() => {
    setOpen(false);
    setUrl(null);
    setError(null);
    setCopied(false);
  }, []);

  const copy = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be blocked in non-secure contexts; ignore
    }
  }, [url]);

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        aria-label="Link new device"
        title="Link a new device"
        className="flex items-center text-[#7c82a0] hover:text-emerald-400 transition-colors p-1"
      >
        <Smartphone className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={closeModal}
        >
          <div
            className="bg-[#0e1118] border border-[#1f2334] rounded-lg max-w-md w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-white font-semibold flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-emerald-400" />
                  Link a new device
                </h2>
                <p className="text-xs text-[#7c82a0] mt-1 leading-relaxed">
                  Open this URL on the device you want to authorize, then click
                  Connect Schwab on that device. The link is valid for 1 hour.
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="text-[#7c82a0] hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {loading && (
              <div className="text-xs text-[#7c82a0] flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Generating link…
              </div>
            )}

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-red-400 text-xs">
                Couldn’t generate link: {error}
              </div>
            )}

            {url && (
              <div className="space-y-2">
                <div className="bg-[#1f2334] rounded p-3 text-[11px] text-white break-all font-mono">
                  {url}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={copy}
                    className="flex-1 flex items-center justify-center gap-2 bg-[#1273ea] hover:bg-[#0f5ec7] text-white text-sm font-medium py-2 rounded transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy link
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={mint}
                    className="flex items-center justify-center gap-2 border border-[#1f2334] hover:border-[#2a3046] text-[#7c82a0] hover:text-white text-sm font-medium px-3 py-2 rounded transition-colors"
                    title="Generate a new link"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
