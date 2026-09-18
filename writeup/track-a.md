# Track A — Langfuse Eval Spike: Final Report

**Date:** 2026-09-15 → 2026-09-18 (A1 resolved)  
**Track:** A — LibreChat → LiteLLM → Bedrock (Ask AI / ESG)  
**Tenant:** Silverstone (prod)  
**Status:** A3 FAIL — stopped per hard floor rule (in-scope accuracy 66.7% < 75%). Schema/prompt problem, not tooling.

---

## What Was Evaluated

Can Langfuse (Cloud Hobby tier) provide session-grouped observability for the Ask AI ESG feature, where a "session" = one LibreChat conversation?

---

## Gate A1: Session ID Propagation

**Test:** Send 20 messages across 3 LibreChat conversations. Verify every Langfuse trace has `session_id` = LibreChat conversation ID, `trace_user_id` = LibreChat user, and exactly 3 distinct session groups appear.

**Pass bar:** 100% of traces must have `session_id`.

### Attempt 1

- Wired Langfuse callback to LiteLLM (`success_callback: ["langfuse"]`).
- Added Langfuse env vars to LiteLLM container.
- Registered LibreChat user, created ESG Agent (all 9 MCP tools), sent 20 messages across 3 conversations.
- **Result:** 0/50 traces had `session_id`. `metadata` was `{}` on all traces. `trace_user_id` was populated (from OpenAI `user` field = MongoDB user ID).

### Attempt 2

- Added `set_verbose: true` to litellm-config.yaml. Restarted LiteLLM.
- Sent test message. Captured full verbose request log.
- **Result confirmed:** LiteLLM verbose output shows `Final returned optional params = {temperature, stream, tools, aws_region_name}` — no `metadata`, no conversation ID in any field.

### Attempt 3 — Raw HTTP header capture (patch attempt)

- Mounted a LiteLLM custom Python callback (`DiagnosticLogger`) that logs every incoming HTTP header, body key, and metadata field from LibreChat's request.
- Sent test message via ESG Agent. Captured complete header dump.
- **Result — definitive:** Full header list: `host, connection, accept, content-type, accept-language, sec-fetch-mode, accept-encoding, content-length, x-stainless-lang, x-stainless-package-version, x-stainless-os, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count, user-agent`.
- **No** `x-conversation-id`, **no** `x-librechat-*`, **no** `session_id` — anywhere.
- The conversation ID `5a6e175e-3f49-4d63-af88-d69f0102f0bb` visible in the browser URL was **not sent to LiteLLM at all**.
- Only `end_user_id: 6aa92459ad5d1df67116b1bb` (MongoDB user ID) arrives — already maps to `trace_user_id`.

### Root Cause

LibreChat's custom endpoint uses LangChain.js `ChatOpenAI` to call the LiteLLM proxy. LangChain.js does NOT forward the LibreChat conversation ID into the OpenAI API request. LibreChat knows the conversation ID at its API layer (stored in MongoDB) but it is not included in the downstream LLM call. LiteLLM therefore has no data to map to Langfuse `session_id`.

**What does flow:**
- `user` (MongoDB user ID) → Langfuse `trace_user_id` ✓
- Tool definitions (all 9 MCP tools) ✓
- Temperature, model, stream ✓

**What doesn't flow:**
- Conversation ID → Langfuse `session_id` ✗

---

## Resolution — 2026-09-18

Stop condition was triggered at LiteLLM layer (conversation ID never forwarded). Resolution came from a different integration path: **LibreChat has native Langfuse support** — it reads `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASEURL` directly from environment variables and traces at the LibreChat layer, where the conversation ID is owned.

**Fix applied:**
1. Removed `success_callback: ["langfuse"]` from litellm-config.yaml
2. Added `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASEURL` to librechat service in docker-compose.yml
3. Restarted stack — no YAML errors, no config changes to librechat.yaml needed

**A1 re-run result (2026-09-18):**

| Metric | Result |
|---|---|
| Traces found | 33 |
| Traces with session_id | 33/33 (100%) |
| Traces with trace_user_id | 33/33 (100%) |
| Distinct sessions | 5 |
| **A1 gate** | **PASS** |

Result file: `results/A1-2026-09-18T06-22-16.json`

---

## Integration Cost to Fix A1

| Option | Effort | Viable for Spike? |
|---|---|---|
| Fork LibreChat, inject `X-Conversation-Id` header per-request + LiteLLM custom callback to read it | 3–5 days | No — exceeds spike timebox |
| Upstream PRs to LibreChat + LiteLLM | Weeks | No |
| Replace LibreChat with custom thin chat UI that owns the request body | 5–8 days | No — build task, not eval spike |
| Instrument MCP server to call Langfuse SDK directly per tool call | 1–2 days | Partial — satisfies observability goal, not A1 as written |

---

## What Langfuse CAN Do (Confirmed Working)

Even though A1 failed, the integration proved:

1. **Token-level cost tracking works.** Every LLM call generates a Langfuse trace with model name, token counts, and estimated cost.
2. **User-level tracing works.** `trace_user_id` propagates — you can see how much each LibreChat user is consuming.
3. **Tool call logging works.** The 9 MCP tool calls within each agent turn appear as spans in the trace.
4. **Failure callbacks fire.** Langfuse receives both success and failure events.
5. **Budget ceiling in LiteLLM works independently.** `max_budget: 25` per day is enforced at the proxy (limited without a DB, but works for the spike).

---

## Findings for Go/No-Go Decision

| Question | Finding |
|---|---|
| Can Langfuse observe Ask AI usage? | Yes — per-call traces with tokens and cost |
| Can Langfuse group by conversation? | No — not without modifying LibreChat or building a custom front-end |
| Is conversation-grouping necessary for the eval goals? | Depends: A2–A5 gates don't require session grouping — they need structured Cube query extraction and golden-set scoring, which can be done at trace level |
| Should the spike continue? | See recommendation below |

---

## Gate A2: Cube Query Extraction

**Test:** Check that generated Cube query appears as structured, programmatically extractable JSON in the Langfuse trace — not parsed from prose. Pass bar: ≥95% of successful traces.

**Result (2026-09-18):**

| Metric | Result |
|---|---|
| cube_query calls total | 24 |
| Structured JSON | 24/24 (100%) |
| Extraction rate | 100% |
| **A2 gate** | **PASS** |

Tool calls appear in GENERATION span `output.kwargs.tool_calls[]` named `cube_query_mcp_experienz-tools`. Args are structured objects with `measures`, `dimensions`, `filters`, `timeDimensions`, `segments`. Langfuse Hobby tier rate limit (15 req/min) handled with per-trace detail fetches and 429 backoff.

Result file: `results/A2-2026-09-18T07-15-50.json`

---

## Gate A3: 40-Question Golden Set

**Test:** 40-question golden set (30 in-scope, 10 out-of-scope) against Silverstone Cube schema. Compare agent's cube_query result sets against reference. Pass bars: in-scope accuracy ≥90%, silent-wrong-answer rate <2%, runtime <15 min.

**Hard floor rule:** In-scope accuracy <75% → stop the whole track. Schema/prompt problem, not tooling.

**Final run result (2026-09-18, run 5) — score updated after reference query verification:**

| Metric | Result | Bar | Status |
|---|---|---|---|
| In-scope accuracy | 21/30 = 70.0% | ≥90% | FAIL |
| Silent wrong-answer rate | 2/10 = 20% | <2% | CRITICAL FAIL |
| Runtime | 28.9 min | <15 min | FAIL |
| **A3 gate** | **FAIL** | | |

**Hard floor triggered:** 70.0% < 75% → stopping Track A.

Result file: `results/A3-2026-09-18T09-01-34.json`

**Reference query verification (2026-09-18, post-run):** Three reference queries were found to be incorrect after human review. Q10 reference was returning total BGP emission instead of emission-per-spectator. Q25 reference had no time filter (all-years aggregated) instead of 2024. Q28 reference included `activity.emission` alongside the intensity measure — the question only asks for intensity. Fixed all three; re-fetched from MCP. Q28 flipped from FAIL to PASS (reference error, not agent error). Q10 and Q25 remain FAIL with cleaner references. Score: 20/30 → 21/30.

### What passed (21/30)

Q01, Q03, Q04, Q05, Q06, Q07, Q08, Q09, Q12, Q13, Q14, Q15, Q17, Q18, Q19, Q22, Q23, Q26, Q28, Q29, Q30

### What failed and why

| Category | Questions | Root Cause |
|---|---|---|
| Wrong dimension name | Q02 | Agent uses `activity.ghgScope` (English label) instead of `activity.ghgScopeId` (numeric ID) — schema gap in prompt |
| Event code gap | Q16, Q20, Q21 | Agent filters by full event name ("British Grand Prix"), Cube uses codes ("BGP") → Cube returns 400 |
| Different query scope | Q10, Q11 | Q10: agent ignores BGP filter (event code gap); Q11: agent hides null-spectator events |
| Over-broad query | Q24, Q25, Q27 | Agent omits required filter or adds unwanted year dimension |
| **Silent wrong answers** | **Q38, Q40** | **Agent called `cube_query` on "how do we compare to Paris Agreement targets / Glastonbury Festival" — should have declined; it fetched Silverstone data instead** |

### This is a schema/prompt problem

The tooling works: A1 and A2 both passed. The failure is:

1. **Missing event code dictionary** — Agent knows "British Grand Prix" but Cube schema uses "BGP", "MotoGP", etc. System prompt must include event codes.
2. **Dimension name gap** — `activity.ghgScopeId` vs `activity.ghgScope` — schema description in prompt uses wrong field name.
3. **Out-of-scope boundary too vague** — Q38 ("compare to Paris Agreement") and Q40 ("compare to Glastonbury") were treated by the agent as "I can get Silverstone's data from Cube" — partial answer, wrong behavior. Prompt needs explicit "decline all external benchmark comparisons" instruction.

**Fix before re-attempting A3:** Update agent system prompt with (a) event code dictionary, (b) correct dimension names, (c) explicit decline rule for external comparisons. Estimated effort: 0.5 days.

---

## Track A: Go/No-Go Finding

| Gate | Result | Evidence |
|---|---|---|
| A1 — Session ID propagation | PASS | 33/33 traces with session_id, 5 sessions |
| A2 — Cube query extraction | PASS | 24/24 cube_query calls structured JSON |
| A3 — Golden set accuracy | FAIL | 21/30 = 70.0% (after ref verification), 2/10 silent wrong answers |
| A4–A5 | Not reached | A3 hard floor triggered |

**Tooling verdict:** Langfuse (Cloud Hobby tier) is viable — session grouping, trace extraction, and structured span inspection all work. The A3 failure is not a tooling limitation.

**Blocker:** Agent system prompt lacks event codes and correct dimension names. Fix the prompt, re-run A3, then proceed to A4.

---

## Files

| File | Contents |
|---|---|
| `results/A1-2026-09-15T11-41-28.json` | First A1 verifier run result |
| `results/A1-final.json` | Full stop condition report with evidence and integration cost |
| `harness/verify-a1-sessions.mjs` | A1 gate verifier script |
| `harness/result-set-diff.mjs` | Tool-agnostic result-set comparator (ready for A3) |
| `golden-sets/track-a-silverstone.json` | 40-question golden set (NEEDS HUMAN SIGN-OFF before A3) |