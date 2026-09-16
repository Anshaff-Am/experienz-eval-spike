/**
 * B2 Gate — Check #3: Certified metrics reconcile against hand-computed baseline within tolerance
 *
 * Reads a reconciliation.json produced by the Grade C reconcile stage.
 * For every metric-wave entry where silver != null and expected != null,
 * checks |silver - expected| <= tolerance (default 0.5pp from the run config).
 * Emits numbers per metric, not just pass/fail.
 *
 * Also run against a known-bad fixture to prove the gate fires on out-of-tolerance values.
 *
 * Usage:
 *   node harness/b2-metric-reconciler.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const GOOD_FIXTURE = resolve('golden-sets/b2-fixtures/reconciliation-good.json');
const BAD_FIXTURE  = resolve('golden-sets/b2-fixtures/reconciliation-bad.json');
const OUT_FILE     = resolve('results/B2-metric-reconcile.json');

function reconcile(filePath, label, expectPass) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const tolerance = raw.tolerance ?? 0.5;
  const results = raw.results ?? [];

  const scoreable = results.filter(r => r.silver != null && r.expected != null);
  const skipped   = results.filter(r => r.silver == null || r.expected == null);

  const metrics = scoreable.map(r => {
    const delta = Math.abs(r.silver - r.expected);
    const pass  = delta <= tolerance;
    return { id: r.id, wave: r.wave, silver: r.silver, expected: r.expected, delta: +delta.toFixed(4), tolerance, pass };
  });

  const passing = metrics.filter(m => m.pass);
  const failing = metrics.filter(m => !m.pass);
  const gatePass = failing.length === 0;
  const behaviourCorrect = gatePass === expectPass;

  console.log(`\n  [${label}]`);
  console.log(`  File:        ${filePath}`);
  console.log(`  Tolerance:   ±${tolerance}pp  |  Weighted: ${raw.weighted}  |  Weight: ${raw.weight_expr}`);
  console.log(`  Scoreable:   ${scoreable.length}  |  Skipped (null silver/expected): ${skipped.length}`);
  console.log(`  Pass:        ${passing.length}  |  Fail: ${failing.length}`);
  console.log(`  Gate:        ${gatePass ? 'PASS ✓' : 'FAIL ✗'}  (expected ${expectPass ? 'PASS' : 'FAIL'} → ${behaviourCorrect ? 'CORRECT ✓' : 'WRONG ✗'})`);

  if (failing.length) {
    console.log(`  Failures:`);
    for (const m of failing) {
      console.log(`    ✗ ${m.id}  silver=${m.silver.toFixed(4)}  expected=${m.expected}  delta=${m.delta}pp  (limit ${tolerance}pp)`);
    }
  }

  // Per-metric table (passing, brief)
  if (passing.length && passing.length <= 20) {
    for (const m of passing) {
      console.log(`    ✓ ${m.id.padEnd(8)}  silver=${m.silver.toFixed(4).padStart(9)}  expected=${String(m.expected).padStart(6)}  Δ=${m.delta}pp`);
    }
  }

  return {
    label, filePath, runId: raw.run_id,
    tolerance, weighted: raw.weighted, weightExpr: raw.weight_expr,
    scoreableCount: scoreable.length, skippedCount: skipped.length,
    passingCount: passing.length, failingCount: failing.length,
    gatePass, expectPass, behaviourCorrect,
    metrics,
    skipped: skipped.map(r => r.id),
  };
}

function main() {
  console.log('\nB2 Check #3 — Certified metric reconciliation');
  console.log('─'.repeat(60));

  const goodResult = reconcile(GOOD_FIXTURE, 'known-good (real run)', true);
  const badResult  = reconcile(BAD_FIXTURE,  'known-bad  (fixture)', false);

  const bothCorrect = goodResult.behaviourCorrect && badResult.behaviourCorrect;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`known-good passes:   ${goodResult.behaviourCorrect ? 'YES ✓' : 'NO ✗'}  (${goodResult.passingCount}/${goodResult.scoreableCount} metrics within ±${goodResult.tolerance}pp)`);
  console.log(`known-bad  fires:    ${badResult.behaviourCorrect  ? 'YES ✓' : 'NO ✗'}  (${badResult.failingCount} metrics out of tolerance)`);
  console.log(`Gate:                ${bothCorrect ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('─'.repeat(60));

  const output = {
    gate: 'B2-check3-metric-reconcile',
    runAt: new Date().toISOString(),
    pass: bothCorrect,
    summary: {
      goodFixturePasses: goodResult.behaviourCorrect,
      badFixtureFires:   badResult.behaviourCorrect,
      goodMetricsPassing: goodResult.passingCount,
      goodMetricsTotal:   goodResult.scoreableCount,
      tolerance: goodResult.tolerance,
    },
    fixtures: { good: goodResult, bad: badResult },
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${OUT_FILE}`);

  process.exit(bothCorrect ? 0 : 1);
}

main();
