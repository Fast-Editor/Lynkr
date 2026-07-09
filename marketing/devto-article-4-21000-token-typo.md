---
title: "The 21,000-Token Typo: Where Agentic Coding Budgets Actually Die"
published: true
tags: ai, productivity, devtools, llm
canonical_url:
---

*Disclosure: I maintain [Lynkr](https://github.com/Fast-Editor/Lynkr), an open-source proxy mentioned at the end. The first 80% of this post is tool-agnostic and the takeaways apply whether or not you ever use it.*

There's a [documented case](https://www.cyfrin.io/blog/expensive-and-slow-for-small-changes-why-ai-coding-agents-can-be-overkill) of a coding agent burning **21,000+ input tokens to fix a one-line README typo**. Not a bug. Not a runaway loop. That's the normal cost structure of agentic coding, and once you see why, you can't unsee it on your own bill.

Stanford's Digital Economy Lab [measured it](https://digitaleconomy.stanford.edu/news/how-are-ai-agents-spending-your-tokens/): agentic tasks consume on the order of **1000x the tokens of ordinary code chat**, and the *same task with the same agent* can vary 30x in cost depending on how the session unfolds. Teams running heavy automation report $500–$2,000 per engineer per month. So where does it go?

## The anatomy of one "small" agentic task

Say you ask your agent to fix a typo. Here's what actually crosses the wire:

**Turn 1:** Your one-line prompt... plus the system prompt, plus ~14 tool schemas (Write, Edit, Bash, Grep, Git — a couple thousand tokens before anyone thinks).

**Turn 2:** The agent greps for the file. The result comes back as JSON — paths, line numbers, match context, metadata. A modest grep is easily 1,000–3,000 tokens. It's now in the context **and gets re-sent on every subsequent turn**.

**Turn 3:** The agent reads the file. Add the full file contents to the context. Re-sent every turn from now on.

**Turn 4:** The edit itself — the cheapest part of the entire session.

**Turn 5:** Verification: re-read, maybe run a linter, another JSON blob of output.

Five turns, and your one-line fix carried: 5x the tool schemas, 4x the grep results, 3x the file contents. Input tokens dominate output roughly **25:1** in typical sessions. You're not paying for intelligence — you're paying for *cargo*.

## The three structural leaks

**Leak 1: Tool schemas on every request.** The agent might use two tools this session. You ship fourteen schemas every turn anyway, because the client doesn't know which ones matter. Measured on a realistic Claude Code request: schemas the request couldn't use accounted for **53% of billed input tokens**.

**Leak 2: Raw JSON in the context window.** JSON is the least token-efficient format your context will ever hold — keys repeated per element, quotes, braces, whitespace. A 60-match grep result: ~3,400 tokens raw, **427 after conversion to a tabular token-oriented format** with redundant fields stripped. Nothing lost that the model needed.

**Leak 3: Frontier models on non-frontier requests.** "What does git stash do?" does not need the same model as "refactor this auth module." But your client sends both to the same place, because model choice is a config setting, not a per-request decision. In my instrumented sessions, **70–90% of requests scored as simple or medium complexity** — they'd be fine (and free) on a local model.

## What to do about it — tool-agnostic

1. **Instrument before optimizing.** Log tokens per request by category (schemas / tool results / conversation). You cannot fix a leak you haven't sized. Most people find their intuition about their own spend is wrong.
2. **Never let raw JSON accumulate in a context window.** Compact it, tabularize it, or summarize it. Tabular JSON is nearly free compression — same information, a fraction of the tokens.
3. **Keep sessions short and contexts clean.** Every tool result you leave in the context is a recurring charge, billed again on every turn until the session ends.
4. **Match model to request, not to workflow.** Route the easy 80% somewhere cheap or local; reserve the frontier model for the requests that actually exercise it. Bring your own API keys and the routing is entirely within your control.

## The plumbing version

Everything above can be done manually. I got tired of doing it manually, so I built it into a proxy: [Lynkr](https://github.com/Fast-Editor/Lynkr) sits between your coding tool (Claude Code, Cursor, Codex CLI) and your providers, strips unusable tool schemas, compresses JSON tool results, caches semantically, and scores each request on 13 dimensions to route it to a tier you define — local Ollama for the easy stuff, your API keys for the hard stuff. Self-hosted, Apache-2.0, no markup, zero client changes.

But the numbers above aren't about my tool. They're about a cost structure every agentic workflow shares. The 21,000-token typo isn't an outlier — it's the default. Measure yours.
