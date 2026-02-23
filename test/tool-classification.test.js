/**
 * Unit tests for Tool Needs Classification
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ToolClassificationWhitelist = require('../src/tools/tool-classification-whitelist.js');
const {
  getLastUserMessage,
  buildClassificationPrompt,
  parseClassificationResult
} = require('../src/tools/tool-classification-llm.js');

describe('Tool Classification - Whitelist', () => {
  let whitelist;

  beforeEach(() => {
    whitelist = new ToolClassificationWhitelist(
      path.join(__dirname, '../config/tool-whitelist.json'),
      { customCommands: [] }
    );
    whitelist.load();
  });

  it('should match exact pattern for needsTools', () => {
    const result = whitelist.check('list all files');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.needsTools, true);
    assert.strictEqual(result.pattern, 'list all files');
  });

  it('should match exact pattern for noTools', () => {
    const result = whitelist.check('hello');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.needsTools, false);
    assert.strictEqual(result.pattern, 'hello');
  });

  it('should match wildcard pattern', () => {
    const result = whitelist.check('bd show 123');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.needsTools, true);
    assert.ok(result.pattern.includes('*'));
  });

  it('should be case insensitive', () => {
    const result = whitelist.check('HELLO');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.needsTools, false);
  });

  it('should normalize whitespace', () => {
    const result = whitelist.check('list   all   files');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.needsTools, true);
  });

  it('should return not matched for unknown patterns', () => {
    const result = whitelist.check('something completely unknown');
    assert.strictEqual(result.matched, false);
  });

  it('should cache results', () => {
    const result1 = whitelist.check('hello');
    const result2 = whitelist.check('hello');

    assert.deepStrictEqual(result1, result2);
    assert.strictEqual(whitelist.cache.size > 0, true);
  });
});

describe('Tool Classification - LLM Helpers', () => {
  it('should extract last user message from simple payload', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'last message' }
      ]
    };

    const message = getLastUserMessage(payload);
    assert.strictEqual(message, 'last message');
  });

  it('should extract text from content blocks', () => {
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', source: 'data:...' },
            { type: 'text', text: 'world' }
          ]
        }
      ]
    };

    const message = getLastUserMessage(payload);
    assert.strictEqual(message, 'hello\nworld');
  });

  it('should return empty string for no user message', () => {
    const payload = {
      messages: [
        { role: 'assistant', content: 'only assistant message' }
      ]
    };

    const message = getLastUserMessage(payload);
    assert.strictEqual(message, '');
  });

  it('should build classification prompt', () => {
    const prompt = buildClassificationPrompt('list all files');

    assert.ok(prompt.includes('list all files'));
    assert.ok(prompt.includes('needsTools'));
    assert.ok(prompt.includes('JSON'));
  });

  it('should parse valid JSON response', () => {
    const response = '{"needsTools": true, "reason": "requires file access"}';
    const result = parseClassificationResult(response);

    assert.strictEqual(result.needsTools, true);
    assert.strictEqual(result.reason, 'requires file access');
  });

  it('should parse JSON in markdown code block', () => {
    const response = '```json\n{"needsTools": false, "reason": "greeting"}\n```';
    const result = parseClassificationResult(response);

    assert.strictEqual(result.needsTools, false);
    assert.strictEqual(result.reason, 'greeting');
  });

  it('should fallback parse when JSON is invalid', () => {
    const response = 'This requires tools to complete';
    const result = parseClassificationResult(response);

    // Should default to true when uncertain
    assert.strictEqual(typeof result.needsTools, 'boolean');
    assert.strictEqual(typeof result.reason, 'string');
  });

  it('should handle malformed JSON gracefully', () => {
    const response = '{"needsTools": "not a boolean"}';
    const result = parseClassificationResult(response);

    // Should fall back to heuristic
    assert.strictEqual(typeof result.needsTools, 'boolean');
  });
});

describe('Tool Classification - Integration', () => {
  it('should prioritize needsTools patterns over noTools', () => {
    const whitelist = new ToolClassificationWhitelist(
      path.join(__dirname, '../config/tool-whitelist.json'),
      { customCommands: [] }
    );
    whitelist.load();

    // "git status" should match needsTools, not fall through to noTools
    const result = whitelist.check('git status');
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.needsTools, true);
  });

  it('should handle edge cases in whitelist', () => {
    const whitelist = new ToolClassificationWhitelist(
      path.join(__dirname, '../config/tool-whitelist.json'),
      { customCommands: [] }
    );
    whitelist.load();

    // Empty message
    const result1 = whitelist.check('');
    assert.strictEqual(result1.matched, false);

    // Just whitespace
    const result2 = whitelist.check('   ');
    assert.strictEqual(result2.matched, false);

    // Special characters
    const result3 = whitelist.check('hello!!!');
    // Might not match due to ! - that's expected
  });

  it('should support custom shell commands', () => {
    const whitelist = new ToolClassificationWhitelist(
      path.join(__dirname, '../config/tool-whitelist.json'),
      { customCommands: ['bd', 'mycommand'] }
    );
    whitelist.load();

    // Custom command without args
    const result1 = whitelist.check('bd');
    assert.strictEqual(result1.matched, true);
    assert.strictEqual(result1.needsTools, true);

    // Custom command with args
    const result2 = whitelist.check('bd show 123');
    assert.strictEqual(result2.matched, true);
    assert.strictEqual(result2.needsTools, true);

    // Another custom command
    const result3 = whitelist.check('mycommand --flag');
    assert.strictEqual(result3.matched, true);
    assert.strictEqual(result3.needsTools, true);
  });
});
