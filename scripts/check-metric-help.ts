/**
 * check-metric-help.ts — keeps lib/metric-help.ts honest against the UI.
 *
 * The registry joins to cards by their exact `label` string, which makes
 * adding help cheap but means a renamed label silently loses its bubble. This
 * script reports both directions of drift:
 *
 *   • labels rendered by a <StatCard> with no registry entry  → no bubble
 *   • registry entries no label uses                          → dead text
 *
 * Run: npx tsx scripts/check-metric-help.ts
 * Exits non-zero if either list is non-empty, so it can gate a build.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { METRIC_HELP } from '../lib/metric-help';

const ROOTS = ['components', 'app'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Finding the label is fiddlier than it looks. A tag-scoped regex like
 * `<Stat[^>]*?label="…"` breaks on JSX expression attributes that contain a
 * `>` character — e.g. `icon={a.spreadPp >= 0 ? TrendingUp : TrendingDown}`
 * ends the match early and the label is missed. (That bug silently hid the
 * "Spread" card and reported its registry entry as orphaned.)
 *
 * So instead: find each opening tag, then take the first `label="…"` within a
 * generous window after it. Attribute lists in this codebase are well under
 * that, and a stray match would have to be a nested component's label — which
 * would itself be worth flagging.
 */
const WINDOW = 500;
const OPEN_STAT   = /<Stat(?:Card)?[\s\n]/g;
const OPEN_BUBBLE = /<(?:InfoBubble|MetricHelpBody)[\s\n]/g;
const LABEL_ATTR  = /\blabel=(?:"([^"]+)"|\{'([^']+)'\})/;

function labelsFor(src: string, opener: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(opener)) {
    const slice = src.slice(m.index!, m.index! + WINDOW);
    const hit = slice.match(LABEL_ATTR);
    const label = hit?.[1] ?? hit?.[2];
    if (label) out.push(label);
  }
  return out;
}

const statLabels   = new Map<string, string[]>();
const bubbleLabels = new Set<string>();

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    for (const label of labelsFor(src, OPEN_STAT)) {
      const seen = statLabels.get(label) ?? [];
      if (!seen.includes(file)) seen.push(file);
      statLabels.set(label, seen);
    }
    for (const label of labelsFor(src, OPEN_BUBBLE)) bubbleLabels.add(label);
  }
}

const helpKeys = new Set(Object.keys(METRIC_HELP));
const missing  = [...statLabels.keys()].filter((l) => !helpKeys.has(l)).sort();
const orphaned = [...helpKeys]
  .filter((k) => !statLabels.has(k) && !bubbleLabels.has(k))
  .sort();

console.log(`StatCard labels found : ${statLabels.size}`);
console.log(`Hand-wired bubbles    : ${bubbleLabels.size}`);
console.log(`Registry entries      : ${helpKeys.size}`);
console.log(`Covered               : ${statLabels.size - missing.length}/${statLabels.size} stat cards`);

if (missing.length) {
  console.log(`\n✗ ${missing.length} stat card label(s) with no registry entry — these render without a bubble:`);
  for (const l of missing) console.log(`    ${JSON.stringify(l)}  ← ${statLabels.get(l)!.join(', ')}`);
}

if (orphaned.length) {
  console.log(`\n✗ ${orphaned.length} registry entr(ies) no label uses — renamed or removed from the UI:`);
  for (const k of orphaned) console.log(`    ${JSON.stringify(k)}`);
}

if (!missing.length && !orphaned.length) {
  console.log('\n✓ every stat card has help, and every entry is reachable');
}

process.exit(missing.length || orphaned.length ? 1 : 0);
