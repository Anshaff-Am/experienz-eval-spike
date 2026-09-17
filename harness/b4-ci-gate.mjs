/**
 * B4 Gate — CI eval gate
 *
 * Two-tier gate for the deploy pipeline:
 *   Tier 1 (hard): B2 deterministic checks — schema compile, DQ rules, metric reconciliation
 *   Tier 2 (threshold): B3 trajectory match — aggregated at suite level, never per-run
 *
 * Exit 0 = both tiers pass → deploy proceeds
 * Exit 1 = any tier fails → deploy blocked
 *
 * Usage:
 *   node harness/b4-ci-gate.mjs [--schema-dir <path>] [--client <name>]
 *
 * In buildspec pre_build:
 *   aws s3 sync s3://experienz-cloud-operations/cubes/${CLIENT}/ /tmp/cube-schema/
 *   node harness/b4-ci-gate.mjs --schema-dir /tmp/cube-schema --client ${CLIENT}
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv;
const getArg = (flag) => args.find((a, i) => args[i - 1] === flag);

const SCHEMA_DIR = getArg('--schema-dir') ?? null;
const CLIENT     = getArg('--client') ?? 'amf1';
const OUT_FILE   = resolve('results/B4-ci-gate.json');

function runCheck(label, script, extraArgs = []) {
  const nodeArgs = [script, ...extraArgs];
  const proc = spawnSync('node', nodeArgs, { stdio: 'inherit', encoding: 'utf-8' });
  const pass = proc.status === 0;
  console.log(`\n  ${pass ? '✓' : '✗'}  ${label}  →  ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  B4 CI Gate — Eval gate for deploy pipeline          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\n  Schema dir: ${SCHEMA_DIR ?? '(default)'}`);
  console.log(`  Client:     ${CLIENT}`);
  console.log(`  Time:       ${new Date().toISOString()}`);

  const schemaArgs = SCHEMA_DIR
    ? ['--schema-dir', SCHEMA_DIR, '--client', CLIENT]
    : ['--client', CLIENT];

  console.log('\n── TIER 1: Deterministic checks (hard gates) ──────────\n');

  const schemaPass  = runCheck('Cube schema validates/compiles',           'harness/b2-cube-schema-validator.mjs', schemaArgs);
  const dqPass      = runCheck('DQ rules fire on bad / quiet on good',     'harness/b2-dq-rules-validator.mjs');
  const reconcPass  = runCheck('Certified metrics within tolerance',       'harness/b2-metric-reconciler.mjs');

  const tier1Pass = schemaPass && dqPass && reconcPass;

  console.log('\n── TIER 2: Trajectory match (threshold gate) ──────────\n');

  const trajPass = runCheck('Agent trajectory match ≥80%', 'harness/b3-trajectory-matcher.mjs');

  const gatePass = tier1Pass && trajPass;

  console.log('\n══════════════════════════════════════════════════════');
  console.log('B4 GATE SUMMARY');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Tier 1 — deterministic: ${tier1Pass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`    Schema compile:       ${schemaPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`    DQ rules:             ${dqPass     ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`    Metric reconcile:     ${reconcPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  Tier 2 — trajectory:   ${trajPass   ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`\n  GATE: ${gatePass ? 'PASS ✓ — deploy proceeds' : 'FAIL ✗ — deploy blocked'}`);
  console.log('══════════════════════════════════════════════════════\n');

  const output = {
    gate: 'B4',
    runAt: new Date().toISOString(),
    schemaDir: SCHEMA_DIR,
    client: CLIENT,
    pass: gatePass,
    tiers: {
      tier1: {
        name: 'deterministic',
        pass: tier1Pass,
        checks: { schemaCompile: schemaPass, dqRules: dqPass, metricReconcile: reconcPass },
      },
      tier2: {
        name: 'trajectory',
        pass: trajPass,
      },
    },
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Saved: ${OUT_FILE}`);

  process.exit(gatePass ? 0 : 1);
}

main();
