# X-Lynkr-Context-Window — Served-Model Context Window Header

## The problem this solves

Clients pointing at Lynkr configure **one model entry** (e.g. `lynkr-auto`)
with **one static context-window number**. But tier routing serves different
real models per request — a 32k local model on SIMPLE, a 128k Azure model on
COMPLEX, a 200k+ model on REASONING. Whatever single number the client
configured is wrong for most requests:

- Too large → the client's compaction never triggers in time, the
  conversation outgrows the served model, and Lynkr's server-side history
  compression has to amputate it mechanically (far worse quality than the
  client's own LLM-based compaction).
- Too small → big-window models are never fully used.

## The contract

Every response whose served model is known carries:

```
X-Lynkr-Model: gpt-5.6-sol
X-Lynkr-Context-Window: 128000
```

`X-Lynkr-Context-Window` is the **served** model's real context window in
tokens, from Lynkr's model registry. It is the authoritative per-turn answer
to "how big is the model I actually just talked to?" — clients should treat
it as their **compaction budget** for the session (and, because sticky
sessions pin one model per conversation, it is stable across a session's
turns except at escalations, where the header updates on the turn that
switched).

**The header is omitted — never guessed — when the registry doesn't know the
model.** A client compacting against a fabricated number either wastes
context or overruns the real window; absence is the honest signal to fall
back to your own configuration.

Emitted on all ingress paths: Anthropic (`/v1/messages`, including
passthrough and native streaming) and OpenAI-compat (`/v1/chat/completions`,
`/v1/responses`).

## Client guidance

- **Harnesses that can read response headers** (custom clients, plugins):
  update your compaction threshold from this header each turn. This is the
  same integration pattern workweave's router uses with its pi extension
  (router-served context window as the single source of truth for
  compaction).
- **opencode / other harnesses with static per-model config**: until the
  harness reads this header, set your Lynkr model entry's `limit.context`
  to the *minimum* window across your configured tiers — early client-side
  compaction (LLM-quality summarization) beats late server-side compression
  (mechanical squeeze) every time.
- Unknown-model responses (no header): keep whatever you configured.
