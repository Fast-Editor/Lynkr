---
title: "I Benchmarked My Self-Hosted Gateway Against LiteLLM on Identical Workloads"
published: false
tags: ai, opensource, llm, node
canonical_url:
---

*Disclosure: I'm the author of [Lynkr](https://github.com/Fast-Editor/Lynkr), so read this as a maintainer's benchmark, not an independent one. Everything below is reproducible — setup, versions, and scenarios are in the [full report](https://github.com/Fast-Editor/Lynkr/blob/main/BENCHMARK_REPORT.md). If your numbers differ, I want the issue.*

LiteLLM is the default answer to "how do I put a proxy in front of my LLM traffic" — 50k+ stars, 100+ providers, and deservedly the category standard. I use pieces of it as a reference implementation. But "standard" and "optimal for agentic coding traffic" are different things, and I built Lynkr because three specific costs in Claude Code/Cursor sessions weren't being addressed by *any* gateway.

I ran both proxies on identical workloads — same backend providers (Ollama local, Moonshot, Azure OpenAI), same prompts, nine scenarios. Here's what came out.

## 1. Tool schemas: the tax nobody audits

Claude Code sends ~14 tool definitions with every request. Ask a read-only question and you still pay to ship Write, Edit, Bash, and Git schemas to the model.

LiteLLM forwards the payload faithfully — that's its job as a passthrough proxy. Lynkr classifies the request first and strips schemas it can't use.

| Same request, same model | Tokens billed | Cost |
|---|---|---|
| LiteLLM | 2,085 | $0.0091 |
| Lynkr | 959 | $0.0044 |

**53% fewer tokens.** On every tool-bearing request, all session long.

## 2. JSON tool results: the most compressible thing in your context

A Bash tool returning 60 grep matches as a JSON array cost ~3,400 tokens through LiteLLM. Lynkr converts large JSON payloads to [TOON](https://github.com/toon-format/toon) (a token-oriented notation) and strips redundant fields before forwarding; plain text passes through untouched.

| 60-result grep output | Tokens billed | Latency |
|---|---|---|
| LiteLLM | 3,458 | 12s |
| Lynkr | 427 | 12s |

**87.6% compression, same latency** (it happens in-process). Honest footnote: TOON alone typically achieves ~40% — the 87.6% is TOON *stacked with* field-stripping on tabular data. Nested blobs compress less. This is why the benchmark is reproducible: run it on your own tool outputs.

To be fair to LiteLLM: there's an open feature request for exactly this ([BerriAI/litellm#29320](https://github.com/BerriAI/litellm/issues/29320)). It's a real gap today, not necessarily forever.

## 3. Routing: cheapest-available vs complexity-scored

LiteLLM's routing strategies (shuffle, latency-based, cost-based) optimize *across deployments of equivalent models*. Set `cost-based-routing` and it sends everything to the cheapest available option — including the requests that shouldn't go there.

In our test, a JWT-vs-cookies security architecture question routed to a small local model under LiteLLM's cost-based strategy. Lynkr's classifier scored it COMPLEX (security domain keywords + trade-off analysis markers) and sent it to the cloud tier, while "what does git stash do?" stayed local and free.

Neither behavior is a bug — they're different philosophies. LiteLLM assumes you've decided which model class the request deserves; Lynkr decides per-request from 13 weighted dimensions (token count, technical depth, tool complexity, reasoning markers, conversation depth...).

## 4. Semantic cache

Ask "Explain TCP vs UDP," then "What's the difference between TCP and UDP?" LiteLLM supports caching (Redis/Qdrant — good, and more backends than Lynkr). In our default-config test, the paraphrase missed and paid full price; Lynkr's embedding cache (cosine ≥ 0.85) served it in **171ms with zero tokens billed** — 11x faster than the cold call.

## Where LiteLLM is still the right choice

Credit where due — pick LiteLLM if you need:

- **Provider breadth**: 100+ providers vs Lynkr's 13.
- **Team/platform features**: virtual keys, per-team budgets, spend dashboards, SSO.
- **Python ecosystem**: it's the native choice in Python shops; Lynkr is Node.
- **A big community**: 50k stars means every edge case has a GitHub issue.

One thing to weigh in 2026: LiteLLM had a rough security run this year (a PyPI supply-chain compromise in March, plus two critical CVEs exploited in the wild). They responded and patched — but if you're choosing a component that sees *all* your prompts and keys, audit whatever you deploy. Lynkr's surface is deliberately small: ~20 runtime dependencies, no database required, Apache-2.0, and short enough to actually read.

## Bottom line

| | LiteLLM | Lynkr |
|---|---|---|
| Category | Universal LLM proxy/platform | Cost engine for coding agents |
| Tool-schema stripping | No | Yes (−53%) |
| JSON result compression | No (open FR) | Yes (−87.6% on tabular) |
| Complexity-based routing | No (cost/latency strategies) | Yes (13-dimension classifier) |
| Semantic cache | Yes | Yes |
| Providers | 100+ | 13 |
| Team governance | Extensive | Minimal |
| Runtime | Python | Node 20+ |

Projected over 100k tool-heavy requests/month on the same backend, the token optimizations alone cut the bill roughly in half. If your traffic is agentic coding, that's the workload these mechanisms were built for: [github.com/Fast-Editor/Lynkr](https://github.com/Fast-Editor/Lynkr).
