/**
 * Signal-engine master switch — single source of truth.
 *
 * 2026-07: the engine was disabled at the user's request after its trades
 * underperformed. The flag originally lived as a local `const` inside
 * `netlify/functions/daily-signal-engine.mts`, which meant it gated the CRON
 * and nothing else. `POST /api/signals` calls the same `runSignalsAndStage()`
 * directly and was never covered — so a UI-triggered run could still reach
 * `autoExecute()` and place real Schwab orders while the engine was nominally
 * "off". The only thing standing in the way was `auto-config.mode` defaulting
 * to 'manual', i.e. the backstop was a setting that can be changed from the
 * UI and persisted to blob storage, not the switch itself.
 *
 * Hoisted here so both entry points read the same value.
 *
 * Deliberately hardcoded rather than env-driven: a disabled trading engine
 * should not be re-armed by a misconfigured environment variable. Flip to
 * `true` and redeploy to re-enable.
 */
export const SIGNAL_ENGINE_ENABLED = false;

/**
 * Whether unattended order placement is permitted right now.
 *
 * Gated at `autoExecute()` rather than at `runSignalsAndStage()` on purpose.
 * Signal computation and inbox staging remain available while the engine is
 * off — that is the documented intent, so manual runs stay useful for
 * evaluation and the shadow/backtest endpoints keep working. What must not
 * happen is a real order reaching Schwab without a human, and `autoExecute()`
 * is the sole unattended caller of `placeOrders`. Gating the chokepoint
 * covers every current caller and any future one.
 *
 * Staged items are unaffected: they still land in the inbox as proposals for
 * manual approval, exactly like the weekly drift rebalance's output.
 */
export function autoExecutionAllowed(): boolean {
  return SIGNAL_ENGINE_ENABLED;
}
