/** Classification tests — run with `npm run test:classify`. */
import assert from 'node:assert';
import { classify, pillarBreakdown, familyConcentration, getFamily } from '../lib/classify';

// Pillar classification
assert.equal(classify('UPRO'), 'triples');
assert.equal(classify('TQQQ'), 'triples');
assert.equal(classify('SOXL'), 'triples');
assert.equal(classify('SQQQ'), 'hedge');
assert.equal(classify('SOXS'), 'hedge');
assert.equal(classify('CLM'), 'cornerstone');
assert.equal(classify('CRF'), 'cornerstone');
assert.equal(classify('QQQY'), 'income');
assert.equal(classify('XDTE'), 'income');
assert.equal(classify('TSLY'), 'income');
assert.equal(classify('SPY'), 'income'); // growth anchor → core/income
assert.equal(classify('TLT'), 'income'); // bond stabilizer
assert.equal(classify('ZZZZ'), 'unknown');

// Puts classify as hedges
assert.equal(classify('SPY   250815P00450000'), 'hedge');
assert.equal(classify('SPY', 'PUT'), 'hedge');

// Families
assert.equal(getFamily('TSLY'), 'yieldmax');
assert.equal(getFamily('QQQY'), 'defiance');
assert.equal(getFamily('XDTE'), 'roundhill');
assert.equal(getFamily('FEPI'), 'rexshares');

// Breakdown math
const bd = pillarBreakdown(
  [
    { symbol: 'UPRO', marketValue: 100_000 },
    { symbol: 'CLM', marketValue: 200_000 },
    { symbol: 'XDTE', marketValue: 650_000 },
    { symbol: 'SQQQ', marketValue: 50_000 },
  ],
  0
);
assert.equal(bd.total, 1_000_000);
assert.ok(Math.abs(bd.percents.triples - 0.1) < 1e-9);
assert.ok(Math.abs(bd.percents.cornerstone - 0.2) < 1e-9);
assert.ok(Math.abs(bd.percents.income - 0.65) < 1e-9);
assert.ok(Math.abs(bd.percents.hedge - 0.05) < 1e-9);

// Family concentration
const fc = familyConcentration([
  { symbol: 'TSLY', marketValue: 500 },
  { symbol: 'NVDY', marketValue: 500 },
]);
assert.ok(Math.abs(fc.yieldmax - 1) < 1e-9);

console.log('✓ test-classify passed');
