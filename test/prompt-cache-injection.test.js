/**
 * Tests for Provider-Side Prompt Cache Injection
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  injectAnthropicCacheBreakpoints,
  injectPromptCaching,
  needsCacheInjection,
  modelSupportsCacheControl,
} = require('../src/clients/prompt-cache-injection');

// ── needsCacheInjection ─────────────────────────────────────────────

describe('needsCacheInjection', () => {
  it('returns true for Anthropic providers', () => {
    assert.equal(needsCacheInjection('azure-anthropic'), true);
    assert.equal(needsCacheInjection('bedrock'), true);
    assert.equal(needsCacheInjection('databricks'), true);
    assert.equal(needsCacheInjection('openrouter'), true);
  });

  it('returns false for auto-caching providers', () => {
    assert.equal(needsCacheInjection('openai'), false);
    assert.equal(needsCacheInjection('ollama'), false);
    assert.equal(needsCacheInjection('vertex'), false);
    assert.equal(needsCacheInjection('moonshot'), false);
    assert.equal(needsCacheInjection('zai'), false);
  });
});

// ── injectAnthropicCacheBreakpoints ─────────────────────────────────

describe('injectAnthropicCacheBreakpoints', () => {
  it('returns 0 for null body', () => {
    assert.equal(injectAnthropicCacheBreakpoints(null), 0);
  });

  it('marks string system prompt with cache_control', () => {
    const body = {
      system: 'You are a helpful assistant',
      messages: [],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 1);
    assert.ok(Array.isArray(body.system));
    assert.equal(body.system[0].type, 'text');
    assert.equal(body.system[0].text, 'You are a helpful assistant');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  });

  it('marks last block of array system prompt', () => {
    const body = {
      system: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
      messages: [],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 1);
    assert.equal(body.system[0].cache_control, undefined);
    assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' });
  });

  it('marks last 3 messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
      ],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 3); // last 3 messages (no system = 3 breakpoints max)

    // First 2 messages: no cache_control
    assert.equal(body.messages[0].content, 'msg1'); // unchanged string
    assert.equal(body.messages[1].content, 'msg2');

    // Last 3 messages: converted to array with cache_control
    assert.ok(Array.isArray(body.messages[2].content));
    assert.ok(Array.isArray(body.messages[3].content));
    assert.ok(Array.isArray(body.messages[4].content));
    assert.deepEqual(body.messages[4].content[0].cache_control, { type: 'ephemeral' });
  });

  it('marks system + last 3 messages = 4 total breakpoints', () => {
    const body = {
      system: 'System prompt',
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
      ],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 4); // 1 system + 3 messages = 4 (max)
  });

  it('respects max 4 breakpoints', () => {
    const body = {
      system: 'System',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
        { role: 'user', content: 'e' },
        { role: 'assistant', content: 'f' },
      ],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.ok(count <= 4, `Expected <= 4 breakpoints, got ${count}`);
  });

  it('handles array content blocks in messages', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
      ],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 1);
    // Should mark the last block in the content array
    assert.equal(body.messages[0].content[0].cache_control, undefined);
    assert.deepEqual(body.messages[0].content[1].cache_control, { type: 'ephemeral' });
  });

  it('does not double-mark already cached content', () => {
    const body = {
      system: [
        { type: 'text', text: 'System', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 0); // already marked
  });

  it('handles single message conversation', () => {
    const body = {
      system: 'System',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 2); // system + 1 message
  });

  it('handles empty messages array', () => {
    const body = {
      system: 'System',
      messages: [],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 1); // system only
  });

  it('handles no system prompt', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };
    const count = injectAnthropicCacheBreakpoints(body);
    assert.equal(count, 1); // 1 message
  });
});

// ── injectPromptCaching ─────────────────────────────────────────────

describe('injectPromptCaching', () => {
  it('injects for azure-anthropic', () => {
    const body = {
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'azure-anthropic');
    assert.equal(count, 2);
  });

  it('injects for bedrock', () => {
    const body = {
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'bedrock');
    assert.equal(count, 2);
  });

  it('does nothing for openai', () => {
    const body = {
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'openai');
    assert.equal(count, 0);
    assert.equal(body.system, 'test'); // unchanged
  });

  it('does nothing for ollama', () => {
    const body = {
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'ollama');
    assert.equal(count, 0);
  });
});

// ── model-capability gate ───────────────────────────────────────────

describe('modelSupportsCacheControl', () => {
  it('always supports for Anthropic-only providers', () => {
    assert.equal(modelSupportsCacheControl({}, 'azure-anthropic'), true);
    assert.equal(modelSupportsCacheControl({ _tierModel: 'whatever' }, 'databricks'), true);
  });

  it('fails open when no model id is present', () => {
    assert.equal(modelSupportsCacheControl({}, 'bedrock'), true);
    assert.equal(modelSupportsCacheControl({}, 'openrouter'), true);
  });

  it('supports Claude model ids on bedrock', () => {
    assert.equal(
      modelSupportsCacheControl(
        { _tierModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
        'bedrock'
      ),
      true
    );
  });

  it('blocks non-Claude bedrock families', () => {
    assert.equal(modelSupportsCacheControl({ _tierModel: 'meta.llama3-70b-instruct-v1:0' }, 'bedrock'), false);
    assert.equal(modelSupportsCacheControl({ _tierModel: 'amazon.titan-text-express-v1' }, 'bedrock'), false);
    assert.equal(modelSupportsCacheControl({ _tierModel: 'mistral.mistral-7b-instruct-v0:2' }, 'bedrock'), false);
    assert.equal(modelSupportsCacheControl({ _tierModel: 'cohere.command-text-v14' }, 'bedrock'), false);
  });

  it('blocks non-supporting openrouter models', () => {
    assert.equal(modelSupportsCacheControl({ model: 'meta-llama/llama-3-70b' }, 'openrouter'), false);
    assert.equal(modelSupportsCacheControl({ model: 'openai/gpt-4o' }, 'openrouter'), false);
  });
});

describe('injectPromptCaching capability gate', () => {
  it('still injects for bedrock when the model id is unknown (backward compatible)', () => {
    const body = {
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'bedrock');
    assert.equal(count, 2);
  });

  it('injects for a Claude model on bedrock', () => {
    const body = {
      _tierModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'bedrock');
    assert.equal(count, 2);
  });

  it('skips injection for a non-Claude bedrock model and leaves body untouched', () => {
    const body = {
      _tierModel: 'meta.llama3-70b-instruct-v1:0',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'bedrock');
    assert.equal(count, 0);
    assert.equal(body.system, 'test'); // unchanged string, no array conversion
    assert.equal(body.messages[0].content, 'hi');
  });

  it('skips injection for a GPT model routed via openrouter', () => {
    const body = {
      model: 'openai/gpt-4o',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const count = injectPromptCaching(body, 'openrouter');
    assert.equal(count, 0);
  });
});
