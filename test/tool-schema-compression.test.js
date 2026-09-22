const assert = require('assert');
const { describe, it } = require('node:test');

// Regression tests for issue #116: compression must target description
// TEXT, never schema shape. The old rebuild dropped strict/pattern/const/
// oneOf and misleveled additionalProperties, silently, with a 2xx.
const { compressToolDescriptions } = require('../src/prompts/system');

const strictTool = () => ({
  type: 'function',
  function: {
    name: 'tool_a',
    description: 'Controlled G1 tool with a fairly long description that should be trimmed down substantially',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', pattern: '^(alice|bob)$', description: 'The recipient of the message' },
        mode: { const: 'fast' },
        choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        count: { type: 'integer', minimum: 1, description: 'How many items to process in this particular run, at most' },
      },
      required: ['recipient'],
      additionalProperties: false,
    },
  },
});

describe('compressToolDescriptions preserves schema shape (issue #116)', () => {
  it('keeps strict, pattern, const, oneOf, minimum, required, additionalProperties', () => {
    const [t] = compressToolDescriptions([strictTool()], 'minimal');
    assert.strictEqual(t.strict, true);
    assert.strictEqual(t.name, 'tool_a');
    const p = t.input_schema.properties;
    assert.strictEqual(p.recipient.pattern, '^(alice|bob)$');
    assert.strictEqual(p.mode.const, 'fast');
    assert.deepStrictEqual(p.choice.oneOf, [{ type: 'string' }, { type: 'number' }]);
    assert.strictEqual(p.count.minimum, 1);
    assert.deepStrictEqual(t.input_schema.required, ['recipient']);
    assert.strictEqual(t.input_schema.additionalProperties, false);
  });

  it('still compresses description text', () => {
    const [t] = compressToolDescriptions([strictTool()], 'minimal');
    assert.ok(t.description.length < 60, t.description);
    assert.ok(t.input_schema.properties.recipient.description.length <= 30);
  });

  it('drops obvious descriptions, trims the rest', () => {
    const [t] = compressToolDescriptions([{
      type: 'function',
      function: {
        name: 't', description: 'd',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to run' },
            custom: { type: 'string', description: 'A very long custom description that definitely needs trimming down' },
          },
        },
      },
    }], 'minimal');
    const p = t.input_schema.properties;
    assert.ok(!('description' in p.command), 'obvious name keeps no description');
    assert.ok(p.custom.description.length <= 30, p.custom.description);
  });

  it('non-minimal mode returns tools untouched', () => {
    const tools = [strictTool()];
    assert.strictEqual(compressToolDescriptions(tools, 'full')[0], tools[0]);
  });

  it('already-Anthropic tools pass through with keywords intact', () => {
    const [t] = compressToolDescriptions([{
      name: 'tool_b', strict: false,
      input_schema: { type: 'object', properties: { x: { type: 'string', pattern: '^a' } } },
    }], 'minimal');
    assert.strictEqual(t.input_schema.properties.x.pattern, '^a');
    assert.strictEqual(t.strict, false);
  });
});
