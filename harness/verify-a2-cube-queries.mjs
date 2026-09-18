#!/usr/bin/env node
/**
 * Gate A2 verifier — cube_query extraction from Langfuse traces.
 *
 * For each GENERATION span in recent traces, extracts tool_calls from the
 * AIMessageChunk output (kwargs.tool_calls). Checks whether any cube_query
 * tool call has structured, extractable JSON args with at least one of:
 * measures, dimensions, filters, timeDimensions.
 *
 * Pass bar: ≥95% of cube_query calls have extractable structured args.
 * Exit 2 if no cube_query calls found (needs re-test with data questions).
 *
 * Rate-limit aware: uses only 2 API calls (traces list + per-trace detail one at a time
 * with 400ms backoff). Stays within Langfuse Hobby tier (15 req/min).
 *
 * Env: LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_HOST
 * Run: node verify-a2-cube-queries.mjs
 */

const BASE = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
const PK   = process.env.LANGFUSE_PUBLIC_KEY;
const SK   = process.env.LANGFUSE_SECRET_KEY;

if (!PK || !SK) { console.error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY'); process.exit(2); }

const auth = Buffer.from(`${PK}:${SK}`).toString('base64');

async function api(path, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${BASE}/api/public/${path}`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = (body.details?.retryAfterSeconds ?? 15) * 1000 + 500;
      console.log(`  Rate limited — waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Langfuse ${res.status} ${path}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`Failed after ${retries} retries: ${path}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CUBE_KEYS = ['measures', 'dimensions', 'filters', 'timeDimensions', 'segments', 'limit', 'order'];

function isStructuredCubeQuery(args) {
  if (!args || typeof args !== 'object') return false;
  return CUBE_KEYS.some(k => Array.isArray(args[k]) || (args[k] && typeof args[k] === 'object'));
}

function extractToolCalls(obsOutput) {
  if (!obsOutput) return [];
  // LangChain AIMessageChunk: output.kwargs.tool_calls or output.kwargs.additional_kwargs.tool_calls
  const kwargs = obsOutput?.kwargs ?? obsOutput;
  return kwargs?.tool_calls ?? kwargs?.additional_kwargs?.tool_calls ?? [];
}

const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const { data: traces } = await api(`traces?limit=30&fromTimestamp=${encodeURIComponent(from)}`);
console.log(`\nTraces found (last 2h): ${traces.length}`);

let cubeQueryTotal = 0;
let cubeQueryStructured = 0;
let cubeQueryUnstructured = 0;
let allToolCalls = {};  // name → count
const detail = [];

for (const t of traces) {
  await sleep(450); // stay well under 15 req/min
  const full = await api(`traces/${t.id}`);

  for (const o of (full.observations ?? [])) {
    if (o.type !== 'GENERATION') continue;
    const toolCalls = extractToolCalls(o.output);

    for (const tc of toolCalls) {
      const name = tc.name ?? tc.function?.name ?? 'unknown';
      allToolCalls[name] = (allToolCalls[name] ?? 0) + 1;

      // Normalize: cube_query_mcp_* or cube_query
      if (!name.toLowerCase().includes('cube_query')) continue;

      cubeQueryTotal++;
      let args = tc.args ?? tc.function?.arguments ?? tc.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }

      const structured = isStructuredCubeQuery(typeof args === 'string' ? null : args);
      if (structured) {
        cubeQueryStructured++;
        detail.push({ traceId: t.id.slice(0,8), name, structured: true,
          measures: args.measures?.length ?? 0, dims: args.dimensions?.length ?? 0,
          filters: args.filters?.length ?? 0, args: JSON.stringify(args).slice(0, 300) });
      } else {
        cubeQueryUnstructured++;
        detail.push({ traceId: t.id.slice(0,8), name, structured: false,
          raw: JSON.stringify(args).slice(0, 200) });
      }
    }
  }
}

console.log('\n=== A2 — cube_query extraction ===\n');
console.log(`All tool calls observed:`);
for (const [n, c] of Object.entries(allToolCalls).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${c}×  ${n}`);
}

console.log(`\ncube_query calls total : ${cubeQueryTotal}`);
console.log(`  Structured JSON      : ${cubeQueryStructured}`);
console.log(`  Unstructured / prose : ${cubeQueryUnstructured}`);

const rate = cubeQueryTotal > 0 ? (cubeQueryStructured / cubeQueryTotal * 100).toFixed(1) : 'N/A';
console.log(`Extraction rate        : ${rate}%  (bar: ≥95%)`);

if (cubeQueryTotal > 0) {
  console.log('\n--- cube_query detail ---');
  for (const d of detail) {
    if (d.structured) {
      console.log(`  [✓] trace=${d.traceId}  tool=${d.name}  measures=${d.measures}  dims=${d.dims}  filters=${d.filters}`);
      console.log(`      args=${d.args}`);
    } else {
      console.log(`  [✗] trace=${d.traceId}  raw=${d.raw}`);
    }
  }
}

if (cubeQueryTotal === 0) {
  console.log('\n⚠  No cube_query calls in recent traces.');
  console.log('   Questions answered via kb_query / form_query / form_meta.');
  console.log('   Send a data question that requires Cube (e.g. "What were total Scope 1 emissions in 2024?")');
  console.log('   then re-run.');
}

const pass = cubeQueryTotal > 0 && (cubeQueryStructured / cubeQueryTotal) >= 0.95;
console.log(`\nA2 result: ${pass ? 'PASS ✓' : cubeQueryTotal === 0 ? 'NO DATA — needs cube_query prompts' : 'FAIL ✗'}`);

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const result = {
  gate: 'A2', runAt: new Date().toISOString(),
  tracesTotal: traces.length,
  allToolCalls, cubeQueryTotal, cubeQueryStructured, cubeQueryUnstructured,
  extractionRatePct: cubeQueryTotal > 0 ? +(cubeQueryStructured / cubeQueryTotal * 100).toFixed(1) : null,
  pass, detail
};
const outPath = join(HERE, '..', 'results', `A2-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\nResult written to ${outPath}`);
process.exit(pass ? 0 : (cubeQueryTotal === 0 ? 2 : 1));
