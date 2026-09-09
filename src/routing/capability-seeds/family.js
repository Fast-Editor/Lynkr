/**
 * Model-family normalization for capability seeding.
 *
 * Capability is a property of the MODEL (weights), not the provider serving
 * it: zai:glm-5.2, baidu:glm-5.2 and ollama:glm-5.2 must resolve to one
 * family id ("glm-5.2") and therefore identical caps. Provider stays on the
 * cost/invocation path only.
 *
 * Normalization (order matters):
 *   1. lowercase + trim, drop @digest suffixes
 *   2. last `/`-segment wins (strips org prefixes: zai-org/glm-5.2,
 *      openai/gpt-4o-mini, anthropic/claude-...)
 *   3. Ollama `:tag` becomes `-tag` (tags often carry SIZE: qwen2.5-coder:7b
 *      → qwen2.5-coder-7b; :latest/:cloud are noise but harmless post-strip)
 *   4. strip serving prefixes (databricks-, anthropic., bedrock/)
 *   5. `_` → `-`, digit-dash-digit → digit.dot.digit
 *      (gpt-3-5-turbo → gpt-3.5-turbo, llama-3-1-70b → llama-3.1-70b),
 *      collapse repeats
 *
 * Quantization is detected, not normalized away: Q4_K_M / gguf / int4 / awq
 * style markers set quant:true so the resolver can apply the small
 * same-brain-smaller-body haircut. Full-precision self-hosted hits the same
 * caps as the API.
 *
 * Pure functions, no I/O. Never throws.
 */

const SERVING_PREFIXES = ['databricks-', 'anthropic.', 'bedrock/'];

// Quant markers: matched against the full "model:tag" string BEFORE tag
// folding, and against the folded family after (tags like Q4_K_M survive as
// -q4-k-m, so one pass after folding suffices — but pre-tag names like
// "model-Q4" exist too, hence match post-fold only, on the whole string).
const QUANT_RE = /(q[23468](_|-|$)|_k_[sm]|[-_]q8_0|gguf|int[48]|fp[148]|awq|gptq|bnb|mlx|quantized)/i;

// Tags that carry no signal even as suffixes.
const NOISE_TAGS = new Set(['latest', 'cloud', 'instruct']);

function detectQuant(s) {
  try {
    return QUANT_RE.test(String(s || ''));
  } catch {
    return false;
  }
}

/**
 * @param {string} provider
 * @param {string} model
 * @returns {{ family:string, quant:boolean }}
 */
function normalizeFamily(provider, model) {
  try {
    let s = `${String(model || '').trim()}`;
    // @sha256:... digests
    s = s.split('@')[0];
    // org prefix: last segment wins
    if (s.includes('/')) s = s.split('/').pop();
    const quant = detectQuant(`${provider || ''}/${model || ''}`) || detectQuant(s);
    // Ollama :tag → -tag (size tags preserved: :7b → -7b)
    if (s.includes(':')) {
      const [base, ...tags] = s.split(':');
      const kept = tags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t && !NOISE_TAGS.has(t));
      s = kept.length > 0 ? `${base}-${kept.join('-')}` : base;
    }
    s = s.toLowerCase().trim();
    for (const p of SERVING_PREFIXES) {
      if (s.startsWith(p)) {
        s = s.slice(p.length);
        break;
      }
    }
    s = s.replace(/_/g, '-');
    // digit-dash-digit → digit.dot.digit, but only for version runs: the
    // second digit must be followed by another dash or end-of-string, so
    // size suffixes survive (llama-3-1-70b → llama-3.1-70b, but
    // qwen3-32b and gemma-3-27b keep their dash).
    s = s.replace(/(\d)-(?=\d(?:-|$))/g, '$1.');
    s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return { family: s || 'unknown', quant };
  } catch {
    return { family: 'unknown', quant: false };
  }
}

/**
 * Quant haircut: same brain, smaller body. Applied by the resolver to
 * seed/family/tier caps — never to explicit operator overrides (an exact
 * provider:model override wins verbatim).
 */
const QUANT_HAIRCUT = 0.02;
const QUANT_FLOOR = 0.1;

function applyQuantHaircut(caps) {
  const out = {};
  for (const [k, v] of Object.entries(caps || {})) {
    const n = Number(v);
    out[k] = Number.isFinite(n) ? Math.max(QUANT_FLOOR, Math.round((n - QUANT_HAIRCUT) * 1000) / 1000) : v;
  }
  return out;
}

module.exports = { normalizeFamily, detectQuant, applyQuantHaircut, QUANT_HAIRCUT };
