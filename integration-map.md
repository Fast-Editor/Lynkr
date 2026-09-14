# OrcaRouter deep integration map — Fast-Editor/Lynkr

## Repository contract

- Default branch (GitHub): `main`
- PR target base: `main` (repository has no `CONTRIBUTING.md`/`AGENTS.md`/`CODEOWNERS`/PR template pinning a `dev`/integration branch; `git log` and remote refs show `main` is the only release branch)
- Base SHA verified this run: `8e5cd11bd27091cae8f1a20273ba29cf332e7468` (upstream moved e8b92dd → 8e5cd11 with `v9.14.8` release + `.github/workflows/ocr-review.yml`; no source/interface changes; branch rebased onto 8e5cd11, no conflicts, no `-author`/config changes)
- Restored branch: `feat/orcarouter-provider` (rebase, working tree clean)

## AI input entry points (all traced)

| Entry | Path | Wired for OrcaRouter? |
| --- | --- | --- |
| Chat completions (Anthropic-wire proxy) | `src/clients/databricks.js::invokeOrcaRouter` + `PROVIDER_INVOKERS.orcarouter` | ✅ live-tested 2026-09-12 (`orcarouter/auto` → HTTP 200) |
| OpenAI `/v1/chat/completions` | `src/api/openai-router.js` (dispatches via `invokeProvider` → `PROVIDER_INVOKERS`) | ✅ |
| OpenAI `/v1/responses` | `src/api/openai-router.js:1772` (same invokeProvider dispatch) | ✅ |
| `/v1/embeddings` | `src/api/openai-router.js:1634` — uses OpenRouter/OpenAI embedding path (Lynkr does not send embeddings through a gateway provider; embeddings-only models are exposed via the live catalog `?capability=embedding` for dropdowns) | catalog only (Lynkr has no gateway embedding invocation; documented) |
| `/v1/models` (OpenAI) & `/v1/models` (Anthropic) & `/v1/providers` | `src/api/openai-router.js:1199`, `src/api/providers-handler.js` | ✅ live catalog surfaced |
| Dashboard overview provider list | `src/dashboard/api.js` | ✅ |
| CLI init wizard | `bin/lynkr-init.js` (provider registry + `.env` baseline) | ✅ |
| CLI connect | `bin/cli.js` → `bin/lynkr-connect-orcarouter.js` | ✅ |

No GUI (no browser dashboard UI for provider selection beyond JSON endpoints); profile `cli`.

## Central provider wiring points modified

- `src/config/index.js`: `SUPPORTED_MODEL_PROVIDERS` + `orcarouter` config block (apiKey/model/endpoint/authBaseUrl/apiBaseUrl); required for primary; tier-fallback validation.
- `src/clients/databricks.js`: `invokeOrcaRouter` (request conversion via shared `openrouter-utils`; Bearer auth; buffered→Anthropic conversion; raw OpenAI SSE passthrough; 429 escalate; 401 → `markRejected`); `PROVIDER_INVOKERS.orcarouter`.
- `src/clients/provider-capabilities.js`: reasoning-content provider set + thinking resolution.
- `src/routing/index.js`: `_enabledProviders` + `getBestCloudProvider`.
- `src/routing/model-tiers.js`: per-provider model resolution + tier parse.
- `src/routing/cache-economics.js`: cache defaults.
- `src/orchestrator/index.js`: destination URL.
- `src/orchestrator/sse-transformer.js`: `DEFAULT_OPENAI_SSE_PROVIDERS` (live E2E-verified SSE).
- `src/api/openai-router.js` / `src/api/providers-handler.js`: `getConfiguredProviders()` async + OrcaRouter live catalog block.
- `src/dashboard/api.js`: provider meta.

## Credential seam (`src/clients/orcarouter-credentials.js`)

- One interface (`OrcaCredentialStore` + `read/save/clear/markRejected`); two adapters:
  - **Adapter A — API key**: `createApiKeyAdapter(store)`. Read/masked status/save/clear through the store; persisted to `.env` `ORCAROUTER_API_KEY` (project's existing secret location).
  - **Adapter B — PKCE**: `connectWithPkce()`. Flow B (out-of-band) chosen because Lynkr is self-hosted software whose install address differs per deployment — no predictable loopback/redirect URI to register (spec rule: use B for self-hosted). S256 mandatory; verifier/state fresh per attempt from crypto RNG; challenge `base64url(sha256(verifier))` unpadded; verifier never in URL/log/error; exchange at `www.orcarouter.ai/api/v1/auth/keys`; granted `scope` read back; 400/403/429/network errors surfaced; key persisted via same `.env`.
- Origins: `ORCA_AUTH_BASE_URL` > `ORCA_BASE_URL` > `https://www.orcarouter.ai`; `ORCA_API_BASE_URL` > `ORCA_BASE_URL` > `https://api.orcarouter.ai`. HTTPS enforced for remote origins; HTTP only loopback.
- `401` → exact-generation `needsReauth` (generation-safe); no fake refresh; no proactive re-auth.

## Model catalog (`src/clients/orcarouter-catalog.js`)

- Live `GET {apiBase}/v1/models?capability=chat` with the account key; bounded (15s timeout, 5000 items); sanitized shape; last-known-good cache.
- Capability filters: chat (whitelisted endpoint types openai/anthropic/gemini/openai-response, excludes image-generation/openai-video/jina-rerank/embeddings), multimodal (chat ∩ declared input_modalities, fail-closed), embedding/image/video/rerank strict endpoint matches.
- Verified fallback seed (metadata-rich, never mixed into live): `openai/gpt-5.5` (reasoning low/medium/high/xhigh), `anthropic/claude-opus-4.8`, `google/gemini-3.5-flash`, `deepseek/deepseek-v4-pro`, `orcarouter/auto`.

## Live evidence 2026-09-12 (re-verified 2026-09-14 on 8e5cd11 base)

- `GET https://api.orcarouter.ai/v1/models?capability=chat` → live, 161 models, `orcarouter/free … openai/gpt-* … anthropic/claude-* … google/gemini-*`.
- `?capability=chat&modality=image` → 122 image-capable chat models.
- `?capability=embedding` → 5; `?capability=image` → 6 (imagen/gpt-image-1).
- Real inference `orcarouter/auto` through `invokeOrcaRouter` → HTTP 200 (content `OK`).

## Tests

- `test/orcarouter-pkce.test.js` — PKCE primitives, authorize URL, exchange (fake auth server), API-key adapter, generation-safe reauth, connectWithPkce E2E.
- `test/orcarouter-integration.test.js` — provider registration, invocation, dual-auth seam, catalog + capability filters + multimodal fail-closed + seed fallback + old-value invalidation, origin separation, secrets-in-errors, 401 needsReauth, no billable replay, static routing/cache, live gated test.
- `test/dispatch-registry.test.js` — registry coverage (orcarouter added).

## Verification

- `npm ci --ignore-scripts` (native hnswlib-node build unavailable in sandbox; KNN-dependent tests skipped per plan — recorded in PR).
- Focused batch: 82 tests pass (pkce+integration+dispatch+sse+format-conversion).
- ESLint clean on all changed files (pre-existing `no-unused-vars` for `tierConfig` in `bin/lynkr-init.js` on base, untouched by this change).
- Live check: real ORCAROUTER_API_KEY via provider code path — catalog (live) + inference (200).
