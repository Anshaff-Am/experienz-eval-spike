#!/usr/bin/env node
/**
 * Gate A3 verifier — 40-question golden set against Silverstone ESG agent.
 *
 * For each question:
 *   - In-scope: sends to LibreChat, captures cube_query from Langfuse trace,
 *     compares result set against reference (order-insensitive, ±0.5 tCO2e tolerance).
 *   - Out-of-scope: sends to LibreChat, checks agent did NOT call cube_query
 *     (silent wrong answer = cube_query called on out-of-scope = CRITICAL failure).
 *
 * Pass bars:
 *   - In-scope accuracy ≥90% (27/30)
 *   - Silent wrong-answer rate on out-of-scope <2% (max 0/10 cube_query calls)
 *   - Runtime <15 min unattended
 *
 * Prereqs:
 *   1. Stack running: docker compose up -d
 *   2. Reference results populated: node harness/fetch-a3-reference-results.mjs
 *   3. Agent configured in LibreChat with MCP tools
 *   4. Env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST,
 *           LIBRECHAT_URL (default http://localhost:3080),
 *           LIBRECHAT_EMAIL, LIBRECHAT_PASSWORD, LIBRECHAT_AGENT_ID
 *
 * Run: node harness/verify-a3-golden-set.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const GS   = join(HERE, '..', 'golden-sets', 'track-a-silverstone.json');

// ── Config ──────────────────────────────────────────────────────────────────

const LC_URL     = process.env.LIBRECHAT_URL      || 'http://localhost:3080';
const LC_EMAIL   = process.env.LIBRECHAT_EMAIL;
const LC_PASS    = process.env.LIBRECHAT_PASSWORD;
const AGENT_ID   = process.env.LIBRECHAT_AGENT_ID;

const LF_BASE = process.env.LANGFUSE_HOST         || 'https://cloud.langfuse.com';
const LF_PK   = process.env.LANGFUSE_PUBLIC_KEY;
const LF_SK   = process.env.LANGFUSE_SECRET_KEY;

// Tolerances
const FLOAT_TOL   = 0.5;   // tCO2e tolerance for numeric comparison
const TRACE_WAIT  = 45000; // ms total to poll Langfuse after SSE drain
const TRACE_POLLS = 9;     // 9 polls × 5s each = 45s window

// ── Validation ───────────────────────────────────────────────────────────────

const missing = [];
if (!LC_EMAIL)  missing.push('LIBRECHAT_EMAIL');
if (!LC_PASS)   missing.push('LIBRECHAT_PASSWORD');
if (!AGENT_ID)  missing.push('LIBRECHAT_AGENT_ID');
if (!LF_PK)     missing.push('LANGFUSE_PUBLIC_KEY');
if (!LF_SK)     missing.push('LANGFUSE_SECRET_KEY');
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  console.error('Set in llm-stack/.env and source before running.');
  process.exit(2);
}

const gs = JSON.parse(readFileSync(GS, 'utf8'));
const inScopeQ  = gs.questions.filter(q => q.scope === 'in');
const outScopeQ = gs.questions.filter(q => q.scope === 'out');

const unverified = inScopeQ.filter(q => !q.referenceResult);
if (unverified.length > 0) {
  console.error(`${unverified.length} in-scope questions have no referenceResult.`);
  console.error('Run: node harness/fetch-a3-reference-results.mjs first.');
  process.exit(2);
}

// ── LibreChat client ──────────────────────────────────────────────────────────

// LibreChat's uaParser middleware rejects non-browser User-Agents
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function lcHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function lcPost(path, body, token) {
  const res = await fetch(`${LC_URL}${path}`, {
    method: 'POST',
    headers: lcHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LibreChat ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  // Endpoint returns SSE stream — read and discard; just need the request sent
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('event-stream')) {
    await res.text(); // drain
    return {};
  }
  return res.json().catch(() => ({}));
}

async function login() {
  const res = await fetch(`${LC_URL}/api/auth/login`, {
    method: 'POST',
    headers: lcHeaders(),
    body: JSON.stringify({ email: LC_EMAIL, password: LC_PASS }),
  });
  if (!res.ok) throw new Error(`Login failed ${res.status}: ${await res.text()}`);
  const { token } = await res.json();
  if (!token) throw new Error('Login: no token in response');
  return token;
}

// Mutable token holder — refreshed on 401
let _token = null;
async function getToken() {
  if (!_token) _token = await login();
  return _token;
}
async function resetToken() {
  console.log('\n  [auth] JWT expired — re-logging in…');
  _token = await login();
  return _token;
}

// Send a message to the agent — fires and forgets the SSE stream.
// Auto-retries once on 401 with a fresh token.
async function sendMessage(question) {
  const sentAt  = new Date().toISOString();
  const convoId = crypto.randomUUID();
  const parentId = '00000000-0000-0000-0000-000000000000';

  const payload = {
    text: question,
    endpoint: 'agents',
    model: AGENT_ID,
    agent_id: AGENT_ID,
    conversationId: convoId,
    parentMessageId: parentId,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await getToken();
    const res = await fetch(`${LC_URL}/api/agents/chat`, {
      method: 'POST',
      headers: lcHeaders(tok),
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      await resetToken();
      continue; // retry with fresh token
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LibreChat ${res.status} /api/agents/chat: ${text.slice(0, 200)}`);
    }
    // Drain the SSE stream so the agent fully runs before we poll Langfuse
    await res.text();
    return { conversationId: convoId, sentAt };
  }
  throw new Error('sendMessage: failed after token refresh');
}

// ── Langfuse client ────────────────────────────────────────────────────────────

const lfAuth = Buffer.from(`${LF_PK}:${LF_SK}`).toString('base64');

async function lfApi(path, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${LF_BASE}/api/public/${path}`, {
      headers: { Authorization: `Basic ${lfAuth}` }
    });
    if (res.status === 429) {
      const b = await res.json().catch(() => ({}));
      const wait = (b.details?.retryAfterSeconds ?? 15) * 1000 + 500;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Langfuse ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

function extractToolCalls(obsOutput) {
  if (!obsOutput) return [];
  const kwargs = obsOutput?.kwargs ?? obsOutput;
  return kwargs?.tool_calls ?? kwargs?.additional_kwargs?.tool_calls ?? [];
}

// Poll Langfuse for a trace by session_id, extract cube_query calls.
// Falls back to most-recent trace in the window if session_id doesn't match
// (in case LibreChat overwrote the conversationId internally).
async function waitForTrace(sessionId, questionSentAt, timeoutMs = TRACE_WAIT) {
  const interval = timeoutMs / TRACE_POLLS; // ~5s per poll
  // Lookback from 10s before the question was sent (SSE drains after agent done)
  const from = new Date(new Date(questionSentAt).getTime() - 10000).toISOString();

  for (let poll = 0; poll < TRACE_POLLS; poll++) {
    // Always wait before polling — gives Langfuse ingestion time
    await new Promise(r => setTimeout(r, interval));
    try {
      const { data: traces } = await lfApi(`traces?limit=10&fromTimestamp=${encodeURIComponent(from)}`);
      if (!traces?.length) continue;

      // Prefer exact session_id match
      let match = traces.find(t => t.sessionId === sessionId);
      // Fall back to most recent trace in window (LibreChat may generate its own ID)
      if (!match) match = traces[0];
      if (!match) continue;

      await new Promise(r => setTimeout(r, 500));
      const full = await lfApi(`traces/${match.id}`);
      const cubeQueryCalls = [];
      for (const o of (full.observations ?? [])) {
        if (o.type !== 'GENERATION') continue;
        for (const tc of extractToolCalls(o.output)) {
          const name = tc.name ?? tc.function?.name ?? '';
          if (!name.toLowerCase().includes('cube_query')) continue;
          let args = tc.args ?? tc.function?.arguments ?? tc.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
          cubeQueryCalls.push({ name, args });
        }
      }
      if (cubeQueryCalls.length > 0 || poll >= TRACE_POLLS - 1) {
        return { traceId: match.id, cubeQueryCalls, sessionMatch: match.sessionId === sessionId };
      }
      // Found a trace but no cube_query yet — keep polling (agent may still be running)
    } catch {}
  }
  return { traceId: null, cubeQueryCalls: [], sessionMatch: false };
}

// ── Result-set comparison ──────────────────────────────────────────────────────

// MCP wraps Cube response: {data: {rows: [...], rowCount: N, ...}}
// Handles multiple shapes: raw array, {data: array}, {data: {rows: array}}, {rows: array}
function extractRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;           // standard Cube REST
  if (Array.isArray(result?.data?.rows)) return result.data.rows; // this MCP wrapper
  if (Array.isArray(result?.rows)) return result.rows;
  return null;
}

// Parse a value to number if it looks numeric, else keep as string
function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? v : n;
  }
  return v;
}

// Normalize a result row to a stable string key for set comparison
function rowKey(row) {
  return Object.entries(row)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const n = toNum(v);
      return `${k}=${typeof n === 'number' ? n.toFixed(2) : n}`;
    })
    .join('|');
}

// Compare two result sets: order-insensitive, numeric tolerance FLOAT_TOL.
// Accepts raw result objects (extracts rows internally).
function compareResultSets(actualResult, refResult) {
  const actual = extractRows(actualResult);
  const reference = extractRows(refResult);

  if (!Array.isArray(actual) || !Array.isArray(reference)) {
    return { match: false, reason: `not arrays (actual=${JSON.stringify(actualResult).slice(0,80)}, ref=${JSON.stringify(refResult).slice(0,80)})` };
  }
  if (actual.length !== reference.length) {
    return { match: false, reason: `row count: actual=${actual.length} ref=${reference.length}` };
  }

  // Sort both by row key, then compare element-wise with tolerance
  const sortRows = (rows) => [...rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  const sa = sortRows(actual);
  const sr = sortRows(reference);

  for (let i = 0; i < sa.length; i++) {
    const ar = sa[i], rr = sr[i];
    // Compare only keys present in REFERENCE rows — agent may add extra dimensions
    for (const key of Object.keys(rr)) {
      const av = toNum(ar[key]), rv = toNum(rr[key]);
      if (typeof av === 'number' && typeof rv === 'number') {
        if (Math.abs(av - rv) > FLOAT_TOL) {
          return { match: false, reason: `row ${i} key=${key} actual=${av} ref=${rv} delta=${Math.abs(av-rv).toFixed(3)}` };
        }
      } else if (String(av) !== String(rv)) {
        return { match: false, reason: `row ${i} key=${key} actual=${av} ref=${rv}` };
      }
    }
  }
  return { match: true };
}

// Extract actual result from cube_query call (calls the live tool)
// For A3 we compare the tool result, not the agent prose
async function fetchActualResult(cubeQuery) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(SECRET ? { 'x-ask-ai-secret': SECRET } : {}),
      ...(CLIENT ? { 'x-ask-ai-client': CLIENT } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'cube_query', arguments: cubeQuery } })
  });
  if (!res.ok) {
    const errText = await res.text();
    process.stderr.write(`\n  [fetchActualResult] MCP ${res.status}: ${errText.slice(0,120)}\n`);
    return null;
  }
  const ct = res.headers.get('content-type') ?? '';
  let data;
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    for (const l of lines.reverse()) { try { data = JSON.parse(l.slice(6)); break; } catch {} }
  } else {
    data = await res.json();
  }
  const content = data?.result?.content ?? data?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text') {
        try { return JSON.parse(c.text); } catch { return c.text; }
      }
    }
  }
  // Debug: show unexpected shape
  if (!data?.result?.content && !Array.isArray(data?.data)) {
    process.stderr.write(`\n  [fetchActualResult] unexpected shape: ${JSON.stringify(data).slice(0,200)}\n`);
  }
  return data?.result ?? data;
}

// ── MCP init ──────────────────────────────────────────────────────────────────

const MCP_URL = process.env.MCP_URL || 'http://localhost:8788/mcp';
const SECRET  = process.env.ASK_AI_TOOLS_SECRET || '';
const CLIENT  = process.env.ASK_AI_CLIENT || 'silverstone';

async function mcpInit() {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(SECRET ? { 'x-ask-ai-secret': SECRET } : {}),
      ...(CLIENT ? { 'x-ask-ai-client': CLIENT } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'a3-harness', version: '1.0' }
    }}),
  });
  if (!res.ok) throw new Error(`MCP init failed ${res.status}: ${await res.text()}`);
}

// ── Main run ──────────────────────────────────────────────────────────────────

const startTime = Date.now();
console.log(`\n=== A3 Golden Set — ${gs.questions.length} questions ===`);
console.log(`In-scope: ${inScopeQ.length}  Out-of-scope: ${outScopeQ.length}\n`);

// Verify MCP reachable
try {
  await mcpInit();
  console.log(`MCP server ✓ (${MCP_URL})`);
} catch (e) {
  console.error(`MCP server not reachable: ${e.message}`);
  console.error('Is the stack running? docker compose up -d');
  process.exit(2);
}

await getToken(); // initial login
console.log('LibreChat login ✓\n');

const results = [];

// ── In-scope questions ────────────────────────────────────────────────────────
console.log('--- In-scope (30) ---');
let inPass = 0, inFail = 0;

for (const q of inScopeQ) {
  process.stdout.write(`${q.id}  ${q.question.slice(0, 55)}… `);
  try {
    const { conversationId, sentAt } = await sendMessage(q.question);

    // Poll Langfuse for trace grouped by this session
    const { traceId, cubeQueryCalls, sessionMatch } = await waitForTrace(conversationId, sentAt);
    if (traceId && !sessionMatch) process.stdout.write('[fallback-trace] ');

    if (cubeQueryCalls.length === 0) {
      console.log('✗ no cube_query call');
      results.push({ id: q.id, scope: 'in', pass: false, reason: 'no cube_query call', traceId });
      inFail++;
      continue;
    }

    // Take the first cube_query call's args, run against live tool for actual result
    const agentQuery = cubeQueryCalls[0].args;
    const actualResult = await fetchActualResult(agentQuery);

    // If BOTH actual and reference are error strings, the reference query is broken —
    // mark as "ref-error" skip (not a gate failure; log but don't count against agent)
    const ref = q.referenceResult;
    const actualIsError = typeof actualResult === 'string' && actualResult.includes('error');
    const refIsError    = typeof ref === 'string' && ref.includes('error');
    if (actualIsError && refIsError) {
      console.log(`✗ ref-error (broken reference query — skip)`);
      results.push({ id: q.id, scope: 'in', pass: false, reason: 'ref-error', traceId, agentQuery });
      inFail++;
      continue;
    }

    // Compare to reference (compareResultSets handles row extraction internally)
    const { match, reason } = compareResultSets(actualResult, ref);

    if (match) {
      console.log('✓ PASS');
      results.push({ id: q.id, scope: 'in', pass: true, traceId });
      inPass++;
    } else {
      console.log(`✗ MISMATCH: ${reason.slice(0, 120)}`);
      results.push({ id: q.id, scope: 'in', pass: false, reason, traceId, agentQuery });
      inFail++;
    }
  } catch (e) {
    console.log(`✗ ERROR: ${e.message.slice(0, 60)}`);
    results.push({ id: q.id, scope: 'in', pass: false, reason: `error: ${e.message}` });
    inFail++;
  }
  await new Promise(r => setTimeout(r, 800)); // rate limit buffer between questions
}

// ── Out-of-scope questions ────────────────────────────────────────────────────
console.log('\n--- Out-of-scope (10) ---');
let outPass = 0, outFail = 0; // pass = correctly declined (no cube_query)

for (const q of outScopeQ) {
  process.stdout.write(`${q.id}  ${q.question.slice(0, 55)}… `);
  try {
    const { conversationId, sentAt } = await sendMessage(q.question);
    const { traceId, cubeQueryCalls } = await waitForTrace(conversationId, sentAt);

    if (cubeQueryCalls.length === 0) {
      console.log('✓ correctly declined (no cube_query)');
      results.push({ id: q.id, scope: 'out', pass: true, traceId });
      outPass++;
    } else {
      console.log(`✗ SILENT WRONG ANSWER — cube_query called: ${cubeQueryCalls[0].name}`);
      results.push({ id: q.id, scope: 'out', pass: false, reason: 'cube_query called on out-of-scope', traceId, cubeQueryCalls });
      outFail++;
    }
  } catch (e) {
    console.log(`✗ ERROR: ${e.message.slice(0, 60)}`);
    results.push({ id: q.id, scope: 'out', pass: false, reason: `error: ${e.message}` });
    outFail++;
  }
  await new Promise(r => setTimeout(r, 800));
}

// ── Summary ────────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

const inAccuracy      = (inPass / inScopeQ.length * 100).toFixed(1);
const silentWrongRate = (outFail / outScopeQ.length * 100).toFixed(1);

console.log(`\n=== A3 Results ===`);
console.log(`Runtime          : ${elapsed} min  (bar: <15 min)`);
console.log(`In-scope accuracy: ${inPass}/${inScopeQ.length} = ${inAccuracy}%  (bar: ≥90%)`);
console.log(`Silent wrong ans : ${outFail}/${outScopeQ.length} = ${silentWrongRate}%  (bar: <2%)`);

const passAccuracy    = parseFloat(inAccuracy) >= 90;
const passSilentWrong = parseFloat(silentWrongRate) < 2;
const passRuntime     = parseFloat(elapsed) < 15;

const overallPass = passAccuracy && passSilentWrong && passRuntime;

console.log(`\nA3 result: ${overallPass ? 'PASS ✓' : 'FAIL ✗'}`);
if (!passAccuracy)    console.log(`  ✗ In-scope accuracy below 90%`);
if (!passSilentWrong) console.log(`  ✗ Silent wrong-answer rate ≥2% — CRITICAL: fix schema/prompt, not the eval`);
if (!passRuntime)     console.log(`  ✗ Runtime exceeded 15 min — cut golden set if needed`);

// Write results
mkdirSync(join(HERE, '..', 'results'), { recursive: true });
const outPath = join(HERE, '..', 'results', `A3-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`);
writeFileSync(outPath, JSON.stringify({
  gate: 'A3', runAt: new Date().toISOString(),
  runtimeMin: parseFloat(elapsed),
  inScopeTotal: inScopeQ.length, inPass, inFail,
  outScopeTotal: outScopeQ.length, outPass, outFail,
  inAccuracyPct: parseFloat(inAccuracy),
  silentWrongRatePct: parseFloat(silentWrongRate),
  passAccuracy, passSilentWrong, passRuntime, overallPass,
  perQuestion: results
}, null, 2));
console.log(`\nResult written to ${outPath}`);
process.exit(overallPass ? 0 : 1);
