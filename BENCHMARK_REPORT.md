# Lynkr vs LiteLLM — Benchmark Report
**Date:** June 5, 2026 · **Addendum:** July 15, 2026 (LiteLLM Auto Router v2 — see bottom)  
**Setup:** Same backend providers (Ollama local, Moonshot, Azure OpenAI), 9 scenarios across 4 feature categories.

> ⚠️ **Update (2026-07-15):** Section 4 and the summary table below predate LiteLLM v1.94's Auto Router v2, which added a native complexity router. The claim "LiteLLM has no complexity routing" is no longer true — see the [addendum](#addendum-july-15-2026--litellm-auto-router-v2) for the re-run against it.

---

## TL;DR

Lynkr reduces tokens sent to the model through three independent mechanisms that LiteLLM does not have. On a realistic agentic coding workload, this translates to measurably lower costs and faster responses — on the same backend.

---

## 1. Smart Tool Selection

**What it does:** Classifies each request and strips irrelevant tool schemas before forwarding. A read-only question doesn't need Write, Edit, Bash, Git tools — Lynkr removes them automatically.

**Test:** 14 tool definitions sent on every request (realistic Claude Code / Cursor session).

| | Tokens billed | Cost |
|---|---|---|
| Lynkr | 959 | $0.0044 |
| LiteLLM | 2,085 | $0.0091 |

**Result: 53% fewer tokens, 52% cheaper — same model, same prompt.**

---

## 2. TOON Compression (JSON Tool Results)

**What it does:** Binary-compresses large JSON payloads (tool results, file reads, grep outputs) before forwarding to the model. Plain text passes through unchanged.

**Test:** A Bash tool returning 60 grep results as a JSON array (~3,400 tokens).

| | Tokens billed | Cost | Latency |
|---|---|---|---|
| Lynkr | 427 | $0.009 | 12s |
| LiteLLM | 3,458 | $0.018 | 12s |

**Result: 87.6% compression, 50% cheaper. Same latency — compression happens in-process.**

---

## 3. Semantic Cache

**What it does:** Generates embeddings of incoming prompts and returns cached responses for semantically similar queries (cosine similarity ≥ 0.85). Zero model tokens billed on a cache hit.

**Test:** Two paraphrased prompts sent back-to-back ("Explain TCP vs UDP" → "What is the difference between TCP and UDP?").

| | Tokens billed | Response time |
|---|---|---|
| Lynkr SC1 (cold) | 2,857 | 1,891ms |
| **Lynkr SC2 (cache hit)** | **2,857\*** | **171ms** |
| LiteLLM SC2 | 54 | 3,282ms |

\*Token count shown is what would have been billed — cache served the stored response, no model call made. Response time dropped from 1,891ms to 171ms (11× faster).

---

## 4. Tier Routing

**What it does:** Scores each request on 15 dimensions (token count, code complexity, reasoning markers, risk patterns, agentic signals) and routes to the appropriate model tier automatically — no caller changes needed.

**Test:** Simple Q&A vs complex security analysis on the same endpoint.

| Request | Lynkr routes to | LiteLLM routes to |
|---|---|---|
| "What does git stash do?" | `minimax-m2.5` (local, free) | Ollama (local) |
| Security analysis of JWT vs cookies | `moonshot-v1-auto` (cloud) | **Ollama (local)** |

LiteLLM's `cost-based-routing` sends everything to the cheapest available model regardless of complexity. For a banking security architecture question, that's the wrong call.

---

## Summary Table

| Feature | Lynkr | LiteLLM |
|---|---|---|
| Smart tool selection | ✅ 53% token reduction | ❌ |
| TOON JSON compression | ✅ 87.6% on large results | ❌ |
| Semantic cache | ✅ 171ms cache hits | ❌ |
| Automatic complexity routing | ✅ embedding intent + 13-dimension scorer | ⚠️ Auto Router v2 since v1.94 (see addendum: 4/11 default, 6–8/11 with paid LLM classifier) |
| Self-hosted / data stays local | ✅ | ✅ |
| MCP integration | ✅ | ❌ |
| Memory system | ✅ Long-term per-session | ❌ |

---

## Cost Projection (100,000 requests/month, same backend)

Based on L2 (TOON) as representative of a tool-heavy agentic session:

| | Monthly cost | vs LiteLLM |
|---|---|---|
| LiteLLM | ~$818 | baseline |
| **Lynkr** | **~$409** | **~50% cheaper** |

*Note: LiteLLM's headline number in raw benchmarks is lower because it routes everything to a free local model. On equal footing (same provider, same model), Lynkr is cheaper due to token optimization.*

---

## How to Compare with Portkey

Portkey is a managed cloud gateway focused on observability, guardrails, and prompt management. It has no automatic complexity detection, no token compression, and no semantic cache. Conditional routing requires the caller to pass metadata tags manually. It's a different product category — operations/governance tooling vs. token optimization proxy.

**Lynkr's target user:** Teams running Claude Code, Cursor, or Codex CLI who want to reduce LLM spend and route through their own infrastructure (Databricks, Azure, Bedrock) without changing any client-side code.

---

---

## Methodology

### Environment

| Component | Version / Config |
|---|---|
| Machine | macOS, Apple Silicon (aarch64) |
| Lynkr | v9.3.2, Node.js 20, `NODE_OPTIONS=--max-old-space-size=512` |
| LiteLLM | v1.87.1, Python 3.12, `routing_strategy: cost-based-routing` |
| Ollama | Local, `minimax-m2.5:cloud` (SIMPLE/MEDIUM tier) |
| Moonshot | `moonshot-v1-auto` (COMPLEX tier) |
| Azure OpenAI | `gpt-5.2-chat` (REASONING tier) |

### What was measured

Each scenario sent an identical HTTP request to both proxies at `POST /v1/messages`. From each response:

- **Billed tokens** — `usage.input_tokens` from the response body (what the model actually received and charged for)
- **Estimated tokens** — calculated locally from the raw request payload before sending (~4 chars/token approximation)
- **Tokens saved** — `max(0, estimatedInputTokens - billedInput)`
- **Cost** — `(billedInput / 1,000,000) × inputPrice + (billedOutput / 1,000,000) × outputPrice` using published per-model pricing
- **Latency** — wall-clock time from request send to full response received

### How compression is measured

Lynkr applies optimizations **before** forwarding to the provider. The `billedInput` from the model therefore reflects post-optimization token count. The delta between estimated request tokens and billed tokens captures the saving.

Important caveat: Lynkr injects a system prompt (memory context, agent instructions) that adds ~2,800 tokens of overhead not present in the raw request. This overhead is included in `billedInput` but not in `estimatedInputTokens`. As a result, scenarios without compression (S1, H1, R1) appear to show negative savings — the system prompt overhead outweighs the compression. Only tool-selection (T1, T2) and TOON (L2) show positive savings because those optimizations save more tokens than the overhead adds.

**For a clean apples-to-apples measurement, compare Lynkr vs LiteLLM billed tokens on the same scenario — not estimated vs billed.**

### Scenario design

| ID | What it tests | Why |
|---|---|---|
| S1 | Simple Q&A | Baseline — tier routing to cheapest model |
| T1 | 14 tools, read request | Smart tool selection — irrelevant tools stripped |
| T2 | 14 tools, write request | Smart tool selection — only write tools kept |
| H1 | 8-turn conversation | History compression — older turns deduped |
| L1 | JSON tool result (package.json, ~40 deps) | TOON — moderate JSON structure |
| L2 | JSON tool result (60-item grep array) | TOON — large repetitive JSON array |
| SC1 | Cold cache prompt | Semantic cache population |
| SC2 | Paraphrased identical prompt | Semantic cache hit — measures latency and token savings |
| R1 | Security analysis, step-by-step | Tier routing — should escalate to cloud model |

### Fairness notes

- Both proxies used the same backend credentials and endpoints.
- Requests were sent sequentially with a 400ms buffer between calls to avoid rate-limiting skew.
- LiteLLM's overall cost is lower in the summary because `cost-based-routing` routes all requests to the free local Ollama model. On scenarios where both proxies used the same provider (L1, L2), Lynkr was 50% cheaper due to TOON compression.
- Portkey was included as a third proxy but was excluded from results — the local gateway container was not running during the benchmark session.
- The benchmark script is open and reproducible: `node benchmark-tier-routing.js` from the Lynkr repo root.

*Benchmark run on macOS, Apple Silicon. Lynkr v9.3.2. LiteLLM v1.87.1.*

---

## Addendum (July 15, 2026) — LiteLLM Auto Router v2

LiteLLM v1.94.0.dev1 shipped **Auto Router v2** with a native `auto_router/complexity_router`: a 7-signal heuristic scorer (default), an optional LLM classifier, keyword tier rules, and the same SIMPLE/MEDIUM/COMPLEX/REASONING tier names Lynkr uses. This obsoletes the June tier-routing comparison (Section 4), which ran LiteLLM with `cost-based-routing` — a strategy that by design ignores prompt content.

### Re-run setup

- **LiteLLM:** v1.94.0.dev1, `litellm-autorouter-v2.yaml` (heuristic default) and `litellm-autorouter-v2-llm.yaml` (LLM classifier). Tier targets identical to Lynkr's live config: SIMPLE/MEDIUM → Ollama `minimax-m2.5:cloud` (free local), COMPLEX → Azure `gpt-5.2-chat`, REASONING → Z.ai `GLM-5.2`.
- **Harness:** `MODE=routing node benchmark-tier-routing.js` — 11 routing scenarios, identical prompts to both proxies, **both judged on the same acceptable-tier sets** (unlike the June run, which asserted routing for Lynkr only). Tier decisions read from `x-lynkr-tier` and `x-litellm-model-id` (explicit `model_info.id` per tier deployment).

### Results

| Router | Routing-correct | Failure pattern |
|---|---|---|
| **Lynkr** | **11/11** | — (2 transient HTTP errors on repeat runs; surviving runs all passed) |
| LiteLLM v2 heuristic (default, <1ms, free) | **4/11** | every miss under-routed: banking security analysis → MEDIUM, whole-pipeline refactor → MEDIUM, prod auth fix → SIMPLE, autonomous agentic loop → SIMPLE, session escalation → SIMPLE |
| LiteLLM v2 + LLM classifier (GPT-5.2) | **6–8/11**, varies run to run | non-deterministic (same prompt flipped SIMPLE↔REASONING); over-escalated a harness suggestion-mode side request; failed the envelope-invariance pair |

Additional findings:

1. **The LLM classifier requires a strong structured-output model.** With the free local minimax as classifier, every classification call failed (`json_invalid`) and silently fell back to the heuristic after burning 3–8s per request. With GPT-5.2 it works but adds a metered API call and ~2–3s to **every** routed request.
2. **No verify-then-escalate cascade.** LiteLLM's fallbacks trigger only on HTTP errors (429/5xx/context-window) — never on answer content. Lynkr's cascade demonstrably claws back cost: one scenario classified COMPLEX was served by the free local model because the cheap answer passed verification.
3. **Cost structure:** LiteLLM's default spent $0 by being wrong (misroutes are invisible on the invoice, visible in answer quality); its accurate mode has a per-request classifier tax that scales linearly with traffic. Lynkr's routing overhead is a cached local embedding, and its spend concentrated on the requests that warranted paid models.

### Fairness caveats (read before quoting)

- The 11 scenarios derive from **Lynkr's own regression suite** — prompts Lynkr's live incidents were hardened against. Lynkr's 11/11 is expected on home turf. The transferable finding is the *direction* of LiteLLM's failures (systematic under-routing on defaults; cost and instability with the classifier), not the exact scores.
- Both proxies had identical tier targets; answer quality was not scored, only the routing decision.
- Auto Router v2 was ~1 day old at test time (first dev release cut 2026-07-14); expect it to improve.

*Addendum run on macOS, Apple Silicon. LiteLLM v1.94.0.dev1, heuristic + GPT-5.2-classifier configs. Reproduce: start LiteLLM with either yaml, then `MODE=routing RUNS=2 node benchmark-tier-routing.js`.*
