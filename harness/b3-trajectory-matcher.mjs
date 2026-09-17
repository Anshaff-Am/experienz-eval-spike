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
    const expectedMatch = run.expectedMatch !== false; // default true for backward compat
    const correct = match === expectedMatch;
    const isRogue = !expectedMatch;

    const extraTools = run.actualTools.filter(t => !run.expectedTools.includes(t));
    const rogueTag = isRogue ? ` [ROGUE-DETECTION: ${run.roguePattern}]` : '';

    console.log(`\n  ${run.id} [${run.taskType}]${rogueTag} session=${run.sessionId.substring(0, 8)}`);
    console.log(`  Expected: ${run.expectedTools.join(' → ')}`);
    console.log(`  Actual:   ${run.actualTools.join(' → ')}`);
    if (extraTools.length) console.log(`  Extra:    ${extraTools.join(', ')} (tolerated)`);

    if (isRogue) {
      const detected = !match;
      console.log(`  Match:    ${match ? 'MATCH' : 'NO MATCH'}`);
      console.log(`  Rogue:    ${detected ? 'DETECTED ✓' : 'MISSED ✗ — rogue slipped through gate'}`);
    } else {
      console.log(`  Result:   ${match ? 'MATCH ✓' : `NO MATCH ✗ — missing: ${firstMissing}`}`);
    }

    results.push({
      id: run.id,
      sessionId: run.sessionId,
      source: run.source ?? 'real',
      taskType: run.taskType,
      description: run.description,
      roguePattern: run.roguePattern ?? null,
      expectedMatch,
      expectedTools: run.expectedTools,
      actualTools: run.actualTools,
      extraTools,
      match,
      correct,
      firstMissing,
      matchedAt,
      iters: run.iters,
      stop: run.stop,
    });
  }

  const correct    = results.filter(r => r.correct).length;
  const total      = results.length;
  const matchRate  = correct / total;
  const gatePass   = matchRate >= passBar;
  const fallback   = matchRate < stopFloor;

  const realRuns   = results.filter(r => r.source === 'real');
  const rogueRuns  = results.filter(r => r.source === 'synthetic');
  const rogueDetected = rogueRuns.filter(r => r.correct).length;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Runs:            ${total}  (real: ${realRuns.length}, rogue-detection: ${rogueRuns.length})`);
  console.log(`Correct:         ${correct} / ${total}`);
  console.log(`  Real sessions: ${realRuns.filter(r => r.correct).length} / ${realRuns.length} match expected trajectory`);
  console.log(`  Rogue cases:   ${rogueDetected} / ${rogueRuns.length} correctly detected`);
  console.log(`Correct rate:    ${(matchRate * 100).toFixed(1)}%  (bar: ${passBar * 100}%  floor: ${stopFloor * 100}%)`);

  if (fallback) {
    console.log(`Gate:       STOP ✗ — correct rate below ${stopFloor * 100}% floor`);
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
    realRuns: realRuns.length,
    rogueRuns: rogueRuns.length,
    runsCorrect: correct,
    rogueDetected,
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
