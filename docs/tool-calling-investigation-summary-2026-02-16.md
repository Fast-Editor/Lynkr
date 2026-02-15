# Lynkr Local Tool-Calling Investigation (Summary)

Date: 2026-02-16 (local)  
Workspace: `/Users/malone/Lynkr`  
Current branch: `codex/ollama-qwen3-tool-ab`  

## 1. Why this doc exists
This is a compact record of what we tried, what actually worked, what failed, and why we decided to move forward with API models for now.

## 2. Final decision
Use API-backed models for tool-reliable Lynkr workflows now.  
Keep local Ollama tool-calling as an experiment track and revisit after upstream fixes.

## 3. What we tested

### A. Phase progression already completed
- Phase 0-5 completed and checkpointed.
- Phase 6 stage-1 side-by-side cutover was completed and documented.

Relevant checkpoints:
- `4561b99` fix: prevent `/v1/messages` `dbPath` ReferenceError
- `09dc725` phase4: MLX-aware routing + tests
- `5a4ecce` phase5: launchd + health checks
- `b5e9ea4` phase6 stage-1 report
- `634c532` fix: MLX-aware routing headers behavior

### B. Local-model strict tool-call probes (historical session results)
- `LIQUID_STRICT_SUMMARY pass=0 raw=0 fail=5 avg_ms=2976 tool_exec_sum=0 nonzero_steps=0`
- `QWEN3_STRICT_SUMMARY pass=0 raw=0 fail=5 avg_ms=3360 tool_exec_sum=0 nonzero_steps=0`
- `LLAMA31_STRICT_SUMMARY pass=0 raw=0 fail=5 avg_ms=16692 tool_exec_sum=0 nonzero_steps=0`
- Re-check on qwen3 again still failed strict probes.

### C. Isolation tests that narrowed the fault domain
1. Direct Ollama API (`/api/chat`) with tools:
- `qwen3:1.7b`: returned tool calls
- `llama3.1:8b`: returned tool calls

2. Lynkr OpenAI-compatible path (`/v1/chat/completions`) with tools:
- Can return `finish_reason: tool_calls` in some runs.
- Latest repro returned normal text refusal for provided tool, no execution loop.

3. Lynkr Anthropic-compatible path (`/v1/messages`) with tools:
- Returns `200` but ended with:
  - `stop_reason: end_turn`
  - empty text content
  - no `tool_use` block
- Routing headers show provider `ollama`.

4. Lynkr runtime logs repeatedly show:
- tools injected: `injected 12 tools`
- `supportsTools: true`
- `toolCallsExecuted: 0`

This strongly suggests the problem is in the Lynkr `/v1/messages` orchestration path with these local-model outputs, not simply “Ollama cannot do tools.”

## 4. Code and branch context

### Current working branch
- `codex/ollama-qwen3-tool-ab`

### Uncommitted local change currently present
- `/Users/malone/Lynkr/src/clients/ollama-utils.js`
  - added `"qwen3"` to tool-capable heuristic set.

### Gemini snapshot branch (preserved separately)
Branch: `codex/liquid-gemini-snapshot`  
Commits:
- `95ec106` (Liquid-specific tool instructions)
- `e7df511` (Liquid tool-call parser work in `openrouter-utils`)
- `b28826a` (MCP HTTP transport + Liquid handling changes)

Rollback safety:
- `codex/rollback-pre-gemini` points to `634c532` (pre-gemini baseline we resumed from).

## 5. Why this is hard (non-hand-wavy)
Tool execution here depends on three layers aligning:
1. Model emits parseable tool call objects.
2. Provider/runtime preserves tool call structure.
3. Lynkr `/v1/messages` loop recognizes + executes + re-injects correctly.

In our runs, layer (1) and sometimes (2) worked in isolation, but layer (3) was unreliable for local models in the Anthropic-compatible loop.

## 6. External signals (checked 2026-02-15/16)

### Lynkr repo
- Open PR: [#39 Improve tool calling response handling](https://github.com/Fast-Editor/Lynkr/pull/39)
- Merged PRs we referenced:
  - [#31 Stop wasteful tool injection in Ollama](https://github.com/Fast-Editor/Lynkr/pull/31)
  - [#42 SUGGESTION_MODE_MODEL](https://github.com/Fast-Editor/Lynkr/pull/42)
- Related split/umbrella context:
  - [#45 Improve tool calling response handling](https://github.com/Fast-Editor/Lynkr/pull/45)

### Ollama repo (related edge-case reports)
- [#10976 Thinking + tools + qwen3 empty output](https://github.com/ollama/ollama/issues/10976)
- [#11381 Qwen3 function-call / think behavior issue](https://github.com/ollama/ollama/issues/11381)
- [#9802 tool-call/template handling issue](https://github.com/ollama/ollama/issues/9802)
- Official baseline behavior: [Ollama tool-calling docs](https://ollama.com/blog/tool-support)

### Liquid docs
- Tool-use format behavior and structured output guidance:
  - [Liquid tool-use docs](https://docs.liquid.ai/docs/inference/features/tool-use)
- Ollama compatibility note:
  - [Liquid Ollama docs](https://docs.liquid.ai/docs/inference/ollama)
  - Includes note referencing merged Ollama support PR for LFM2, with LFM2.1 support pending.

## 7. Lynkr docs evidence we used
- `/Users/malone/Lynkr/documentation/tools.md:22` (tool flow assumptions)
- `/Users/malone/Lynkr/documentation/providers.md:421` (recommended tool models)
- `/Users/malone/Lynkr/documentation/providers.md:867` (provider comparison: Ollama tool-calling = Fair)
- `/Users/malone/Lynkr/documentation/providers.md:688` (MLX section and recommended model families)
- `/Users/malone/Lynkr/documentation/installation.md:363` (recommended Ollama models; smaller variants struggle)

## 8. Re-entry checklist (when revisiting local tools)
1. Keep this branch frozen as baseline.
2. Re-test strict probe after Lynkr PR #39 (or equivalent) lands.
3. Re-test with one known strong local tool model only (avoid broad matrix first).
4. Validate on `/v1/messages` specifically (not only `/v1/chat/completions`).
5. Only promote after observed `toolCallsExecuted > 0` in Lynkr logs for repeated requests.

## 9. Immediate move-forward implementation (Moonshot/Kimi)
Applied on branch `codex/ollama-qwen3-tool-ab`:
1. Added first-class `moonshot` provider support in config/dispatch/provider discovery.
2. Switched runtime to:
   - `MODEL_PROVIDER=moonshot`
   - `MOONSHOT_ENDPOINT=https://api.moonshot.ai/anthropic/v1/messages`
   - `MOONSHOT_MODEL=kimi-k2.5`
3. Fixed misleading response headers to return actual provider (`moonshot`) from orchestrator.
4. Smoke results:
   - `/health/live` and `/v1/health`: `200`
   - `/v1/messages` simple prompt: model `kimi-k2.5`, text `READY`
   - `/v1/messages` tool prompt: `stop_reason=tool_use`, tool name `Read`
