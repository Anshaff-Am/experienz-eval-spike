/**
 * B2 Gate — Check #2: DQ rules fire on known-bad fixture, stay quiet on known-good
 *
 * Reads a silver-validator output JSON and asserts every hard check passed.
 * Run against both a known-good fixture (must pass) and a known-bad fixture
 * (must fail) to prove the gate works in both directions.
 *
 * Usage:
 *   node harness/b2-dq-rules-validator.mjs
 *   node harness/b2-dq-rules-validator.mjs --fixture <path>   (single fixture)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const GOOD_FIXTURE = resolve('golden-sets/b2-fixtures/silver-validation-good.json');
const BAD_FIXTURE  = resolve('golden-sets/b2-fixtures/silver-validation-bad.json');
const OUT_FILE     = resolve('results/B2-dq-rules.json');

function validateSilverOutput(filePath, label) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const hardChecks = (raw.findings ?? []).filter(f => f.hard === true);
  const failed     = hardChecks.filter(f => f.status !== 'pass');
  const passed     = hardChecks.filter(f => f.status === 'pass');
  const gatePass   = failed.length === 0;

  return {
    label,
    filePath,
    validatorStatus: raw.status,
    checksTotal:  hardChecks.length,
    checksPassed: passed.length,
    checksFailed: failed.length,
    gatePass,
    failures: failed.map(f => ({ check: f.check, detail: f.detail })),
    checks: hardChecks.map(f => ({ check: f.check, status: f.status, detail: f.detail })),
  };
}

function runFixture(filePath, label, expectPass) {
  const result = validateSilverOutput(filePath, label);
  const behaviourCorrect = result.gatePass === expectPass;

  console.log(`\n  [${label}]`);
  console.log(`  File:           ${filePath}`);
  console.log(`  Hard checks:    ${result.checksTotal}  pass=${result.checksPassed}  fail=${result.checksFailed}`);
  console.log(`  Gate outcome:   ${result.gatePass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  Expected:       ${expectPass ? 'PASS' : 'FAIL'}  →  behaviour ${behaviourCorrect ? 'CORRECT ✓' : 'WRONG ✗'}`);

  if (result.failures.length) {
    for (const f of result.failures) console.log(`    ✗ ${f.check}: ${f.detail}`);
  }

  return { ...result, expectPass, behaviourCorrect };
}

function main() {
  console.log('\nB2 Check #2 — DQ rules (Silver validation hard gates)');
  console.log('─'.repeat(60));

  const goodResult = runFixture(GOOD_FIXTURE, 'known-good (real run)', true);
  const badResult  = runFixture(BAD_FIXTURE,  'known-bad  (fixture)', false);

  const bothCorrect = goodResult.behaviourCorrect && badResult.behaviourCorrect;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`known-good stays quiet: ${goodResult.behaviourCorrect ? 'YES ✓' : 'NO ✗'}`);
  console.log(`known-bad  fires:       ${badResult.behaviourCorrect  ? 'YES ✓' : 'NO ✗'}`);
  console.log(`Gate:                   ${bothCorrect ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('─'.repeat(60));

  const output = {
    gate: 'B2-check2-dq-rules',
    runAt: new Date().toISOString(),
    pass: bothCorrect,
    summary: {
      goodFixtureQuiet: goodResult.behaviourCorrect,
      badFixtureFires:  badResult.behaviourCorrect,
    },
    fixtures: { good: goodResult, bad: badResult },
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${OUT_FILE}`);

  process.exit(bothCorrect ? 0 : 1);
}

main();
