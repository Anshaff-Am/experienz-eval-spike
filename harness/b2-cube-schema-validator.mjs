/**
 * B2 Gate — Check #1: Cube schema validates and compiles
 *
 * Reads .js schema files from a local directory (pre-downloaded from S3)
 * and validates each by executing in a Cube.js-compatible VM sandbox.
 * Emits per-file pass/fail and suite-level numbers.
 *
 * Usage:
 *   node harness/b2-cube-schema-validator.mjs [--schema-dir <path>] [--client <name>]
 *
 * Download schema first:
 *   aws s3 sync s3://experienz-cloud-operations/cubes/astonmartinf1/ <schema-dir>
 */

import vm from 'vm';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

const args = process.argv;
const getArg = (flag) => args.find((a, i) => args[i - 1] === flag);

const CLIENT = getArg('--client') ?? 'astonmartinf1';
const SCHEMA_DIR = getArg('--schema-dir') ??
  String.raw`C:\Users\aameer\AppData\Local\Temp\claude\c--Users-aameer-Documents-Experienz-Dev-Repos\42c0ef3d-7b0c-4294-9180-d31feb443b6c\scratchpad\amf1-schema`;
const OUT_FILE = resolve('results/B2-cube-schema.json');

function validateSchema(filePath, source) {
  const cubes = [];
  const views = [];
  const errors = [];
  const warnings = [];

  // Cube.js DSL stubs — mirror what the real runtime provides
  const cubeFn = (name, def) => {
    if (!name || typeof name !== 'string') {
      errors.push(`cube() called with invalid name: ${JSON.stringify(name)}`);
      return;
    }
    const issues = [];
    if (!def || typeof def !== 'object') {
      issues.push('definition object missing');
    } else {
      if (!def.sql && !def.sqlTable && !def.extends) {
        issues.push('no sql / sqlTable / extends — cube has no data source');
      }
      if (!def.measures && !def.dimensions && !def.extends) {
        issues.push('no measures or dimensions defined');
      }
    }
    if (issues.length) warnings.push(`${name}: ${issues.join('; ')}`);
    cubes.push(name);
  };

  // __trino stubs — used by trino_partner_sources.js to get catalog/schema names
  const trinoStubs = {
    getTrinoPostgresCatalog: () => 'trino_postgres',
    getTrinoPostgresSchema: () => CLIENT,
    getTrinoHiveCatalog: () => 'hive',
    getTrinoHiveSchema: () => CLIENT,
    getTrinoHiveVersion: () => 'v1',
  };

  const context = vm.createContext({
    cube: cubeFn,
    view: (name) => views.push(name),
    // Cube.js magic globals injected at compile time
    COMPILE_CONTEXT: {
      securityContext: { client_name: CLIENT, clientName: CLIENT }
    },
    // CUBE = self-reference variable used in sql expressions: `${CUBE}."column"`
    CUBE: `"${CLIENT}"`,
    // __trino helpers accessed via globalThis in trino_partner_sources.js
    getTrinoPostgresCatalog: trinoStubs.getTrinoPostgresCatalog,
    getTrinoPostgresSchema: trinoStubs.getTrinoPostgresSchema,
    getTrinoHiveCatalog: trinoStubs.getTrinoHiveCatalog,
    getTrinoHiveSchema: trinoStubs.getTrinoHiveSchema,
    getTrinoHiveVersion: trinoStubs.getTrinoHiveVersion,
    // process.env used by some schema files
    process: { env: { CLIENT_NAME: CLIENT, NODE_ENV: 'production', STAGE: 'prod' } },
    // Suppress any schema-file console output
    console: { log: () => {}, warn: () => {}, error: () => {} },
  });

  try {
    vm.runInContext(source, context, {
      filename: filePath,
      timeout: 5000,
      displayErrors: true,
    });
  } catch (e) {
    errors.push(e.message);
  }

  return {
    file: filePath.split(/[\\/]/).pop(),
    cubes,
    views,
    errors,
    warnings,
    pass: errors.length === 0,
  };
}

function main() {
  console.log(`\nB2 Check #1 — Cube schema validation`);
  console.log(`Client:     ${CLIENT}`);
  console.log(`Schema dir: ${SCHEMA_DIR}\n`);

  const files = readdirSync(SCHEMA_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    console.error('No .js files found in schema dir. Download first:');
    console.error(`  aws s3 sync s3://experienz-cloud-operations/cubes/${CLIENT}/ <schema-dir>`);
    process.exit(1);
  }

  console.log(`Found ${files.length} schema files\n`);

  const results = [];
  for (const file of files) {
    const filePath = join(SCHEMA_DIR, file);
    const source = readFileSync(filePath, 'utf-8');
    const result = validateSchema(filePath, source);
    results.push(result);

    const status = result.pass ? 'PASS' : 'FAIL';
    const cubeList = result.cubes.length ? `cubes=[${result.cubes.join(', ')}]` : '(no cubes defined)';
    console.log(`  ${result.file.padEnd(48)} ${status}  ${cubeList}`);
    for (const e of result.errors)   console.log(`        ✗ ERROR:   ${e}`);
    for (const w of result.warnings) console.log(`        ⚠ WARN:    ${w}`);
  }

  const passing = results.filter(r => r.pass).length;
  const failing = results.filter(r => !r.pass).length;
  const allCubes = results.flatMap(r => r.cubes);
  const gatePass = failing === 0;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Files:   ${results.length}  |  Pass: ${passing}  |  Fail: ${failing}`);
  console.log(`Cubes:   ${allCubes.length} — [${allCubes.join(', ')}]`);
  console.log(`Gate:    ${gatePass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`${'─'.repeat(70)}\n`);

  const output = {
    gate: 'B2-check1-cube-schema',
    runAt: new Date().toISOString(),
    client: CLIENT,
    schemaDir: SCHEMA_DIR,
    pass: gatePass,
    summary: {
      filesTotal: results.length,
      filesPassing: passing,
      filesFailing: failing,
      cubesFound: allCubes.length,
      cubeNames: allCubes,
    },
    files: results,
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Saved: ${OUT_FILE}`);

  process.exit(gatePass ? 0 : 1);
}

main();
