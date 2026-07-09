---
title: "How a 13-Dimension Complexity Scorer Decides Which Model Gets Your Request"
published: true
tags: ai, opensource, node, architecture
canonical_url:
---

*Disclosure: I'm the author of [Lynkr](https://github.com/Fast-Editor/Lynkr), the open-source proxy whose internals this post walks through. All code shown is real and Apache-2.0 — [read it here](https://github.com/Fast-Editor/Lynkr/blob/main/src/routing/complexity-analyzer.js).*

The most expensive default in AI coding tools is that **model choice is a setting, not a decision**. You pick a model once; every request — "what does git stash do?" and "refactor this auth module" alike — goes there. Routing each request to the cheapest model that can actually handle it is worth 50%+ of most bills, but it only works if the "can actually handle it" judgment is reliable. Get it wrong downward and a small model fumbles your file edits; get it wrong upward and you've saved nothing.

Here's how Lynkr makes that judgment, in enough detail that you could reimplement it.

## Why not just count tokens?

The obvious heuristics fail in both directions:

- **"Long request → big model"** fails on a 60k-token context that's mostly grep output around a trivial question.
- **"Short request → small model"** fails catastrophically on "fix the auth bug in session.js" — eight words that unleash a tool-heavy agentic session a 7B model will faceplant on.

Token count is *one* signal. The failure cases all come from treating it as the only one.

## The architecture: weighted dimensions, then overrides

Every request gets a 0–100 score from 13 dimensions in four groups. The weights are configurable; these are the defaults:

```js
const DIMENSION_WEIGHTS = {
  // Content Analysis (35%)
  tokenCount: 0.08,
  promptComplexity: 0.10,   // avg sentence length/structure
  technicalDepth: 0.10,     // technical keyword density
  domainSpecificity: 0.07,  // security/ML/distributed/db/frontend/devops
  // Tool Analysis (25%)
  toolCount: 0.08,
  toolComplexity: 0.10,     // which tools, not how many
  toolChainPotential: 0.07, // "first...then", "step 2", sequencing language
  // Reasoning Requirements (25%)
  multiStepReasoning: 0.10,
  codeGeneration: 0.08,
  analysisDepth: 0.07,      // trade-off/comparison markers
  // Context Factors (15%)
  conversationDepth: 0.05,
  priorToolUsage: 0.05,     // tool_results already in the conversation
  ambiguity: 0.05,
};
```

A few design decisions worth stealing:

**Not all tools are equal.** A request that can `Grep` is not like a request that can `Bash`. Each tool carries a hand-tuned risk weight — `Bash` 0.9, `Write` 0.8, `Edit` 0.7, down to `Grep` at 0.2. A request whose available toolset averages 0.8 is an agentic mutation session; one averaging 0.25 is read-only research. Same tool *count*, completely different stakes.

**Subtract the harness baseline.** Claude Code ships ~14 tool schemas with *every* request, including "hello". If you count them naively, everything looks agentic and nothing routes local. The scorer subtracts the client's constant baseline and scores only the *effective* tools the request could plausibly use — one of those fixes that sounds trivial and changed everything.

**Conversation history is a signal.** Three `tool_result` blocks already in the conversation means you're mid-agentic-flow — this is not the moment to downgrade models and break the session's momentum. `priorToolUsage` and `conversationDepth` push mid-session requests up-tier.

**Ambiguity cuts the other way.** "file X, line 42, this error" is specific — a small model can act on it. "Something feels slow sometimes" needs interpretation before action. Specificity markers (paths, line numbers, error strings) *lower* the score.

## Overrides: the classifier knows what it can't know

Two pattern lists short-circuit the whole scoring pipeline:

- **Force-local:** greetings, acknowledgments, "what does X do" one-liners. Score 0, never leave the machine, no cloud tokens ever.
- **Force-cloud:** security-critical analysis, architecture decisions, anything matching high-risk patterns. Straight to the top tier regardless of how cheap it looks. A JWT-vs-cookies security question is short and toolless — every naive heuristic routes it local. This is the wrong request to save $0.004 on.

On top of the regex dimensions, an AST pass (tree-sitter) scores actual code structure in the payload — cyclomatic signals beat keyword counting when real code is present.

## From score to model

```
score < threshold        → SIMPLE   (e.g. ollama:qwen2.5:7b, free)
threshold..~65           → MEDIUM   (e.g. ollama:qwen2.5-coder, free)
above                    → COMPLEX  (your API key: Sonnet, GPT-4o...)
reasoning markers heavy  → REASONING (o3, DeepSeek R1...)
```

The threshold moves with a single mode switch — `aggressive` (60) routes more local, `conservative` (25) routes more to the cloud, default is 40. Multi-turn conversations score with a recency-weighted sliding window, so a short follow-up ("now add tests") inherits the complexity of the work it refers to instead of scoring as a trivial one-liner.

Crucially, **the classifier only chooses among models you listed**. It's not an autonomous agent picking providers — you define the tiers, it picks the tier.

## Does it work?

In my instrumented sessions, 70–90% of requests score SIMPLE or MEDIUM and run free on local models, while tool-heavy and security-flagged requests reliably escalate. The failure mode everyone fears — cheap model breaking an agentic session — is exactly what the tool weights, baseline subtraction, and prior-tool-usage dimensions exist to prevent.

Is 13 hand-weighted dimensions the optimal design? Almost certainly not — a learned router trained on outcome data would beat it eventually. But it's transparent (every routing decision logs its per-dimension breakdown), it's tunable, it runs in-process in microseconds, and it never sends your prompts to a third-party classifier API.

The whole thing is readable in one sitting: [src/routing/complexity-analyzer.js](https://github.com/Fast-Editor/Lynkr/blob/main/src/routing/complexity-analyzer.js). Steal the design or use the proxy — either outcome means fewer frontier-model tokens spent on `git stash` questions.
