# External Routing Critiques vs Lynkr — Scorecard (September 2026)

Two public threads criticized prompt-level model routing the week of 2026-09-22:
**Theo (@theo)** on Jev-based routing ("system one, zero context, mid-task
downgrades don't save money, bench it"), following OpenRouter's launch of
`typesafe/jev-router` and his DeepSWE bench of it (80% @ $1.50/task @ 19.9 min
vs GPT-6 Astra low 80% @ $1.46 @ 4.6 min); and **Kun Chen (@kunchenguid)**
("request-level routing can't work; caching forbids mid-session switches;
routing belongs in the harness"). This doc records which claims are true for
Lynkr specifically, with evidence. Verdicts were established during the
2026-09-22 → 09-26 routing work (TaskBand, passthrough fixes, envelope
hardening) and three live Cursor incidents.

## Theo's claims

| Claim | True for Lynkr? | Evidence |
|---|---|---|
| "Jev has literally zero context — system, tools, agent constraints" | **No** | Jev state carries `tools_attached`/`effective_tools` (client-profile baseline subtracted), `has_tool_history`, task context, behavioral buckets (`last_turn_tools/errors`). `jev-router.js` `buildJevState`, `task-ledger.js` `buildJevSignals`. |
| "Jev doesn't think, so it can't be trusted to route" | **No, by design** | Jev is a second opinion: 0.3 confidence cut, one-band-up cap (cap bypass in `jevTierOverride` found and fixed 09-22). Worst-case judge error costs one band for one turn. |
| "Routing to a dumber model mid-task doesn't save money; cache writes dominate" | **Was true; fixed 09-24** | The passthrough downgrade gate demoted COMPLEX tasks to Haiku mid tool-loop (telemetry: `downgrade_break_even_cleared` → `downgrade_cache_stale` cascade). Fixed: `tool_loop_hold`, flat-rate gate, upgrade-pin persistence. Metered path always had break-even math (`cache-switch-cost.js`). |
| "Can't know if 'port this to Rust' is 100 lines or a million" | **Partially yes** | First turn of a fresh task has no repo signal — anchor + Jev score task-type, not situational difficulty. Bounded: caps limit the error to one band; TaskBand floors follow-ups at the band the task *earned*. Blindness is per-decision, not per-task. |
| "Bench it — exact numbers" | **Yes, fully (open)** | Ground truth is a heuristic quality score; no offline eval yet proves routed > fixed. Addressed by: DeepSWE 4-arm bench (in progress), TwinRouterBench Phase 1, follow-up eval harvest. |

## Kun Chen's claims

| Claim | True for Lynkr? | Evidence |
|---|---|---|
| "A prompt without surrounding context isn't enough signal" | **Partially yes** | Same first-turn blindness as above (his toy-repo vs linux-kernel example). Open mitigation ideas: repo-aware signals via `code-graph`, paired-context probe to quantify. |
| "Request-level routing won't work; a gateway must assume one continuous session" | **No — disproven here** | TaskBand does task segmentation, earned-difficulty tracking, and continuation floors *at the gateway* from the resent transcript (`task-ledger.js`, `session_task_state`). Coding harnesses resend the whole conversation; the gateway is not blind to task structure. |
| "Prompt caching makes mid-session model changes uneconomic" | **Policy: no. Plumbing: unverified** | Policy is enforced (break-even gate, `tool_loop_hold`, boundary-only switching). Open question: whether `cache_control`/cache-read tokens survive Lynkr's proxying on the metered Anthropic path — Aug 2026 found prefix rewriting broke GPT caching until the prefix-stable pipeline; Anthropic-path equivalent untested. The DeepSWE smoke test measures this. |
| "Routing belongs in the harness: dig-then-delegate multi-agent" | **No (complementary, not competing)** | Lynkr routes each subagent stream independently under any multi-agent harness. Harness-level dig-then-delegate has an unpriced cost (frontier tokens deciding whether frontier is needed) and is harness-locked; a gateway prices every stream across Claude Code/Cursor/Codex uniformly. The one piece Lynkr lacks from his vision is the pre-dig (same gap as row 1). |

## The two real gaps (everything else is engineered around or false)

1. **First-decision context blindness.** No repo introspection at turn one of a
   fresh task. Mitigations in place bound the cost (one band, one turn, TaskBand
   recovery); the actual fix would be repo-aware difficulty signals.
2. **Unproven claims.** Both threads reduce to "show numbers." Open work:
   DeepSWE 4-arm bench (score / $/task / min/task for routed vs fixed-cheap vs
   frontier-direct vs frontier-via-proxy), cache-passthrough verification,
   TwinRouterBench regression gate.

## Field note: what actually fails in practice

The week's three live incidents (Cursor traffic) are the empirical footnote to
both threads: in every failure the *system-one categorizers were right* (anchor
score 10, Jev SIMPLE @ 0.89 on "Hi") and a **deterministic non-learning layer**
overrode them — shortfall's capability fallback, the risk regexes reading
Cursor's `<rules>` envelope, the break-even gate mispricing a flat-rate path.
The critics' fear is a dumb judge; the observed failure mode is overconfident
machinery *around* the judge. All three closed 09-24 → 09-26 (`shortfall.js`
tier-before-cost + humility gate, `harness-envelope.js`, `tool_loop_hold`).
