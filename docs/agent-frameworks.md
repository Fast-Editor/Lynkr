# Using Lynkr with agent frameworks (LangGraph, CrewAI, AutoGen)

Multi-agent systems have a specific cost failure mode: every agent resends
the full growing conversation each round-trip, so an uncapped loop compounds
— each turn re-bills every previous turn. Production case: an AutoGen
code-review deployment ran **40% over its projected LLM budget in month one**
from exactly this, until hard loop caps were added.

Lynkr sits between your framework and your providers and gives you, with
zero framework-side changes:

- **Complexity-tier routing** — coordinator chatter and trivial steps go to
  a cheap/local model, hard steps to your frontier model.
- **Loop caps** — a stateless circuit breaker that kills non-converging
  agent loops with a clean 429 instead of a surprise invoice.
- **Per-agent budgets** — virtual-key ceilings so one runaway agent can't
  spend the whole team's budget.
- **Tool-result compression + semantic caching** on everything that flows
  through.

## 1. Point your framework at Lynkr

Lynkr exposes an OpenAI-compatible endpoint, so every major framework
connects with two settings — base URL and any non-empty API key:

**LangGraph / LangChain**

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://localhost:8081/v1",
    api_key="lynkr-local",          # any non-empty string
    model="default",                # Lynkr routes by complexity regardless
)
```

**CrewAI**

```python
from crewai import LLM

llm = LLM(
    model="openai/default",
    base_url="http://localhost:8081/v1",
    api_key="lynkr-local",
)
```

**AutoGen (AG2)**

```python
config_list = [{
    "model": "default",
    "base_url": "http://localhost:8081/v1",
    "api_key": "lynkr-local",
}]
```

Anthropic-native frameworks can use `http://localhost:8081/v1/messages`
instead — both surfaces get the same routing, guards, and budgets.

## 2. Cap runaway loops

Off by default. Enable in Lynkr's `.env`:

```bash
LYNKR_MAX_SESSION_TURNS=80   # reject when a conversation exceeds 80 messages
LYNKR_MAX_TOOL_TURNS=25      # reject when it carries more than 25 tool results
```

The guard is stateless — it reads loop depth from the payload itself
(message count, tool_result count), so it survives proxy restarts and needs
no session affinity. A tripped cap returns:

```json
{ "error": { "type": "loop_cap_exceeded", "message": "Conversation has 81 messages, over the configured cap of 80 …" } }
```

as an HTTP **429**. Handle it in your framework as a terminal condition
(don't blind-retry): in AutoGen set `max_consecutive_auto_reply` as a
belt-and-braces framework-side cap; in LangGraph catch the exception in
your graph node and route to a human-review sink.

Sizing guidance: a healthy tool-using agent task usually converges well
under 25 tool calls. If your workload legitimately needs more, raise the
cap per deployment — but look at a stuck transcript first; the cap firing
usually means the loop was not going to converge.

## 3. Give each agent its own budget

Send a virtual-key header per agent (or per crew/team). Lynkr's
hierarchical budget checks every level and rejects with 429 when a ceiling
is hit:

```python
llm = ChatOpenAI(
    base_url="http://localhost:8081/v1",
    api_key="lynkr-local",
    model="default",
    default_headers={
        "LYNKR-Virtual-Key": "agent:researcher",
        "LYNKR-Team-Id": "crew:pricing-bot",
    },
)
```

Ceilings live in `data/budgets.json`:

```json
{
  "virtual_key": { "agent:researcher": { "ceiling_usd": 5, "period": "daily" } },
  "team":        { "crew:pricing-bot": { "ceiling_usd": 25, "period": "daily" } }
}
```

Disable enforcement entirely with `LYNKR_BUDGET_ENFORCER=false`.

## 4. See what you saved

```bash
lynkr stats --days 7     # shareable savings receipt
lynkr usage --days 7     # full per-tier/provider/model breakdown
```

## Notes

- Tier routing decides per request; sticky sessions keep one decision per
  conversation with automatic escalation when a task outgrows its model
  (see [`docs/routing-intelligence.md`](routing-intelligence.md)).
- Loop caps and budgets apply on `/v1/messages`, `/v1/chat/completions`,
  and `/v1/responses` — all client surfaces, not just one.
