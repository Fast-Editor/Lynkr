# Terminal-Bench: Lynkr vs openrouter/auto vs vLLM Semantic Router

**Dates:** September 30 – October 6, 2026
**Benchmark:** [Terminal-Bench](https://github.com/laude-institute/terminal-bench) core 0.1.1 — 80 command-line tasks
(forensic recovery, kernel and initramfs builds, git surgery, data pipelines, model training), each run by the
reference Terminus agent inside a container and scored pass/fail by a hidden test suite. Agents get a per-task
time budget (mostly 360 s) and up to 50 turns. No partial credit, no human in the loop.
**Question:** which router gives the best accuracy per dollar on a real multi-turn agent workload — not a quiz.

## Headline results

All runs on one Azure `Standard_D32s_v3`, concurrency 8, one attempt per task. Costs are provider-billed
(cache-aware; DeepSeek at its published off-peak rate).

| Router | Resolved | Cost / run | Cost / solved task | Agent timeouts | Calls > 300 s |
|---|---|---|---|---|---|
| **Lynkr** (tier routing, 2 models) | **42 / 80** · three runs: 39, 39, 42 | **$1.54** (runs: $1.14, $1.28, $1.54) | **$0.037** | 10 | 0 |
| openrouter/auto | 44 / 80 · two runs: 41, 44 | $4.72 ($4.31) | $0.107 | 9 | — |
| vLLM Semantic Router v0.4 | 25 / 80 | $0.57 † | $0.023 † | 34 | 48 |

† Semantic Router's low cost is not a saving: it made 580 model calls where Lynkr made 1,203, because tasks
died early (see below). Treat its cost-per-solved as misleading.

**Reading the table.** A single 80-task run swings ±3–4 tasks between identical reruns (Lynkr's three runs on
one configuration: 39, 39, 42; auto's two: 41, 44). Lynkr and openrouter/auto are tied on accuracy within that
noise. They are not tied on cost: Lynkr spends about 30 % of auto's budget on the same tasks, and that gap held
in every run. Semantic Router is a clear third on this workload for reasons that have nothing to do with its
classifier (details in [Finding 4](#finding-4-vllm-semantic-router-lost-on-gateway-mechanics-not-routing)).

## Setup

**Lynkr configuration** (final, runs v13–v15):

| Tier | Model | Host (via OpenRouter, pinned) | Reasoning | Output cap | Upstream timeout |
|---|---|---|---|---|---|
| SIMPLE, MEDIUM | `z-ai/glm-5.3-flash` | Friendli, failover Parasail | low | 16 384 | 90 s |
| COMPLEX, REASONING | `deepseek/deepseek-v4.1-flash` | DeepSeek official | medium | client's 64 000 | 150 s |

Routing: anchor-embedding intent score + Jev judge + session pins; structured output (`output_format`) forwarded
as strict `json_schema` where the host supports it, `json_object` otherwise. kNN, shortfall, risk/force keyword
escalators, the format guard and every prompt-mutating feature (TOON, history compression, caveman) were off.
`FALLBACK_ENABLED=false`.

**openrouter/auto:** Terminus → LiteLLM → `openrouter/auto`, no settings exposed. Served 97 % / 100 % of calls
with `deepseek/deepseek-v4.1-flash`, mostly at Together ($0.30 / $1.20 per M).

**vLLM Semantic Router 0.4.0:** `vllm-sr serve --minimal` (router + Envoy, CPU), policy = exemplar-contrast
complexity signal OR keyword markers → strong lane, else cheap lane; static selection; caches and plugins off.
Backends were the **same two models on the same hosts at the same effort and output caps as Lynkr**, pinned
through OpenRouter presets (`@preset/…` selectable by model name). The strong lane ran without a
`response_format` because DeepSeek official rejects `json_schema` and the router has no `json_object`
downgrade (Lynkr does).

**Client:** Terminus via LiteLLM — Anthropic adapter for Lynkr (`ANTHROPIC_API_BASE`), OpenAI provider for the
other two. All three arms received identical prompts and the same JSON response schema.

## Finding 1: openrouter/auto is one model

Parsed from auto's own debug logs: 1,250 of 1,294 calls in the first run and 1,309 of 1,309 in the second went
to `deepseek/deepseek-v4.1-flash`. "Auto" was not choosing between models on this workload; it was choosing
between *hosts* for one model — Together, DeepInfra, Fireworks, BaseTen — and paid Together's $0.30 / $1.20
for most of them. DeepSeek sells the same weights at $0.15 / $0.60 off-peak. Roughly half of Lynkr's cost
advantage is simply pinning the strong tier to the cheapest host that serves the model; the other half is
the cheap tier taking the tasks where paying for DeepSeek buys nothing.

Consequence: Lynkr's strong tier *is* auto's model, so Lynkr can at best tie auto on accuracy with a two-model
ladder. Every point it drops is a task the cheap tier got that DeepSeek would have solved.

## Finding 2: both routers lose the same tasks

Of 80 tasks, 34 failed for every router in every run. The failure modes in Lynkr's final run:

| Mode | Tasks | Routing can fix it? |
|---|---|---|
| model declared "done", tests disagreed | 21 | no — model ceiling |
| agent out of time (downloads, training, long builds) | 9 | no |
| benchmark test window too short for its own setup | 6 | no — dataset design |
| Docker image won't build | 3 | no |
| 50-turn cap | 1 | no |

The contested set is seven tasks, four of which flip between identical reruns.

## Finding 3: the gateway decided more than the classifier

Getting Lynkr from 3 / 80 (first run) to 42 / 80 took fourteen iterations. Almost none were about choosing
models. In order of impact:

1. **Injected tool definitions.** Lynkr added 12 Claude Code tool schemas to every tool-less request; a
   JSON-command agent became a tool-calling agent. Removed.
2. **Silently swapped model.** A provider served its configured default instead of the tier's model for two
   full runs while telemetry recorded the requested name. Now every call verifies the served model
   (`[ModelCheck]`) and provider (`[ProviderCheck]`).
3. **Dropped response schema.** The client's `output_format` never reached the model; schema violations went
   from 47 per run to 0 once forwarded (and the XML tool-call extractor stopped mangling JSON replies).
4. **Slow cheap host.** The cheapest glm host ran at 32 tokens/s and timed out 11 tasks; load-tested
   alternatives at the same price ran at 180 tokens/s. A model is a (weights, host, settings) triple.
5. **No upstream timeout.** One stalled call ran 846 s. Per-model timeouts with failover down the pinned host
   list and a per-model output cap now bound a runaway to ~90 s.
6. **A $4 / $20 fallback model** waiting behind failures. Disabled.

## Finding 4: vLLM Semantic Router lost on gateway mechanics, not routing

Its routing decisions were sane — a 76 / 24 cheap-to-strong split close to Lynkr's 67 / 33, and the hard-task
lane caught the forensic and build tasks. It still solved 25 / 80 with 34 agent timeouts. Why:

| Cause | Measured | Lynkr on the same hosts |
|---|---|---|
| No upstream timeout or failover | 48 calls > 300 s (33 glm, 15 DeepSeek), longest 1 214 s = the Envoy listener limit | 0 calls > 300 s; cut at 90 / 150 s, 11 failovers |
| Classifier runs every turn | complexity embedding on CPU: median 2.0 s, p90 3.7 s per call, no session pinning without an `x-session-id` header | ~0 after the first turn (session pins) |
| Strict response codec | 10 empty upstream replies → hard errors → 30 harness retries → tasks lost | tolerated / retried upstream |

Head to head: zero tasks only Semantic Router solved vs Lynkr, 17 only Lynkr solved; vs auto, 1 vs 20. Of its 34
timeouts, Lynkr solved 12 and auto 16.

Fair caveat: this is their router on a CPU box routing to vendor APIs, not the GPU-backed vLLM pool it is
designed around. On GPUs the classifier is ~10× faster and stalled hosts are theirs to fix. The point stands for
anyone routing to vendors: timeouts, failover, pins and served-model checks moved the result more than any
classifier did.

## Finding 5: structural difficulty scoring is theater

Lynkr's complexity analyser (message length, tool count, code blocks, turn count, keywords) scored all 80 task
instructions between 0.11 and 0.34 on a 0–1 scale — "create hello world" and "recover a password from a raw
ext4 image" within a few points. Those dimensions measure what a request *looks like*. What separated the tasks
was semantics: the anchor-embedding score and the 100 ms judge call. The shortfall cost optimiser had been fed
the structural score and ignored the semantic ones; it now takes the per-head max of both.

Even then, predicted difficulty explains much less of pass/fail than hoped. A new exemplar-contrast complexity
signal reaches leave-one-out AUC **0.68** against pass/fail (anchor 0.52, structural 0.46); the in-sample 0.87
was leakage and is not the number to quote.

## What changed in Lynkr (all in [PR #120](https://github.com/Fast-Editor/Lynkr/pull/120))

- Declarative routing: `config/routing.json` — named signals combined by AND/OR/NOT rules into prioritised
  decisions with per-decision tier, reasoning effort, host preference and plugins; observe vs enforce mode;
  `lynkr route --preview` explains any request; `lynkr audit <session>` prints the per-turn ledger.
- Turn-outcome attribution: each turn classified progress / no-progress / regression / provider-error /
  tool-error / missing, with environment noise never training the policy; a switch gate with hysteresis
  (observe mode) built on it.
- Provider layer: per-model host pin, upstream timeout, failover, output cap, served-model and served-provider
  verification, provider-reported cost accounting incl. cache reads.
- Request fidelity: structured output forwarded, JSON replies skip the XML extractor, structured requests
  bypass the response cache, no injected tools, format guard opt-out.
- Measurement tooling: `scripts/calibrate-capabilities.js` (per-model capability profiles from solo runs),
  `scripts/cache-probe.js`, a 77-fixture routing corpus gate in `test:unit`.
- Tried and shelved, with numbers: NLI grounding of completion claims (caught 3 / 28 false completions, flagged
  4 / 39 true ones — no signal on this benchmark); stuck-loop escalation and completion verification (cost more
  tasks than they saved with these models).

## Caveats

- Single attempts: ±3–4 tasks of noise per run. No accuracy claim finer than "tied" is supported. Cost
  differences are far outside noise.
- Lynkr set reasoning effort per tier; auto ran its model at default (it exposes no such knob). Both clients
  sent identical requests with no effort parameter — this is a router feature difference, stated here so it is
  not mistaken for rigging. Reasoning was 84 % of auto's output tokens.
- Three of the 80 task images do not build on current base images; every arm loses them.
- The original auto run (41 / 80, $4.31) was on a smaller VM at concurrency 4 before the resize; the 44 / 80,
  $4.72 rerun is the like-for-like number.
- A two-model ladder is the least interesting case for a cost optimiser. Lynkr's shortfall/capability machinery
  needs three or more models of graded capability and measured profiles to do more than mirror the tier config.

## Reproduce

```bash
# Lynkr arm (TIER_* and OPENROUTER_* as in the setup table; see .env.example)
ANTHROPIC_API_BASE=http://localhost:8081 ANTHROPIC_API_KEY=x \
  tb run --dataset terminal-bench-core==0.1.1 --agent terminus \
  --model anthropic/claude-sonnet-4-5 --n-concurrent-trials 8 --output-path ./tb-lynkr

# openrouter/auto arm
OPENROUTER_API_KEY=… tb run --dataset terminal-bench-core==0.1.1 --agent terminus \
  --model openrouter/openrouter/auto --n-concurrent-trials 8 --output-path ./tb-auto

# cost from Lynkr telemetry (provider-reported tokens, cache-aware)
python3 scripts/cost_from_telemetry.py <min_telemetry_id>
# fit capability profiles from measured solo runs
node scripts/calibrate-capabilities.js --model openrouter:z-ai/glm-5.3-flash --model openrouter:deepseek/deepseek-v4.1-flash=./tb-auto --dry-run
```

Raw run directories, per-episode prompts and replies, and the telemetry rows behind every number above are
retained; ask in the repository issues if you want them.
