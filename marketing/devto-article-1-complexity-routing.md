---
title: "Where Claude Code's Tokens Actually Go (and How I Cut My Bill in Half)"
published: true
tags: ai, opensource, devtools, productivity
canonical_url:
---

*Disclosure up front: I'm the author of [Lynkr](https://github.com/Fast-Editor/Lynkr), the open-source (Apache-2.0) proxy discussed below. All numbers come from a benchmark you can reproduce yourself — methodology linked at the end.*

I spent a few weeks instrumenting my own Claude Code sessions to answer one question: **where do the tokens actually go?**

The answer surprised me. It wasn't my prompts. It wasn't even the model's responses. The bulk of my spend was overhead I never looked at:

1. **Tool schemas sent on every single request.** Claude Code ships ~14 tool definitions (Write, Edit, Bash, Git, Grep...) with *every* message — even when you're asking a read-only question that can only ever use two of them.
2. **Raw JSON tool results.** A single grep returning 60 matches came back as a ~3,400-token JSON array. File reads, test output, `ls` results — all shipped verbatim into the context, on every turn, forever.
3. **Paying full price for trivial requests.** "What does `git stash` do?" was hitting the same expensive model as "refactor this auth module."

A famous example of this failure mode: an agent [burned 21,000+ input tokens fixing a one-line README typo](https://www.cyfrin.io/blog/expensive-and-slow-for-small-changes-why-ai-coding-agents-can-be-overkill). Stanford's Digital Economy Lab found agentic coding tasks consume [~1000x the tokens of ordinary code chat](https://digitaleconomy.stanford.edu/news/how-are-ai-agents-spending-your-tokens/). This is not a niche problem — it's the cost structure of every agentic coding tool.

## The fix: put intelligence between the agent and the model

None of this requires changing your tools. Claude Code, Cursor, and Codex CLI all let you override the API base URL. So I built a proxy that sits in the middle and does four things:

### 1. Strip tools the request can't use

Classify each request; a read-only question doesn't need Write/Edit/Bash schemas, so don't send them.

**Measured result:** 959 tokens vs 2,085 for the identical request — **53% fewer tokens, same model, same answer.**

### 2. Compress JSON tool results

Large JSON payloads (grep output, file listings, test results) get converted to [TOON](https://github.com/toon-format/toon), a token-oriented format, plus redundant-field stripping before they're forwarded to the model. Plain text passes through untouched.

**Measured result:** that 60-match grep result went from 3,458 tokens to 427 — **87.6% smaller**. (Honest caveat: TOON alone typically saves ~40%; the 87.6% is TOON *stacked with* field-stripping on a tabular payload. Deeply nested data compresses less. Run the benchmark on your own workload.)

### 3. Semantic caching

If you ask "explain TCP vs UDP" and later "what's the difference between TCP and UDP?", that's the same question. Embedding similarity ≥ 0.85 → serve the cached response. **171ms, zero tokens billed.**

### 4. Route by complexity, not by config

This is the part I haven't seen anywhere else done automatically. Each request is scored on 15 dimensions — token count, code complexity, reasoning markers, agentic signals, risk patterns — and routed to a tier you define:

```bash
TIER_SIMPLE=ollama:qwen2.5:7b          # free, local
TIER_MEDIUM=ollama:qwen2.5-coder:latest # free, local
TIER_COMPLEX=your-cloud-provider        # your API key
TIER_REASONING=your-cloud-provider
```

In my sessions, **70–90% of requests scored SIMPLE or MEDIUM** and never left my machine. Only genuinely hard problems — architecture, tricky refactors, security analysis — hit a paid backend.

The routing is deliberately conservative in one direction: tool-heavy agentic requests don't get downgraded, because the #1 complaint with every static routing setup is cheap models fumbling tool calls (failed edits, broken git operations). Routing *down* is only a saving if the answer still works.

## What this looks like in practice

```bash
npm install -g lynkr
lynkr init          # interactive wizard: pick your tiers and providers
lynkr start
```

Then point your tool at it — for Cursor it's Settings → Models → Override Base URL → `http://localhost:8081/v1`; for Codex CLI it's two lines in `~/.codex/config.toml`. No code changes, no plugins.

Everything is self-hosted: your prompts and code never transit a third-party SaaS, there's no markup fee, and the whole thing is Apache-2.0 on [GitHub](https://github.com/Fast-Editor/Lynkr).

## The numbers, side by side

Benchmarked against LiteLLM v1.87.1 on identical workloads, same backend providers:

| Scenario | Through Lynkr | Baseline | Delta |
|---|---|---|---|
| Tool-heavy request (14 schemas) | 959 tokens | 2,085 tokens | −53% |
| 60-result grep (JSON tool output) | 427 tokens | 3,458 tokens | −87.6% |
| Repeated paraphrased query | 171ms, 0 tokens | 3,282ms, full price | 11x faster |
| Complexity routing | simple→local, hard→cloud | cheapest-model-always | correctness |

Projected over 100k requests/month on a tool-heavy workload: roughly **half the bill, same backend, same models for the requests that matter**.

## Takeaways even if you never use my tool

1. **Audit your tool schemas.** They're the silent tax on every agentic request.
2. **Never ship raw JSON into a context window.** Tabular JSON is the single most compressible thing in your token stream.
3. **Most of your requests are simple.** You don't need a frontier model to explain `git stash`. Bring your own API keys, keep the easy 80% local, and spend where it counts.

If you try Lynkr and the numbers don't hold on your workload, open an issue with your benchmark output — I want the counterexamples: [github.com/Fast-Editor/Lynkr](https://github.com/Fast-Editor/Lynkr).
