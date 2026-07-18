/** Automation configuration + daily caps for auto-execution. */
import { storage, KEYS } from '@/lib/storage';

export interface AutoConfig {
  enabled: boolean;
  /** Max auto-executed trades per day. */
  maxTradesPerDay: number;
  /** Max total absolute exposure shift (buys + sells, dollars) per day. */
  maxExposureShiftPerDay: number;
  /** Only signals at/below this severity auto-execute ('low' | 'medium'). */
  maxAutoSeverity: 'low' | 'medium';
}

export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  enabled: false, // opt-in
  maxTradesPerDay: 3,
  maxExposureShiftPerDay: 25_000,
  maxAutoSeverity: 'medium',
};

export async function loadAutoConfig(): Promise<AutoConfig> {
  return (await storage.get<AutoConfig>(KEYS.autoConfig)) ?? DEFAULT_AUTO_CONFIG;
}

export async function saveAutoConfig(cfg: AutoConfig): Promise<void> {
  await storage.set(KEYS.autoConfig, cfg);
}

export interface AutomationPause {
  paused: boolean;
  reason?: string;
  pausedAt?: string;
}

export async function getAutomationPause(): Promise<AutomationPause> {
  return (await storage.get<AutomationPause>(KEYS.automationPause)) ?? { paused: false };
}

export async function setAutomationPause(pause: AutomationPause): Promise<void> {
  await storage.set(KEYS.automationPause, pause);
}
