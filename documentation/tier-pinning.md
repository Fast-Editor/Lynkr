# Tier Pinning via the Client's Model Picker

Lynkr turns the model dropdown that desktop AI clients already have into a
**routing tier selector** — no client plugin, no custom UI, no config file on
the client machine. Pick a "model" in the picker; Lynkr reads that pick as a
tier pin and routes accordingly. To our knowledge this technique has no prior
art in other gateways (checked against LiteLLM, OpenRouter, Portkey, Kong,
and workweave/router as of 2026-09).

## The idea

Desktop clients (Claude Desktop, Codex/ChatGPT Desktop) send whatever model
id the user picked in their dropdown. Lynkr sits in front of the provider, so
it sees that id before any routing happens. Instead of treating the picker as
"which upstream model to call," Lynkr maps picker entries onto its four
routing tiers:

| Picker intent | Tier | What Lynkr does |
|---|---|---|
| "Auto" entry | none | Full content-based tier routing (default behavior) |
| Top model | `REASONING` | Pin to the REASONING tier's configured model |
| Mid model | `COMPLEX` / `MEDIUM` | Pin to that tier's configured model |
| Small model | `SIMPLE` | Pin to the SIMPLE tier's configured model |

A pin **bypasses content scoring** for that request: the user explicitly
asked for a capability class, and an explicit user choice beats a heuristic.
Unrecognized ids/values always resolve to *no pin* (fall through to normal
routing) — the resolver never guesses (see `documentation/claude-desktop.md`
for the incident-shaped reasoning behind exact-match-only resolution).

## Two client shapes, two mechanisms

### 1. Gateway-advertised ids (Claude Desktop) — `src/routing/model-slots.js`

Claude Desktop populates its picker from the gateway's own `/v1/models`
response, but **validates ids against a fixed known set** — arbitrary ids
break the picker. So Lynkr advertises five real Claude model ids and maps
them to tiers (`claude-opus-5` → REASONING, `claude-sonnet-5` → COMPLEX,
`claude-sonnet-4-6` → MEDIUM, `claude-haiku-4-5-20251001` → SIMPLE, with
`claude-fable-5` as the "Auto" no-pin entry). Wired via
`src/api/claude-desktop-gateway.js` (advertises the list) and
`src/api/router.js` (resolves the pick back to a tier).

### 2. Real-catalog ids + parameters (Codex/ChatGPT Desktop) —
`src/routing/openai-model-slots.js`

Codex has no gateway hook for its picker — it always sends a **real** OpenAI
model id plus a `reasoning.effort` field (`minimal | low | medium | high`,
shown in the UI as effort labels like "Light"). Lynkr pins on the
`(model, effort)` **combination** instead of inventing ids. Confirmed live
(2026-08-28) against a captured Codex Desktop request. Wired via
`src/api/openai-router.js` on both `/v1/chat/completions` and
`/v1/responses`.

## Generalizing to a new client

The pattern reduces to three questions:

1. **What does the client actually send** when the user changes the picker?
   Capture one real request (a temp diagnostic log; remove it after). Never
   guess from UI labels — the label "Light" turned out to be wire value
   `"low"`, and an early guess about a model variant's meaning had to be
   removed for lack of evidence.
2. **Can Lynkr control the picker's contents?** If yes (Claude Desktop
   shape): advertise ids the client will accept, map id → tier. If no
   (Codex shape): map the real `(model, parameters)` combinations the picker
   can produce.
3. **What happens on unrecognized input?** Always: no pin, fall through to
   content scoring. A picker pin is advisory-input-turned-explicit — an
   unmapped value must degrade to the default, never to a wrong pin.

Both resolvers return `null` for anything unrecognized, and both feed the
same downstream pin mechanism (`_forceProvider`), so a new client mapping is
one small module + one resolver call at its ingress point.

## Scope and caveats

- A picker pin governs the **first model call of a turn**. Multi-step
  agentic turns (tool loops) re-score by content on subsequent steps — a
  property of the shared pin plumbing (`_forceProvider` is consumed on first
  read), consistent across both client shapes.
- Pins select a **tier**, whose model comes from your `TIER_*` config — the
  picker never routes to a model you haven't configured.
- Session pins (sticky routing) and picker pins compose: the picker pin wins
  for the request that carries it, and normal stickiness resumes after.
