# Lynkr — FOSS United Grant Application

> Draft proposal. Edit fields marked **[FILL]** before submitting.

---

## Project at a glance

**Name:** Lynkr
**Repository:** https://github.com/Fast-Editor/Lynkr
**License:** Apache-2.0
**Maintainer:** Vishal Veera Reddy (sole maintainer)
**Location:** Hyderabad, Telangana, India
**Started:** December 2025
**Current version:** 9.0.2
**npm package:** https://www.npmjs.com/package/lynkr
**Funding manifest:** [funding.json](../funding.json) at repo root

**One-line description:** A self-hosted AI gateway for Indian developers that decouples AI coding tools from their default LLM providers, cutting per-developer AI bills 60-80% while unlocking existing Indian cloud accounts (Bedrock, Azure, Databricks) for tools like Claude Code and Cursor.

**Built in Hyderabad** by an India-based maintainer (currently a software engineer at ServiceNow Hyderabad), targeting Indian developer infrastructure as a full-time effort once funded.

---

## What is Lynkr?

Every popular AI coding tool today locks developers into one specific cloud LLM:
- **Claude Code** → only works with Anthropic ($15/MTok output)
- **Codex CLI** → only works with OpenAI
- **Cursor** → only works with OpenAI
- **jcode, Cline, Continue, Pi** → similar single-provider defaults

This means an Indian developer who already has access to AWS Bedrock through their employer, an Azure OpenAI deployment from their MSDN credit, or a free local Ollama install on their laptop **cannot use any of those for the AI coding tools they actually want to use.** They are forced to pay foreign vendors a second time.

Lynkr is a self-hosted Node.js proxy (Apache-2.0) that sits between any AI coding tool and any LLM provider. One `npm install` command, one `.env` file, and:

1. **The tool keeps working unchanged** — Lynkr auto-detects which client connected (Claude Code, Cursor, Codex, Cline, Pi, jcode, Warp, etc.) and translates request and response formats on the fly.
2. **Requests route to whatever you configure** — 12+ providers supported today: Ollama, AWS Bedrock, Azure OpenAI, Azure Anthropic, OpenRouter, Databricks, Moonshot, Google Vertex, llama.cpp, LM Studio, Z.AI, and direct OpenAI.
3. **A 5-phase complexity classifier picks the cheapest model that can handle each turn** — greetings and short questions go to free local models; multi-file refactors go to flagship cloud models. Configurable via four `TIER_*` environment variables.
4. **Token cost drops 60-80%** through tier routing, MCP Code Mode (replaces 100+ tool definitions with 4 meta-tools — 96% token reduction), and tool-result compression for repetitive outputs (git diffs, test runs, file reads).

**Result:** A typical developer goes from $200-690/month across their AI tools to ~$45/month, with 70% of requests served by free local models.

---

## Why this matters for the Indian FOSS ecosystem

**Foreign-exchange tax on Indian developers.** Every dollar spent on Anthropic / OpenAI subscriptions leaves India. At ₹85/USD, a single developer's $200/month tool bill is ₹17,000/month. For a 50-person engineering team in Bengaluru, that's ₹1.02 crore/year flowing to two US companies. Lynkr cuts this 60-80% by routing through Indian-friendly alternatives (free Ollama, sub-cost OpenRouter, or your existing Indian cloud spend).

**Enterprise unblock.** Indian enterprises with strict data-residency and procurement rules already have Azure OpenAI, AWS Bedrock, or on-prem Databricks endpoints approved. Without Lynkr, their developers can't use modern AI coding tools through those approved channels — so they either get blocked from AI tooling or go around the rules. Lynkr resolves both at once.

**Sovereign AI infrastructure.** As Indian developers and companies adopt AI coding tools, the orchestration layer matters. Lynkr keeps that layer self-hosted, FOSS, and built from India — instead of letting LiteLLM (US) or Portkey (paid SaaS) define how Indian developers route their AI requests.

**MSME / startup affordability.** Solo developers, students, and small Indian product teams cannot justify $200/month per seat for tooling. Lynkr makes flagship-quality AI coding accessible on a free or near-free budget by mixing local models (Ollama on a laptop) with selectively-routed cloud calls.

---

## What's already shipped (traction)

- **9.0.2** released on npm
- **699 passing tests**
- **12+ provider integrations**, all maintained against live APIs
- **Format translation** between Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses APIs (the three formats every modern AI coding tool uses)
- **Universal tool-call extractor** for 10 model-specific tool-call formats: Minimax, GLM, Hermes / Qwen, Qwen3-Coder, Llama python_tag, Mistral [TOOL_CALLS], DeepSeek, GPT-OSS, plus generic function-call and raw JSON. Necessary because non-OpenAI models emit tool calls in incompatible formats — Lynkr normalises them all.
- **MCP (Model Context Protocol) integration** with Code Mode meta-tools (96% token reduction on definitions)
- **Tool-result compression** with 10 compressors: test output, git diff/status/log, directory listings, lint, build, JSON, container, large-file skeletons, generic
- **Persistent memory system** (Titans-inspired, surprise-based) stored in SQLite
- **Tier-based routing** with 5-phase complexity classifier (request length, tool count, keywords, conversation depth, token budget)
- **Homebrew tap, npm install, and curl-piped installer**

**Repo:** https://github.com/Fast-Editor/Lynkr — **412 stars**, **43 forks**, **4 open issues**, Apache-2.0
**Activity:** First commit December 2025; **32 npm versions** released in five months; latest push April 2026
**npm package:** [lynkr on npm](https://www.npmjs.com/package/lynkr) — **480 downloads in the last 30 days**, **155 in the last 7 days**, downloads on **29 of the last 30 days** (consistent daily usage, not a spike)
**Community:** Early stage — informal users on GitHub Issues and Discord. Building a public Discord and forum is a Q1 milestone (see roadmap).

---

## Eligibility against FOSS United criteria

| FOSS United criterion | Lynkr |
|---|---|
| Indian origin | ✅ — single Indian maintainer, project initiated in India |
| Indian-based maintainer | ✅ — Hyderabad, Telangana |
| FOSS license | ✅ Apache-2.0 |
| Working software (not just an idea) | ✅ v9.0.2 on npm, 699 tests |
| Differentiation vs alternatives | ✅ See "Comparison" section below |
| User impact | ✅ Direct cost reduction + vendor lock-in removal for every Indian dev using AI tools |
| Sustainability | ✅ See "5-year plan" section below |

---

## Comparison with existing alternatives

| Tool | What it does | Why Lynkr is different |
|---|---|---|
| **LiteLLM** (US, BerriAI) | Generic LLM proxy with unified API | Targets backend developers calling LLM APIs directly. Doesn't auto-detect AI coding tools, doesn't translate Anthropic ↔ OpenAI tool-call formats specifically, no tier-based complexity routing. Lynkr is purpose-built for the AI-coding-tool wedge. |
| **Portkey** (US, paid SaaS) | LLM gateway with observability | Closed-source SaaS. Cannot be self-hosted by Indian enterprises with data-residency requirements. |
| **OpenRouter** (US) | Unified-API marketplace for LLMs | Hosted service — every request leaves your network and gets billed in USD. Lynkr is self-hosted and runs free models locally. |
| **Helicone, Langfuse, etc.** | LLM observability layers | Don't translate request formats; don't route between providers. |

Lynkr is the only solution that:
1. Sits between AI **coding tools** specifically (not generic LLM clients)
2. Translates between three major API surfaces (Anthropic, OpenAI Chat, OpenAI Responses) including tool-call formats
3. Auto-classifies request complexity to mix free local + paid cloud models
4. Is self-hosted, FOSS, and built from India

---

## Grant request

**Total ask:** **₹8,50,000 over 12 months**

| Bucket | Amount | Purpose |
|---|---|---|
| Maintainer time (full-time, 12 months) | ₹7,00,000 | Core development — provider integrations, format translation, tool-call extractors, tool-result compression, MCP Code Mode, tests, docs. |
| Infrastructure | ₹1,00,000 | CI runners (GitHub Actions paid tier), benchmark harness, public dashboard hosting, telemetry mirrors, domain + SSL. |
| Community + outreach | ₹50,000 | Two FOSS conference talks (FOSSConf, IndiaFOSS, etc.), travel + accommodation, Discord/Forum hosting, one community workshop. |

This sits comfortably within FOSS United's median range of ₹3-7 lakhs and below the ₹15 lakh ceiling. Disbursement will be milestone-based per FOSS United policy for grants over ₹3 lakhs.

---

## Milestones (12-month roadmap)

Each milestone is a tranche release point under FOSS United's milestone-based disbursement.

### Q1 — Stability + observability
- 800+ passing tests
- Public benchmarking harness comparing cost, latency, and output quality across all 12 providers
- Lynkr observability dashboard (latency, cache-hit rate, tier-routing distribution, cost saved)
- 1000+ npm weekly downloads

### Q2 — Indian-cloud-first
- First-class adapters for Indian-hosted LLM providers (Sarvam, Krutrim, Ola, etc.) as they expose APIs
- Hindi/Indic language routing tier (route Indic-language turns to Indic-trained models automatically)
- Documentation translated to Hindi
- 1500+ GitHub stars

### Q3 — Enterprise readiness
- Audit log + RBAC for shared deployments (so a team can run one Lynkr instance for many developers)
- SAML / OIDC integration for enterprise SSO
- Helm chart for Kubernetes deployments
- 3+ Indian enterprise pilots

### Q4 — Ecosystem + sustainability
- Plugin SDK for community-contributed providers and compressors
- ≥5 community-contributed plugins merged
- Indian FOSS conference talk at IndiaFOSS / FOSSConf
- Self-funded MRR via GitHub Sponsors and enterprise support contracts to demonstrate post-grant sustainability

---

## Reporting commitments (per FOSS United guidelines)

- **funding.json** committed at repo root, updated with each milestone (already in place — see [`/funding.json`](../funding.json))
- **Quarterly check-in** with FOSS United on milestone progress
- **One community engagement per quarter:** blog post, conference talk, or forum AMA. Drafts published openly on lynkr.dev / dev.to / FOSS United forum.
- **Participation** in FOSS United maintainer training sessions and community events
- **FOSS Pledge** signed before grant disbursement
- **Open financial reporting** — `funding.history` updated annually in `funding.json`

---

## 5-year sustainability plan

Lynkr remains FOSS forever. Long-term funding stack:

1. **Years 1-2:** FOSS United grant + GitHub Sponsors recurring
2. **Year 2 onwards:** Optional **Lynkr Enterprise** binary (paid) bundling SSO, audit logs, multi-tenant deployment — without forking the open-source core. Inspired by Frappe / ERPNext, Sentry, and PostHog models.
3. **Year 3 onwards:** Indian-cloud partnership revenue — Lynkr ships out-of-box configurations for Sarvam, Krutrim, Ola, Bharat-AI as they mature, in exchange for partnership co-marketing.
4. **Year 4-5:** Self-sustaining via the above; FOSS United funding no longer required.

This staged plan is exactly the model the FOSS United thesis flags as preferred — community grant funds the proof-of-concept and traction, then commercial-but-FOSS-aligned revenue takes over.

---

## Why fund this now

1. **AI coding tools are still early.** Standardising on a FOSS, India-built gateway *now* shapes how the next decade of Indian developer infrastructure looks. Waiting two years means LiteLLM (US) or Portkey (US, paid SaaS) become the default everywhere.
2. **Cost crisis is real and immediate.** Indian developers and teams are actively looking for ways to cut AI tool spend. Lynkr is shipping today (412 stars, 480+ monthly npm downloads, 32 releases in 5 months) — users are saving money today. A grant accelerates community building, not greenfield R&D.
3. **The maintainer is ready to commit full-time.** I am currently a software engineer at ServiceNow Hyderabad and have built Lynkr to its current state (412 stars, 32 releases, 699 tests) **entirely on evenings and weekends in five months**. The grant unlocks the next stage: reducing my day-job commitment so Lynkr's primary working hours come from a focused, full-time-equivalent effort rather than a side project. The traction proves the discipline; the grant resolves the bandwidth constraint.

## Why FOSS United, and not other funding

Per criterion #13 of the FOSS United thesis ("Can this project get funding elsewhere?"), here is an honest assessment of the alternatives and why FOSS United is the right fit:

| Funding source | Fit for Lynkr | Why not the primary path |
|---|---|---|
| VC equity (e.g., Y Combinator, Indian VCs) | Possible — applying in parallel | Equity capital pulls toward closed-source / SaaS-first models. FOSS United funding keeps the open-source layer permanently free. |
| GitHub Sponsors | Active, but slow to scale | Best for sustaining post-grant; insufficient at 5-month traction to fund full-time work. |
| FLOSS Fund / OpenCollective | Eligible; will pursue in parallel | Different funding pool; not mutually exclusive with FOSS United. |
| Cloud-provider open-source programs (AWS, Azure, etc.) | Tight fit since Lynkr integrates with their products | Conflict of interest — they fund usage of *their* clouds, biasing development away from neutrality. |
| Self-funded | Not viable for full-time work | Requires the maintainer to work a day job, slowing release velocity. |

FOSS United is the only funder whose mission directly aligns with Lynkr's wedge — **Indian-origin FOSS infrastructure for Indian developers** — without distorting incentives toward a single commercial outcome.

---

## Maintainer background

**Vishal Veera Reddy** is a software engineer based in Hyderabad, Telangana, building open-source developer infrastructure. He is the sole maintainer of Lynkr, which he initiated in December 2025 and has shipped 32 versions of in five months — averaging ~6 releases per month while accumulating 412 GitHub stars and steady daily npm download activity entirely through organic discovery.

His work on Lynkr spans the full stack of modern AI gateway problems: bidirectional translation between three live LLM API formats (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses), tool-call extractors for ten distinct model-specific output formats (Minimax, Qwen, GLM, Llama, DeepSeek, Mistral, GPT-OSS, etc.), MCP integration with Code Mode meta-tools, persistent memory grounded in the Titans paper, and a 5-phase complexity classifier for tier-based routing. Lynkr's 699-test suite reflects his engineering discipline — every provider integration is regression-tested against a contract.

He is committed to working on Lynkr full-time. The grant enables him to continue this without commercial pressure to close-source the project or to pivot to a SaaS-only model — keeping critical Indian developer infrastructure permanently FOSS.

**Education:** Master's degree in Computer Science, North Carolina State University (NCSU), United States.
**Current role:** Software Engineer at **ServiceNow** (Hyderabad). I have built and shipped Lynkr — 412 stars, 32 releases, 699 tests in five months — entirely outside of work hours, evenings and weekends. **The FOSS United grant would let me reduce my day-job commitment and dedicate primary working hours to Lynkr**, which is the level of focus a project of this scope now needs to scale beyond a solo nights-and-weekends effort.
**Prior FOSS work:** Lynkr is my first major open-source project. The fact that I shipped 412 stars and 32 releases in five months while holding a full-time SE role at ServiceNow demonstrates the level of commitment I bring to FOSS work — and is exactly the bottleneck this grant unblocks.

**Links:**
- GitHub: https://github.com/vishalveerareddy123
- Repository: https://github.com/Fast-Editor/Lynkr
- npm: https://www.npmjs.com/package/lynkr
- Email: veerareddyvishal56@gmail.com
- *[FILL — Twitter/X handle, LinkedIn URL, personal blog if you have one. If not, that's fine — the GitHub presence is enough]*

---

## Appendix: Funding manifest

A valid `funding.json` (FLOSS Fund / fundingjson.org v1.1.0 schema) is committed at the root of the Lynkr repository at [funding.json](../funding.json). It declares:
- Maintainer entity
- Project metadata (Apache-2.0 license, tags, repository URL)
- Funding channels (GitHub Sponsors, FOSS United grant, bank transfer)
- Active funding plans matching the milestones above
