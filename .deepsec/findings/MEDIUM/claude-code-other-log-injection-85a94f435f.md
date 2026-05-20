# [MEDIUM] Untruncated `assistantResponse` in query/response pair log enables disk-fill DoS and downstream log-parser confusion

**File:** [`src/logger/audit-logger.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/logger/audit-logger.js#L508-L554) (lines 508, 552, 554)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-log-injection`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

`logQueryResponsePair` (lines 508-579) explicitly bypasses truncation for the assistant response: `assistantResponse, // Full response, NO truncation or deduplication (usually unique)` (line 552). Unlike `logLlmRequest` (which truncates via `maxContentLength.response`) and the standard truncation flow, this pair logger writes the full response into a JSONL log line.

LLM responses can be megabytes (especially in tool/code-generation workflows). For each query-response pair, a many-MB JSONL line is appended to the audit log file. Combined with the audit logger being on-by-default for compliance, an attacker who can issue LLM requests (or any user under high load) can fill disk by submitting prompts that elicit very long responses. There is no per-line size cap, no rate limiting in this module, and no monitoring of the resulting file size. Because pino is configured with `sync: false` (line 52), backpressure is invisible until the disk fills.

Secondary impact: most JSONL/audit-log readers (line-based parsers, SIEM ingestion, log shippers like Filebeat, Splunk Universal Forwarder) have per-line size limits. Lines that exceed those limits are dropped or split, defeating the audit/compliance use case they are meant to support.

## Recommendation

Apply at least a sane upper bound (e.g., 1MB) to `assistantResponse` before logging in `logQueryResponsePair`. If full content is truly required for compliance, route it through the same `ContentDeduplicator` pipeline used for `userMessages`/`systemPrompt`/`userQuery` — store full content in the dictionary file (where rotation/retention applies) and emit just the hash reference in the main log line. Also document an explicit per-entry size cap in the compliance configuration so operators can tune it.

## Recent committers (`git log`)

- MichaelAnders <developer@call-home.ch> (2026-01-31)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-26)
