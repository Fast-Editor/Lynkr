/**
 * Model + reasoning-effort → tier mapping for Codex/ChatGPT desktop's model
 * picker (the "5.6 Sol Light" dropdown in the app UI).
 *
 * This is the OpenAI/Responses-API-shaped counterpart to ./model-slots.js.
 * That module works because Claude Desktop lets a gateway advertise
 * completely made-up model ids ("claude-fable-5" etc.) via its own /v1/models
 * list. Codex has no such gateway hook — its dropdown is populated from
 * OpenAI's own real model catalog, and it always sends a real OpenAI model
 * id (e.g. "gpt-5.6-sol", "gpt-5.6-mini") plus a `reasoning.effort` field
 * (OpenAI's documented enum: minimal | low | medium | high). So instead of
 * inventing ids, this pins on (model, effort) combinations Codex's dropdown
 * can actually produce.
 *
 * Verification status: CONFIRMED live (2026-08-28) via a temp diagnostic log
 * (since removed) that captured a real Codex Desktop request. A screenshot
 * of the picker showed model options "5.6 Sol / 5.6 Terra / 5.6 Luna / 5.5 /
 * 5.2" (five peer entries, no visible size/tier hint — an earlier version of
 * this file guessed "luna" meant a cheap/distilled variant; that guess had
 * no evidence and has been removed) and an "Effort" row labeled "Light".
 * The captured request, sent with that exact picker state, carried
 * `reasoning: {"effort":"low","summary":"detailed","context":"all_turns"}`
 * — so the UI label "Light" is confirmed to be OpenAI's documented public
 * enum value "low" verbatim, not a distinct string. resolveTierForOpenAIModel()
 * stays conservative regardless: any unrecognized model or effort value
 * returns null (no pin), falling through to normal content-based scoring.
 *
 * Scope note (also observed live in the same captured session): the pin
 * only governs the FIRST model call of a turn. Multi-step agentic turns
 * (tool calls, follow-up steps) re-score by content on each subsequent
 * step — this is inherent to the shared `_forceProvider` mechanism
 * (orchestrator/index.js deletes it after the first read), identical to
 * how router.js's own Claude-Desktop-picker pin already behaves. Not a bug
 * introduced here; a pre-existing property of the shared pin plumbing.
 *
 * Shared by:
 *   - src/api/openai-router.js — resolves an incoming /chat/completions or
 *     /responses request's `model` + `reasoning.effort` fields to a tier,
 *     mirroring router.js's model-id-pin block (which openai-router.js's
 *     handlers never go through — they call orchestrator.processMessage()
 *     directly).
 *
 * @module routing/openai-model-slots
 */

// OpenAI's publicly documented naming convention for distilled/cheap model
// variants — NOT confirmed present in this app's specific dropdown (its
// real options are Sol/Terra/Luna/5.5/5.2, no mini/nano seen), kept only
// because it's a well-established public-catalog convention that costs
// nothing to check if some other Codex build or client does send one.
const SMALL_MODEL_PATTERN = /-(mini|nano)\b/i;

// reasoning.effort → tier. Confirmed live 2026-08-28: Codex Desktop's
// "Light" picker label sends the literal wire value "low", not "light" —
// OpenAI's publicly documented Responses API enum, verbatim. See the module
// doc comment above for the captured request that confirmed this.
const EFFORT_TIER = {
  minimal: "SIMPLE",
  low: "MEDIUM",
  medium: "COMPLEX",
  high: "REASONING",
};

/**
 * Resolve a Codex-style model id + reasoning effort to a Lynkr tier.
 *
 * @param {string|null|undefined} model - e.g. "gpt-5.6-sol"
 * @param {string|null|undefined} effort - e.g. "low" (from body.reasoning.effort)
 * @returns {string|null} one of SIMPLE/MEDIUM/COMPLEX/REASONING, or null when
 *   unrecognized — caller should fall through to normal content scoring.
 */
function resolveTierForOpenAIModel(model, effort) {
  if (typeof model === "string" && SMALL_MODEL_PATTERN.test(model)) {
    return "SIMPLE";
  }
  if (typeof effort === "string" && EFFORT_TIER[effort.toLowerCase()]) {
    return EFFORT_TIER[effort.toLowerCase()];
  }
  return null;
}

module.exports = { EFFORT_TIER, SMALL_MODEL_PATTERN, resolveTierForOpenAIModel };
