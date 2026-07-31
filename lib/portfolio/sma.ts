/**
 * Moving-average periods available to the allocation scorer.
 *
 * Lives here rather than in the route because Next.js restricts what a route
 * module may export — handlers and a small set of config keys only. A `const`
 * export from `app/api/.../route.ts` fails the build's route-type check even
 * though it is otherwise valid TypeScript.
 */

export const SMA_PERIODS = [50, 100, 200] as const;
export type SmaPeriod = typeof SMA_PERIODS[number];

export const DEFAULT_SMA_PERIOD: SmaPeriod = 50;

/**
 * Why the choice matters: a 50-day average tracks recent momentum and turns
 * quickly, so on the high-volatility weekly payers it flips a position between
 * "accumulation zone" and "extended" within days. A 200-day average describes
 * the longer trend and is far steadier, but is slow to acknowledge a genuine
 * regime change. Neither is correct in general — which is why this is a knob
 * rather than a constant.
 */
export const SMA_PERIOD_HELP: Record<SmaPeriod, string> = {
  50:  'Fast — tracks recent momentum, flips often on volatile names.',
  100: 'Middle ground between momentum and trend.',
  200: 'Slow — describes the long trend, slow to react to regime change.',
};
