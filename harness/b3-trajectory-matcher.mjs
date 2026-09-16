/**
 * B3 Gate — Trajectory matching
 *
 * In-order (not exact-order) trajectory check:
 *   Expected tools must appear as a subsequence of actual tools.
 *   Extra tools between expected steps are tolerated.
 *   A missing required tool or wrong order = FAIL.
 *
 * Pass bar:  ≥80% of runs match expected trajectory
 * Stop floor: <50% → agent not deterministic enough; fall back to B2 artifact checks
 *
 * Usage:  node harness/b3-trajectory-matcher.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const GOLDEN_SET = resolve('golden-sets/b3-trajectories.json');
const OUT_FILE   = resolve('results/B3-trajectory.json');

/**
 * In-order subsequence check.
 * Returns { match, matchedAt, firstMissing }
 */
function inOrderMatch(expected, actual) {
  if (expected.length === 0) return { match: true, matchedAt: [], firstMissing: null };

  let ei = 0;
  const matchedAt = [];

  for (let ai = 0; ai < actual.length && ei < expected.length; ai++) {
    if (actual[ai] === expected[ei]) {
      matchedAt.push({ tool: expected[ei], actualIndex: ai });
      ei++;
    }
  }

  const allFound = ei === expected.length;
  return {
    match: allFound,
    matchedAt,
    firstMissing: allFound ? null : expected[ei],
  };
}

function main() {
  const golden = JSON.parse(readFileSync(GOLDEN_SET, 'utf-8'));
  const { runs, passBar, stopFloor, matchMode } = golden;

  console.log('\nB3 Gate — In-order trajectory matching');
  console.log(`Golden set: ${runs.length} runs  |  Mode: ${matchMode}  |  Pass bar: ≥${passBar * 100}%  |  Stop floor: <${stopFloor * 100}%`);
  console.log('─'.repeat(70));

  const results = [];

  for (const run of runs) {
    const { match, matchedAt, firstMissing } = inOrderMatch(run.expectedTools, run.actualTools);

    const extraTools = run.actualTools.filter(t => !run.expectedTools.includes(t));

    console.log(`\n  ${run.id} [${run.taskType}] session=${run.sessionId.substring(0, 8)}`);
    console.log(`  Expected: ${run.expectedTools.join(' → ')}`);
    console.log(`  Actual:   ${run.actualTools.join(' → ')}`);
    if (extraTools.length) console.log(`  Extra:    ${extraTools.join(', ')} (tolerated)`);
    console.log(`  Result:   ${match ? 'MATCH ✓' : `NO MATCH ✗ — missing: ${firstMissing}`}`);

    results.push({
      id: run.id,
      sessionId: run.sessionId,
      taskType: run.taskType,
      description: run.description,
      expectedTools: run.expectedTools,
      actualTools: run.actualTools,
      extraTools,
      match,
      firstMissing,
      matchedAt,
      iters: run.iters,
      stop: run.stop,
    });
  }

  const matching   = results.filter(r => r.match).length;
  const total      = results.length;
  const matchRate  = matching / total;
  const gatePass   = matchRate >= passBar;
  const fallback   = matchRate < stopFloor;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Runs:       ${total}  |  Match: ${matching}  |  Fail: ${total - matching}`);
  console.log(`Match rate: ${(matchRate * 100).toFixed(1)}%  (bar: ${passBar * 100}%  floor: ${stopFloor * 100}%)`);

  if (fallback) {
    console.log(`Gate:       STOP ✗ — match rate below ${stopFloor * 100}% floor`);
    console.log(`Action:     Fall back to B2 artifact checks only. Revisit B3 when agent stabilises.`);
  } else if (gatePass) {
    console.log(`Gate:       PASS ✓`);
  } else {
    console.log(`Gate:       FAIL ✗ — below ${passBar * 100}% pass bar (above ${stopFloor * 100}% floor)`);
  }
  console.log('─'.repeat(70));

  const output = {
    gate: 'B3',
    runAt: new Date().toISOString(),
    goldenSet: GOLDEN_SET,
    matchMode,
    passBar,
    stopFloor,
    runsTotal: total,
    runsMatching: matching,
    matchRate: +matchRate.toFixed(4),
    pass: gatePass,
    fallback,
    taskTypeCoverage: [...new Set(runs.map(r => r.taskType))],
    runs: results,
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${OUT_FILE}`);

  process.exit(gatePass ? 0 : 1);
}

main();
