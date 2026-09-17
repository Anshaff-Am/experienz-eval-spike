/**
 * B4 Gate — Local proof-of-concept
 *
 * Proves the two-tier gate works correctly without a live CodeBuild run:
 *
 *   Case A (BROKEN):  gate run against golden-sets/b4-fixtures/ (broken schema)
 *                     Expected: exit 1 — deploy would be BLOCKED
 *
 *   Case B (GOOD):    gate run against real amf1 schema dir
 *                     Expected: exit 0 — deploy would PROCEED
 *
 * Usage:
 *   node harness/b4-prove-it.mjs [--schema-dir <real-schema-path>] [--client <name>]
 *
 * If --schema-dir not provided, skips Case B (good schema requires local S3 download).
 */

import { spawnSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const args     = process.argv;
const getArg   = (flag) => args.find((a, i) => args[i - 1] === flag);
const SCHEMA_DIR = getArg('--schema-dir') ?? null;
const CLIENT     = getArg('--client') ?? 'amf1';
const OUT_FILE   = resolve('results/B4-final.json');

const BROKEN_DIR = resolve('golden-sets/b4-fixtures');
const GATE       = 'harness/b4-ci-gate.mjs';

function runGate(label, schemaDir, expectPass) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`CASE: ${label}`);
  console.log(`Schema dir: ${schemaDir}`);
  console.log(`Expected:   ${expectPass ? 'PASS (deploy proceeds)' : 'FAIL (deploy blocked)'}`);
  console.log('═'.repeat(60));

  const gateArgs = ['--schema-dir', schemaDir, '--client', CLIENT];
  const proc = spawnSync('node', [GATE, ...gateArgs], { stdio: 'inherit', encoding: 'utf-8' });
  const passed = proc.status === 0;
  const correct = passed === expectPass;

  console.log(`\nGate exit code: ${proc.status}  →  ${passed ? 'PASS' : 'FAIL'}`);
  console.log(`Behaviour: ${correct ? 'CORRECT ✓' : 'WRONG ✗  ← investigate'}`);

  return { label, schemaDir, expectPass, passed, correct };
}

function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  B4 Proof-of-Concept — Local CI gate demonstration      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nTime: ${new Date().toISOString()}`);

  const results = [];

  // Case A — broken schema must block
  results.push(runGate(
    'BROKEN schema → gate must block (exit 1)',
    BROKEN_DIR,
    false
  ));

  // Case B — good schema must pass (only if schema dir provided)
  if (SCHEMA_DIR) {
    if (!existsSync(SCHEMA_DIR)) {
      console.log(`\nSkipping Case B — schema dir not found: ${SCHEMA_DIR}`);
      console.log('Download first: aws s3 sync s3://experienz-cloud-operations/cubes/amf1/ <schema-dir>');
    } else {
      results.push(runGate(
        'GOOD schema → gate must pass (exit 0)',
        SCHEMA_DIR,
        true
      ));
    }
  } else {
    console.log('\nSkipping Case B (no --schema-dir provided).');
    console.log('To run both cases:');
    console.log('  aws s3 sync s3://experienz-cloud-operations/cubes/amf1/ /tmp/amf1-schema/');
    console.log('  node harness/b4-prove-it.mjs --schema-dir /tmp/amf1-schema --client amf1');
  }

  const allCorrect = results.every(r => r.correct);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('PROOF SUMMARY');
  console.log('═'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.correct ? '✓' : '✗'}  ${r.label}`);
  }
  console.log(`\n  Proof: ${allCorrect ? 'COMPLETE ✓' : 'INCOMPLETE ✗'}`);
  if (results.length < 2) {
    console.log('  Note: Only Case A run. Run with --schema-dir to complete Case B.');
  }
  console.log('═'.repeat(60));

  const output = {
    gate: 'B4',
    runAt: new Date().toISOString(),
    proofComplete: allCorrect && results.length === 2,
    cases: results,
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${OUT_FILE}`);

  process.exit(allCorrect ? 0 : 1);
}

main();
