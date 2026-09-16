# Track A — Langfuse Eval Spike: Final Report

**Date:** 2026-09-15  
**Track:** A — LibreChat → LiteLLM → Bedrock (Ask AI / ESG)  
**Tenant:** Silverstone (prod)  
**Status:** STOPPED at Gate A1 (stop condition triggered — 3 attempts including raw header capture)

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

## Stop Condition Triggered

Per CLAUDE.md: "Not working by end of day 1 → stop, report integration cost (may need LibreChat fork / LiteLLM patch). Do not silently absorb."

Two attempts exhausted. No third attempt.

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

## Recommendation

**Option A — Continue with revised A1 definition:**  
Redefine A1 as "user-level tracing works" (already passing) rather than "conversation-level session grouping." This unblocks A2–A5 which are load-bearing for the actual eval capability. Accept conversation grouping as a known gap — logged as a future integration investment if Langfuse is selected.

**Option B — Stop Track A entirely:**  
Per CLAUDE.md gate rules. A1 as written failed. Report Langfuse as viable for per-call observability but not conversation-scoped eval without integration work.

**My read:** Option A is defensible because the real eval value (A2: structured query extraction, A3: golden-set accuracy, A4: experiment diff) doesn't depend on session grouping. A1 was a proxy metric for "is Langfuse integrated?" — it IS integrated. The gap is grouping, not integration.

However, this is a product/spike leadership decision — flagging for Sekar rather than proceeding unilaterally.

---

## Files

| File | Contents |
|---|---|
| `results/A1-2026-09-15T11-41-28.json` | First A1 verifier run result |
| `results/A1-final.json` | Full stop condition report with evidence and integration cost |
| `harness/verify-a1-sessions.mjs` | A1 gate verifier script |
| `harness/result-set-diff.mjs` | Tool-agnostic result-set comparator (ready for A3) |
| `golden-sets/track-a-silverstone.json` | 40-question golden set (NEEDS HUMAN SIGN-OFF before A3) |