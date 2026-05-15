/**
 * NYSE trading-day calendar.
 *
 * The signal engine, daily cron, heartbeat checker, and digest sender all need
 * to distinguish trading days from non-trading days. The honest minimum:
 * weekends are never trading days, and the NYSE publishes a list of full-day
 * closures (~9–10 per year). Half-days exist but trade for normal-engine
 * purposes; we treat them as full trading days.
 *
 * The holiday list is hardcoded through 2027. Extend it as new schedules are
 * published. Better than a 3rd-party API call for a calendar that changes
 * once a year.
 *
 *   https://www.nyse.com/markets/hours-calendars
 *
 * All functions interpret dates in America/New_York to match NYSE's hours.
 * Callers don't need to be tz-aware — pass a Date or skip the arg for "now".
 */

// ─── NYSE full-day closures, 2025–2027 ───────────────────────────────────────
//
// New Year's Day, MLK Day, Presidents' Day, Good Friday, Memorial Day,
// Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas. Plus the
// observed-on-Monday rule for holidays that fall on a Sunday and the observed-
// on-Friday rule for ones that fall on a Saturday.
const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

/** YYYY-MM-DD in America/New_York for the given date. */
export function nyDateString(d: Date = new Date()): string {
  // toLocaleDateString with en-CA gives ISO format (YYYY-MM-DD).
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Day-of-week (0=Sun, 6=Sat) in America/New_York. */
function nyDayOfWeek(d: Date): number {
  // Sunday..Saturday in en-US weekday format.
  const wd = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday:  'short',
  });
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

/** Is the given date a NYSE trading day? Excludes weekends and holidays. */
export function isTradingDay(d: Date = new Date()): boolean {
  const dow = nyDayOfWeek(d);
  if (dow === 0 || dow === 6) return false;
  return !NYSE_HOLIDAYS.has(nyDateString(d));
}

/** Most recent trading day at or before `d` (defaults to today). */
export function lastTradingDay(d: Date = new Date()): Date {
  const cursor = new Date(d);
  while (!isTradingDay(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor;
}

/** Next trading day strictly after `d` (defaults to today). */
export function nextTradingDay(d: Date = new Date()): Date {
  const cursor = new Date(d);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (!isTradingDay(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor;
}

/**
 * Number of trading days in the inclusive range [a, b]. Useful for "how many
 * trading days has it been since the last engine run?". Returns 0 when a > b.
 */
export function tradingDaysBetween(a: Date, b: Date): number {
  if (a.getTime() > b.getTime()) return 0;
  let n = 0;
  const cursor = new Date(a);
  while (cursor.getTime() <= b.getTime()) {
    if (isTradingDay(cursor)) n += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return n;
}

/**
 * The expected window for the next cron health check. If today is a trading
 * day, alerts should fire when the gap exceeds 25h (one daily run + slack).
 * If today is NOT a trading day, alert windows extend through the next
 * trading day — Saturday/Sunday silence is normal.
 */
export function expectedRunWindowHours(from: Date = new Date()): number {
  if (isTradingDay(from)) return 25;
  // Find the next trading day and compute hours until end of that day.
  const next = nextTradingDay(from);
  const diffMs = next.getTime() - from.getTime();
  // Add 25h slack to the next trading day's end.
  return Math.ceil(diffMs / (60 * 60 * 1000)) + 25;
}
