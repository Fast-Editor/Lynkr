/**
 * Model id → tier mapping for Claude Desktop's model picker.
 *
 * Claude Desktop VALIDATES model ids against a fixed set — arbitrary ids
 * (e.g. "lynkr-simple") make it show "model list hasn't loaded". These five
 * slots mirror ollama's internal/proxy/claude_desktop_models.go, the ids
 * Desktop currently accepts.
 *
 * Shared by:
 *   - src/api/claude-desktop-gateway.js — advertises these as the Anthropic-
 *     format model list Desktop's picker renders.
 *   - src/api/router.js — resolves an incoming request's `model` field back
 *     to a tier, so an explicit pick in Desktop's dropdown pins routing
 *     instead of only being advisory.
 *
 * @module routing/model-slots
 */

const MODEL_SLOTS = [
  { id: "claude-fable-5", family: "fable", createdAt: "2026-06-09T00:00:00Z", isDefault: true, tier: null, label: "Lynkr Auto (tier routing)" },
  { id: "claude-opus-5", family: "opus", createdAt: "2026-07-24T00:00:00Z", isDefault: true, tier: "REASONING" },
  { id: "claude-sonnet-5", family: "sonnet", createdAt: "2026-06-30T00:00:00Z", isDefault: true, tier: "COMPLEX" },
  { id: "claude-sonnet-4-6", family: "sonnet", createdAt: "2025-11-18T00:00:00Z", isDefault: false, tier: "MEDIUM" },
  { id: "claude-haiku-4-5-20251001", family: "haiku", createdAt: "2025-10-01T00:00:00Z", isDefault: true, tier: "SIMPLE" },
];

/**
 * Resolve a client-supplied model id to the tier it pins.
 *
 * @param {string} modelId
 * @returns {string|null} one of SIMPLE/MEDIUM/COMPLEX/REASONING, or null if
 *   the id is unrecognized or maps to "Auto" (no pin — caller should fall
 *   through to content-based scoring).
 */
function resolveTierForModelId(modelId) {
  if (!modelId) return null;
  const slot = MODEL_SLOTS.find((s) => s.id === modelId);
  return slot?.tier || null;
}

module.exports = { MODEL_SLOTS, resolveTierForModelId };
