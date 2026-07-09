# PR 4: Continue docs — model provider page

**Target:** `continuedev/continue` → `docs/customize/model-providers/more/` (where
long-tail providers like LiteLLM live — check `more/` listing and mirror an existing
page's frontmatter/format before opening).

**Proposed file:** `docs/customize/model-providers/more/lynkr.mdx`

```mdx
---
title: Lynkr
---

# Lynkr

[Lynkr](https://github.com/Fast-Editor/Lynkr) is a self-hosted, Apache-2.0 LLM
gateway with an OpenAI-compatible endpoint. It routes each request by complexity —
simple requests to local models (Ollama, llama.cpp, LM Studio), complex ones to a
configured cloud provider (Bedrock, Azure OpenAI, Databricks, OpenRouter, and
others) — and reduces token usage by stripping unused tool schemas and compressing
large JSON tool results.

## Setup

Install and start Lynkr:

```bash
npm install -g lynkr
lynkr init   # wizard: choose tier models and provider credentials
lynkr start  # serves http://localhost:8081
```

Then configure Continue to use it as an OpenAI-compatible provider:

```yaml
models:
  - name: Lynkr
    provider: openai
    model: lynkr-auto        # placeholder; Lynkr picks the model per request
    apiBase: http://localhost:8081/v1
    apiKey: none
```

Lynkr's tier routing selects the actual model per request, so a single Continue
model entry covers the local-to-cloud range you configured in `lynkr init`.
```

**PR title:**
```
docs: add Lynkr to model providers (more)
```

**PR body:**
```
Adds a docs page for Lynkr, a self-hosted Apache-2.0 gateway usable with
Continue through the OpenAI-compatible provider. Placed under
model-providers/more alongside similar gateway entries; happy to adjust to
match current config-format conventions (yaml vs json examples) if needed.
```

**Before opening:** confirm Continue's current config format in an adjacent page
(they migrated config formats before — mirror whatever `more/litellm.mdx` or the
nearest gateway page uses today).
