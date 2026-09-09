/**
 * models.dev adapter: boolean capability flags per model (tool_call,
 * vision/image input, reasoning, context window). Same public endpoint the
 * pricing registry already consumes (https://models.dev/api.json), same
 * shape ({ providerId: { models: { modelId: {...} } } }).
 *
 * Flags don't set caps — they GATE them: a model with tool_call=false gets
 * tool_use capped (it can still drive tools via XML extraction, which is why
 * this is a cap, not a zero). Everything else passes through as provenance
 * for operator review.
 *
 * Fail-soft: { status:'skipped', reason } on any problem.
 */

const { fetchJson, getCached, setCached, skipped } = require('./sources');
const { normalizeFamily } = require('./family');

const MODELS_DEV_URL = 'https://models.dev/api.json';

// Conservative ceiling for models without function-calling. XML-extracted
// tool calls (see xml-tool-extractor.js) keep them usable, hence 0.4 not 0.
const NO_TOOLCALL_TOOL_USE_CAP = 0.4;

/**
 * @param {object} [opts] — { refresh:boolean }
 * @returns {Promise<{ status, flags?:Object<family,{toolCall,vision,reasoning,context}>, reason? }>}
 */
async function fetchModelsDevFlags({ refresh = true } = {}) {
  const parse = (data) => {
    const out = {};
    for (const [providerId, providerData] of Object.entries(data || {})) {
      if (!providerData?.models) continue;
      for (const [modelId, info] of Object.entries(providerData.models)) {
        if (!info || typeof info !== 'object') continue;
        const { family } = normalizeFamily(providerId, modelId);
        if (family === 'unknown' || out[family]) continue; // first provider wins
        out[family] = {
          toolCall: info.tool_call ?? null,
          vision: Array.isArray(info.input) ? info.input.includes('image') : null,
          reasoning: info.reasoning ?? null,
          context: Number(info.context) || null,
        };
      }
    }
    return out;
  };

  if (!refresh) {
    const cached = getCached('modelsdev');
    if (cached) return { status: 'ok', flags: cached, cached: true };
    return skipped('no cache (run with --refresh)');
  }
  try {
    const flags = parse(await fetchJson(MODELS_DEV_URL));
    setCached('modelsdev', flags);
    return { status: 'ok', flags };
  } catch (err) {
    const cached = getCached('modelsdev');
    if (cached) return { status: 'ok', flags: cached, cached: true, stale: err.message };
    return skipped(`fetch failed and no cache: ${err.message}`);
  }
}

module.exports = { fetchModelsDevFlags, MODELS_DEV_URL, NO_TOOLCALL_TOOL_USE_CAP };
