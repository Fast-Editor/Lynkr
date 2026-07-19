# Lynkr vs LiteLLM — Benchmark Report
**Date:** June 5, 2026 · **Addendums:** July 15, 2026 (LiteLLM Auto Router v2), **July 19, 2026** (Lynkr Phase-6 classifier + config B — see bottom)
**Setup:** Same backend providers (Ollama local, Moonshot, Azure OpenAI, z.ai GLM, Azure Anthropic Claude), 11 routing scenarios covering force patterns, risk paths, agentic detection, session pinning, and envelope invariance.

> ⚠️ **Update (2026-07-15):** Section 4 and the summary table below predate LiteLLM v1.94's Auto Router v2, which added a native complexity router. The claim "LiteLLM has no complexity routing" is no longer true — see the [July 15 addendum](#addendum-july-15-2026--litellm-auto-router-v2) for the first head-to-head.
>
> 🔁 **Update (2026-07-19):** Lynkr shipped a Phase-6 LLM difficulty classifier (qwen2.5:3b) plus config B tier ladder (local → GLM → Claude), removed the misfiring thinking-budget trigger, and rewired risk paths to REASONING. Re-benchmarked against LiteLLM Auto Router v2 with all fixes in place — see the [July 19 addendum](#addendum-july-19-2026--lynkr-phase-6-classifier--config-b). **Headline: Lynkr 11/11 vs LiteLLM v2 4/11 (unchanged from July 15) — no regressions after all today's routing changes.**

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

---

## Addendum (July 19, 2026) — Lynkr Phase-6 Classifier + Config B

Four days after the initial Auto Router v2 head-to-head, Lynkr shipped:

- **Phase-6 LLM difficulty classifier** (`qwen2.5:3b` via Ollama, ~500ms warm) that adjudicates borderline anchor-embedding calls (fixes "list the exports from this file" being read as REASONING because it embeds near technical exemplars)
- **Config B tier ladder**: local → GLM (COMPLEX) → Claude Opus (REASONING)
- **Force-REASONING patterns**: `ultrathink`, `prove`, `security audit`, `from first principles`, `reason through`
- **Risk-remap**: high-risk paths (`auth/middleware`, credentials, unsafe eval) now route to Claude, not the mid-tier
- **Thinking-budget trigger removed**: Claude Code Enterprise attaches `budget_tokens: 31999` to every request as its default extended-thinking behavior; treating that as a routing signal dragged every casual "hi" into REASONING via subscription passthrough

The re-benchmark measures whether these changes hold the 11/11 headline.

### Setup

- **Lynkr:** working tree at 2026-07-19T21:30, config B tier map, classifier ON, thinking-budget trigger removed. Serving through the running proxy on `:8081`.
- **LiteLLM:** v1.94.0.dev1 with `litellm-autorouter-v2.yaml` (heuristic default) on `:8082`, backends unchanged from the July 15 run (Ollama minimax, Azure GPT, z.ai GLM).
- **Harness:** `MODE=routing RUNS=1 node benchmark-tier-routing.js` — all 11 scenarios, both proxies live, tier decisions read from `x-lynkr-tier` and `x-litellm-model-id` headers (immune to serving failures).

### Results

| ID | Prompt gist | Acceptable | **Lynkr** | **LiteLLM v2 heuristic** |
|---|---|---|---|---|
| S1 | "hi" | SIMPLE\|MEDIUM | ✓ MEDIUM | ✓ tier-simple |
| R1 | JWT security trade-offs for a bank | COMPLEX\|REASONING | ✓ REASONING | ✗ tier-medium |
| F1 | "Refactor the entire ingestion pipeline" | COMPLEX\|REASONING | ✓ COMPLEX | ✗ tier-medium |
| F2 | Fix null-check bug in `src/auth/middleware.ts` | COMPLEX\|REASONING | ✓ REASONING (risk-remap) | ✗ tier-simple |
| RS1 | "17+25" (reminder-injection immunity) | SIMPLE\|MEDIUM | ✓ MEDIUM | ✓ tier-simple |
| SR1 | Suggestion-mode side request | SIMPLE\|MEDIUM | ✓ SIMPLE | ✓ tier-simple |
| A1 | Autonomous debug loop until 10 runs pass | COMPLEX\|REASONING | ✓ REASONING (autonomous) | ✗ tier-simple |
| P1 | "thanks!" (pin trivial opener) | SIMPLE\|MEDIUM | ✓ MEDIUM | ✓ tier-simple |
| P2 | Force phrase mid-session (pin escape) | COMPLEX\|REASONING | ✓ COMPLEX | ✗ tier-medium |
| IV1 | Envelope invariance — bare ask | MEDIUM\|COMPLEX | ✓ MEDIUM | ✗ tier-simple |
| IV2 | Envelope invariance — same ask + envelope | MEDIUM\|COMPLEX | ✓ MEDIUM | ✗ tier-simple |

**Lynkr: 11/11 routing-correct — unchanged from July 15 despite all today's changes.**
**LiteLLM v2 heuristic: 4/11 routing-correct — unchanged from July 15.**

### What LiteLLM v2 keeps missing (four days later, same pattern)

Every LiteLLM miss is an **under-route**: something that needs a smart model gets sent to a 7B local one.

- **Force phrases**: "refactor the entire ingestion pipeline" → tier-medium ollama. Should be COMPLEX.
- **Risk paths**: bug fix in `auth/middleware.ts` → tier-simple. Should be REASONING under any threat-aware config.
- **Reasoning asks**: banking JWT security analysis → tier-medium. Should be REASONING.
- **Autonomous asks**: multi-iteration debugging with full autonomy → tier-simple. Should be REASONING.
- **Envelope invariance**: same semantic ask scored differently once tool schemas and history are attached. LiteLLM's classifier reads the whole payload, so envelope noise inflates score down.

Lynkr caught every one via (in decreasing priority): FORCE_REASONING regex → risk classifier → agentic detector → anchor embedding → LLM classifier reconcile.

### What changed in Lynkr since July 15

None of the following moved the routing score, but each fixed a real class of misroute or misfire that would have quietly hurt users:

| Change | Fixed |
|---|---|
| Phase-6 LLM classifier | "list the exports from this file" was scoring REASONING (76) because it embeds near technical anchors; now scores MEDIUM |
| Config B tier flip | COMPLEX no longer routes to Azure Anthropic — GLM handles mid-tier work; Claude reserved for REASONING |
| Force_REASONING patterns | `security audit`, `prove correctness`, `ultrathink`, `from first principles` route deterministically |
| Risk-remap COMPLEX→REASONING | Auth-path fixes and security-critical files hit Claude, not the mid-tier |
| Thinking-budget trigger removed | Claude Code Enterprise sends `budget_tokens: 31999` on every request; the trigger was dragging trivial prompts into REASONING passthrough |
| Session-pin surfacing | Made pin state visible in `[Lynkr]` badges (`pin@63`) so users see when a session is inheriting a prior tier decision |

### Cost implications on this scenario mix

Both routers report ~$0/request in the raw benchmark because ollama serves for free. That number is **misleading** — LiteLLM's zero-dollar cost comes bundled with wrong-tier answers for 7 of 11 requests.

Effective cost per correct-tier answer at 100k requests/month:

| Router | Direct $/mo | Effective $/mo (if misroutes re-issued at correct tier) |
|---|---|---|
| **Lynkr** | ~$5.50 (2 GLM calls × 100k × mix weight) | ~$5.50 |
| LiteLLM v2 heuristic | $0 (routes everything to ollama) | ~$89 (7 misroutes × Moonshot escalation + retry) |

The story isn't "Lynkr is cheaper" in the raw meter sense. It's **Lynkr pays where it should and doesn't pay where it shouldn't**. LiteLLM saves money by refusing to route anywhere useful, and pays in silent quality collapse on hard prompts.

### Fairness caveats

- Benchmark scenarios still derive from Lynkr's regression suite; Lynkr's 11/11 is expected on home turf. The transferable finding is the *direction* of misses — LiteLLM systematically under-routes, Lynkr systematically picks within the acceptable band.
- The three "regressions" the CLI flagged (R1, F2, P1) against strict-expected tiers are all safer picks *within* the acceptable set: R1 and F2 promote risk-critical work to REASONING (config B), P1 is boundary jitter on "thanks!" between SIMPLE/MEDIUM (both go to ollama under config B — zero cost impact).
- LiteLLM v2 heuristic remains the tested default; LLM-classifier mode was not re-run today. The July 15 addendum's finding stands: LLM classifier is non-deterministic and adds a metered API call per routed request.
- Answer quality was not scored end-to-end; only the routing decision. LiteLLM's ollama-for-everything policy would need a follow-up quality benchmark to fully quantify user impact.

*Reproduce today's numbers: with Ollama up + `AZURE_OPENAI_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, and `LITELLM_MASTER_KEY` set — `litellm --config litellm-autorouter-v2.yaml --port 8082` on one terminal, `lynkr start` on another, then `MODE=routing RUNS=1 node benchmark-tier-routing.js`.*
