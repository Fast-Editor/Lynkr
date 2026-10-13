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

// Regression tests: compressSchemaDescriptions is invoked as
// compressSchemaDescriptions(schema, null) for the schema ROOT, where there is
// no property name to judge. Passing that null into isObviousFromName threw
// "TypeError: Cannot read properties of null (reading 'toLowerCase')", which
// the orchestrator catches and logs as
//   "System prompt optimization failed, continuing with original"
// (src/orchestrator/index.js). Net effect: for every tool whose input schema
// carries a root-level `description`, minimal-mode compression silently did
// nothing — and the sibling optimizeSystemPrompt() call in the same try block
// was skipped too.
describe('compressToolDescriptions tolerates a root-level schema description', () => {
  const rootDescriptionTool = () => ({
    type: 'function',
    function: {
      name: 'tool_root',
      parameters: {
        type: 'object',
        description: 'A deliberately long root-level schema description that exceeds thirty chars',
        properties: {
          command: { type: 'string', description: 'The command to run' },
          custom: { type: 'string', description: 'A very long custom description that definitely needs trimming down' },
        },
        required: ['command'],
      },
    },
  });

  it('does not throw (was: TypeError on null.toLowerCase)', () => {
    assert.doesNotThrow(() => compressToolDescriptions([rootDescriptionTool()], 'minimal'));
  });

  it('compresses the root description while preserving schema shape', () => {
    const [t] = compressToolDescriptions([rootDescriptionTool()], 'minimal');
    assert.strictEqual(t.input_schema.type, 'object');
    assert.deepStrictEqual(t.input_schema.required, ['command']);
    assert.strictEqual(typeof t.input_schema.description, 'string');
    assert.ok(t.input_schema.description.length <= 30, t.input_schema.description);
    // Nested behaviour is unchanged.
    assert.ok(!('description' in t.input_schema.properties.command));
    assert.ok(t.input_schema.properties.custom.description.length <= 30);
  });

  it('handles a root-level schema with no properties without throwing', () => {
    assert.doesNotThrow(() => compressToolDescriptions([{
      name: 'bare',
      input_schema: { type: 'object', description: 'x'.repeat(80) },
    }], 'minimal'));
  });

  it('handles a root-level schema array without throwing', () => {
    assert.doesNotThrow(() => compressToolDescriptions([{
      name: 'listy',
      input_schema: [{ type: 'object', description: 'x'.repeat(80) }],
    }], 'minimal'));
  });
});
