# Submission 2: hesreallyhim/awesome-claude-code — ISSUE FORM, NOT A PR

**⚠️ Their rules (from CONTRIBUTING.md, July 2026):**
- PRs are rejected — use the web issue form ONLY:
  https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml
- **Must be submitted by a human** (you), not via CLI or automation.
- Descriptions must be factual, one line, no emojis, no sales pitch, don't address the reader.
- They openly deprioritize submissions that are part of a promotional strategy and
  favor projects that already have users. With ~500 stars Lynkr is borderline —
  consider submitting AFTER the Show HN / next stars milestone for better odds.
  A rejected submission can't be easily resubmitted, so timing matters.

**Form field drafts (paste into the web form):**

- **Resource name:** `Lynkr`
- **Link:** `https://github.com/Fast-Editor/Lynkr`
- **Category:** Developer tooling / proxies (pick the closest offered in the form dropdown)
- **One-line description (their style — descriptive, not promotional):**
  ```
  Self-hosted proxy that routes Claude Code requests across 13 providers by scoring request complexity, strips unused tool schemas, compresses JSON tool results, and caches semantically similar prompts.
  ```
- **Why it's awesome (if the form asks):**
  ```
  Complexity-scored routing (rather than static rules) keeps tool-heavy requests on capable models while sending simple ones to local Ollama/llama.cpp, and the token-reduction layers work with an unmodified Claude Code client. Apache-2.0, benchmark methodology published in the repo.
  ```

**If accepted**, add their badge to Lynkr's README:
```markdown
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)
```

**Also submit to the second list** — `jqueryscript/awesome-claude-code` (standard
awesome-list, accepts normal PRs). Entry line, same style:
```markdown
- [Lynkr](https://github.com/Fast-Editor/Lynkr) - Self-hosted gateway that routes Claude Code requests to 13 providers by request complexity, with tool-schema stripping, JSON tool-result compression, and semantic caching.
```
