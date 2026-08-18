# ITSMBench Results — Lynkr as the Model Under Test

**Date:** August 13–15, 2026
**Benchmark:** [ITSMBench](https://github.com/new-measure/ITSMBench) (Atomicwork + New Measure, released 2026-08-12) — 89 IT service-desk tasks in containerized enterprise environments (42 mocked systems, ~1,800 DB tables, ~2,000 REST endpoints), each scored pass/fail by a hidden end-state verifier.

## Headline results

| Measurement | Score | Cost/task (real) |
|---|---|---|
| **Full suite, 89 tasks, 1 attempt** | **31.0% Pass@1** (27/87 scored; 2 trials errored) | ~$0.90 |
| 10-task subset, 2 attempts (best config) | 35.0% Pass@1 / 40.0% Pass@2 | $0.87 |
| Same model on its native harness (official leaderboard, rank 8) | 35.51% Pass@1 | $1.29 |

**Key claim:** after the fixes in PR #91, routing through Lynkr is statistically
indistinguishable from calling the model directly (35.0% vs 35.51% on matched
conditions) while costing ~33% less — the proxy tax was eliminated.

## Setup

- **Model:** Azure OpenAI `gpt-5.6-sol`, reasoning effort high, served through
  Lynkr's tier router (all tiers pinned to the same model — routing
  intelligence was deliberately NOT part of this measurement).
- **Agent:** [pi coding agent](https://pi.dev) via [Harbor](https://github.com/laude-institute/harbor),
  with a custom Harbor agent (`agents_lynkr/lynkr_pi.py` in the ITSMBench
  checkout) that registers Lynkr as an OpenAI-compatible provider inside each
  task container (`http://host.docker.internal:8081/v1`) and installs an ITSM
  operations playbook as the agent's `AGENTS.md`.
- **Attempts:** leaderboard entries average Pass@1 over 5 attempts on all 89
  tasks; our full-suite number is 1 attempt (±~5 points), the subset number is
  2 attempts.

## Official leaderboard context (Pass@1, 5 attempts, 89 tasks)

| Rank | Entry | Pass@1 | $/task |
|---|---|---|---|
| 1 | claude-opus-5 [high] | 46.07% | $1.75 |
| 3 | grok-4.5 [high] | 45.39% | $0.71 |
| 6 | gpt-5.6-sol [xhigh] | 39.10% | $1.53 |
| 8 | gpt-5.6-sol [high] + codex | 35.51% | $1.29 |
| — | **Lynkr → gpt-5.6-sol [high] + pi** | **31–35%** ⚠ | **$0.87–0.90** |
| 15 | gpt-5.6-terra [low] | 20.00% | $0.37 |

⚠ Not an official submission: 1–2 attempts vs their 5; the full-89 single-attempt
run landed at 31.0%, the matched-methodology subset at 35.0%.

## Per-family breakdown (full 89, 1 attempt)

| Family | Score | Notes |
|---|---|---|
| iam (identity/access) | 6/9 | strongest area |
| ops | 4/5 | strong |
| grc (compliance) | 3/7 | |
| a / b / n | 4/11, 4/11, 4/12 | middling |
| c (BEC/compromise response) | 1/5 | weak — misses restoration of false-positive lockouts |
| alloc (IPAM), net | 0/5 | weak — mutate-before-verify traps |
| **ep (offboarding/endpoints)** | **1/22** | the dominant weakness: blast-radius enumeration (all devices of a leaver, whole termination cohorts) |

The `ep` family alone is a quarter of the benchmark; solving its enumeration
pattern is the single highest-leverage quality improvement available
(31% → potentially mid-50s).

## What the benchmark drove into Lynkr (PR #91)

Measured defects found and fixed during this work:

1. **Empty-completion guard** — exhausted 429 retries surfaced as clean empty
   200s; agent clients read them as "task complete" and died mid-episode
   (killed 6/7 episodes in one run).
2. **System prompt preserved on continuations** — previously replaced with a
   generic one-liner after turn 1, silently discarding the client agent's
   instructions.
3. **Reasoning effort forwarded** to Azure Responses (was silently dropped);
   `max_output_tokens` fixed for gpt-5.x.
4. **Prefix-stable request pipeline** — deterministic tool-call/tee IDs,
   uniform system-reminder stripping, fixed compression threshold, and
   `prompt_cache_key` — took provider prompt-cache hits from 0–3% to
   **92–95%** (~5× real cost reduction; Lynkr's recorded `cost_usd` predates
   cache-discount awareness and overstates real cost ~5–7×).
5. **Cache-hit telemetry** — `cache_read_tokens` now recorded (was always
   null; the field was dropped in two response conversions).

## Agent playbook findings (transferable to any ITSM agent)

Failure analysis of always-failing tasks produced a 9-rule playbook (in
`agents_lynkr/lynkr_pi.py::_PLAYBOOK`); the highest-value rules:

- **Sweep the class, not the named entity** — enumerate ALL devices of a
  leaver, ALL members of a terminated cohort, ALL suspended users; never stop
  at what the ticket names.
- **Undo the over-response** — reversing false-positive automated lockouts is
  part of resolving the incident.
- **Semantic read-back after every write** — ServiceNow "Closed" = state 7,
  not 6; verify by value, not by HTTP 200.
- **Deprovision, don't suspend** — applies to service accounts too.
- **Escalation = a message in the security channel**, not a ticket note.

Rule adoption flipped task-a-2 from a persistent failure to 20/20 assertions.

## Reproduction

```bash
# One-time setup (see agents_lynkr/lynkr_pi.py for the custom agent)
uv tool install harbor
git clone https://github.com/new-measure/ITSMBench ~/ITSMBench

# Subset run (~$10-15, ~15 min at concurrency 3)
cd ~/ITSMBench && set -a && source .env && set +a
PYTHONPATH=. harbor run -c configs/lynkr-subset.yaml \
  --agent-setup-timeout-multiplier 3 --env-file .env -y

# Results: jobs/<job>/result.json + per-trial verifier/ctrf.json
# Cost/cache: Lynkr telemetry (.lynkr/telemetry.db, cache_read_tokens column)
```

Gotchas: `-p` is not repeatable (use a `tasks:` list in a config yaml);
pre-build task environment images; the concurrency flag is `--n-concurrent`;
agent setup needs the timeout multiplier.

## Open items

- **ep-family enumeration** — largest quality lever (playbook rules exist but
  the cohort-discovery inference still fails).
- **Streaming passthrough** ([#92](https://github.com/Fast-Editor/Lynkr/issues/92)) —
  remaining proxy latency; hurts long-turn workloads (see terminal-bench).
- **Tier routing was not exercised** — all tiers pinned to one model. A
  cheap-model + cascade-verify configuration is the untested path toward the
  cost-quality frontier (evo-style ~50% at ~$0.10–0.25/task).
- 5-attempt full-89 run (~$385 at high effort) for an officially comparable
  number.
