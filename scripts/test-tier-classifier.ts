/**
 * Tier-classifier tests.
 *
 * Covers classifySignalTier in lib/signals/daily-plan.ts after the tier-2
 * promotion: MAINTENANCE_RANKED_TRIM, PILLAR_FILL, and TRIPLES_DIP_LADDER
 * now classify as 'auto' (eligible for unattended execution) when sized
 * ≤ AUTO_TIER_MAX_DOLLARS ($5K).
 *
 * Pairs with the auto-execute guardrail validation in
 * lib/signals/auto-execute.ts — without that safety prereq these
 * promotions would re-create the AFW incident on equity trades.
 */

import assert from 'node:assert/strict';
import { classifySignalTier } from '../lib/signals/daily-plan';
import type { TradeSignal } from '../lib/signals/engine';

let pass = 0;
let fail = 0;

function test(label: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${label}\n        ${msg}`);
  }
}

function sig(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id:          't1',
    rule:        'PILLAR_FILL',
    action:      'FILL_INCOME',
    ticker:      'JEPI',
    direction:   'BUY',
    sizeDollars: 1_000,
    priority:    'MEDIUM',
    reason:      'test',
    data:        {},
    timestamp:   new Date().toISOString(),
    ...over,
  };
}

// ─── Newly promoted rules (the point of this commit) ────────────────────────

console.log('\nPromoted rules — tier 1 when sized ≤ $5K');

test('MAINTENANCE_RANKED_TRIM at $3K → auto', () => {
  assert.equal(classifySignalTier(sig({ rule: 'MAINTENANCE_RANKED_TRIM', direction: 'SELL', sizeDollars: 3_000 })), 'auto');
});

test('PILLAR_FILL at $5K → auto (right at the ceiling)', () => {
  assert.equal(classifySignalTier(sig({ rule: 'PILLAR_FILL', sizeDollars: 5_000 })), 'auto');
});

test('TRIPLES_DIP_LADDER at $500 → auto', () => {
  assert.equal(classifySignalTier(sig({ rule: 'TRIPLES_DIP_LADDER', ticker: 'SOXL', sizeDollars: 500 })), 'auto');
});

test('TRIPLES_DIP_LADDER at $1K → auto', () => {
  assert.equal(classifySignalTier(sig({ rule: 'TRIPLES_DIP_LADDER', ticker: 'UPRO', sizeDollars: 1_000 })), 'auto');
});

// ─── Ceiling — anything > $5K stays tier 2 ─────────────────────────────────

console.log('\n$5K ceiling enforcement');

test('PILLAR_FILL above $5K → approval (over ceiling)', () => {
  assert.equal(classifySignalTier(sig({ rule: 'PILLAR_FILL', sizeDollars: 5_001 })), 'approval');
});

test('MAINTENANCE_RANKED_TRIM at $10K → approval (over ceiling)', () => {
  assert.equal(classifySignalTier(sig({ rule: 'MAINTENANCE_RANKED_TRIM', direction: 'SELL', sizeDollars: 10_000 })), 'approval');
});

test('TRIPLES_DIP_LADDER above $5K → approval (over ceiling)', () => {
  assert.equal(classifySignalTier(sig({ rule: 'TRIPLES_DIP_LADDER', ticker: 'SOXL', sizeDollars: 6_000 })), 'approval');
});

// ─── Existing rules — unchanged behavior ───────────────────────────────────

console.log('\nExisting auto rules — unchanged');

test('AFW_TRIGGER at $500 → auto', () => {
  assert.equal(classifySignalTier(sig({ rule: 'AFW_TRIGGER', sizeDollars: 500 })), 'auto');
});

test('CLM_CRF_TRIM at $1K → auto', () => {
  assert.equal(classifySignalTier(sig({ rule: 'CLM_CRF_TRIM', direction: 'SELL', sizeDollars: 1_000 })), 'auto');
});

test('AIRBAG_SCALE at $200 → auto', () => {
  assert.equal(classifySignalTier(sig({ rule: 'AIRBAG_SCALE', ticker: 'SPXU', sizeDollars: 200 })), 'auto');
});

// ─── Non-whitelist rules — still approval ──────────────────────────────────

console.log('\nNon-whitelist rules — still approval');

test('unknown rule at any size → approval', () => {
  assert.equal(classifySignalTier(sig({ rule: 'SOME_FUTURE_RULE', sizeDollars: 100 })), 'approval');
});

// ─── Alert/info rules — always tier 3 ──────────────────────────────────────

console.log('\nAlert/info rules — always tier 3');

test('DEFENSE_MODE → alert regardless of direction', () => {
  assert.equal(classifySignalTier(sig({ rule: 'DEFENSE_MODE', direction: 'SELL', sizeDollars: 1_000 })), 'alert');
});

test('MARGIN_KILL_SWITCH → alert', () => {
  assert.equal(classifySignalTier(sig({ rule: 'MARGIN_KILL_SWITCH', direction: 'ALERT', sizeDollars: 0 })), 'alert');
});

test('any signal with ALERT direction → alert', () => {
  assert.equal(classifySignalTier(sig({ rule: 'PILLAR_FILL', direction: 'ALERT', sizeDollars: 1_000 })), 'alert');
});

test('any signal with INFO direction → alert', () => {
  assert.equal(classifySignalTier(sig({ rule: 'AFW_TRIGGER', direction: 'INFO', sizeDollars: 0 })), 'alert');
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
