/** Persisted engine state (anchors, high-water marks, debt history). */
import { storage, KEYS } from '@/lib/storage';
import { emptyState, type EngineState } from './types';

export async function loadEngineState(): Promise<EngineState> {
  return (await storage.get<EngineState>(KEYS.engineState)) ?? emptyState();
}

export async function saveEngineState(state: EngineState): Promise<void> {
  await storage.set(KEYS.engineState, state);
}
