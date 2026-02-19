# TOON Integration Spec (Lynkr Spike)

Date: 2026-02-17  
Branch: `codex/toon-integration-spike`  
Status: Implemented behind flags (`TOON_ENABLED=false` by default).

## 1) Goal

Reduce prompt token usage for large structured JSON context while preserving current Lynkr routing, tool execution semantics, and reliability.

## 2) Non-Goals

1. Do not replace Lynkr routing/fallback logic.
2. Do not change MCP/tool protocol behavior.
3. Do not change provider request envelope formats.
4. Do not require TOON for normal operation.

## 3) Integration Strategy (Minimal, Reversible)

1. Add a TOON adapter module (encode-only for prompt context).
2. Apply TOON only to eligible large JSON blobs before they are inserted into model-visible context.
3. Keep original JSON in memory/session for execution and audit; only prompt copy is compressed.
4. Fail open: if TOON conversion fails, send original JSON unchanged.

## 4) What We Will Compress

Eligible inputs (all required):

1. Payload is valid JSON object/array.
2. Payload size exceeds threshold (for example, `TOON_MIN_BYTES`).
3. Payload is read-only context for model comprehension (not protocol-critical).

Primary targets:

1. Large tool output summaries inserted into prompt context.
2. Large search/result payloads injected for reasoning.
3. Structured data snapshots used for analysis tasks.

## 5) What We Will Never Compress

Hard exclusions:

1. Tool schemas/definitions (`tools`, `input_schema`, function signatures).
2. Tool call argument payloads that are executed by systems.
3. Provider request envelopes (`/v1/messages`, `/chat/completions` body schema fields).
4. Protocol control fields (roles, stop reasons, tool IDs, request IDs).
5. Stored canonical session payloads used for replay/debug/audit.

Rule: if a payload is machine-validated/executed downstream, keep JSON.

## 6) Config Flags (Default Safe)

Proposed env flags:

1. `TOON_ENABLED=false` (default off)
2. `TOON_MIN_BYTES=4096` (only convert larger payloads)
3. `TOON_FAIL_OPEN=true` (fallback to JSON on any TOON error)
4. `TOON_LOG_STATS=true` (log before/after token estimate for observability)

## 7) Verification Gates

Before enabling:

1. Existing unit tests pass unchanged.
2. Existing MCP smoke passes (`find_tool`/`call_tool` path).

With `TOON_ENABLED=true`:

1. Prompt A/B benchmark still passes functionally.
2. No regression in Task/subagent behavior.
3. Data-heavy prompt shows token reduction vs baseline.
4. No increase in protocol/tool-call errors.

## 8) Rollback Rules

Immediate rollback:

1. Set `TOON_ENABLED=false`.
2. Restart Lynkr service.

Code rollback:

1. Revert TOON integration commit(s) on this branch.
2. Re-run unit + MCP smoke gates.

## 9) Risks and Mitigations

1. Risk: semantic drift from transformed payloads.
   - Mitigation: apply only to read-only context, fail-open on error, keep canonical JSON.
2. Risk: negligible gains on non-tabular/deeply nested payloads.
   - Mitigation: threshold + eligibility checks; skip low-value payloads.
3. Risk: harder debugging.
   - Mitigation: log conversion stats and keep original payload for diagnostics.

## 10) Stock Provider Validation (Ollama Cloud)

Date: 2026-02-17

Runtime under test:

1. `MODEL_PROVIDER=ollama`
2. `OLLAMA_ENDPOINT=http://127.0.0.1:11434`
3. `OLLAMA_MODEL=glm-5:cloud`
4. `TOON_MIN_BYTES=256`
5. `TOON_FAIL_OPEN=true`
6. `TOON_LOG_STATS=true`

Probe used:

1. Send a two-message request where the second message is a large JSON blob.
2. Ask model to classify the next message as `JSON` vs `OTHER` based on first character.
3. Run once with `TOON_ENABLED=false`, once with `TOON_ENABLED=true`.

Observed results:

1. `TOON_ENABLED=false`
   - Reply: `JSON`
   - Provider header: `x-lynkr-provider: ollama`
   - TOON log entries: `0`
2. `TOON_ENABLED=true`
   - Reply: `OTHER`
   - Provider header: `x-lynkr-provider: ollama`
   - TOON log entries: `1`
   - Logged conversion stats: `originalBytes=6416`, `compressedBytes=5854` (saved `562` bytes, `8.76%`)

Conclusion:

1. TOON gating works on stock Ollama cloud path (not moonshot-specific).
2. Compression is applied only when flag-enabled.
3. Provider routing remains unchanged (`ollama`) during TOON transformation.
