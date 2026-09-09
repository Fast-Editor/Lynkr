/**
 * Family-ladder heuristics: zero-network capability estimates from model
 * family names. Vendors ship in ladders (haiku<sonnet<opus, mini<full,
 * flash<pro, air<max, 7b<32b<70b), so an unknown model usually reveals its
 * rung by name. Deliberately pessimistic: heuristics never claim frontier
 * (cap 0.85) — exact seeds do that. Returns null when nothing matches, so
 * the resolver falls through to tier-slot caps (today's behavior).
 *
 * Tilts: coder-named models get +codegen, reasoner-named +reasoning.
 * Everything rounded to 3 decimals. Pure, no I/O, never throws.
 */

const CAP = 0.85;
const FLOOR = 0.15;

// Ordered: first match wins. Frontier names before size rules (a bare
// "deepseek-r1" carries no size suffix but is strong).
const LADDER = [
  // Frontier (0.80)
  { re: /^(gpt-5(\.|$)|o1(-pro)?$|o3($|-)|claude-opus-4|gemini-2\.5-pro|deepseek-r1$|deepseek-reasoner|glm-5\.|kimi-k3($|-)|grok-4|llama-3\.1-405b|qwen3-max|qwen3-235b|doubao-seed-1\.6|minimax-m2($|-)|gpt-5\.2|gpt-5\.3|gpt-5\.4)/, base: 0.8 },
  // Strong (0.65)
  { re: /(sonnet|gpt-4o$|gpt-4-turbo|gpt-5-mini|gpt-5-nano$|gemini-2\.[05].*pro|qwen3-3[02]b|qwen2\.5-3[23]b|deepseek-v3|glm-4\.7|glm-4\.6|glm-4\.5($|-)|kimi-k2($|-)|mistral-large|codestral|gpt-oss-120b|llama-3\.3-70b|qwen3-30b-a3b|devstral-large|kimi-k2\.5|gemini-3-pro|claude-4\.5)/, base: 0.65 },
  // Mid (0.50)
  { re: /(gpt-4o-mini|haiku|o4-mini|qwen3-(4b|8b|14b)|qwen2\.5-(7b|14b)|gemma-3-27b|phi-4|mistral-small|ministral|glm-4-flash|glm-4\.5-air|-lite$|-air$|devstral-small|qwen3-4b|gpt-5\.1)/, base: 0.5 },
  // Small (0.30)
  { re: /(-7b|-8b|-9b|^.*[^0-9](7|8|9)b$|mini|nano|gemma-?2|phi-3|llama-3\.2|flash-lite)/, base: 0.3 },
  // Tiny (0.20)
  { re: /(-1b|-2b|-3b|-0\.5b|-1\.5b|tiny$|gpt-3\.5)/, base: 0.2 },
];

const CODER_RE = /(coder|codestral|starcoder|qwen3-coder|devstral)/;
const REASONER_RE = /(reason|r1$|qwq|\bo1\b|\bo3\b|thinking)/;

function _sizeBase(family) {
  const m = String(family || '').match(/(\d+(?:\.\d+)?)\s*b(?:$|-)/);
  if (!m) return null;
  const gb = Number(m[1]);
  if (!Number.isFinite(gb)) return null;
  if (gb >= 100) return 0.8;
  if (gb >= 30) return 0.65;
  if (gb >= 10) return 0.5;
  if (gb >= 4) return 0.35;
  return 0.25;
}

/**
 * @param {string} family — normalized family id (see family.js)
 * @returns {null | { reasoning:number, codegen:number, debugging:number, tool_use:number }}
 */
function heuristicCaps(family) {
  try {
    const f = String(family || '').toLowerCase().trim();
    if (!f || f === 'unknown') return null;
    let base = null;
    for (const { re, base: b } of LADDER) {
      if (re.test(f)) {
        base = b;
        break;
      }
    }
    if (base === null) base = _sizeBase(f);
    if (base === null) return null;
    const round3 = (v) => Math.max(FLOOR, Math.min(CAP, Math.round(v * 1000) / 1000));
    const codegen = base + (CODER_RE.test(f) ? 0.05 : 0);
    const reasoning = base + (REASONER_RE.test(f) ? 0.05 : 0);
    return {
      reasoning: round3(reasoning),
      codegen: round3(codegen),
      debugging: round3(base),
      tool_use: round3(base),
    };
  } catch {
    return null;
  }
}

module.exports = { heuristicCaps };
