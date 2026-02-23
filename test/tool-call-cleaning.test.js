/**
 * Tests for universal tool call cleaning
 */

const assert = require('assert');
const { describe, it } = require('node:test');
const {
  cleanToolCallArguments,
  cleanToolCalls,
  stripMarkdownFromCommand,
  FENCE_REGEX,
  BULLET_POINT_REGEX,
  PROMPT_CHAR_REGEX
} = require('../src/tools/tool-call-cleaner');

describe('Universal Tool Call Cleaning', () => {
  describe('stripMarkdownFromCommand', () => {
    it('should strip bash code fences', () => {
      const dirty = '```bash\nls -la\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should strip sh code fences', () => {
      const dirty = '```sh\ncd /tmp\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'cd /tmp');
    });

    it('should strip shell code fences', () => {
      const dirty = '```shell\npwd\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'pwd');
    });

    it('should strip zsh code fences', () => {
      const dirty = '```zsh\necho "test"\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'echo "test"');
    });

    it('should strip console code fences', () => {
      const dirty = '```console\ngit status\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'git status');
    });

    it('should strip terminal code fences', () => {
      const dirty = '```terminal\nnpm test\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'npm test');
    });

    it('should strip $ prompt characters', () => {
      const dirty = '$ ls -la';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should strip # prompt characters', () => {
      const dirty = '# apt-get update';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'apt-get update');
    });

    it('should strip ● bullet points', () => {
      const dirty = '● ls -la';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should strip • bullet points', () => {
      const dirty = '• pwd';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'pwd');
    });

    it('should strip - bullet points', () => {
      const dirty = '- git status';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'git status');
    });

    it('should strip * bullet points', () => {
      const dirty = '* npm test';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'npm test');
    });

    it('should strip ❯ arrow prompts', () => {
      const dirty = '❯ cd /tmp';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'cd /tmp');
    });

    it('should strip > angle bracket prompts', () => {
      const dirty = '> echo "test"';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'echo "test"');
    });

    it('should fix user reported issue: "● ls"', () => {
      const dirty = '● ls';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls');
    });

    it('should handle combined: bullet + prompt', () => {
      const dirty = '● $ ls -la';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should handle combined: bullet + prompt + fence', () => {
      const dirty = '```bash\n● $ ls -la\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should clean multiline with mixed bullets and prompts', () => {
      const dirty = '● $ cd /tmp\n• # ls -la';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'cd /tmp\nls -la');
    });

    it('should handle bullet points with extra spacing', () => {
      const dirty = '●   ls -la';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should handle multiline commands with prompt chars', () => {
      const dirty = '```bash\n$ cd /tmp\n$ ls -la\n# pwd\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'cd /tmp\nls -la\npwd');
    });

    it('should handle code fence with extra whitespace', () => {
      const dirty = '```bash  \n  ls -la  \n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should handle prompt chars with extra spacing', () => {
      const dirty = '$   ls -la';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'ls -la');
    });

    it('should not modify clean commands', () => {
      const clean = 'ls -la /home/user';
      const result = stripMarkdownFromCommand(clean);
      assert.strictEqual(result, clean);
    });

    it('should handle empty string', () => {
      const result = stripMarkdownFromCommand('');
      assert.strictEqual(result, '');
    });

    it('should handle null', () => {
      const result = stripMarkdownFromCommand(null);
      assert.strictEqual(result, null);
    });

    it('should handle undefined', () => {
      const result = stripMarkdownFromCommand(undefined);
      assert.strictEqual(result, undefined);
    });

    it('should preserve commands with # that are not prompts', () => {
      const command = 'echo "# This is a comment"';
      const result = stripMarkdownFromCommand(command);
      assert.strictEqual(result, command);
    });

    it('should handle complex multiline with mixed content', () => {
      const dirty = '```bash\n$ echo "Starting process"\n# ls -la\ngrep "pattern" file.txt\n```';
      const clean = stripMarkdownFromCommand(dirty);
      assert.strictEqual(clean, 'echo "Starting process"\nls -la\ngrep "pattern" file.txt');
    });
  });

  describe('cleanToolCallArguments', () => {
    describe('Anthropic format', () => {
      it('should clean Bash tool with code fence', () => {
        const dirty = {
          name: 'Bash',
          id: 'toolu_123',
          input: { command: '```bash\nls -la\n```' }
        };
        const clean = cleanToolCallArguments(dirty);
        assert.strictEqual(clean.input.command, 'ls -la');
        assert.strictEqual(clean.name, 'Bash');
        assert.strictEqual(clean.id, 'toolu_123');
      });

      it('should clean Bash tool with prompt characters', () => {
        const dirty = {
          name: 'Bash',
          input: { command: '$ ls -la' }
        };
        const clean = cleanToolCallArguments(dirty);
        assert.strictEqual(clean.input.command, 'ls -la');
      });

      it('should handle multiline commands', () => {
        const dirty = {
          name: 'Bash',
          input: { command: '```bash\n$ cd /tmp\n# ls -la\n```' }
        };
        const clean = cleanToolCallArguments(dirty);
        assert.strictEqual(clean.input.command, 'cd /tmp\nls -la');
      });

      it('should preserve other input fields', () => {
        const dirty = {
          name: 'Bash',
          input: {
            command: '```bash\nls\n```',
            timeout: 5000,
            description: 'List files'
          }
        };
        const clean = cleanToolCallArguments(dirty);
        assert.strictEqual(clean.input.command, 'ls');
        assert.strictEqual(clean.input.timeout, 5000);
        assert.strictEqual(clean.input.description, 'List files');
      });

      it('should not modify non-Bash tools', () => {
        const tool = {
          name: 'Read',
          input: { file_path: '/tmp/test.txt' }
        };
        const clean = cleanToolCallArguments(tool);
        assert.deepStrictEqual(clean, tool);
      });

      it('should not modify Bash tools with clean commands', () => {
        const tool = {
          name: 'Bash',
          input: { command: 'ls -la /home/user' }
        };
        const clean = cleanToolCallArguments(tool);
        assert.strictEqual(clean, tool); // Should be same object reference
      });
    });

    describe('OpenAI format', () => {
      it('should clean Bash tool with code fence (string arguments)', () => {
        const dirty = {
          id: 'call_123',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({ command: '```bash\nls -la\n```' })
          }
        };
        const clean = cleanToolCallArguments(dirty);
        const args = JSON.parse(clean.function.arguments);
        assert.strictEqual(args.command, 'ls -la');
      });

      it('should clean Bash tool with code fence (object arguments)', () => {
        const dirty = {
          id: 'call_123',
          function: {
            name: 'Bash',
            arguments: { command: '```bash\nls -la\n```' }
          }
        };
        const clean = cleanToolCallArguments(dirty);
        const args = JSON.parse(clean.function.arguments);
        assert.strictEqual(args.command, 'ls -la');
      });

      it('should clean Bash tool with prompt characters', () => {
        const dirty = {
          id: 'call_123',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({ command: '$ pwd' })
          }
        };
        const clean = cleanToolCallArguments(dirty);
        const args = JSON.parse(clean.function.arguments);
        assert.strictEqual(args.command, 'pwd');
      });

      it('should preserve other arguments', () => {
        const dirty = {
          id: 'call_123',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({
              command: '```bash\nls\n```',
              timeout: 5000
            })
          }
        };
        const clean = cleanToolCallArguments(dirty);
        const args = JSON.parse(clean.function.arguments);
        assert.strictEqual(args.command, 'ls');
        assert.strictEqual(args.timeout, 5000);
      });

      it('should not modify non-Bash tools', () => {
        const tool = {
          id: 'call_123',
          function: {
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/tmp/test.txt' })
          }
        };
        const clean = cleanToolCallArguments(tool);
        assert.strictEqual(clean, tool);
      });
    });

    describe('Edge cases', () => {
      it('should handle null input', () => {
        const result = cleanToolCallArguments(null);
        assert.strictEqual(result, null);
      });

      it('should handle undefined input', () => {
        const result = cleanToolCallArguments(undefined);
        assert.strictEqual(result, undefined);
      });

      it('should handle tool call without command', () => {
        const tool = {
          name: 'Bash',
          input: {}
        };
        const clean = cleanToolCallArguments(tool);
        assert.strictEqual(clean, tool);
      });

      it('should handle tool call with non-string command', () => {
        const tool = {
          name: 'Bash',
          input: { command: 123 }
        };
        const clean = cleanToolCallArguments(tool);
        assert.strictEqual(clean, tool);
      });
    });
  });

  describe('cleanToolCalls', () => {
    it('should clean multiple tool calls', () => {
      const dirty = [
        {
          name: 'Bash',
          input: { command: '```bash\nls -la\n```' }
        },
        {
          name: 'Bash',
          input: { command: '$ pwd' }
        },
        {
          name: 'Read',
          input: { file_path: '/tmp/test.txt' }
        }
      ];

      const clean = cleanToolCalls(dirty);
      assert.strictEqual(clean.length, 3);
      assert.strictEqual(clean[0].input.command, 'ls -la');
      assert.strictEqual(clean[1].input.command, 'pwd');
      assert.strictEqual(clean[2].input.file_path, '/tmp/test.txt');
    });

    it('should handle empty array', () => {
      const result = cleanToolCalls([]);
      assert.deepStrictEqual(result, []);
    });

    it('should handle null', () => {
      const result = cleanToolCalls(null);
      assert.strictEqual(result, null);
    });

    it('should handle undefined', () => {
      const result = cleanToolCalls(undefined);
      assert.strictEqual(result, undefined);
    });

    it('should handle array with no cleanable calls', () => {
      const tools = [
        {
          name: 'Read',
          input: { file_path: '/tmp/test.txt' }
        },
        {
          name: 'Write',
          input: { file_path: '/tmp/out.txt', content: 'test' }
        }
      ];

      const clean = cleanToolCalls(tools);
      assert.strictEqual(clean.length, 2);
      assert.strictEqual(clean[0], tools[0]);
      assert.strictEqual(clean[1], tools[1]);
    });

    it('should preserve tool call order', () => {
      const dirty = [
        {
          name: 'Read',
          input: { file_path: '/tmp/test.txt' }
        },
        {
          name: 'Bash',
          input: { command: '```bash\nls\n```' }
        },
        {
          name: 'Write',
          input: { file_path: '/tmp/out.txt', content: 'test' }
        }
      ];

      const clean = cleanToolCalls(dirty);
      assert.strictEqual(clean.length, 3);
      assert.strictEqual(clean[0].name, 'Read');
      assert.strictEqual(clean[1].name, 'Bash');
      assert.strictEqual(clean[2].name, 'Write');
    });
  });

  describe('Regular expressions', () => {
    it('FENCE_REGEX should match all supported code fence types', () => {
      const fences = [
        '```bash\ncommand\n```',
        '```sh\ncommand\n```',
        '```shell\ncommand\n```',
        '```zsh\ncommand\n```',
        '```console\ncommand\n```',
        '```terminal\ncommand\n```'
      ];

      fences.forEach(fence => {
        assert.strictEqual(FENCE_REGEX.test(fence), true);
      });
    });

    it('FENCE_REGEX should not match non-shell code fences', () => {
      const fences = [
        '```javascript\ncode\n```',
        '```python\ncode\n```',
        '```json\n{}\n```'
      ];

      fences.forEach(fence => {
        FENCE_REGEX.lastIndex = 0; // Reset regex state
        assert.strictEqual(FENCE_REGEX.test(fence), false);
      });
    });

    it('PROMPT_CHAR_REGEX should match $ and # at line start', () => {
      const prompts = [
        '$ command',
        '# command',
        '  $ command',
        '  # command'
      ];

      prompts.forEach(prompt => {
        PROMPT_CHAR_REGEX.lastIndex = 0; // Reset regex state
        assert.strictEqual(PROMPT_CHAR_REGEX.test(prompt), true);
      });
    });

    it('PROMPT_CHAR_REGEX should not match $ and # in middle of line', () => {
      const strings = [
        'echo $VAR',
        'price is $100',
        'echo "# comment"'
      ];

      strings.forEach(str => {
        // Reset regex state
        PROMPT_CHAR_REGEX.lastIndex = 0;
        const match = PROMPT_CHAR_REGEX.test(str);
        assert.strictEqual(match, false);
      });
    });

    it('BULLET_POINT_REGEX should match all bullet point types at line start', () => {
      const bullets = [
        '● command',
        '• command',
        '- command',
        '* command',
        '❯ command',
        '> command',
        '  ● command',
        '  • command'
      ];

      bullets.forEach(bullet => {
        BULLET_POINT_REGEX.lastIndex = 0; // Reset regex state
        assert.strictEqual(BULLET_POINT_REGEX.test(bullet), true, `Failed for: ${bullet}`);
      });
    });

    it('BULLET_POINT_REGEX should not match bullets in middle of line', () => {
      const strings = [
        'echo ● test',
        'list • item',
        'math: 5 - 3',
        'multiply: 5 * 2',
        'echo > output.txt'
      ];

      strings.forEach(str => {
        BULLET_POINT_REGEX.lastIndex = 0; // Reset regex state
        const match = BULLET_POINT_REGEX.test(str);
        assert.strictEqual(match, false, `Should not match: ${str}`);
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should fix user reported issue: "● ls" tool call', () => {
      const toolCall = {
        name: 'Bash',
        id: 'toolu_123',
        input: { command: '● ls' }
      };
      const clean = cleanToolCallArguments(toolCall);
      assert.strictEqual(clean.input.command, 'ls');
    });

    it('should clean real-world LLM response with markdown', () => {
      const toolCall = {
        name: 'Bash',
        id: 'toolu_abc123',
        input: {
          command: '```bash\n$ ls -la /home/user/projects\n```',
          description: 'List project files'
        }
      };

      const clean = cleanToolCallArguments(toolCall);
      assert.strictEqual(clean.input.command, 'ls -la /home/user/projects');
      assert.strictEqual(clean.input.description, 'List project files');
    });

    it('should clean complex multiline command', () => {
      const toolCall = {
        name: 'Bash',
        input: {
          command: '```bash\n$ cd /tmp\n$ mkdir test\n# ls -la\n$ cd test\n```'
        }
      };

      const clean = cleanToolCallArguments(toolCall);
      assert.strictEqual(clean.input.command, 'cd /tmp\nmkdir test\nls -la\ncd test');
    });

    it('should clean command with bullets, fences, and prompts combined', () => {
      const toolCall = {
        name: 'Bash',
        input: {
          command: '```bash\n● $ cd /tmp\n• # mkdir test\n- ls -la\n```'
        }
      };

      const clean = cleanToolCallArguments(toolCall);
      assert.strictEqual(clean.input.command, 'cd /tmp\nmkdir test\nls -la');
    });

    it('should handle mixed tool calls array', () => {
      const toolCalls = [
        {
          name: 'Bash',
          input: { command: '```bash\nls\n```' }
        },
        {
          name: 'Read',
          input: { file_path: '/tmp/test.txt' }
        },
        {
          name: 'Bash',
          input: { command: '$ pwd' }
        },
        {
          name: 'Write',
          input: { file_path: '/tmp/out.txt', content: 'test' }
        }
      ];

      const clean = cleanToolCalls(toolCalls);
      assert.strictEqual(clean[0].input.command, 'ls');
      assert.strictEqual(clean[1].input.file_path, '/tmp/test.txt');
      assert.strictEqual(clean[2].input.command, 'pwd');
      assert.strictEqual(clean[3].input.file_path, '/tmp/out.txt');
    });

    it('should handle OpenAI format from comparison mode', () => {
      const toolCalls = [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'Bash',
            arguments: '{"command":"```bash\\nls -la\\n```","timeout":5000}'
          }
        }
      ];

      const clean = cleanToolCalls(toolCalls);
      const args = JSON.parse(clean[0].function.arguments);
      assert.strictEqual(args.command, 'ls -la');
      assert.strictEqual(args.timeout, 5000);
    });
  });
});
