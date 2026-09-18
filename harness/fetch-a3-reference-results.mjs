#!/usr/bin/env node
/**
 * Populates referenceResult for each in-scope question in track-a-silverstone.json
 * by calling the cube_query MCP tool directly (bypassing the agent).
 *
 * Writes the updated golden set back to the file.
 * Run once before A3 to establish ground truth.
 *
 * Env: ASK_AI_TOOLS_SECRET, ASK_AI_CLIENT (from llm-stack/.env)
 *   or set MCP_URL to override (default: http://localhost:8788/mcp)
 *
 * Run: node harness/fetch-a3-reference-results.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE   = dirname(fileURLToPath(import.meta.url));
const GS     = join(HERE, '..', 'golden-sets', 'track-a-silverstone.json');
const MCP    = process.env.MCP_URL || 'http://localhost:8788/mcp';
const SECRET = process.env.ASK_AI_TOOLS_SECRET || '';
const CLIENT = process.env.ASK_AI_CLIENT || 'silverstone';

let msgId = 1;

async function callMcp(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: msgId++, method, params });
  const res  = await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(SECRET ? { 'x-ask-ai-secret': SECRET } : {}),
      ...(CLIENT ? { 'x-ask-ai-client': CLIENT } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`MCP ${res.status}: ${await res.text()}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    // Streamable-HTTP: collect SSE events, pick last result
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines.reverse()) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
    throw new Error('No parseable SSE result');
  }
  return res.json();
}

async function cubeQuery(query) {
  // MCP tools/call
  const resp = await callMcp('tools/call', {
    name: 'cube_query',
    arguments: query,
  });
  // resp.result.content[0].text or resp.result
  const content = resp?.result?.content ?? resp?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text') {
        try { return JSON.parse(c.text); } catch { return c.text; }
      }
    }
  }
  return resp?.result ?? resp;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const gs = JSON.parse(readFileSync(GS, 'utf8'));
const inScope = gs.questions.filter(q => q.scope === 'in' && q.referenceQuery);

console.log(`\nFetching reference results for ${inScope.length} in-scope questions…`);
console.log(`MCP endpoint: ${MCP}  client: ${CLIENT}\n`);

// First, check MCP reachable
try {
  await callMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'a3-fetcher', version: '1.0' }
  });
  console.log('MCP server reachable ✓\n');
} catch (e) {
  console.error(`MCP server not reachable at ${MCP}: ${e.message}`);
  console.error('Is the stack running? docker compose up -d');
  process.exit(1);
}

let passed = 0;
let failed  = 0;

for (const q of inScope) {
  process.stdout.write(`${q.id}  ${q.question.slice(0, 60)}… `);
  try {
    const result = await cubeQuery(q.referenceQuery);
    // Store compact version: array of row objects, or the raw result
    q.referenceResult = result;
    q.verified = false; // human must still sanity-check the numbers
    q.fetchedAt = new Date().toISOString();
    console.log('✓');
    passed++;
  } catch (e) {
    console.log(`✗ ERROR: ${e.message.slice(0, 80)}`);
    q.referenceResult = null;
    q.fetchError = e.message.slice(0, 200);
    failed++;
  }
  await sleep(300); // rate limit buffer
}

gs._meta.resultsLastFetched = new Date().toISOString();
gs._meta.verified = false;
gs._meta.note += `\nResults fetched ${new Date().toISOString()} — UNVERIFIED. Human must check numbers before A3 gates.`;

writeFileSync(GS, JSON.stringify(gs, null, 2));
console.log(`\n✓ ${passed} fetched   ✗ ${failed} failed`);
console.log(`Updated: ${GS}`);
console.log('\nNEXT: human spot-check ≥5 results, then run verify-a3-golden-set.mjs');
process.exit(failed > 0 ? 1 : 0);
