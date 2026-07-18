/**
 * Strategy settings CRUD — exposes every engine tunable without a redeploy.
 * Stored overrides are merged over the CONFIG defaults at read time.
 */
import { NextRequest, NextResponse } from 'next/server';
import { storage, KEYS } from '@/lib/storage';
import { CONFIG } from '@/lib/signals/engine';
import { GUARDRAIL_CONFIG } from '@/lib/guardrails';
import { PILLAR_TARGETS } from '@/lib/data/fund-metadata';

export const dynamic = 'force-dynamic';

export interface StrategySettings {
  pillarTargets: typeof PILLAR_TARGETS;
  engine: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  fireTargetEquity: number;
}

const DEFAULTS: StrategySettings = {
  pillarTargets: PILLAR_TARGETS,
  engine: CONFIG as unknown as Record<string, unknown>,
  guardrails: GUARDRAIL_CONFIG as unknown as Record<string, unknown>,
  fireTargetEquity: 2_000_000,
};

export async function GET() {
  const overrides = await storage.get<Partial<StrategySettings>>(KEYS.strategySettings);
  return NextResponse.json({ ...DEFAULTS, ...overrides });
}

export async function PUT(req: NextRequest) {
  const overrides = (await req.json()) as Partial<StrategySettings>;
  await storage.set(KEYS.strategySettings, overrides);
  return NextResponse.json({ ...DEFAULTS, ...overrides });
}

export async function DELETE() {
  await storage.delete(KEYS.strategySettings);
  return NextResponse.json(DEFAULTS);
}
