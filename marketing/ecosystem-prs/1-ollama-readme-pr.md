# PR 1: Ollama README — Community Integrations

**Target:** `ollama/ollama` → `README.md` → "Community Integrations" → **Libraries & SDKs** subsection
(they explicitly invite this: "Want to add your project? Open a pull request.")

**Line to add** (alphabetical placement near LiteLLM, matching their exact format —
`- [Name](url) - description`, one line, no emojis, no superlatives):

```markdown
- [Lynkr](https://github.com/Fast-Editor/Lynkr) - Self-hosted LLM gateway that routes coding-tool requests (Claude Code, Cursor, Codex CLI) to Ollama by complexity, with tool-output compression and semantic caching
```

**PR title:**
```
docs: add Lynkr to Community Integrations (Libraries & SDKs)
```

**PR body:**
```
Adds Lynkr to the Libraries & SDKs list.

Lynkr is an Apache-2.0 self-hosted gateway that uses Ollama as a first-class
routing tier: it scores each request from AI coding tools (Claude Code, Cursor,
Codex CLI, Cline, Continue) by complexity and routes simple/medium requests to
local Ollama models, escalating only complex ones to cloud providers. It also
compresses JSON tool outputs and adds semantic caching in front of Ollama.

- Repo: https://github.com/Fast-Editor/Lynkr (Apache-2.0)
- Ollama integration docs: https://github.com/Fast-Editor/Lynkr#quick-start-2-minutes

Follows the existing entry format; placed alphabetically.
```

**Steps:** fork ollama/ollama → edit README.md → single-line commit → PR.
