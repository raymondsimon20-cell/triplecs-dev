/**
 * Rights-offering filing watcher — CLM & CRF.
 *
 * Polls SEC EDGAR for recent N-2 / N-2/A / 497 / 424B filings on the
 * Cornerstone funds. A new N-2 (or amendment) is the canonical signal
 * that a closed-end fund is registering shares for a rights offering.
 * On detection, advances ro-status to 'announced' and emits an alert.
 *
 * Idempotent: if status is already past 'none' (and not yet 'complete'),
 * the watcher leaves it alone — manual stage advances win.
 */
import { getStore } from '@netlify/blobs';
import type { StoredAlert } from './storage';

// Local copy of the ROStatus shape — kept in sync with app/api/ro-status/route.ts.
// Duplicating avoids pulling next/server runtime into a module that runs
// in the Netlify-functions environment.
type ROStage = 'none' | 'announced' | 'subscription_open' | 'subscription_closed' | 'complete';
interface ROStatus {
  ticker: string;
  status: ROStage;
  notes: string;
  updatedAt: string;
}

const WATCH = [
  { ticker: 'CLM', cik: '0000814083' }, // Cornerstone Strategic Value Fund
  { ticker: 'CRF', cik: '0000033934' }, // Cornerstone Total Return Fund
];

// CEF rights offerings are registered on N-2; amendments and prospectus
// supplements (497, 424B*) follow as the offering progresses.
const RO_FORMS = new Set(['N-2', 'N-2/A', '497', '424B2', '424B3', '424B5']);

// Window for "recent" — function runs daily, so a 7-day window gives
// plenty of overlap to absorb a missed run without re-alerting on stale
// filings (idempotency comes from the ro-status check below).
const LOOKBACK_DAYS = 7;

// SEC requires a User-Agent that identifies the app + a contact email.
// Missing or generic UA returns 403. Override via env var in deploys.
const UA = process.env.SEC_USER_AGENT ?? 'TripleCApp ops@triplec.local';

interface EdgarRecent {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
}

async function fetchRecentFilings(cik: string): Promise<EdgarRecent | null> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) {
    console.warn(`[ro-watch] EDGAR ${r.status} for CIK ${cik}`);
    return null;
  }
  const j = (await r.json()) as { filings?: { recent?: EdgarRecent } };
  return j.filings?.recent ?? null;
}

export async function checkROFilings(now = Date.now()): Promise<StoredAlert[]> {
  const cutoff = now - LOOKBACK_DAYS * 86_400_000;
  const alerts: StoredAlert[] = [];

  for (const { ticker, cik } of WATCH) {
    let recent: EdgarRecent | null;
    try {
      recent = await fetchRecentFilings(cik);
    } catch (err) {
      console.warn(`[ro-watch] fetch failed for ${ticker}:`, err);
      continue;
    }
    if (!recent || !recent.form?.length) continue;

    // EDGAR returns parallel arrays sorted newest-first.
    let hit: { form: string; date: string; accession: string } | null = null;
    for (let i = 0; i < recent.form.length; i++) {
      const filed = new Date(recent.filingDate[i]).getTime();
      if (filed < cutoff) break;
      if (RO_FORMS.has(recent.form[i])) {
        hit = { form: recent.form[i], date: recent.filingDate[i], accession: recent.accessionNumber[i] };
        break;
      }
    }
    if (!hit) continue;

    // Idempotency: don't trample a manually-advanced status.
    let cur: ROStatus | null = null;
    try {
      cur = (await getStore('ro-status').get(ticker, { type: 'json' })) as ROStatus | null;
    } catch { /* treat as none */ }

    const isOpenCycle = cur && cur.status !== 'none' && cur.status !== 'complete';
    if (isOpenCycle) continue;

    // Skip if we already alerted on this exact accession.
    if (cur?.notes?.includes(hit.accession)) continue;

    const entry: ROStatus = {
      ticker,
      status: 'announced',
      notes: `Auto-detected ${hit.form} filed ${hit.date} (accession ${hit.accession})`,
      updatedAt: new Date(now).toISOString(),
    };
    try {
      await getStore('ro-status').setJSON(ticker, entry);
    } catch (err) {
      console.warn(`[ro-watch] failed to write ro-status for ${ticker}:`, err);
      continue;
    }

    alerts.push({
      id: `ro-${ticker}-${now}`,
      createdAt: now,
      level: 'warn',
      read: false,
      rule: `${ticker} rights offering — auto-detected`,
      detail: `New ${hit.form} filed ${hit.date}. Verify on cornerstoneadvisors.com and advance ro-status when subscription opens.`,
    });
    console.log(`[ro-watch] ${ticker}: detected ${hit.form} (${hit.accession}) — flipped to announced`);
  }

  return alerts;
}
