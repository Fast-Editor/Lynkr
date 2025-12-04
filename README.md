# Lynkr 

[![npm version](https://img.shields.io/npm/v/lynkr.svg)](https://www.npmjs.com/package/lynkr)
[![Homebrew Tap](https://img.shields.io/badge/homebrew-lynkr-brightgreen.svg)](https://github.com/vishalveerareddy123/homebrew-lynkr)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/vishalveerareddy123/Lynkr)

> It is a Cli tool which acts like a HTTP proxy that lets Claude Code CLI talk to non-Anthropic backends, manage local tools, and compose Model Context Protocol (MCP) servers with prompt caching, repo intelligence, and Git-aware automation.

## Table of Contents

1. [Overview](#overview)
2. [Core Capabilities](#core-capabilities)
   - [Repo Intelligence & Navigation](#repo-intelligence--navigation)
   - [Git Workflow Enhancements](#git-workflow-enhancements)
   - [Diff & Change Management](#diff--change-management)
   - [Execution & Tooling](#execution--tooling)
   - [Workflow & Collaboration](#workflow--collaboration)
   - [UX, Monitoring, and Logs](#ux-monitoring-and-logs)
3. [Architecture](#architecture)
4. [Getting Started](#getting-started)
5. [Configuration Reference](#configuration-reference)
6. [Runtime Operations](#runtime-operations)
   - [Launching the Proxy](#launching-the-proxy)
   - [Connecting Claude Code CLI](#connecting-claude-code-cli)
   - [Using Built-in Workspace Tools](#using-built-in-workspace-tools)
   - [Working with Prompt Caching](#working-with-prompt-caching)
   - [Integrating MCP Servers](#integrating-mcp-servers)
7. [Manual Test Matrix](#manual-test-matrix)
8. [Troubleshooting](#troubleshooting)
9. [Roadmap & Known Gaps](#roadmap--known-gaps)
10. [FAQ](#faq)
11. [License](#license)

---

## Overview

This repository contains a Node.js service that emulates the Anthropic Claude Code backend so that the Claude Code CLI (or any compatible client) can operate against alternative model providers and custom tooling.

Key highlights:

- **Claude provider adapters** – Works with Databricks (default) and Azure-hosted Anthropic endpoints; requests are normalized to each provider while returning Claude-flavored responses.
- **Workspace awareness** – Local repo indexing, `CLAUDE.md` summaries, language-aware navigation, and Git helpers mirror core Claude Code workflows.
- **Model Context Protocol (MCP) orchestration** – Automatically discovers MCP manifests, launches JSON-RPC 2.0 servers, and re-exposes their tools inside the proxy.
- **Prompt caching** – Re-uses repeated prompts to reduce latency and token consumption, matching Claude’s own cache semantics.
- **Policy enforcement** – Environment-driven guardrails control Git operations, test requirements, web fetch fallbacks, and sandboxing rules.

The result is a self-hosted alternative that stays close to Anthropic’s ergonomics while remaining hackable for experimentation.

> **Compatibility note:** Claude models hosted on Databricks work out of the box. Set `MODEL_PROVIDER=azure-anthropic` (and related credentials) to target the Azure-hosted Anthropic `/anthropic/v1/messages` endpoint. Additional providers will require future adapters.

Further documentation and usage notes are available on [DeepWiki](https://deepwiki.com/vishalveerareddy123/Lynkr).

---

## Core Capabilities

### Repo Intelligence & Navigation

- Fast indexer builds a lightweight SQLite catalog of files, symbols, references, and framework hints.
- `CLAUDE.md` summary highlights language mix, frameworks, lint configs, and dependency signals.
- Symbol search and reference lookups return definition sites and cross-file usage for supported languages (TypeScript/JavaScript/Python via Tree-sitter parsers) with heuristic fallbacks for others.
- Automatic invalidation ensures removed files disappear from search results after `workspace_index_rebuild`.

### Git Workflow Enhancements

- Git status, diff, stage, commit, push, and pull tooling via `src/tools/git.js`.
- Policy flags such as `POLICY_GIT_ALLOW_PUSH` and `POLICY_GIT_REQUIRE_TESTS` enforce push restrictions or test gating.
- Diff review endpoints summarise changes and highlight risks, feeding the AI review surface.
- Release note generator composes summarized change logs for downstream publishing.

### Diff & Change Management

- Unified diff summaries with optional AI review (`workspace_diff_review`).
- Release note synthesis from Git history.
- Test harness integrates with git policies to ensure guarding before commit/push events.
- (Planned) Per-file threaded reviews and automated risk estimation (see [Roadmap](#roadmap--known-gaps)).

### Execution & Tooling

- Tool execution pipeline sandboxes or runs tools in the host workspace based on policy.
- MCP sandbox orchestration (Docker runtime by default) optionally isolates external tools with mount and permission controls.
- Automated testing harness exposes `workspace_test_run`, `workspace_test_history`, and `workspace_test_summary`.
- Prompt caching reduces repeated token usage for iterative conversations.

### Workflow & Collaboration

- Lightweight task tracker (`workspace_task_*` tools) persists TODO items in SQLite.
- Session database (`data/sessions.db`) stores conversational transcripts for auditing.
- Policy web fallback fetches limited remote data when explicitly permitted.

### UX, Monitoring, and Logs

- Pino-based structured logs with timestamps and severity.
- Request/response logging for Databricks interactions (visible in stdout).
- Session appenders log every user, assistant, and tool turn for reproducibility.
- Metrics directory ready for future Prometheus/StatsD integration.

---

## Architecture

```
┌────────────────────┐      ┌───────────────────────┐
│ Claude Code CLI    │──HTTP│ Claude Code Proxy      │
│ (or Claude client) │      │ (Express API gateway)  │
└────────────────────┘      └──────────┬────────────┘
                                       │
        ┌───────────────────────────────┼─────────────────────────────┐
        │                               │                             │
┌───────▼───────┐               ┌───────▼────────┐             ┌──────▼───────┐
│ Orchestrator  │               │ Prompt Cache   │             │ Session Store│
│ (agent loop)  │               │ (LRU + TTL)    │             │ (SQLite)     │
└───────┬───────┘               └───────┬────────┘             └──────┬───────┘
        │                                │                            │
┌───────▼────────────────────────────┐   │   ┌────────────────────────▼──────┐
│ Tool Registry & Policy Engine      │   │   │ Indexer / Repo Intelligence   │
│ (workspace, git, diff, MCP tools)  │   │   │ (SQLite catalog + CLAUDE.md)   │
└───────┬────────────────────────────┘   │   └────────────────────────┬──────┘
        │                                │                            │
┌───────▼────────┐               ┌─────────────────────────────┐             ┌──────▼──────────┐
│ MCP Registry   │               │ Provider Adapters            │             │ Sandbox Runtime │
│ (manifest ->   │────────RPC────│ (Databricks / Azure Anthropic│──────┐      │ (Docker, etc.) │
│ JSON-RPC client│               │ + future backends)           │      │      └────────────────┘
└────────────────┘               └───────────┬──────────────────┘      │
                                             │                         │
                                 ┌───────────▼───────────┐             │
                                 │ Databricks Serving    │─────────────┘
                                 │ Endpoint (REST)       │
                                 └───────────────────────┘
                                             │
                                 ┌───────────▼───────────┐
                                 │ Azure Anthropic       │
                                 │ `/anthropic/v1/messages`│
                                 └───────────────────────┘

                                              ┌─────────▼─────────┐
                                              │ External MCP tools │
                                              │ (GitHub, Jira, etc)│
                                              └────────────────────┘
```

- **`src/api/router.js`** – Express routes that accept Claude-compatible `/v1/messages` requests.
- **`src/orchestrator/index.js`** – Agent loop handling model invocation, tool execution, prompt caching, and policy enforcement.
- **`src/cache/prompt.js`** – LRU cache implementation with SHA-256 keying and TTL eviction.
- **`src/mcp/*`** – Manifest discovery, JSON-RPC 2.0 client, and dynamic tool registration for MCP servers.
- **`src/tools/*`** – Built-in workspace, git, diff, testing, task, and MCP bridging tools.
- **`src/indexer/index.js`** – File crawler and metadata extractor that persists into SQLite and regenerates `CLAUDE.md`.

---

## Getting Started

### Prerequisites

- **Node.js 18+** (required for the global `fetch` API).
- **npm** (bundled with Node).
- **Databricks account** with a Claude-compatible serving endpoint (e.g., `databricks-claude-sonnet-4-5`).
- Optional: **Docker** for MCP sandboxing and tool isolation.
- Optional: **Claude Code CLI** (latest release). Configure it to target the proxy URL instead of api.anthropic.com.

### Installation

```bash
# from npm (recommended)
npm install -g lynkr
lynkr start

# via Homebrew tap
brew tap vishalveerareddy123/lynkr
brew install vishalveerareddy123/lynkr/lynkr

# or clone the repo
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr
npm install
```

Populate an `.env` file (or export environment variables) before starting:

```env
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://<your-workspace>.cloud.databricks.com
DATABRICKS_API_KEY=<personal-access-token>
PORT=8080
WORKSPACE_ROOT=/path/to/your/repo
PROMPT_CACHE_ENABLED=true
```

You can copy `.env.example` if you maintain one, or rely on shell exports.

#### Selecting a model provider

Set `MODEL_PROVIDER` to select the upstream endpoint:

- `MODEL_PROVIDER=databricks` (default) – expects `DATABRICKS_API_BASE`, `DATABRICKS_API_KEY`, and optionally `DATABRICKS_ENDPOINT_PATH`.
- `MODEL_PROVIDER=azure-anthropic` – routes requests to Azure’s `/anthropic/v1/messages` endpoint and uses the headers Azure expects.

For Azure-hosted Anthropic, supply the Azure-specific credentials:

```env
MODEL_PROVIDER=azure-anthropic
AZURE_ANTHROPIC_ENDPOINT=https://<resource-name>.services.ai.azure.com/anthropic/v1/messages
AZURE_ANTHROPIC_API_KEY=<azure-api-key>
AZURE_ANTHROPIC_VERSION=2023-06-01
PORT=8080
WORKSPACE_ROOT=/path/to/your/repo
```

---

## Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port for the proxy server. | `8080` |
| `WORKSPACE_ROOT` | Filesystem path exposed to workspace tools and indexer. | `process.cwd()` |
| `MODEL_PROVIDER` | Selects the model backend (`databricks`, `azure-anthropic`). | `databricks` |
| `MODEL_DEFAULT` | Overrides the default model/deployment name sent to the provider. | Provider-specific default |
| `DATABRICKS_API_BASE` | Base URL of your Databricks workspace (required when `MODEL_PROVIDER=databricks`). | – |
| `DATABRICKS_API_KEY` | Databricks PAT used for the serving endpoint (required for Databricks). | – |
| `DATABRICKS_ENDPOINT_PATH` | Optional override for the Databricks serving endpoint path. | `/serving-endpoints/databricks-claude-sonnet-4-5/invocations` |
| `AZURE_ANTHROPIC_ENDPOINT` | Full HTTPS endpoint for Azure-hosted Anthropic `/anthropic/v1/messages` (required when `MODEL_PROVIDER=azure-anthropic`). | – |
| `AZURE_ANTHROPIC_API_KEY` | API key supplied via the `x-api-key` header for Azure Anthropic. | – |
| `AZURE_ANTHROPIC_VERSION` | Anthropic API version header for Azure Anthropic calls. | `2023-06-01` |
| `PROMPT_CACHE_ENABLED` | Toggle the prompt cache system. | `true` |
| `PROMPT_CACHE_TTL_MS` | Milliseconds before cached prompts expire. | `300000` (5 minutes) |
| `PROMPT_CACHE_MAX_ENTRIES` | Maximum number of cached prompts retained. | `64` |
| `POLICY_MAX_STEPS` | Max agent loop iterations before timeout. | `8` |
| `POLICY_GIT_ALLOW_PUSH` | Allow/disallow `workspace_git_push`. | `false` |
| `POLICY_GIT_REQUIRE_TESTS` | Enforce passing tests before `workspace_git_commit`. | `false` |
| `POLICY_GIT_TEST_COMMAND` | Custom test command invoked by policies. | `null` |
| `WEB_SEARCH_ENDPOINT` | URL for policy-driven web fetch fallback. | `http://localhost:8888/search` |
| `WEB_SEARCH_ALLOWED_HOSTS` | Comma-separated allowlist for `web_fetch`. | `null` |
| `MCP_SERVER_MANIFEST` | Single manifest file for MCP server. | `null` |
| `MCP_MANIFEST_DIRS` | Semicolon-separated directories scanned for manifests. | `~/.claude/mcp` |
| `MCP_SANDBOX_ENABLED` | Enable container sandbox for MCP tools (requires `MCP_SANDBOX_IMAGE`). | `true` |
| `MCP_SANDBOX_IMAGE` | Docker/OCI image name used for sandboxing. | `null` |
| `WORKSPACE_TEST_COMMAND` | Default CLI used by `workspace_test_run`. | `null` |
| `WORKSPACE_TEST_TIMEOUT_MS` | Test harness timeout. | `600000` |
| `WORKSPACE_TEST_COVERAGE_FILES` | Comma-separated coverage summary files. | `coverage/coverage-summary.json` |

See `src/config/index.js` for the full configuration matrix, including sandbox mounts, permissions, and MCP networking policies.

---

## Runtime Operations

### Launching the Proxy

```bash
# global install
lynkr start

# local checkout
npm run dev    # development: auto-restarts on file changes
npm start      # production
```

Logs stream to stdout. The server listens on `PORT` and exposes `/v1/messages` in the Anthropic-compatible shape. If you installed via npm globally, `lynkr start` reads the same environment variables described above.

### Connecting Claude Code CLI

1. Install or upgrade Claude Code CLI.
2. Export the proxy endpoint:
   ```bash
   export ANTHROPIC_BASE_URL=http://localhost:8080
   export ANTHROPIC_API_KEY=dummy # not used, but Anthropic CLI requires it
   ```
3. Launch `claude` CLI within `WORKSPACE_ROOT`.
4. Invoke commands as normal; the CLI will route requests through the proxy.

### Using Built-in Workspace Tools

You can call tools programmatically via HTTP:

```bash
curl http://localhost:8080/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: manual-test' \
  -d '{
    "model": "claude-proxy",
    "messages": [{ "role": "user", "content": "Rebuild the workspace index." }],
    "tools": [{
      "name": "workspace_index_rebuild",
      "type": "function",
      "description": "Rebuild the repo index and project summary",
      "input_schema": { "type": "object" }
    }],
    "tool_choice": {
      "type": "function",
      "function": { "name": "workspace_index_rebuild" }
    }
  }'
```

Tool responses appear in the assistant content block with structured JSON.

### Working with Prompt Caching

- Set `PROMPT_CACHE_ENABLED=true` (default) to activate the cache.
- The cache retains up to `PROMPT_CACHE_MAX_ENTRIES` entries for `PROMPT_CACHE_TTL_MS` milliseconds.
- A cache hit skips the Databricks call; response metadata populates `cache_read_input_tokens`.
- Cache misses record `cache_creation_input_tokens`, indicating a fresh prompt was cached.
- Cache entries are invalidated automatically when they age out; no manual maintenance required.
- Disable caching temporarily by exporting `PROMPT_CACHE_ENABLED=false` and restarting the server.

### Integrating MCP Servers

1. Place MCP manifest JSON files under `~/.claude/mcp` or configure `MCP_MANIFEST_DIRS`.
2. Each manifest should define the server command, arguments, and capabilities per the MCP spec.
3. Restart the proxy; manifests are loaded at boot. Registered tools appear with names `mcp_<server>_<tool>`.
4. Invoke tools via `workspace_mcp_call` or indirectly when the assistant selects them.
5. Sandbox settings (`MCP_SANDBOX_*`) control Docker runtime, mounts, environment passthrough, and permission prompts.

### Running with Docker

A `Dockerfile` and `docker-compose.yml` are included for reproducible deployments.

#### Build & run with Docker Compose

```bash
cp .env.example .env        # populate with Databricks/Azure credentials, workspace path, etc.
docker compose up --build
```

The compose file exposes:

- Proxy HTTP API on `8080`
- Optional SearxNG instance on `8888` (started automatically when `WEB_SEARCH_ENDPOINT` is the default)

Workspace files are mounted into the container (`./:/workspace`), and `./data` is persisted for SQLite state. If you launch the proxy outside of this compose setup you must provide your own search backend and point `WEB_SEARCH_ENDPOINT` at it (for example, a self-hosted SearxNG instance). Without a reachable search service the `web_search` and `web_fetch` tools will return placeholder responses or fail.

#### Manual Docker build

```bash
docker build -t claude-code-proxy .
docker run --rm -p 8080:8080 -p 8888:8888 \
  -v "$(pwd)":/workspace \
  -v "$(pwd)/data":/app/data \
  --env-file .env \
  claude-code-proxy
```

Adjust port and volume mappings to suit your environment. Ensure the container has access to the target workspace and required credentials.

#### Direct `docker run` with inline environment variables

```bash
docker run --rm -p 8080:8080 \
  -v "$(pwd)":/workspace \
  -v "$(pwd)/data":/app/data \
  -e MODEL_PROVIDER=databricks \
  -e DATABRICKS_API_BASE=https://<workspace>.cloud.databricks.com \
  -e DATABRICKS_ENDPOINT_PATH=/serving-endpoints/<endpoint-name>/invocations \
  -e DATABRICKS_API_KEY=<personal-access-token> \
  -e WORKSPACE_ROOT=/workspace \
  -e PORT=8080 \
  claude-code-proxy
```

Use additional `-e` flags (or `--env-file`) to pass Azure Anthropic credentials or other configuration values as needed.
Replace `<workspace>` and `<endpoint-name>` with your Databricks workspace host and the Serving Endpoint you want to target (e.g. `/serving-endpoints/databricks-gpt-4o-mini/invocations`) so you can choose any available model.

### Provider-specific behaviour

- **Databricks** – Mirrors Anthropic’s hosted behaviour. Automatic policy web fallbacks (`needsWebFallback`) can trigger an extra `web_fetch`, and the upstream service executes dynamic pages on your behalf.
- **Azure Anthropic** – Requests are normalised to Azure’s payload shape. The proxy disables automatic `web_fetch` fallbacks to avoid duplicate tool executions; instead, the assistant surfaces a diagnostic message and you can trigger the tool manually if required.
- In both cases, `web_search` and `web_fetch` run locally. They do not execute JavaScript, so pages that render data client-side (Google Finance, etc.) will return scaffolding only. Prefer JSON/CSV quote APIs (e.g. Yahoo chart API) when you need live financial data.

---

## Manual Test Matrix

| Area | Scenario | Steps | Expected Outcome |
|------|----------|-------|------------------|
| **Indexing & Repo Intelligence** | Rebuild index | 1. `workspace_index_rebuild` 2. Inspect `CLAUDE.md` 3. Run `workspace_symbol_search` | CLAUDE.md and symbol catalog reflect current repo state. |
| | Remove file & reindex | 1. Delete a tracked file 2. Rebuild index 3. Search for removed symbol | Symbol search returns no hits; CLAUDE.md drops the file from language counts. |
| **Language Navigation** | Cross-file definition | 1. Choose TS symbol defined/imported across files 2. Search for symbol 3. Get references | Definition points to source file; references list usages in other files only. |
| | Unsupported language fallback | 1. Use Ruby file with unique method 2. Symbol search and references | Heuristic matches return without crashing. |
| **Project Summary** | After tests | 1. Run `workspace_index_rebuild` 2. Call `project_summary` | Summary includes latest test stats and style hints (e.g., ESLint). |
| | Missing coverage files | 1. Move coverage JSON 2. Call `project_summary` | Response notes missing coverage gracefully. |
| **Task Tracker** | CRUD flow | 1. `workspace_task_create` 2. `workspace_tasks_list` 3. `workspace_task_update` 4. `workspace_task_set_status` 5. `workspace_task_delete` | Tasks persist across calls; deletion removes entry. |
| **Git Guards** | Push policy | 1. `POLICY_GIT_ALLOW_PUSH=false` 2. `workspace_git_push` | Request denied with policy message. |
| | Require tests before commit | 1. `POLICY_GIT_REQUIRE_TESTS=true` 2. Attempt commit without running tests | Commit blocked until tests executed. |
| **Prompt Cache** | Cache hit | 1. Send identical prompt twice 2. Check logs | Second response logs cache hit; response usage shows `cache_read_input_tokens`. |
| **MCP** | Manifest discovery | 1. Add manifest 2. Restart proxy 3. Call `workspace_mcp_call` | MCP tools execute via JSON-RPC bridge. |

---

## Troubleshooting

- **`path must be a non-empty string` errors** – Tool calls like `fs_read` require explicit paths. Verify the CLI sent a valid `path` argument.
- **Agent loop exceeding limits** – Increase `POLICY_MAX_STEPS` or fix misbehaving tool that loops.
- **`spawn npm test ENOENT`** – Configure `WORKSPACE_TEST_COMMAND` or ensure `npm test` exists in the workspace.
- **MCP server not discovered** – Confirm manifests live inside `MCP_MANIFEST_DIRS` and contain executable commands. Check logs for discovery errors.
- **Prompt cache not activating** – Ensure `PROMPT_CACHE_ENABLED=true`. Cache only stores tool-free completions; tool use requests bypass caching by design.
- **Claude CLI prompts for missing tools** – Verify `tools` array in the client request lists the functions you expect. The proxy only exposes registered handlers.
- **Dynamic finance pages return stale data** – `web_fetch` fetches static HTML only. Use an API endpoint (e.g. Yahoo Finance chart JSON) or the Databricks-hosted tooling if you need rendered values from heavily scripted pages.

---

## Roadmap & Known Gaps

- **Per-file diff comments & conversation threading** – Planned to mirror Claude’s review UX.
- **Automated risk assessment tied to diffs** – Future enhancement leveraging test outcomes and static analysis.
- **Expanded language-server fidelity** – Currently Tree-sitter-based; deeper AST integration or LSP bridging is a future goal.
- **Claude Skills parity** – Skills are not reproduced; designing a safe, declarative skill layer is an open area.
- **Coverage dashboards & historical trends** – Test summary tracks latest runs but no long-term history yet.

---

## FAQ

**Q: Is this an exact drop-in replacement for Anthropic’s backend?**  
A: No. It mimics key Claude Code CLI behaviors but is intentionally extensible; certain premium features (Claude Skills, hosted sandboxes) are out of scope.

**Q: How does the proxy compare with Anthropic’s hosted backend?**  
A: Functionally they overlap on core workflows (chat, tool calls, repo ops), but differ in scope:

| Capability | Anthropic Hosted Backend | Claude Code Proxy |
|------------|-------------------------|-------------------|
| Claude models | Anthropic-operated Sonnet/Opus | Adapters for Databricks (default) and Azure Anthropic |
| Prompt cache | Managed, opaque | Local LRU cache with configurable TTL/size |
| Git & workspace tools | Anthropic-managed hooks | Local Node handlers (`src/tools/`) with policy gate |
| Web search/fetch | Hosted browsing agent, JS-capable | Local HTTP fetch (no JS) plus optional policy fallback |
| MCP orchestration | Anthropic-managed sandbox | Local MCP discovery, optional Docker sandbox |
| Secure sandboxes | Anthropic-provided remote sandboxes | Optional Docker runtime; full access if disabled |
| Claude Skills / workflows | Available in hosted product | Not implemented (future roadmap) |
| Support & SLAs | Anthropic-run service | Self-hosted; you own uptime, auth, logging |
| Cost & scaling | Usage-billed API | Whatever infra you deploy (Node + dependencies) |

The proxy is ideal when you need local control, custom tooling, or non-Anthropic model endpoints. If you require fully managed browsing, secure sandboxes, or enterprise SLA, stick with the hosted backend.

**Q: Does prompt caching work like Anthropic’s cache?**  
A: Functionally similar. Identical messages (model, messages, tools, sampling params) reuse cached responses until TTL expires. Tool-invoking turns skip caching.

**Q: Can I connect multiple MCP servers?**  
A: Yes. Place multiple manifests in `MCP_MANIFEST_DIRS`. Each server is launched and its tools are namespaced.

**Q: How do I change the workspace root?**  
A: Set `WORKSPACE_ROOT` before starting the proxy. The indexer and filesystem tools operate relative to that path.

**Q: Where are session transcripts stored?**  
A: In SQLite at `data/sessions.db` (configurable via `SESSION_DB_PATH`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

If you find Lynkr useful, please ⭐ the repo — it helps more people discover it.
