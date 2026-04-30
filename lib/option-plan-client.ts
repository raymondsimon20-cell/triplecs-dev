/**
 * Client-side helper for /api/option-plan.
 *
 * The endpoint streams Claude's selection process back token-by-token to dodge
 * Netlify's 26s inactivity timeout, then sends the final validated plan inside
 * a `__RESULT__…__DONE__` sentinel block. This helper drains the stream and
 * returns the parsed plan.
 *
 * Side-effect to be aware of: the endpoint also auto-stages the selected
 * contract into the Trade Inbox (source='option') before responding. So a
 * successful call to this helper means the trade is already queued for
 * one-click approval — callers should not also stage it themselves.
 */

export interface SelectedContract {
  expiration:       string;
  dte:              number;
  strike:           number;
  otmPct:           number;
  delta:            number;
  bid:              number;
  ask:              number;
  mid:              number;
  iv:               number;
  annualisedReturn: number;
  breakeven:        number;
  closeTarget75:    number;
}

export interface OptionPlanResponse {
  occSymbol:        string;
  instruction:      'BUY_TO_OPEN' | 'SELL_TO_OPEN';
  contracts:        number;
  limitPrice:       number;
  rationale:        string;
  selectedContract: SelectedContract;
  validationPassed: boolean;
  symbol:           string;
  underlyingPrice:  number;
  mode:             string;
}

export async function fetchOptionPlan(body: Record<string, unknown>): Promise<OptionPlanResponse> {
  const res = await fetch('/api/option-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const err = await res.json();
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    throw new Error(`Server error (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += decoder.decode(value, { stream: true });
    if (accumulated.includes('__DONE__')) break;
  }
  const idx = accumulated.lastIndexOf('__RESULT__');
  if (idx === -1) throw new Error('No result received from server');
  const resultStr = accumulated.slice(idx + '__RESULT__'.length).replace('__DONE__', '').trim();
  const data = JSON.parse(resultStr) as OptionPlanResponse & { error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}
