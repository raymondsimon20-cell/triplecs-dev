/**
 * OCC option symbol parsing.
 *
 * Extracted from components/OpenPutTracker so the protective-put analysis can
 * use the same parser rather than a second copy that drifts from it.
 *
 * Format: "TSLA  250117P00200000" — underlying (space padded), YYMMDD
 * expiration, P or C, then strike × 1000 as 8 zero-padded digits.
 */

export interface ParsedOcc {
  underlying: string;
  expiration: string;   // YYYY-MM-DD
  isCall:     boolean;
  strike:     number;
}

export function parseOcc(symbol: string): ParsedOcc | null {
  const clean = symbol.replace(/\s+/g, '');
  const m = clean.match(/^([A-Z]+)(\d{6})([PC])(\d{8})$/i);
  if (!m) return null;

  const [, under, dateStr, type, strikeStr] = m;
  const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
  const expiration = `${year}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;

  return {
    underlying: under.toUpperCase(),
    expiration,
    isCall: type.toUpperCase() === 'C',
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

/** Calendar days to expiration, floored at zero. */
export function daysToExpiry(expiration: string): number {
  const exp = new Date(`${expiration}T16:00:00`);
  const now = new Date();
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / 86_400_000));
}
