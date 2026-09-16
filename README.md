# Experienz Eval Tooling Spike

8-day timeboxed spike to decide go/no-go on eval tooling for two systems.

| Track | System | Tool | Status |
|---|---|---|---|
| A | LibreChat → LiteLLM → Bedrock (chat) | Langfuse | STOPPED at A1 |
| B | Analytics Engine on AgentCore (agent) | AgentCore Evaluations | B1–B3 PASS, B4 in progress |

## Repo structure

```
harness/        evaluation scripts — deterministic checks, trajectory matcher
golden-sets/    reference fixtures and golden agent runs
results/        per-gate output JSON, written immediately after each gate runs
writeup/        one-pager per track with actual numbers and recommendation
```

## Track B gate summary

| Gate | Result | Key number |
|---|---|---|
| B1 — On-demand scoring via AgentCore | PASS | 15/15 evaluations scored, no agent re-instrumentation |
| B2 — Deterministic artifact checks | PASS | 3/3 checks (schema 11/11, DQ 8/8, metrics 38/38 ±0.5pp) |
| B3 — In-order trajectory matching | PASS | 6/6 = 100% (bar: ≥80%) |
| B4 — CI gate | IN PROGRESS | Blocked: `codebuild:StartBuild` = implicitDeny |

## Track A gate summary

| Gate | Result | Reason |
|---|---|---|
| A1 — session_id in Langfuse | STOP | LibreChat drops conversation ID before LLM call. Fix: ~3–5 days (LibreChat fork). |

## Running the harness

```bash
# B2 — all three deterministic checks
node harness/b2-run-all.mjs

# B3 — trajectory matching
node harness/b3-trajectory-matcher.mjs

# B2 Check 1 only (schema validate) — pass schema dir and client
node harness/b2-cube-schema-validator.mjs --schema-dir <path> --client <name>
```

Requires Node.js 18+. No npm dependencies — all harness scripts use Node built-ins only.
