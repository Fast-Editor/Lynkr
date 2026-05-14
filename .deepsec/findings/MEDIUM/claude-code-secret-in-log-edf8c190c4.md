# [MEDIUM] Tool-loop error log dumps full conversation, system prompt, and LLM response without redaction

**File:** [`src/orchestrator/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/orchestrator/index.js#L2900-L2916) (lines 2900, 2912, 2913, 2914, 2915, 2916)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `secret-in-log`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

When the tool-call loop limit is exceeded, the error logger (line ~2900-2918) emits a structured log record that contains:
- `myPrompt: cleanPayload.messages` — the entire conversation array sent to the LLM (line 2912)
- `systemPrompt: cleanPayload.system` — the full system prompt (line 2913)
- `llmResponse: databricksResponse?.data || databricksResponse?.json` — the full upstream LLM response (line 2914)
- `repeatedToolCalls: toolCalls` — full tool call payloads (line 2915)
- `toolCallHistory: Array.from(toolCallHistory.entries())` — every tool call in the request (line 2916)

This is inconsistent with the rest of the system: the audit logger (`createAuditLogger`) deliberately enforces length truncation per `config.audit.maxContentLength.{systemPrompt,userMessages,response}` (limits set in config/index.js:519-522), but the loop-termination error log bypasses those caps. If `pino`/winston output is forwarded to a centralized log aggregator (Datadog, Splunk, CloudWatch, ELK) — which is standard for hosted Lynkr deployments — the conversation history (potentially containing API keys, customer data, source code, file contents pulled by the Read tool, secrets pasted by users, etc.) is leaked into log infrastructure that may have a different security boundary than the application.

A secondary concern: an attacker that can deterministically trigger the tool-call loop (e.g., via a crafted prompt that makes the model loop) can use the error log as a side-channel to exfiltrate the system prompt to anyone with log access.

## Recommendation

Apply the same truncation/redaction policy used by the audit logger (e.g., `auditLogger.logLlmRequest` shape) when logging tool-loop terminations. At minimum, truncate `myPrompt`, `systemPrompt`, and `llmResponse` to a fixed character limit, and run them through the audit-logger redaction/sanitization pipeline. Consider gating verbose context capture behind an explicit `LLM_AUDIT_INCLUDE_LOOP_CONTEXT` env flag rather than always logging full content.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
