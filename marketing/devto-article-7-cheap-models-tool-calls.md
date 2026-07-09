---
title: "Routing Down Is Easy. Knowing When Not To Is Hard: Why Cheap Models Break Your Coding Agent"
published: true
tags: ai, llm, opensource, devtools
canonical_url:
---

*Disclosure: I maintain [Lynkr](https://github.com/Fast-Editor/Lynkr), an open-source router whose design decisions this post explains. The failure modes described are patterns widely reported across router issue trackers and local-LLM forums — the examples are representative reconstructions, not captured transcripts. The problem is real either way; ask anyone who's routed a coding agent to a 7B model.*

Everyone who gets their first LLM router working does the same thing within the hour: point the expensive coding agent at a free local model and watch the bill drop to zero.

Then the agent tries to edit a file.

## The graveyard of downgraded sessions

If you browse the issue tracker of any Claude Code router — or r/LocalLLaMA on any given week — you'll find the same story in a hundred variations. The routing works perfectly. The *session* dies anyway. The killers, in rough order of frequency:

**1. Malformed tool arguments.** The agent decides to call `Edit`, and the model produces arguments that are *almost* JSON:

```json
{"file_path": "src/auth.js", "old_string": "if (token) {", "new_string": "if (token && !expired) {"
```

One missing brace. The harness rejects the call, the model retries, produces a different malformation, and you're three turns deep into fixing nothing. Frontier models emit structurally valid tool calls with boring reliability; sub-10B models do it *most* of the time — and "most of the time," at 30 tool calls per session, means every session breaks.

**2. Stale string matching.** `Edit`-style tools require the `old_string` to match the file exactly. Small models paraphrase from memory instead of quoting — they'll "remember" the line as `if (token) {` when the file says `if (accessToken) {`. The edit fails, the model re-reads the file, burns 2,000 tokens, tries again with a different paraphrase. This is the single most reported failure, because it *looks* like the router's fault and is actually a capability cliff.

**3. Hallucinated context.** Ask a small model to run tests and it may confidently call `Bash` with `npm test -- --grep "auth"` in a repo that uses pytest. It's not being stupid — it's pattern-completing from training data instead of the conversation, because instruction-following degrades faster than fluency as models shrink.

**4. The infinite loop.** The subtlest one: the model calls `Read` on the same file five times in a row, or greps, reads, greps the same term again. Weak models lose the thread of *what they already know* in long agentic contexts. Nothing errors — the session just stops converging while tokens burn.

Here's the uncomfortable part: **none of these are the router's bug, and all of them are the router's fault.** The router made a judgment — "this request is cheap-model-safe" — and the judgment was wrong.

## Why the obvious heuristics misjudge

Most routing setups decide with static rules: token thresholds, keyword lists, scenario slots. These fail in a specific, predictable way: **they measure the request's size, not its stakes.**

"Fix the auth bug in session.js" is eight words. Every token-based rule on earth routes it to the small model. But those eight words unleash a read-grep-edit-test loop — the exact workload where small models faceplant. Meanwhile, "explain the difference between optimistic and pessimistic locking, with examples" looks expensive (long answer, technical vocabulary) and is actually *perfectly* cheap-model-safe: it's pure text generation, no tool calls, no exact string matching, nothing to break.

Size and stakes are almost uncorrelated in agentic traffic. That's the whole problem.

## What "stakes-aware" routing looks like

When I built [Lynkr](https://github.com/Fast-Editor/Lynkr)'s router, most of the design ended up being about *when not to save money*. The parts that matter:

**Weight the tools, not just their count.** A request where `Grep` and `Read` are in play is research — paraphrase-tolerant, failure-tolerant, ideal for a local model. A request where `Bash`, `Write`, or `Edit` will fire is a mutation with exact-match requirements. Lynkr assigns each tool a risk weight (`Bash` 0.9, `Write` 0.8, `Edit` 0.7 … `Grep` 0.2) and scores the request's *effective* toolset. Two requests with five tools each can land tiers apart.

**Treat mid-session as a signal.** If the conversation already contains three tool results, you're inside an agentic flow with accumulated exact-state (file contents, error strings). Downgrading the model mid-flow throws away the one thing that was keeping the loop convergent. Prior tool usage and conversation depth push requests *up*-tier even when the latest message is short.

**Subtract the harness baseline.** Claude Code ships ~14 tool schemas with every request — including "hello." Count them naively and everything looks agentic, so nothing ever routes local and you save nothing. Score only the tools the request could plausibly use, and the safe majority routes down while the risky minority stays up.

**Some patterns override everything.** Greetings and "what does X do" questions force-route local, always. Security-sensitive analysis force-routes to the strong tier, always — a JWT architecture question is short, toolless, and precisely the wrong place to save four cents.

The result on my own traffic: 70–90% of requests route to free local models — but they're the *right* 70–90%, which is the entire difference between "my bill dropped" and "my agent broke."

## Takeaways, router-agnostic

1. **Route research down, mutations up.** If your router can't tell a `Grep` request from an `Edit` request, it isn't routing — it's gambling on which sessions break.
2. **Never downgrade mid-loop.** Model consistency across an agentic sequence is worth more than the marginal savings of one cheap turn.
3. **Measure session survival, not just cost.** A routing setup that saves 60% and breaks one session in five is more expensive than the bill it replaced — you're paying in re-runs and rage.
4. **The ceiling is rising.** Local models' tool-calling improves every quarter; the set of safely-downgradable requests grows with it. A router with per-tool judgment gets to expand that set gradually. A token threshold has to guess again from scratch.

The router's job was never "pick the cheapest model." It's "pick the cheapest model *that won't break the session*" — and those five extra words are where all the engineering lives.

The scorer described here is ~1,000 lines of readable Apache-2.0 JavaScript: [src/routing/complexity-analyzer.js](https://github.com/Fast-Editor/Lynkr/blob/main/src/routing/complexity-analyzer.js). Steal the design, or file an issue telling me where it misjudges — the failure cases are the interesting part.
