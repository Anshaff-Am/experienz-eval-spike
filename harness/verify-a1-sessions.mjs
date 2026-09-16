#!/usr/bin/env node
/**
 * Gate A1 verifier — session_id + trace_user_id propagation.
 *
 * After sending 20 messages across 3 LibreChat conversations, run this script.
 * It queries Langfuse for traces in the last hour and checks:
 *   1. Every trace has a session_id (= LibreChat conversation ID)
 *   2. Every trace has a trace_user_id
 *   3. Exactly 3 distinct session_ids exist across 20 traces
 *
 * Env: LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_HOST
 * Run: node verify-a1-sessions.mjs
 */

const BASE = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
const PK = process.env.LANGFUSE_PUBLIC_KEY;
const SK = process.env.LANGFUSE_SECRET_KEY;

if (!PK || !SK) {
  console.error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
  process.exit(2);
}

const auth = Buffer.from(`${PK}:${SK}`).toString('base64');

async function fetchTraces({ limit = 50, fromTimestamp } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (fromTimestamp) params.set('fromTimestamp', fromTimestamp);

  const res = await fetch(`${BASE}/api/public/traces?${params}`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) throw new Error(`Langfuse API ${res.status}: ${await res.text()}`);
  return res.json();
}

const fromTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // last 1 hour
const { data: traces } = await fetchTraces({ limit: 50, fromTimestamp });

console.log(`\nFound ${traces.length} traces in the last hour.\n`);

if (traces.length === 0) {
  console.log('FAIL — no traces found. Is the stack running and Langfuse wired?');
  process.exit(1);
}

let missingSession = 0;
let missingUser = 0;
const sessions = new Set();

for (const t of traces) {
  if (!t.sessionId) missingSession++;
  else sessions.add(t.sessionId);
  if (!t.userId) missingUser++;
}

console.log(`Traces with session_id  : ${traces.length - missingSession}/${traces.length}`);
console.log(`Traces with trace_user_id: ${traces.length - missingUser}/${traces.length}`);
console.log(`Distinct sessions        : ${sessions.size}`);
console.log(`Session IDs              : ${[...sessions].join(', ')}`);

const pass =
  missingSession === 0 &&
  missingUser === 0 &&
  sessions.size === 3;

console.log(`\nA1 result: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);

if (missingSession > 0) console.log(`  ✗ ${missingSession} traces missing session_id`);
if (missingUser > 0) console.log(`  ✗ ${missingUser} traces missing trace_user_id`);
if (sessions.size !== 3) console.log(`  ✗ Expected 3 sessions, got ${sessions.size}`);

// Write result to /results
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const result = {
  gate: 'A1',
  runAt: new Date().toISOString(),
  traceCount: traces.length,
  missingSessionId: missingSession,
  missingUserId: missingUser,
  distinctSessions: sessions.size,
  sessionIds: [...sessions],
  pass
};

const outPath = join(HERE, '..', 'results', `A1-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\nResult written to ${outPath}`);

process.exit(pass ? 0 : 1);