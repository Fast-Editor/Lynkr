---
title: "Lynkr vs claude-code-router: Static Rules vs a Complexity Classifier"
published: true
tags: ai, opensource, devtools, claude
canonical_url:
---

*Disclosure: I'm the author of [Lynkr](https://github.com/Fast-Editor/Lynkr). claude-code-router is a genuinely good project that pioneered this category — this is a technical comparison of two different approaches, not a takedown. Where CCR is the better choice, I say so.*

If you want to keep the Claude Code harness but route requests to other models, you have two main self-hosted options today: [claude-code-router](https://github.com/musistudio/claude-code-router) (CCR, ~35k stars, the incumbent) and [Lynkr](https://github.com/Fast-Editor/Lynkr). They solve the same problem with fundamentally different architectures, and which one fits you depends on how much you want to configure versus delegate.

## The core difference in one paragraph

**CCR routes by scenario rules you write.** It has slots — `default`, `background`, `think`, `longContext` (triggered above a token threshold), `webSearch`, `image` — and you assign a model to each. It's predictable, transparent, and entirely under your control.

**Lynkr routes by scoring the request itself.** Every request gets a 0–100 complexity score computed from 13 weighted dimensions — token count, technical keyword density, tool complexity, multi-step reasoning markers, conversation depth, ambiguity, and so on — and lands in a tier (`SIMPLE`/`MEDIUM`/`COMPLEX`/`REASONING`) you've mapped to models. You configure the tiers once; the classifier decides per-request.

## Where CCR wins

- **Maturity and ecosystem.** 35k stars, ~730k monthly npm downloads, 20+ provider transformers, custom JS plugins, a web UI, and in-session `/model` switching. If you hit a weird provider quirk, someone has already hit it.
- **Predictability.** A rule is a rule. If you want *"long contexts always go to Gemini"*, CCR expresses that in one line and never surprises you.
- **Claude Code specialization.** CCR does one client deeply. Lynkr supports Claude Code, Cursor, Codex CLI, Cline, and Continue — breadth costs some depth.

## Where the rule-based approach breaks down

Browse CCR's issue tracker (~1,000 open issues) and one complaint dominates: **tool-calling breakage on downgraded models** — failed file edits, broken git operations, agents going in circles. The root cause usually isn't CCR's code. It's that static rules can't see *what the request needs*:

- A short prompt ("fix the auth bug in session.js") looks cheap by token count — but it's an agentic, tool-heavy task that a small local model will fumble.
- A long context triggers the `longContext` rule — but if it's 60k tokens of grep output around a trivial question, an expensive long-context model is wasted money.

Token counts and scenario names are proxies. The thing you actually care about — *can a cheap model handle this without breaking the session?* — requires looking at the request's structure.

## What Lynkr does differently

Three things, all absent from CCR by design (it aims to be a lean router):

**1. The complexity classifier.** Requests with agentic signals (write/edit/bash tool availability, prior tool results in the conversation, sequential-step language) score into higher tiers even when they're short. Trivia stays local even when the context is long. Force-patterns short-circuit both ways: greetings never hit the cloud; security-critical analysis never gets downgraded. The design goal is exactly the failure mode above — *route down only when the answer will still work*.

**2. Token optimization on the wire.** Lynkr strips tool schemas the request can't use (measured: **53% fewer tokens** on a realistic 14-tool Claude Code request) and compresses large JSON tool results before they hit the model (measured: 3,458 → 427 tokens on a 60-match grep result). CCR forwards requests as-is.

**3. Semantic caching.** Paraphrased repeat questions are served from an embedding cache in ~171ms with zero tokens billed.

## Honest comparison table

| | claude-code-router | Lynkr |
|---|---|---|
| Routing logic | Scenario rules + token threshold | 13-dimension complexity score → tiers |
| Configuration | Per-scenario, per-provider (flexible, verbose) | Pick 4 tier models via `lynkr init` wizard |
| Tool-schema stripping | No | Yes (−53% measured) |
| JSON tool-result compression | No | Yes (TOON + field stripping) |
| Semantic cache | No | Yes |
| Clients | Claude Code (deep) | Claude Code, Cursor, Codex CLI, Cline, Continue |
| Provider transformers/plugins | 20+, custom JS | 13 providers built-in |
| Ecosystem maturity | ~35k stars, huge community | Young (~500 stars), one maintainer |
| In-session model switching | Yes (`/model`) | No (automatic per-request) |
| License | MIT | Apache-2.0 |

## Which should you use?

- **You want explicit control and a battle-tested ecosystem** → CCR. It's the safe default and its community is unmatched.
- **You're tired of tuning rules, or your cheap-model sessions keep breaking** → try Lynkr. The classifier exists precisely because static rules degrade on agentic workloads.
- **Your bill is dominated by tool output and repeated context** → Lynkr, regardless of routing preference; the compression and caching layers work even if you route everything to one model.

Both are self-hosted, free, and take five minutes to try. Run your own workload through each and compare the token logs — that's the only benchmark that matters. Mine are reproducible here: [github.com/Fast-Editor/Lynkr](https://github.com/Fast-Editor/Lynkr/blob/main/BENCHMARK_REPORT.md).
