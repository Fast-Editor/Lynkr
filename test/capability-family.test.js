const assert = require('assert');
const { describe, it } = require('node:test');
const { normalizeFamily, detectQuant, applyQuantHaircut } = require('../src/routing/capability-seeds/family');
const { heuristicCaps } = require('../src/routing/capability-seeds/family-heuristics');

describe('family normalization', () => {
  it('strips provider prefixes and org segments', () => {
    assert.strictEqual(normalizeFamily('zai', 'GLM-5.2').family, 'glm-5.2');
    assert.strictEqual(normalizeFamily('baidu', 'glm-5.2').family, 'glm-5.2');
    assert.strictEqual(normalizeFamily('ollama', 'glm-5.2').family, 'glm-5.2');
    assert.strictEqual(normalizeFamily('openai', 'openai/gpt-4o-mini').family, 'gpt-4o-mini');
    assert.strictEqual(normalizeFamily('x', 'zai-org/GLM-5.2').family, 'glm-5.2');
    assert.strictEqual(normalizeFamily('databricks', 'databricks-claude-sonnet-4-5').family, 'claude-sonnet-4.5');
  });

  it('folds ollama tags, keeping size and dropping noise', () => {
    assert.strictEqual(normalizeFamily('ollama', 'qwen2.5-coder:7b').family, 'qwen2.5-coder-7b');
    assert.strictEqual(normalizeFamily('ollama', 'minimax-m3:cloud').family, 'minimax-m3');
    assert.strictEqual(normalizeFamily('ollama', 'llama3.2:latest').family, 'llama3.2');
  });

  it('unifies separators and version runs', () => {
    assert.strictEqual(normalizeFamily('x', 'gpt_3_5_turbo').family, 'gpt-3.5-turbo');
    assert.strictEqual(normalizeFamily('x', 'llama-3-1-70b').family, 'llama-3.1-70b');
    assert.strictEqual(normalizeFamily('x', 'Qwen3-32B').family, 'qwen3-32b');
  });

  it('detects quantization without changing identity matching', () => {
    const q = normalizeFamily('ollama', 'glm-5.2:Q4_K_M');
    assert.strictEqual(q.family, 'glm-5.2-q4-k-m');
    assert.strictEqual(q.quant, true);
    assert.strictEqual(normalizeFamily('zai', 'glm-5.2').quant, false);
    assert.strictEqual(detectQuant('model.gguf'), true);
    assert.strictEqual(detectQuant('gpt-4o'), false);
  });

  it('applies a small floor-bounded haircut', () => {
    const out = applyQuantHaircut({ reasoning: 0.7, codegen: 0.1 });
    assert.strictEqual(out.reasoning, 0.68);
    assert.strictEqual(out.codegen, 0.1); // floor holds, never negative push below 0.1
  });
});

describe('family-ladder heuristics', () => {
  it('orders flagship > mid > small', () => {
    const opus = heuristicCaps('claude-opus-4-6');
    const sonnet = heuristicCaps('claude-sonnet-4-5');
    const haiku = heuristicCaps('claude-haiku-4-5');
    assert.ok(opus.reasoning > sonnet.reasoning && sonnet.reasoning > haiku.reasoning);
  });

  it('never claims frontier and returns null on no signal', () => {
    assert.ok(heuristicCaps('gpt-5.4').reasoning <= 0.85);
    assert.strictEqual(heuristicCaps('muse-spark-1.3-contributor-free'), null);
    assert.strictEqual(heuristicCaps('unknown'), null);
    assert.strictEqual(heuristicCaps(''), null);
  });

  it('tilts coders and reasoners', () => {
    const coder = heuristicCaps('qwen2.5-coder-32b');
    assert.ok(coder.codegen >= coder.reasoning);
    const reasoner = heuristicCaps('deepseek-r1');
    assert.ok(reasoner.reasoning >= reasoner.codegen);
  });

  it('sizes unknown numbered models monotonically', () => {
    const small = heuristicCaps('somemodel-7b');
    const big = heuristicCaps('somemodel-70b');
    assert.ok(big.reasoning > small.reasoning);
  });
});
