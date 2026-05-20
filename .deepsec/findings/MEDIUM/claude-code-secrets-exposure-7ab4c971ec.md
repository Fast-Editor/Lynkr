# [MEDIUM] Anonymization regex misses common secret formats — false sense of security

**File:** [`src/training/trajectory-compressor.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/training/trajectory-compressor.js#L38-L55) (lines 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Finding

The `--anonymize` flag is documented (in the bin/lynkr-trajectory.js help and the file docstring) as stripping 'PII / paths / secrets', and the CLI is intended to produce JSONL training data that can be shared (uploaded for fine-tuning, sent to evaluators). But the ANONYMIZE_PATTERNS list is hand-rolled and incomplete. It misses many well-known secret formats that commonly appear in tool stdout/stderr captured into session_history.content: (a) Stripe `sk_live_...`, `pk_live_...`, `rk_live_...` (the only `sk-` rule requires a hyphen, not underscore); (b) Google API keys `AIza[A-Za-z0-9_-]{35}`; (c) GitHub tokens `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, and `github_pat_...`; (d) Slack tokens `xoxb-`, `xoxa-`, `xoxp-`, `xoxs-`; (e) Twilio `AC[a-f0-9]{32}` and `SK[a-f0-9]{32}`; (f) AWS Secret Access Keys (40-char alphanumeric — only the access key ID prefix `AKIA` is matched); (g) AWS temporary creds (`ASIA*`, `AGPA*`, `AROA*`, `AIDA*`); (h) Postgres/MySQL connection strings with embedded credentials (e.g. `postgres://user:pass@host`); (i) generic key-value secrets in URLs/logs like `?api_key=...`, `password=...`, `secret=...`. Because trajectories embed shell tool outputs verbatim, any of these tokens that flowed through a session will leak in the supposedly-anonymized JSONL. Worse, the documentation promises secret stripping, so operators may publish/transfer these files trusting the redaction.

## Recommendation

Either (a) replace the hand-rolled list with an established secret-scanning ruleset (gitleaks, trufflehog, or detect-secrets patterns), or (b) explicitly document which secret formats are detected and which are NOT, and add a final entropy-based fallback (Shannon-entropy redaction for high-entropy tokens of length > 24). Consider also redacting any value whose key matches `*key*|*token*|*secret*|*password*` in JSON content. Add unit tests covering each major provider's token format.
