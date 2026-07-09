# PR 3: Cline docs — provider configuration page

**Target:** `cline/cline` → `docs/provider-config/` (new page, matching their .mdx format —
check an existing page like the LiteLLM/Ollama one for exact frontmatter before opening).

**Proposed file:** `docs/provider-config/lynkr.mdx`

```mdx
---
title: "Lynkr"
description: "Use Cline with Lynkr, a self-hosted gateway that routes requests by complexity across local and cloud providers."
---

# Using Cline with Lynkr

[Lynkr](https://github.com/Fast-Editor/Lynkr) is a self-hosted, Apache-2.0 LLM
gateway that exposes an OpenAI-compatible endpoint and routes each request by
complexity: simple requests go to local models (Ollama, llama.cpp, LM Studio),
complex ones to the cloud provider you configure (Bedrock, Azure, Databricks,
OpenRouter, and others). It also compresses large JSON tool results and caches
semantically similar prompts, which reduces token usage on agentic sessions.

## Setup

1. Install and start Lynkr:

   ```bash
   npm install -g lynkr
   lynkr init   # interactive wizard: pick tier models and providers
   lynkr start  # serves http://localhost:8081
   ```

2. In Cline's settings, choose the **OpenAI Compatible** provider and set:

   - **Base URL:** `http://localhost:8081/v1`
   - **API Key:** any non-empty value (auth is handled by Lynkr's provider config)
   - **Model ID:** any placeholder; Lynkr's tier routing selects the actual model
     per request based on the tiers you configured in `lynkr init`

3. Send a message in Cline. Simple requests route to your local tier; complex,
   tool-heavy requests escalate to your configured cloud tier automatically.

## Notes

- Requests never transit third-party infrastructure; Lynkr runs entirely on
  your machine and calls your configured providers directly.
- See [Lynkr's routing docs](https://github.com/Fast-Editor/Lynkr/blob/main/documentation/routing.md)
  for tier configuration and complexity-threshold tuning.
```

**PR title:**
```
docs: add Lynkr provider configuration guide
```

**PR body:**
```
Adds a provider-config page for Lynkr, a self-hosted Apache-2.0 gateway that
works with Cline via the OpenAI-compatible provider. Follows the structure of
the existing provider pages. Happy to adjust format/frontmatter to match
conventions if I've missed any.
```

**Before opening:** verify one existing page in `docs/provider-config/` and mirror
its exact frontmatter fields; verify the settings-name ("OpenAI Compatible") matches
current Cline UI wording.
