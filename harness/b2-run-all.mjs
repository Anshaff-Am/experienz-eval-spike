/**
 * B2 Gate — Run all three checks and write combined result
 *
 * Check 1: Cube schema validates/compiles          → b2-cube-schema-validator.mjs
 * Check 2: DQ rules fire on bad / quiet on good    → b2-dq-rules-validator.mjs
 * Check 3: Certified metrics within tolerance      → b2-metric-reconciler.mjs
 *
 * Usage:  node harness/b2-run-all.mjs
 * Gate passes only if all three checks pass.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const checks = [
  { name: 'Cube schema validates',              script: 'harness/b2-cube-schema-validator.mjs', result: 'results/B2-cube-schema.json' },
  { name: 'DQ rules fire/quiet correctly',      script: 'harness/b2-dq-rules-validator.mjs',   result: 'results/B2-dq-rules.json'    },
  { name: 'Certified metrics within tolerance', script: 'harness/b2-metric-reconciler.mjs',    result: 'results/B2-metric-reconcile.json' },
];

console.log('\n╔══════════════════════════════════════════════╗');
console.log('║  B2 Gate — Deterministic artifact checks     ║');
console.log('╚══════════════════════════════════════════════╝\n');

const checkResults = [];

for (const check of checks) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`CHECK: ${check.name}`);
  console.log('═'.repeat(60));

  const proc = spawnSync('node', [check.script], { stdio: 'inherit', encoding: 'utf-8' });
  const passed = proc.status === 0;

  let detail = null;
  try { detail = JSON.parse(readFileSync(check.result, 'utf-8')); } catch {}

  checkResults.push({ name: check.name, script: check.script, pass: passed, detail });
}

const allPass = checkResults.every(c => c.pass);

console.log(`\n${'═'.repeat(60)}`);
console.log('B2 GATE SUMMARY');
console.log('═'.repeat(60));
for (const c of checkResults) {
  console.log(`  ${c.pass ? '✓' : '✗'}  ${c.name}`);
}
console.log(`\n  GATE: ${allPass ? 'PASS ✓' : 'FAIL ✗'}`);
console.log('═'.repeat(60) + '\n');

const output = {
  gate: 'B2',
  runAt: new Date().toISOString(),
  pass: allPass,
  checks: checkResults.map(c => ({
    name: c.name,
    script: c.script,
    pass: c.pass,
  })),
};

writeFileSync('results/B2-final.json', JSON.stringify(output, null, 2));
console.log('Saved: results/B2-final.json');

process.exit(allPass ? 0 : 1);
