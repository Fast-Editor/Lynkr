/**
 * Claude Desktop third-party gateway support.
 *
 * Claude Desktop has a native "3p" deployment mode in which it sends its
 * normal Anthropic Messages API traffic to a local gateway URL instead of
 * api.anthropic.com (this is the route Ollama's `ollama launch
 * claude-desktop` integration uses). Lynkr already speaks the Messages API
 * on /v1/messages, so the only missing surface is model discovery: Desktop
 * lists the gateway's models and maps them into its model picker using two
 * non-standard fields observed in Ollama's gateway implementation
 * (internal/proxy/claude_desktop.go): `anthropic_family_tier` and
 * `is_family_default`.
 *
 * This router serves that list, derived from Lynkr's TIER_* config so the
 * Desktop model picker doubles as a tier selector:
 *
 *   SIMPLE    -> haiku family (default)
 *   MEDIUM    -> sonnet family
 *   COMPLEX   -> sonnet family (default)
 *   REASONING -> opus family (default)
 *
 * The selected id PINS routing: src/api/router.js resolves the request's
 * `model` field against ../routing/model-slots.js and, when it matches one
 * of these ids (anything but "Lynkr Auto" / claude-fable-5), skips content
 * scoring entirely and forces that tier. Only "Lynkr Auto" and unrecognized
 * ids fall through to Lynkr's normal per-message scoring, same as Claude
 * Code traffic gets.
 *
 * Gating: GET /v1/models is already served in OpenAI format by
 * openai-router.js (mounted after this router). We only intercept callers
 * that identify as Anthropic API clients via the `anthropic-version` header
 * (Claude Desktop always sends it) or an explicit ?format=anthropic. Set
 * CLAUDE_DESKTOP_GATEWAY=0 to disable the intercept entirely.
 *
 * Profile installation lives in scripts/claude-desktop.js.
 */

const express = require("express");
const config = require("../config");
const logger = require("../logger");
const { MODEL_SLOTS } = require("../routing/model-slots");

const router = express.Router();

// Fixed timestamp: Anthropic's list endpoint dates models by release, not by
// request time, and a stable value keeps repeated calls cache-friendly.
const CREATED_AT = "2026-01-01T00:00:00Z";

const DEFAULT_MAX_TOKENS = 32768;

// MODEL_SLOTS lives in ../routing/model-slots.js — shared with router.js,
// which resolves an incoming request's `model` field back to a tier so an
// explicit pick in Desktop's dropdown pins routing instead of only being
// advisory (see the model-id-pin block in router.js).

function gatewayEnabled() {
  return process.env.CLAUDE_DESKTOP_GATEWAY !== "0";
}

function maxTokens() {
  const raw = Number(process.env.CLAUDE_DESKTOP_GATEWAY_MAX_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TOKENS;
}

/**
 * Build the Anthropic-shaped model list from configured tiers. Tiers that
 * are unset in .env are skipped; if that leaves a family with no default,
 * the first surviving entry of that family is promoted so Desktop always
 * has a selectable default per family.
 */
function buildGatewayModels() {
  const entries = [];
  for (const slot of MODEL_SLOTS) {
    let label = slot.label;
    if (!label) {
      const configured = config.modelTiers?.[slot.tier];
      if (!configured) continue; // tier unset in .env — skip this slot
      const [provider, ...modelParts] = configured.split(":");
      const model = modelParts.join(":") || provider;
      label = `Lynkr ${slot.tier} (${model})`;
    }
    entries.push({
      type: "model",
      id: slot.id,
      display_name: label,
      created_at: slot.createdAt || CREATED_AT,
      max_tokens: maxTokens(),
      anthropic_family_tier: slot.family,
      is_family_default: slot.isDefault,
    });
  }
  return entries;
}

router.get("/models", (req, res, next) => {
  const wantsAnthropic =
    req.headers["anthropic-version"] || req.query.format === "anthropic";
  if (!gatewayEnabled() || !wantsAnthropic) return next();

  try {
    const data = buildGatewayModels();
    if (data.length === 0) return next(); // no tiers configured — fall through
    logger.debug(
      { modelCount: data.length, ua: req.headers["user-agent"] },
      "[ClaudeDesktopGateway] Listed tier models (Anthropic format)"
    );
    res.json({
      data,
      first_id: data[0].id,
      last_id: data[data.length - 1].id,
      has_more: false,
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      "[ClaudeDesktopGateway] Failed to list models"
    );
    next(); // fall through to the OpenAI-format handler rather than 500
  }
});

module.exports = router;
module.exports._buildGatewayModels = buildGatewayModels; // test hook
