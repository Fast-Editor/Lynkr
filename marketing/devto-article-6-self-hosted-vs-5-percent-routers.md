---
title: "The 5% Router Tax: What Hosted LLM Gateways Charge For (and How to Self-Host It)"
published: true
tags: ai, opensource, selfhosted, llm
canonical_url:
---

*Disclosure: I maintain [Lynkr](https://github.com/Fast-Editor/Lynkr), the self-hosted gateway discussed in the second half. OpenRouter and Requesty are good products — this post is about understanding what you're paying for so you can decide whether you need to.*

Hosted LLM routers had a huge 2026 — OpenRouter alone pushes 25 trillion tokens a week. The pitch is real: one API key, 400+ models, automatic failover. The price is a **~5% fee on every token you route** (5.5% on OpenRouter credits, 5% on Requesty), plus a subtler cost: every prompt, every file your coding agent reads, every secret that leaks into a context window transits their infrastructure.

For a hobby project, 5% of a small bill is nothing and the convenience wins. For an agentic coding workload — where teams routinely spend $500–$2,000 per engineer per month — 5% is real money, and the data-transit question stops being academic. So it's worth asking precisely: **what does the hosted router actually do for that fee, and which parts can you self-host?**

## What the fee buys

1. **Unified API across providers** — one format in, translated per-provider out.
2. **Failover** — a provider 500s, your request retries elsewhere.
3. **Model marketplace** — new models available the day they launch.
4. **Consolidated billing** — one invoice instead of six provider accounts.
5. **(Sometimes) smart routing** — OpenRouter's `auto` router picks a model per-request.

Items 1, 2, and 5 are software. Items 3 and 4 are genuinely hard to self-host — if you want day-one access to every new model with zero account setup, the marketplace earns its fee. But most coding workloads use a handful of models, not four hundred.

## The parts a hosted router structurally can't give you

- **Local models as a tier.** No hosted router will route your easy requests to the Ollama instance on your own machine — free, private, zero latency to first byte on cached weights. For coding traffic, where (in my instrumented sessions) 70–90% of requests are simple enough for a good local model, this is the single biggest cost lever, and it's only available to something running on your side of the wire.
- **Your data staying home.** Self-hosted means prompts, code, and keys never transit a third party. For anyone with a compliance requirement — or code they'd rather not ship to a router's logs — this isn't a preference, it's a prerequisite.
- **Token optimization before the bill.** A hosted router bills you for the tokens you send it — it has no incentive to shrink them. A self-hosted proxy can strip unusable tool schemas (measured: −53% on tool-heavy requests) and compress JSON tool results (measured: 3,458 → 427 tokens on a grep result) *before* any provider bills you. That's not a routing saving; it stacks on top of routing.
- **No availability dependency.** Hosted routers go down (OpenRouter's outages have their own HN threads) and offer no SLA at consumer tiers. A local proxy fails independently of anyone's status page.

## What self-hosting costs you

Honesty cuts both ways:

- **You run a process.** `npm install -g lynkr && lynkr init && lynkr start` — but it's yours now: updates, logs, the works.
- **You manage provider accounts.** Two or three API keys instead of one. The consolidated invoice is genuinely gone.
- **Model lag.** A new provider means waiting for support (or a PR) instead of it appearing in a dropdown.
- **Nobody to email.** Self-hosted support is a GitHub issue tracker.

If those trade-offs read as "fine," the math is straightforward: the 5% fee disappears, the local-tier routing removes the easy majority of requests from your bill entirely, and compression shrinks what's left.

## The hybrid that actually makes sense

This isn't either/or. A pattern I see working:

```
Coding tool → self-hosted proxy (Lynkr)
                ├─ SIMPLE/MEDIUM  → local Ollama/llama.cpp   (free)
                ├─ COMPLEX        → direct provider API keys  (no fee)
                └─ exotic models  → OpenRouter               (5% on the long tail only)
```

Keep a hosted router as *one backend* for the long tail of models you rarely need, route the bulk directly or locally, and let the proxy's classifier decide per-request. You get the marketplace when you want it without paying the tax on your entire volume.

Lynkr is Apache-2.0, self-hosted, supports 13 providers including Ollama, llama.cpp, LM Studio, Bedrock, Azure, Databricks — and OpenRouter itself as a tier: [github.com/Fast-Editor/Lynkr](https://github.com/Fast-Editor/Lynkr). Benchmarks with methodology are in the repo; run them on your own workload before believing anyone's percentages, including mine.
