---
title: "Choosing a Local Tier for Your Coding Agent (July 2026 Edition)"
published: true
tags: ai, llm, opensource, ollama
canonical_url:
---

*Disclosure: I maintain [Lynkr](https://github.com/Fast-Editor/Lynkr), the open-source router used in the config examples. The benchmark figures below are third-party or vendor-reported (flagged where vendor-only) — I haven't independently benchmarked these models yet; the point of this post is to help you match models to request classes and test on your own workload.*

June 2026 was the busiest month for open-weight coding models in recent memory: GLM-5.2, MiniMax M3, Kimi K2.7 Code, Gemma 4, and NVIDIA's Nemotron 3 Ultra all landed within weeks. If you route your coding agent's simple requests to a local model — the "cloud architect, local coder" pattern — your options just changed meaningfully.

Here's how I'd map the current field onto routing tiers, by hardware budget and by what each model can *safely* own.

## First, the trap: "best open model" ≠ "your local tier"

The headline model of the month, [GLM-5.2](https://techsy.io/en/blog/best-open-source-llms-2026), scores 62.1% on SWE-bench Pro — above GPT-5.5. It is also a 744B-parameter MoE whose 2-bit quant alone wants ~245 GB of memory. That's an open-*weight* model, not a local model; for self-hosters it's a $40k-rig proposition ([one published build](https://aiweekly.co/node/5306) runs it on four RTX PRO 6000s). The same goes for DeepSeek-V4 Pro and MiniMax M3: superb models you'll realistically consume via API, where they belong in your COMPLEX/REASONING tiers, not your local one.

Your local tier is decided by a harsher question: **what fits in your VRAM and still makes reliable tool calls?**

## The local field, by hardware budget

**~16 GB RAM (ordinary laptop): Gemma 4 12B.** Released June 3 as a dense 12B that genuinely fits consumer RAM ([SitePoint's guide](https://www.sitepoint.com/local-llms-are-getting-easier-the-complete-guide-2026/)). Apache-2.0-class licensing with no usage clauses. This is a SIMPLE-tier model: explanations, one-liners, commit messages, "what does this error mean." I would not hand it an Edit tool.

**24 GB GPU (RTX 3090/4090 class): Qwen3.6-27B — still the default answer.** The community's consensus "local Claude" since April: within a few points of frontier models on SWE-bench Verified (77.2 reported vs Claude's 80.9 — [analysis](https://codersera.com/blog/qwen-3-6-as-local-claude-code-replacement-2026/)), Apache-2.0, runs quantized on a single 24 GB card or a ~$2k build. Its known weakness is exactly the one that matters for agents: tool-call reliability drifts in long contexts — fine as a *supervised* MEDIUM tier, risky as an unsupervised COMPLEX one.

**Agentic multi-file edits on similar hardware: Devstral Small 2.** Purpose-built for multi-file, tool-driven coding rather than chat ([KDnuggets roundup](https://www.kdnuggets.com/top-7-coding-models-you-can-run-locally-in-2026)). If your traffic is edit-heavy, it can arguably take MEDIUM-tier mutation requests that I'd keep away from general chat models.

**Autocomplete-shaped work: Codestral 22B** is fast and good at it — but mind the non-commercial license before using it for work.

One rule that keeps proving out ([Pinggy's guide](https://pinggy.io/blog/best_open_source_self_hosted_llms_for_coding/)): **within the same memory budget, a bigger model at Q4 usually beats a smaller one at Q8.** Quantization choice matters nearly as much as model family.

## Mapping to tiers

Putting that together into a routing config (Lynkr shown; the mapping logic applies to any router):

```bash
# 24 GB GPU + API keys for the hard stuff
TIER_SIMPLE=ollama:gemma4:12b            # trivia, explanations, greetings
TIER_MEDIUM=ollama:qwen3.6:27b           # code questions, supervised edits
TIER_COMPLEX=deepseek:deepseek-v4-flash  # tool-heavy mutations, via API
TIER_REASONING=deepseek:deepseek-v4      # architecture, multi-step planning
```

Why V4 Flash for COMPLEX: it's the first open-weight model teams report dropping into real agentic pipelines as a frontier substitute *on price* ([OpenRouter's June analysis](https://openrouter.ai/blog/insights/the-open-weight-models-that-matter-june-2026/)) — the cheapest "won't break the session" option right now. Kimi K2.7 Code (vendor-reported 58.6% SWE-bench Pro at ~30% fewer reasoning tokens) and GLM-5.2 are strong API-tier alternatives; all the June day-one numbers are vendor-reported, so treat them as directional until LiveBench catches up.

The key discipline: **the boundary between MEDIUM and COMPLEX should not be "how big is the request" but "will tools mutate state."** Local models in this class handle read-and-explain reliably; exact-match edits and bash execution are where they still break sessions — I wrote up those failure modes [here](https://dev.to/lynkr/routing-down-is-easy-knowing-when-not-to-is-hard-why-cheap-models-break-your-coding-agent-4g33).

## What changed vs three months ago

1. **The floor rose.** A 16 GB laptop now runs a genuinely useful SIMPLE tier (Gemma 4). Six months ago that tier meant 3B models that couldn't be trusted with a paragraph.
2. **The open-weight ceiling now beats proprietary on some coding benchmarks** (GLM-5.2 > GPT-5.5 on SWE-bench Pro) — but at server scale, which *strengthens* the hybrid pattern: open models via cheap APIs up top, small open models on your metal below.
3. **MoE won.** Every serious June release is Mixture-of-Experts. For self-hosters this cuts both ways: better quality-per-active-param, but total memory footprints that keep the top tier out of reach.
4. **Licensing is consolidating** around MIT (DeepSeek) and Apache-2.0 (Qwen, Gemma) for the models you'd actually build on.

## Test on your traffic, not on benchmarks

Every number above is someone else's workload. The honest way to pick your local tier: route a week of your real traffic through whatever candidates fit your hardware, and count *session survival* — how often the local model's tool calls held up — not just benchmark deltas. That's a one-line config change per candidate, and your own telemetry will contradict at least one thing this post told you.

Lynkr is Apache-2.0, self-hosted, and treats every model above as a first-class routing tier: [github.com/Fast-Editor/Lynkr](https://github.com/Fast-Editor/Lynkr).
