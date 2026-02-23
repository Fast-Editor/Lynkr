/**
 * Tests for the per-model tool parser architecture (src/parsers/)
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const BaseToolParser = require('../src/parsers/base-tool-parser');
const GenericToolParser = require('../src/parsers/generic-tool-parser');
const Glm47ToolParser = require('../src/parsers/glm47-tool-parser');
const { getParserForModel, clearParserCache, PARSER_REGISTRY } = require('../src/parsers');

describe('BaseToolParser', () => {
  it('should throw on unimplemented extractToolCallsFromText', () => {
    const parser = new BaseToolParser('test-model');
    assert.throws(
      () => parser.extractToolCallsFromText('text'),
      /must implement extractToolCallsFromText/
    );
  });

  it('should pass-through normalizeToolCalls', () => {
    const parser = new BaseToolParser('test-model');
    const calls = [{ function: { name: 'Bash', arguments: {} } }];
    assert.deepStrictEqual(parser.normalizeToolCalls(calls), calls);
  });

  it('should pass-through cleanArguments', () => {
    const parser = new BaseToolParser('test-model');
    const call = { name: 'Bash', input: { command: 'ls' } };
    assert.strictEqual(parser.cleanArguments(call), call);
  });

  it('should strip <think> tags', () => {
    const parser = new BaseToolParser('test-model');
    const text = '<think>reasoning</think>The answer is 42';
    assert.strictEqual(parser.stripReasoningTags(text), 'The answer is 42');
  });

  it('should handle non-string in stripReasoningTags', () => {
    const parser = new BaseToolParser('test-model');
    assert.strictEqual(parser.stripReasoningTags(null), null);
    assert.strictEqual(parser.stripReasoningTags(undefined), undefined);
  });
});

describe('GenericToolParser', () => {
  let parser;
  beforeEach(() => { parser = new GenericToolParser('unknown-model'); });

  describe('extractToolCallsFromText', () => {
    it('should extract JSON tool calls', () => {
      const text = 'I will call {"name": "Bash", "parameters": {"command": "ls"}} now';
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'Bash');
      assert.deepStrictEqual(result[0].function.arguments, { command: 'ls' });
    });

    it('should return null for plain text', () => {
      assert.strictEqual(parser.extractToolCallsFromText('Hello world'), null);
    });

    it('should return null for null/empty input', () => {
      assert.strictEqual(parser.extractToolCallsFromText(null), null);
      assert.strictEqual(parser.extractToolCallsFromText(''), null);
    });

    it('should not extract fenced code blocks (that is model-specific)', () => {
      const text = '```bash\nls -la\n```';
      assert.strictEqual(parser.extractToolCallsFromText(text), null);
    });
  });

  describe('cleanArguments', () => {
    it('should clean Bash tool with code fence (Anthropic format)', () => {
      const dirty = { name: 'Bash', input: { command: '```bash\nls -la\n```' } };
      const clean = parser.cleanArguments(dirty);
      assert.strictEqual(clean.input.command, 'ls -la');
    });

    it('should clean Bash tool with prompt char (Anthropic format)', () => {
      const dirty = { name: 'Bash', input: { command: '$ pwd' } };
      const clean = parser.cleanArguments(dirty);
      assert.strictEqual(clean.input.command, 'pwd');
    });

    it('should clean Bash tool with bullet point', () => {
      const dirty = { name: 'Bash', input: { command: '● ls' } };
      const clean = parser.cleanArguments(dirty);
      assert.strictEqual(clean.input.command, 'ls');
    });

    it('should not modify non-Bash tools', () => {
      const tool = { name: 'Read', input: { file_path: '/tmp/test.txt' } };
      assert.strictEqual(parser.cleanArguments(tool), tool);
    });

    it('should not modify clean Bash commands', () => {
      const tool = { name: 'Bash', input: { command: 'ls -la' } };
      assert.strictEqual(parser.cleanArguments(tool), tool);
    });

    it('should handle null', () => {
      assert.strictEqual(parser.cleanArguments(null), null);
    });

    it('should clean OpenAI format', () => {
      const dirty = {
        function: { name: 'Bash', arguments: JSON.stringify({ command: '```bash\nls\n```' }) }
      };
      const clean = parser.cleanArguments(dirty);
      const args = JSON.parse(clean.function.arguments);
      assert.strictEqual(args.command, 'ls');
    });
  });
});

describe('Glm47ToolParser', () => {
  let parser;
  beforeEach(() => { parser = new Glm47ToolParser('glm-4.7:cloud'); });

  describe('extractToolCallsFromText — XML format', () => {
    it('should extract GLM XML tool call', () => {
      const text = `<tool_call>Bash
<arg_key>command</arg_key>
<arg_value>ls -la</arg_value>
</tool_call>`;
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'Bash');
      assert.strictEqual(result[0].function.arguments.command, 'ls -la');
    });

    it('should extract multiple XML tool calls', () => {
      const text = `<tool_call>Read
<arg_key>file_path</arg_key>
<arg_value>/tmp/test.txt</arg_value>
</tool_call>
<tool_call>Bash
<arg_key>command</arg_key>
<arg_value>pwd</arg_value>
</tool_call>`;
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].function.name, 'Read');
      assert.strictEqual(result[0].function.arguments.file_path, '/tmp/test.txt');
      assert.strictEqual(result[1].function.name, 'Bash');
      assert.strictEqual(result[1].function.arguments.command, 'pwd');
    });

    it('should handle multi-arg XML tool call', () => {
      const text = `<tool_call>Write
<arg_key>file_path</arg_key>
<arg_value>/tmp/out.txt</arg_value>
<arg_key>content</arg_key>
<arg_value>Hello world</arg_value>
</tool_call>`;
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'Write');
      assert.strictEqual(result[0].function.arguments.file_path, '/tmp/out.txt');
      assert.strictEqual(result[0].function.arguments.content, 'Hello world');
    });

    it('should handle tool call with no arguments', () => {
      const text = `<tool_call>SomeToolWithNoArgs</tool_call>`;
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'SomeToolWithNoArgs');
      assert.deepStrictEqual(result[0].function.arguments, {});
    });
  });

  describe('extractToolCallsFromText — bullet points', () => {
    it('should extract bullet-point shell commands', () => {
      const text = 'I will run these commands:\n● git status\n● ls -la';
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].function.name, 'Bash');
      assert.strictEqual(result[0].function.arguments.command, 'git status');
      assert.strictEqual(result[1].function.arguments.command, 'ls -la');
    });

    it('should not extract non-shell-command bullets', () => {
      const text = '● This is just a note\n● Another note';
      assert.strictEqual(parser.extractToolCallsFromText(text), null);
    });
  });

  describe('extractToolCallsFromText — fenced code blocks', () => {
    it('should extract commands from bash code block', () => {
      const text = '```bash\nls -la\npwd\n```';
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].function.arguments.command, 'ls -la');
      assert.strictEqual(result[1].function.arguments.command, 'pwd');
    });

    it('should strip $ and # prompt chars', () => {
      const text = '```bash\n$ ls -la\n# pwd\n```';
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result[0].function.arguments.command, 'ls -la');
      assert.strictEqual(result[1].function.arguments.command, 'pwd');
    });
  });

  describe('extractToolCallsFromText — priority', () => {
    it('should prefer XML over bullet points', () => {
      const text = `<tool_call>Read
<arg_key>file_path</arg_key>
<arg_value>/tmp/test.txt</arg_value>
</tool_call>
● ls -la`;
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      // XML match should win
      assert.strictEqual(result[0].function.name, 'Read');
    });
  });

  describe('orphaned closing tag stripping', () => {
    it('should strip orphaned </arg_value> from "Invoking tool(s):" text', () => {
      const text = 'Invoking tool(s): Grep</arg_value>';
      const result = parser.extractToolCallsFromText(text);
      // After stripping, text becomes "Invoking tool(s): Grep" — no tool_call structure
      assert.strictEqual(result, null);
    });

    it('should strip orphaned </think> from text', () => {
      const text = 'Invoking tool(s): Grep, Grep, Glob</think>';
      const result = parser.extractToolCallsFromText(text);
      assert.strictEqual(result, null);
    });

    it('should NOT strip </arg_value> when matching <arg_value> opener exists', () => {
      const text = `<tool_call>Bash
<arg_key>command</arg_key>
<arg_value>ls -la</arg_value>
</tool_call>`;
      const result = parser.extractToolCallsFromText(text);
      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'Bash');
      assert.strictEqual(result[0].function.arguments.command, 'ls -la');
    });

    it('should NOT strip </think> when matching <think> opener exists', () => {
      // Complete <think>...</think> pairs are kept by orphan stripping
      // (they get stripped by stripReasoningTags instead)
      const text = '<think>reasoning here</think>\n● git status';
      const result = parser.extractToolCallsFromText(text);
      // The complete <think> pair remains but is on its own line;
      // bullet extraction finds "● git status" on the next line
      assert.ok(result);
      assert.strictEqual(result[0].function.arguments.command, 'git status');
    });
  });

  describe('stripReasoningTags', () => {
    it('should strip complete <think> blocks', () => {
      assert.strictEqual(parser.stripReasoningTags('<think>reasoning</think>Answer'), 'Answer');
    });

    it('should strip orphaned </think> closing tag', () => {
      assert.strictEqual(parser.stripReasoningTags('Answer</think>'), 'Answer');
    });

    it('should strip orphaned </arg_value> closing tag', () => {
      assert.strictEqual(parser.stripReasoningTags('Grep</arg_value>'), 'Grep');
    });

    it('should not strip tags with matching openers', () => {
      const text = '<arg_value>val</arg_value>';
      assert.strictEqual(parser.stripReasoningTags(text), text);
    });
  });

  describe('cleanArguments', () => {
    it('should clean markdown from Bash commands', () => {
      const dirty = { name: 'Bash', input: { command: '```bash\nls -la\n```' } };
      const clean = parser.cleanArguments(dirty);
      assert.strictEqual(clean.input.command, 'ls -la');
    });

    it('should pass through non-Bash tools', () => {
      const tool = { name: 'Read', input: { file_path: '/tmp/test.txt' } };
      assert.strictEqual(parser.cleanArguments(tool), tool);
    });
  });
});

describe('Parser Registry', () => {
  beforeEach(() => { clearParserCache(); });

  it('should return Glm47ToolParser for glm-4.7 models', () => {
    const parser = getParserForModel('glm-4.7:cloud');
    assert.strictEqual(parser.constructor.name, 'Glm47ToolParser');
  });

  it('should return Glm47ToolParser for glm4 models', () => {
    const parser = getParserForModel('glm4-9b');
    assert.strictEqual(parser.constructor.name, 'Glm47ToolParser');
  });

  it('should return Glm47ToolParser for glm-4 models', () => {
    const parser = getParserForModel('glm-4-base');
    assert.strictEqual(parser.constructor.name, 'Glm47ToolParser');
  });

  it('should return parser for qwen3-coder models', () => {
    const parser = getParserForModel('qwen3-coder-next');
    assert.notStrictEqual(parser.constructor.name, 'GenericToolParser');
  });

  it('should return parser for qwen3 models', () => {
    const parser = getParserForModel('qwen3-base');
    assert.notStrictEqual(parser.constructor.name, 'GenericToolParser');
  });

  it('should return GenericToolParser for unknown models', () => {
    const parser = getParserForModel('some-random-model');
    assert.strictEqual(parser.constructor.name, 'GenericToolParser');
  });

  it('should return GenericToolParser for null model name', () => {
    const parser = getParserForModel(null);
    assert.strictEqual(parser.constructor.name, 'GenericToolParser');
  });

  it('should cache parser instances', () => {
    const p1 = getParserForModel('glm-4.7:cloud');
    const p2 = getParserForModel('glm-4.7:cloud');
    assert.strictEqual(p1, p2);
  });

  it('should clear cache', () => {
    const p1 = getParserForModel('glm-4.7:cloud');
    clearParserCache();
    const p2 = getParserForModel('glm-4.7:cloud');
    assert.notStrictEqual(p1, p2);
  });
});
