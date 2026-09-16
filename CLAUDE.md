# CLAUDE.md — Eval Tooling Spike

This file gives you (Claude Code) full context for this repo. Read it before doing any work here, and re-check it if you're unsure whether something is in scope.

## What this repo is for

An 8-working-day timeboxed spike to decide **go/no-go** on eval tooling for two systems. This is explicitly NOT a build task — the deliverable is a decision with evidence, plus a reusable harness and golden datasets. Do not optimize for a polished production system. Optimize for: fast, correct answers to "does this gate pass or fail, with what number."

- **Track A**: LibreChat → LiteLLM → Bedrock (semantic-layer chat). Candidate tool: **Langfuse** (hosted/Cloud tier only — never self-hosted for this spike).
- **Track B**: Analyst agent on AWS Bedrock **AgentCore**. Candidate tool: **AgentCore Evaluations**.

## Core principle — read this twice

Both surfaces produce executable artifacts (a Cube query, a Cube schema, a DQ rule), not free text. Correctness is checkable by **running the artifact and comparing results** — deterministic, cheap, no judge variance. LLM-as-judge is reserved for the one thing execution genuinely can't score: whether a prose explanation matches the numbers actually returned.

**If you find yourself writing an LLM-judge rubric before Track A gates A1–A4 have all passed, stop.** That means a deterministic gate upstream didn't actually hold and is being quietly worked around instead of reported as failed. Flag it to the user instead of proceeding.

## Gate structure — sequential and load-bearing

Gates within a track must be built and passed **in order**. Do not build gate N+1 if gate N hasn't passed — everything downstream assumes the upstream gate holds. If a gate fails its bar, stop that track, write up why, and do not attempt more than twice.

### Track A

| Gate | Test | Pass bar | Hard floor / stop condition |
|---|---|---|---|
| A1 | Session ID (LibreChat conversation ID) survives into Langfuse trace as `session_id`; user ID as `trace_user_id`. 20 messages across 3 conversations → exactly 3 grouped sessions. | 100% | Not working by end of day 1 → stop, report integration cost (may need LibreChat fork / LiteLLM patch). Do not silently absorb. |
| A2 | Generated Cube query (measures, dimensions, filters, time grain) is a structured, programmatically extractable field in the trace — not parsed from prose. | ≥95% of successful traces | Not recoverable, no small fix at tool-call boundary → escalate immediately, don't spend a day on workarounds. This gate is load-bearing for the whole approach. |
| A3 | 40-question golden set (30 in-scope, 10 deliberately out-of-scope) against one tenant's Cube schema. Reference query + result set stored per question. Compare generated result sets to reference: set comparison, order-insensitive, float tolerance. | Runs unattended <15 min. In-scope accuracy ≥90%. Silent-wrong-answer rate on out-of-scope <2% (treat this as MORE important than accuracy). | In-scope accuracy <75% → stop the whole track, this is a schema/prompt problem not a tooling problem. Runtime >30 min → cut the golden set, not the checks. |
| A4 | Change one prompt/model/schema description, re-run as a Langfuse dataset experiment, get a side-by-side score diff. | Diff visible with zero manual spreadsheet work; a regression on any question is clickable through to its trace. | Exporting CSVs to compare runs → stop, report that a thinner tool (e.g. promptfoo + own harness) would be cheaper. |
| A5 | ONLY if A1–A4 all pass. One judge rubric, explanation-quality only (does prose match the returned numbers). Hand-label 30 traces, compare to judge scores. | ≥80% agreement with human labels | <70% after one rubric revision → drop the judge, ship without it. Do not attempt a third revision. |

### Track B

| Gate | Test | Pass bar | Hard floor / stop condition |
|---|---|---|---|
| B1 | 5 real recorded agent runs scored via on-demand evaluation against existing span/trace IDs, using 2–3 built-in evaluators. | Zero changes to agent instrumentation required | Needs meaningful re-instrumentation → native advantage is gone; report this as the finding, don't absorb the integration cost. |
| B2 | Code evaluators for: (a) Cube schema validates/compiles, (b) DQ rules fire on known-bad fixture / stay quiet on known-good, (c) certified metrics reconcile against hand-computed baseline within tolerance. | All three run as hard gates, zero LLM involvement, identical results on repeat runs. Emit numbers, not just pass/fail. | Should not fail. If it does, the real blocker is "we can't define a correct schema" — escalate as a product conversation, not a tooling one. |
| B3 | 12 golden agent runs. In-order (not exact-order) trajectory matching + tool parameter accuracy. Judge-scored evaluators aggregated at suite level only, never gated per-run. | ≥80% of runs match expected trajectory | <50% match → agent isn't deterministic enough to regression-test at trajectory level. Fall back to artifact checks (B2) only — a fine place to land. |
| B4 | Batch evaluation in deploy pipeline, two-tier gate: hard-fail on B2 deterministic checks, threshold-gate on aggregated judge scores. Test with a deliberately broken schema change (must block) and a known-good change (must pass). | Both cases behave correctly; total runtime fits deploy window. | Runtime/ingestion delay makes blocking impractical → run nightly against main instead, don't engineer around the lag. |

## Explicitly out of scope — do not build these even if asked to optimize

- Ragas or any RAG retrieval metrics (context precision/recall don't map onto a semantic-layer lookup — this is not a document-retrieval system)
- Self-hosted Langfuse (use Cloud Hobby tier — free, 50k units/month, sufficient for this spike's volume)
- Any UI or dashboard
- Growing golden sets past 40 questions (Track A) / 12 runs (Track B)
- Unifying both tracks onto one platform "for elegance" (only note as an option if it'd cost ≤2 days)
- A third attempt at any gate, ever

## Repo structure to maintain

```
/harness          — comparison/evaluator code (result-set diff, trajectory matcher, deterministic checks)
/golden-sets       — the 40 questions + reference queries/results; 12 golden trajectories; DQ fixtures
/results           — per-gate output logs, captured immediately after each gate runs
/writeup           — the two final one-page-per-track documents
```

This harness and these golden sets are the deliverable that outlives the tool choice — build them tool-agnostically where possible (e.g., result-set comparison logic shouldn't be Langfuse-specific).

## How to behave when working in this repo

1. **Don't skip ahead.** If A1 hasn't been confirmed passing, don't start building A2/A3 harness code — flag that A1 needs verification first.
2. **Never fabricate a "pass."** If you can't verify a gate against real infra (missing credentials, no access), say so explicitly rather than producing a plausible-looking result.
3. **Golden-set content needs human sign-off.** You can draft candidate questions and reference Cube queries, but flag every one as "needs schema verification by a human" — don't present drafted answers as verified.
4. **Record numbers immediately.** Every gate run should write its actual result (not just pass/fail) to `/results` before moving on.
5. **When a stop condition is hit, stop.** Don't attempt a workaround beyond two tries. Write the failure reason clearly instead of continuing to iterate.
6. **When uncertain whether something is in scope, ask** rather than assuming more is better — this is a spike, not a build, and over-delivering on one gate steals time from the timebox.

## Access/config this repo assumes (fill in before running)

- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` — Cloud Hobby tier project
- LiteLLM config with Langfuse callback enabled
- LibreChat instance reachable for sending test messages
- Cube schema/tenant: `[TENANT_NAME — fill in]`
- AgentCore Evaluations API access + existing 5 run span/trace IDs: `[fill in]`
- Analyst agent schema + DQ rule definitions location: `[fill in]`
